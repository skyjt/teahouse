import { createServer, Socket, type Server } from 'node:net'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { resolve as pathResolve } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  PULL_IDLE_TIMEOUT,
  PULL_WAIT_HEARTBEAT,
  type DoneFrame,
  type Envelope,
  type PullFrame,
  type PullOkFrame,
  type ScreenOpenFrame,
  type TcpFrame
} from '../../shared/protocol'
import { encodeFrame, FrameReader } from './frame'

// 文件传输数据面（protocol §8，拉取式）：
// 发送方被动开 TCP 服务，按 pull 帧供流（边读边算 SHA-256）；
// 接收方主动连接，逐文件 pull → 收裸流 → 校验 → .part 改名落盘。
// 零 Electron 依赖，vitest 直接回环测试。

export interface OutgoingFile {
  fileId: string
  absPath: string
  size: number
}

export interface OutgoingLookup {
  /** 仅 accepted 状态的传输可被拉取；返回 null 拒绝 */
  resolve(transferId: string, fileId: string): OutgoingFile | null
  /** 超长文本 TCP 控制帧入口；返回 true 表示已接收并应 ACK */
  receiveMessage?: (env: Envelope, remoteAddress: string) => boolean
  /** 同一监听端口的屏幕连接：只在首帧分流，不占文件供流槽。 */
  openScreen?: (socket: Socket, frame: ScreenOpenFrame) => ((frame: TcpFrame) => void) | null
  /** 对端是否声明 tw1（决议 #211）：只有声明者才能收 wait 帧，旧端遇未知帧型会断链 */
  supportsWait?: (peerId: string) => boolean
}

export type ReadStreamFactory = (
  path: string,
  options?: { start?: number; end?: number }
) => ReturnType<typeof createReadStream>

export interface TransferServerLimits {
  maxConcurrentStreams: number
  maxConnections: number
  handshakeTimeoutMs: number
  idleTimeoutMs: number
  waitHeartbeatMs: number
}

interface PendingStreamStart {
  socket: Socket
  start: () => void
  started: boolean
  released: boolean
}

const DEFAULT_SERVER_LIMITS: TransferServerLimits = {
  maxConcurrentStreams: 3,
  maxConnections: 256,
  handshakeTimeoutMs: 15_000,
  idleTimeoutMs: 60_000,
  waitHeartbeatMs: PULL_WAIT_HEARTBEAT
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

export type WriteStreamFactory = (
  path: string,
  options?: { flags?: string }
) => ReturnType<typeof createWriteStream>

/** 发送侧 TCP 服务。事件：'progress'、'served'、'disconnected'(transferId) */
export class TransferServer extends EventEmitter {
  private server: Server | null = null
  /** 活跃连接：stop 时强制销毁，避免 server.close 因残留 socket 挂起 */
  private readonly sockets = new Set<Socket>()
  private readonly limits: TransferServerLimits
  private readonly pendingStreamStarts: PendingStreamStart[] = []
  /** 已通过 pull 授权且连接尚未关闭的 transfer 计数，用于截止前已开始传输的宽限。 */
  private readonly activeTransfers = new Map<string, number>()
  private activeStreamSlots = 0
  private pumpingStreamStarts = false

  constructor(
    private readonly port: number,
    private readonly lookup: OutgoingLookup,
    private readonly bindAddress?: string,
    private readonly openReadStream: ReadStreamFactory = createReadStream,
    limits: Partial<TransferServerLimits> = {}
  ) {
    super()
    this.limits = {
      maxConcurrentStreams: positiveLimit(
        limits.maxConcurrentStreams,
        DEFAULT_SERVER_LIMITS.maxConcurrentStreams
      ),
      maxConnections: positiveLimit(limits.maxConnections, DEFAULT_SERVER_LIMITS.maxConnections),
      handshakeTimeoutMs: positiveLimit(
        limits.handshakeTimeoutMs,
        DEFAULT_SERVER_LIMITS.handshakeTimeoutMs
      ),
      idleTimeoutMs: positiveLimit(limits.idleTimeoutMs, DEFAULT_SERVER_LIMITS.idleTimeoutMs),
      waitHeartbeatMs: positiveLimit(
        limits.waitHeartbeatMs,
        DEFAULT_SERVER_LIMITS.waitHeartbeatMs
      )
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        if (this.sockets.size >= this.limits.maxConnections) {
          socket.destroy()
          return
        }
        this.serve(socket)
      })
      server.once('error', reject)
      server.listen(this.port, this.bindAddress, () => {
        server.removeListener('error', reject)
        server.on('error', error => this.emit('diagnostic-error', error)) // 运行期错误不致命
        this.server = server
        resolve()
      })
    })
  }

  isTransferActive(transferId: string): boolean {
    return (this.activeTransfers.get(transferId) ?? 0) > 0
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      const server = this.server
      this.server = null
      for (const socket of this.sockets) {
        socket.destroy()
      }
      this.sockets.clear()
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      server.close(() => done())
      // 残留半开连接时 close 可能迟迟不回调；强制收口避免测试 afterEach 挂死
      setTimeout(done, 1_000)
    })
  }

  private enqueueStreamStart(socket: Socket, start: () => void): PendingStreamStart {
    const job: PendingStreamStart = { socket, start, started: false, released: false }
    this.pendingStreamStarts.push(job)
    socket.setTimeout(0)
    return job
  }

  private releaseStreamStart(job: PendingStreamStart): void {
    if (job.released) return
    job.released = true
    if (job.started) {
      this.activeStreamSlots = Math.max(0, this.activeStreamSlots - 1)
    } else {
      const index = this.pendingStreamStarts.indexOf(job)
      if (index >= 0) this.pendingStreamStarts.splice(index, 1)
    }
    this.pumpStreamStarts()
  }

  private pumpStreamStarts(): void {
    if (this.pumpingStreamStarts) return
    this.pumpingStreamStarts = true
    try {
      while (
        this.activeStreamSlots < this.limits.maxConcurrentStreams &&
        this.pendingStreamStarts.length > 0
      ) {
        const job = this.pendingStreamStarts.shift()!
        if (job.released || job.socket.destroyed) {
          job.released = true
          continue
        }
        job.started = true
        this.activeStreamSlots += 1
        try {
          job.start()
        } catch {
          this.releaseStreamStart(job)
          job.socket.destroy()
        }
      }
    } finally {
      this.pumpingStreamStarts = false
    }
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.setNoDelay(true)
    socket.setTimeout(this.limits.handshakeTimeoutMs)
    socket.on('timeout', () => socket.destroy())
    let busy = false // 同一连接内文件串行（协议约定），防交叉 pull
    let activeStreams: Array<ReturnType<ReadStreamFactory>> = []
    let streamJob: PendingStreamStart | null = null
    /** 发送端写缓冲满时只挂一个 drain，避免重复 resume 与泄漏 listener */
    let waitingDrain = false
    /** wait 保活（决议 #211）：排队 / 哈希收尾期间周期告知对端「仍在处理」 */
    let waitTimer: ReturnType<typeof setInterval> | null = null
    const socketTransfers = new Set<string>()
    let firstFrame = true
    let screenFrames: ((frame: TcpFrame) => void) | null = null

    const trackTransfer = (transferId: string): void => {
      if (socketTransfers.has(transferId)) return
      socketTransfers.add(transferId)
      this.activeTransfers.set(transferId, (this.activeTransfers.get(transferId) ?? 0) + 1)
    }

    const send = (frame: TcpFrame): void => {
      socket.write(encodeFrame(frame))
    }
    const stopWaitHeartbeat = (): void => {
      if (!waitTimer) return
      clearInterval(waitTimer)
      waitTimer = null
    }
    const startWaitHeartbeat = (wantsWait: boolean): void => {
      if (!wantsWait || waitTimer || socket.destroyed) return
      send({ type: 'wait' })
      waitTimer = setInterval(() => {
        if (socket.destroyed) {
          stopWaitHeartbeat()
          return
        }
        send({ type: 'wait' })
      }, this.limits.waitHeartbeatMs)
    }
    const trackStream = (
      stream: ReturnType<ReadStreamFactory>
    ): ReturnType<ReadStreamFactory> => {
      activeStreams.push(stream)
      stream.once('close', () => {
        activeStreams = activeStreams.filter((item) => item !== stream)
      })
      return stream
    }

    const reader = new FrameReader(
      (frame) => {
        if (socket.destroyed) return
        if (screenFrames) { screenFrames(frame); return }
        if (firstFrame && frame.type === 'screen-open') {
          firstFrame = false
          socket.setTimeout(0)
          screenFrames = this.lookup.openScreen?.(socket, frame) ?? null
          if (!screenFrames) socket.destroy()
          return
        }
        firstFrame = false
        if (frame.type.startsWith('screen-')) { socket.destroy(); return }
        socket.setTimeout(this.limits.idleTimeoutMs)
        if (frame.type === 'finish') {
          this.emit('served', frame.transferId)
          return
        }
        if (frame.type === 'msg') {
          const ok = this.lookup.receiveMessage?.(frame.envelope, socket.remoteAddress ?? '') ?? false
          if (ok) send({ type: 'msg-ack', ackFor: frame.envelope.id })
          else send({ type: 'err', reason: 'bad-msg' })
          return
        }
        if (frame.type !== 'pull' || busy) {
          if (frame.type === 'pull') send({ type: 'err', reason: 'busy' })
          return
        }
        const pull = frame as PullFrame
        const file = this.lookup.resolve(pull.transferId, pull.fileId)
        if (!file) {
          send({ type: 'err', reason: 'not-found' })
          return
        }
        const offset = pull.offset
        if (offset > file.size) {
          send({ type: 'err', reason: 'bad-offset' })
          return
        }
        trackTransfer(pull.transferId)
        busy = true
        const wantsWait = this.lookup.supportsWait?.(pull.from) === true
        const job = this.enqueueStreamStart(socket, () => {
          stopWaitHeartbeat()
          socket.setTimeout(this.limits.idleTimeoutMs)
          const currentFile = this.lookup.resolve(pull.transferId, pull.fileId)
          if (!currentFile || offset > currentFile.size) {
            send({ type: 'err', reason: currentFile ? 'bad-offset' : 'not-found' })
            busy = false
            this.releaseStreamStart(job)
            return
          }

          const len = currentFile.size - offset
          send({ type: 'pull-ok', fileId: currentFile.fileId, len } satisfies PullOkFrame)
          const hash = createHash('sha256')
          const asBuffer = (chunk: Buffer | string): Buffer =>
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          const sendDataChunk = (
            stream: ReturnType<ReadStreamFactory>,
            chunk: Buffer | string
          ): void => {
            const data = asBuffer(chunk)
            this.emit('progress', pull.transferId, data.length)
            if (!socket.write(data) && !waitingDrain) {
              waitingDrain = true
              stream.pause()
              socket.once('drain', () => {
                waitingDrain = false
                if (!socket.destroyed) stream.resume()
              })
            }
          }
          const finish = (sha256: string): void => {
            stopWaitHeartbeat()
            if (socket.destroyed) return
            send({ type: 'done', fileId: currentFile.fileId, sha256 } satisfies DoneFrame)
            busy = false
            this.releaseStreamStart(job)
            if (streamJob === job) streamJob = null
          }

          if (offset === 0) {
            // 首次拉取时同一条读流边发边算哈希；避免大文件先整盘预读导致 UI 长时间 0B。
            const dataStream = trackStream(this.openReadStream(currentFile.absPath))
            dataStream.on('data', (chunk) => {
              hash.update(asBuffer(chunk))
              sendDataChunk(dataStream, chunk)
            })
            dataStream.on('error', () => socket.destroy())
            dataStream.on('end', () => finish(hash.digest('hex')))
            return
          }

          // 断点续传仍需整文件哈希；数据流先启动，哈希流完成后再发送 done。
          let dataEnded = len === 0
          let digest: string | null = null
          const finishResumeIfReady = (): void => {
            if (!dataEnded || digest === null) return
            finish(digest)
          }

          const hashStream = trackStream(this.openReadStream(currentFile.absPath))
          hashStream.on('data', (chunk) => hash.update(chunk))
          hashStream.on('error', () => socket.destroy())
          hashStream.on('end', () => {
            digest = hash.digest('hex')
            finishResumeIfReady()
          })

          if (len === 0) {
            if (digest === null) startWaitHeartbeat(wantsWait)
            finishResumeIfReady()
            return
          }
          const dataStream = trackStream(
            this.openReadStream(currentFile.absPath, { start: offset })
          )
          dataStream.on('data', (chunk) => sendDataChunk(dataStream, chunk))
          dataStream.on('error', () => socket.destroy())
          dataStream.on('end', () => {
            dataEnded = true
            // 数据发完但整文件哈希还没算完（大文件近尾续传）：wait 保活防接收端空闲超时误判
            if (digest === null) startWaitHeartbeat(wantsWait)
            finishResumeIfReady()
          })
        })
        streamJob = job
        this.pumpStreamStarts()
        // 并发预算满、进入 FIFO 排队：立即告知对端并周期保活，避免对端只看到 0 速度
        if (!job.started && !job.released) startWaitHeartbeat(wantsWait)
      },
      () => socket.destroy(),
      () => socket.destroy()
    )

    socket.on('data', (chunk) => {
      try {
        reader.feed(chunk)
      } catch {
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      stopWaitHeartbeat()
      this.sockets.delete(socket)
      if (streamJob) {
        this.releaseStreamStart(streamJob)
        streamJob = null
      }
      for (const stream of activeStreams.splice(0)) stream.destroy()
      for (const transferId of socketTransfers) {
        const left = Math.max(0, (this.activeTransfers.get(transferId) ?? 1) - 1)
        if (left > 0) {
          this.activeTransfers.set(transferId, left)
        } else {
          this.activeTransfers.delete(transferId)
          this.emit('disconnected', transferId)
        }
      }
      busy = false
    })
  }
}

export interface IncomingFilePlan {
  fileId: string
  /** 已 sanitize 的相对路径（'/' 分隔） */
  relPath: string
  size: number
  isDir?: boolean
}

export type PullStage = 'connect' | 'connected' | 'prepare' | 'pull' | 'receive' | 'verify' | 'write' | 'complete'

export interface PullOptions {
  /** 关键阶段元数据；不含文件名、路径或进度。 */
  onPhase?: (stage: PullStage, localAddress?: string, localPort?: number) => void
  host: string
  port: number
  selfId: string
  transferId: string
  files: IncomingFilePlan[]
  saveDir: string
  onProgress: (bytesDelta: number) => void
  /** 由服务侧设置以支持取消：destroy 当前 socket */
  cancelRef: { canceled: boolean; socket: Socket | null }
  /** 排队状态回调（决议 #211）：收到 wait 帧且尚未开始供流时 true，pull-ok 到达后 false */
  onQueued?: (queued: boolean) => void
  /** 空闲超时（决议 #211）：超过该时长无任何帧/数据判失败；默认 PULL_IDLE_TIMEOUT */
  idleTimeoutMs?: number
  /** 只有发送端声明 tw1 才能接收预哈希 wait；未知能力按旧端处理。 */
  supportsWait?: boolean
  /** 测试注入：预哈希保活间隔与读取流。 */
  waitHeartbeatMs?: number
  openReadStream?: ReadStreamFactory
  /** 测试注入：默认写入真实文件系统 */
  openWriteStream?: WriteStreamFactory
}

/** 接收侧：连接发送方逐文件拉取；保留 .part 时可从 offset 断点续传。 */
export function pullTransfer(opts: PullOptions): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const root = pathResolve(opts.saveDir)
    let socket = new Socket()
    let stage: PullStage = 'connect'
    const phase = (value: PullStage): void => {
      stage = value
      opts.onPhase?.(value, socket.localAddress, socket.localPort)
    }

    const queue = [...opts.files]
    let current: {
      plan: IncomingFilePlan
      partPath: string
      finalPath: string
      stream: ReturnType<WriteStreamFactory>
      hash: ReturnType<typeof createHash>
      left: number
      /** pull-ok 已到达：之后的 wait 帧只是哈希收尾保活，不再是排队状态 */
      started: boolean
      finishing: boolean
    } | null = null
    let settled = false
    /** 写盘背压 pause 后，文件切换时 end() 可能吞掉 drain，须显式 resume */
    let socketPaused = false
    let preparingStream: ReturnType<ReadStreamFactory> | null = null
    let prepareHeartbeat: ReturnType<typeof setInterval> | null = null
    const stopPreparing = (): void => {
      if (prepareHeartbeat) clearInterval(prepareHeartbeat)
      prepareHeartbeat = null
      preparingStream?.destroy()
      preparingStream = null
    }
    const removePart = (path: string): void => {
      try {
        rmSync(path, { force: true })
      } catch {
        // 清理失败不覆盖原始传输失败原因。
      }
    }
    const resumeSocket = (): void => {
      if (!socketPaused) return
      socketPaused = false
      if (!settled && !socket.destroyed) socket.resume()
    }

    const fail = (reason: string, error?: unknown): void => {
      if (settled) return
      settled = true
      stopPreparing()
      resumeSocket()
      if (current) {
        current.stream.destroy()
        // 取消不再清 .part（决议 #211）：留给「重新下载」断点续传
        if (
          reason === 'hash-mismatch' ||
          reason === 'size-mismatch' ||
          reason === 'path-escape' ||
          reason === 'part-read-error'
        ) {
          removePart(current.partPath)
        }
      }
      socket.destroy()
      reject(Object.assign(new Error(reason), { stage, code: (error as { code?: unknown } | undefined)?.code }))
    }

    const succeed = (): void => {
      if (settled) return
      settled = true
      stopPreparing()
      resumeSocket()
      socket.end()
      phase('complete')
      resolvePromise()
    }

    const canContinue = (): boolean => {
      if (settled) return false
      if (opts.cancelRef.canceled || socket.destroyed) {
        fail(opts.cancelRef.canceled ? 'canceled' : 'closed')
        return false
      }
      return true
    }
    const next = (): void => {
      if (!canContinue()) return
      const plan = queue.shift()
      if (!plan) {
        socket.write(encodeFrame({ type: 'finish', transferId: opts.transferId }))
        succeed()
        return
      }
      phase('prepare')
      if (!canContinue()) return
      const finalPath = join(root, ...plan.relPath.split('/'))
      if (!pathResolve(finalPath).startsWith(root + sep)) {
        fail('path-escape') // sanitize 之外的最后一道闸
        return
      }
      if (plan.isDir) {
        try {
          mkdirSync(finalPath, { recursive: true })
        } catch (error) {
          fail('write-error', error)
          return
        }
        next()
        return
      }
      try {
        mkdirSync(dirname(finalPath), { recursive: true })
      } catch (error) {
        fail('write-error', error)
        return
      }
      const partPath = `${finalPath}.part`
      let offset = 0
      try {
        offset = Math.min(statSync(partPath).size, plan.size)
      } catch {
        offset = 0
      }
      if (offset > 0) opts.onProgress(offset)
      const hash = createHash('sha256')
      const startPull = (): void => {
        stopPreparing()
        if (!canContinue()) return
        phase('pull')
        if (!canContinue()) return
        current = {
          plan,
          partPath,
          finalPath,
          stream: (opts.openWriteStream ?? createWriteStream)(partPath, { flags: offset > 0 ? 'a' : 'w' }),
          hash,
          left: plan.size - offset,
          started: false,
          finishing: false
        }
        current.stream.on('error', error => fail('write-error', error))
        socket.write(
          encodeFrame({
            type: 'pull',
            from: opts.selfId,
            transferId: opts.transferId,
            fileId: plan.fileId,
            offset
          })
        )
      }
      if (offset === 0) {
        startPull()
        return
      }
      if (!canContinue()) return
      if (opts.supportsWait) {
        // 首个 wait 把发送端的 15 秒握手空闲切到 60 秒；后续心跳覆盖慢预哈希。
        socket.write(encodeFrame({ type: 'wait' }))
        prepareHeartbeat = setInterval(() => {
          if (canContinue()) socket.write(encodeFrame({ type: 'wait' }))
        }, positiveLimit(opts.waitHeartbeatMs, PULL_WAIT_HEARTBEAT))
      } else {
        // 旧端不识别 wait：先关闭空闲连接，预哈希完成再连接拉取。
        // 新的未连接 socket 仍交给 cancelRef，取消可立即终止本地读取。
        const previous = socket
        socket = new Socket()
        socketPaused = false
        attachSocket(socket)
        previous.destroy()
      }
      try {
        const existing = (opts.openReadStream ?? createReadStream)(partPath, { start: 0, end: offset - 1 })
        preparingStream = existing
        existing.on('data', (chunk) => { if (canContinue()) hash.update(chunk) })
        existing.on('error', error => {
          if (!canContinue()) return
          removePart(partPath)
          fail('part-read-error', error)
        })
        existing.on('end', () => {
          stopPreparing()
          if (!canContinue()) return
          if (opts.supportsWait) startPull()
          else connect(startPull)
        })
      } catch (error) {
        fail('part-read-error', error)
      }
    }

    const createReader = (connection: Socket): FrameReader => {
      const reader = new FrameReader(
        (frame) => {
          if (connection !== socket || !canContinue()) return
          if (frame.type === 'err') {
            fail(`peer:${frame.reason}`)
            return
          }
          if (frame.type === 'wait') {
            // 发送端排队 / 哈希收尾保活（决议 #211）：帧本身已刷新空闲计时
            if (current && !current.started) opts.onQueued?.(true)
            return
          }
          if (frame.type === 'pull-ok' && current && !current.finishing) {
            phase('receive')
            current.started = true
            opts.onQueued?.(false)
            if (frame.len !== current.left) {
              fail('size-mismatch')
              return
            }
            if (frame.len > 0) reader.expectRaw(frame.len)
            return
          }
          if (frame.type === 'done' && current && !current.finishing) {
            phase('verify')
            const item = current
            item.finishing = true
            // Node Writable 在 end/finish 路径上可能不再 emit drain；
            // 若上一文件写盘背压 pause 了 socket，不 resume 则下一文件 pull-ok 永远读不到（死锁）。
            resumeSocket()
            item.stream.end(() => {
              if (!canContinue()) return
              const got = item.hash.digest('hex')
              if (got !== frame.sha256) {
                removePart(item.partPath)
                fail('hash-mismatch')
                return
              }
              // 重名避让（F-FILE-3 不覆盖）：根级避让在服务层，此处兜底逐文件避让
              try {
                phase('write')
                if (!canContinue()) return
                renameSync(item.partPath, dedupeTargetPath(item.finalPath))
              } catch (error) {
                removePart(item.partPath)
                fail('write-error', error)
                return
              }
              current = null
              next()
            })
          }
        },
        (chunk) => {
          if (connection !== socket || !canContinue() || !current || current.finishing) return
          current.hash.update(chunk)
          current.left -= chunk.length
          if (!current.stream.write(chunk) && !socketPaused) {
            socketPaused = true
            socket.pause()
            current.stream.once('drain', () => resumeSocket())
          }
          opts.onProgress(chunk.length)
        },
        (reason) => { if (connection === socket) fail(reason) }
      )
      return reader
    }
    const attachSocket = (connection: Socket): void => {
      opts.cancelRef.socket = connection
      connection.setNoDelay(true)
      const reader = createReader(connection)
      connection.on('data', chunk => { if (connection === socket && canContinue()) reader.feed(chunk) })
      connection.on('timeout', () => { if (connection === socket) fail('timeout') })
      connection.on('error', error => { if (connection === socket) fail('socket-error', error) })
      connection.on('close', () => { if (connection === socket) fail('closed') })
    }
    const connect = (ready: () => void): void => {
      if (!canContinue()) return
      phase('connect')
      socket.setTimeout(positiveLimit(opts.idleTimeoutMs, PULL_IDLE_TIMEOUT))
      const connection = socket
      connection.connect({ host: opts.host, port: opts.port }, () => {
        if (connection !== socket || !canContinue()) return
        phase('connected')
        ready()
      })
    }
    attachSocket(socket)
    connect(next)
  })
}

/** 发送前对落盘目标做重名避让：name.ext → name(1).ext（F-FILE-3 不覆盖） */
export function dedupeTargetPath(path: string): string {
  try {
    statSync(path)
  } catch {
    return path // 不存在，直接用
  }
  const dir = dirname(path)
  const base = path.slice(dir.length + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem}(${i})${ext}`)
    try {
      statSync(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${stem}(${Date.now()})${ext}`)
}
