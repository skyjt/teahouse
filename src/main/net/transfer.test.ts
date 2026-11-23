import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createConnection, createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  TransferServer,
  dedupeTargetPath,
  pullTransfer,
  type IncomingFilePlan,
  type OutgoingFile,
  type ReadStreamFactory,
  type TransferServerLimits,
  type WriteStreamFactory
} from './transfer'
import { encodeFrame, FrameReader } from './frame'

function encodeUnknownFrame(frame: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

function closesWithin(socket: Socket, timeoutMs = 500): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// 数据面回环测试：真实文件、真实 TCP（127.0.0.1）、真实 SHA-256。
// 控制面（offer/accept）的可靠投递已由 messenger.test 覆盖。

const tmpDirs: string[] = []
const servers: TransferServer[] = []

async function removeTmpWithRetry(dir: string): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)))
    }
  }
  throw lastErr
}

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-transfer-'))
  tmpDirs.push(dir)
  return dir
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitFor(predicate: () => boolean, timeout = 500) {
  return vi.waitUntil(predicate, { timeout, interval: 10 })
}

class SlowReadable extends Readable {
  private sent = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly chunk: Buffer,
    private readonly maxChunks: number
  ) {
    super()
  }

  _read(): void {
    if (this.timer || this.destroyed) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.destroyed) return
      if (this.sent >= this.maxChunks) {
        this.push(null)
        return
      }
      this.sent += 1
      this.push(this.chunk)
    }, 10)
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    callback(error)
  }
}

class HeldReadable extends Readable {
  private released = false

  _read(): void {
    // 测试主动 release 前保持流打开。
  }

  release(byte = 0x61): void {
    if (this.released) return
    this.released = true
    this.push(Buffer.from([byte]))
    this.push(null)
  }
}

class SlowFileWritable extends Writable {
  readonly inner: ReturnType<typeof createWriteStream>
  private readonly innerClosed: Promise<void>
  maxBuffered = 0

  constructor(
    path: string,
    flags: string,
    private readonly delayMs: number,
    highWaterMark = 16 * 1024
  ) {
    super({ highWaterMark })
    this.inner = createWriteStream(path, { flags, highWaterMark: 16 * 1024 })
    this.innerClosed = new Promise(resolve => this.inner.once('close', resolve))
    this.inner.on('error', (err) => this.destroy(err))
  }

  write(
    chunk: Uint8Array | string,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void
  ): boolean {
    const ok =
      typeof encoding === 'function'
        ? super.write(chunk, encoding)
        : encoding
          ? super.write(chunk, encoding, cb)
          : super.write(chunk, cb)
    this.maxBuffered = Math.max(this.maxBuffered, this.writableLength)
    return ok
  }

  _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    setTimeout(() => {
      if (this.destroyed) {
        callback()
        return
      }
      if (this.inner.write(chunk, encoding)) {
        callback()
        return
      }
      this.inner.once('drain', callback)
    }, this.delayMs)
  }

  _final(callback: (error?: Error | null) => void): void {
    this.inner.end(callback)
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // 外层 close 必须代表真实文件已关闭，destroy() 本身不会同步关闭 fd。
    this.inner.destroy()
    void this.innerClosed.then(() => callback(error))
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of tmpDirs.splice(0)) await removeTmpWithRetry(dir)
})

// 由实际监听器占住内核分配的端口，不能先探测空闲端口再关闭重绑。
async function listenServer(server: TransferServer): Promise<number> {
  servers.push(server)
  await server.start()
  return server.port
}

async function startServer(
  files: Map<string, Map<string, OutgoingFile>>,
  openReadStream?: ReadStreamFactory
): Promise<number> {
  const server = new TransferServer(
    0,
    {
      resolve: (transferId, fileId) => files.get(transferId)?.get(fileId) ?? null
    },
    '127.0.0.1',
    openReadStream
  )
  return listenServer(server)
}

describe('transfer 数据面回环', () => {
  it('并行监听端口 0 时分配独立端口，停止后可重新分配', async () => {
    const listeners = Array.from({ length: 3 }, () =>
      new TransferServer(0, { resolve: () => null }, '127.0.0.1')
    )
    const ports = await Promise.all(listeners.map(listenServer))
    expect(ports.every(port => port > 0)).toBe(true)
    expect(new Set(ports).size).toBe(listeners.length)
    for (const port of ports) (await connectSocket(port)).destroy()
    const server = listeners[0]
    await server.stop()
    expect(server.port).toBe(0)
    await server.start()
    expect(server.port).toBeGreaterThan(0)
    const socket = await connectSocket(server.port)
    socket.destroy()
  })

  it('记录已通过 pull 授权的活动 transfer，并在连接断开时清除', async () => {
    const held = new HeldReadable()
    const server = new TransferServer(
      0,
      {
        resolve: (transferId, fileId) =>
          transferId === 't-active' && fileId === 'f-active'
            ? { fileId, absPath: '/virtual/active', size: 1 }
            : null
      },
      '127.0.0.1',
      () => held as unknown as ReturnType<ReadStreamFactory>
    )
    const disconnected: string[] = []
    server.on('disconnected', (transferId) => disconnected.push(transferId as string))
    const port = await listenServer(server)

    const socket = await connectSocket(port)
    expect(server.isTransferActive('t-active')).toBe(false)
    socket.write(
      encodeFrame({
        type: 'pull',
        from: 'receiver',
        transferId: 't-active',
        fileId: 'f-active',
        offset: 0
      })
    )
    await waitFor(() => server.isTransferActive('t-active'))
    socket.destroy()
    await waitFor(() => !server.isTransferActive('t-active'))
    expect(disconnected).toEqual(['t-active'])
  })

  it('发送端最多同时打开 3 条数据读流，第四条授权拉取按 FIFO 等待', async () => {
    const held: HeldReadable[] = []
    const opened: string[] = []
    const files = new Map<string, OutgoingFile>()
    for (let i = 1; i <= 4; i++) {
      files.set(`t${i}`, { fileId: `f${i}`, absPath: `/virtual/t${i}`, size: 1 })
    }
    const server = new TransferServer(
      0,
      {
        resolve: (transferId, fileId) => {
          const file = files.get(transferId)
          return file?.fileId === fileId ? file : null
        }
      },
      '127.0.0.1',
      (path) => {
        opened.push(path)
        const stream = new HeldReadable()
        held.push(stream)
        return stream as unknown as ReturnType<ReadStreamFactory>
      }
    )
    const port = await listenServer(server)

    const sockets: Socket[] = []
    for (let i = 1; i <= 4; i++) {
      const socket = await connectSocket(port)
      sockets.push(socket)
      socket.write(
        encodeFrame({ type: 'pull', from: 'receiver', transferId: `t${i}`, fileId: `f${i}`, offset: 0 })
      )
    }

    await waitFor(() => opened.length === 3)
    await delay(40)
    expect(opened).toEqual(['/virtual/t1', '/virtual/t2', '/virtual/t3'])

    held[0].release()
    await waitFor(() => opened.length === 4)
    expect(opened[3]).toBe('/virtual/t4')

    for (const stream of held) stream.release()
    for (const socket of sockets) socket.destroy()
  })

  it('连接总数达到上限时立即关闭新连接', async () => {
    const limits: Partial<TransferServerLimits> = { maxConnections: 1, handshakeTimeoutMs: 1_000 }
    const server = new TransferServer(0, { resolve: () => null }, '127.0.0.1', undefined, limits)
    const port = await listenServer(server)

    const first = await connectSocket(port)
    const second = await connectSocket(port)

    await expect(closesWithin(second)).resolves.toBe(true)
    expect(first.destroyed).toBe(false)
    first.destroy()
  })

  it('握手阶段和有效控制阶段分别应用可注入空闲超时', async () => {
    const limits: Partial<TransferServerLimits> = {
      handshakeTimeoutMs: 200,
      idleTimeoutMs: 80
    }
    const server = new TransferServer(0, { resolve: () => null }, '127.0.0.1', undefined, limits)
    const port = await listenServer(server)

    const timeouts = vi.spyOn(Socket.prototype, 'setTimeout')
    try {
      const silent = await connectSocket(port)
      await expect(closesWithin(silent, 2_000)).resolves.toBe(true)
      expect(timeouts).toHaveBeenCalledWith(limits.handshakeTimeoutMs)
      timeouts.mockClear()

      const active = await connectSocket(port)
      active.write(encodeFrame({ type: 'finish', transferId: 't-finished' }))
      await expect(closesWithin(active, 2_000)).resolves.toBe(true)
      expect(timeouts).toHaveBeenCalledWith(limits.idleTimeoutMs)
    } finally {
      timeouts.mockRestore()
    }
  })

  it('畸形 finish 只关闭当前连接，后续合法连接仍可完成', async () => {
    const dir = makeTmp()
    const path = join(dir, 'valid.txt')
    writeFileSync(path, 'hello')
    const server = new TransferServer(
      0,
      { resolve: (id) => id === 'valid-transfer' ? { fileId: 'f1', absPath: path, size: 5 } : null },
      '127.0.0.1'
    )
    const served: string[] = []
    server.on('served', (transferId) => served.push(transferId as string))
    const port = await listenServer(server)

    const badSocket = await connectSocket(port)
    const badClosed = waitForClose(badSocket)
    badSocket.write(encodeUnknownFrame({ type: 'finish', transferId: {} }))
    await badClosed

    const goodSocket = await connectSocket(port)
    goodSocket.write(encodeFrame({ type: 'finish', transferId: 'valid-transfer' }))
    await delay(20)
    expect(served).toEqual([]) // 未授权拉取过的 finish 不能伪造送达。
    goodSocket.destroy()
    await pullTransfer({ host: '127.0.0.1', port, selfId: 'receiver',
      transferId: 'valid-transfer', files: [{ fileId: 'f1', relPath: 'copy.txt', size: 5 }],
      saveDir: dir, cancelRef: { canceled: false, socket: null }, onProgress: () => undefined })
    await waitFor(() => served.length > 0)

    expect(served).toEqual(['valid-transfer'])
  })

  it('文件夹结构 + 大文件 + 空文件：逐文件拉取、哈希校验、结构还原', async () => {
    const src = makeTmp()
    const dst = makeTmp()
    const big = randomBytes(600 * 1024) // 600KB，跨多个 TCP chunk
    mkdirSync(join(src, 'docs'))
    writeFileSync(join(src, 'big.bin'), big)
    writeFileSync(join(src, 'docs', '说明.txt'), '你好，茶话间')
    writeFileSync(join(src, 'empty.dat'), '')

    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'big.bin'), size: big.length }],
      ['f2', { fileId: 'f2', absPath: join(src, 'docs', '说明.txt'), size: Buffer.byteLength('你好，茶话间') }],
      ['f3', { fileId: 'f3', absPath: join(src, 'empty.dat'), size: 0 }]
    ])
    const port = await startServer(new Map([['t1', outgoing]]))

    const plans: IncomingFilePlan[] = [
      { fileId: 'f1', relPath: '工程/big.bin', size: big.length },
      { fileId: 'f2', relPath: '工程/docs/说明.txt', size: Buffer.byteLength('你好，茶话间') },
      { fileId: 'f3', relPath: '工程/empty.dat', size: 0 }
    ]
    let bytes = 0
    await pullTransfer({
      host: '127.0.0.1',
      port,
      selfId: 'node-receiver',
      transferId: 't1',
      files: plans,
      saveDir: dst,
      cancelRef: { canceled: false, socket: null },
      onProgress: (d) => {
        bytes += d
      }
    })

    expect(readFileSync(join(dst, '工程', 'big.bin')).equals(big)).toBe(true)
    expect(readFileSync(join(dst, '工程', 'docs', '说明.txt'), 'utf8')).toBe('你好，茶话间')
    expect(readFileSync(join(dst, '工程', 'empty.dat')).length).toBe(0)
    expect(bytes).toBe(big.length + Buffer.byteLength('你好，茶话间'))
  }, 15_000)

  it('首次拉取时同一读流边发送边计算哈希，避免大文件接受后长时间 0B', async () => {
    const dst = makeTmp()
    const body = Buffer.alloc(4096, 0x5a)
    const readCalls: Array<{ start?: number }> = []
    const openReadStream: ReadStreamFactory = (_path, options) => {
      readCalls.push({ start: options?.start })
      return Readable.from([body]) as ReturnType<ReadStreamFactory>
    }
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: 'virtual.bin', size: body.length }]
    ])
    const port = await startServer(new Map([['t-streaming', outgoing]]), openReadStream)

    await pullTransfer({
      host: '127.0.0.1',
      port,
      selfId: 'node-receiver',
      transferId: 't-streaming',
      files: [{ fileId: 'f1', relPath: 'virtual.bin', size: body.length }],
      saveDir: dst,
      cancelRef: { canceled: false, socket: null },
      onProgress: () => undefined
    })

    expect(readFileSync(join(dst, 'virtual.bin')).equals(body)).toBe(true)
    expect(readCalls).toEqual([{ start: undefined }])
  })

  it('接收方中断连接时销毁发送端正在读取的文件流', async () => {
    const opened: SlowReadable[] = []
    const openReadStream: ReadStreamFactory = () => {
      const stream = new SlowReadable(Buffer.alloc(64 * 1024, 0x61), 1_000)
      opened.push(stream)
      return stream as unknown as ReturnType<ReadStreamFactory>
    }
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: 'virtual-large.bin', size: 64 * 1024 * 1_000 }]
    ])
    const port = await startServer(new Map([['t-close', outgoing]]), openReadStream)
    const socket = createConnection({ host: '127.0.0.1', port })
    const reader = new FrameReader(
      () => undefined,
      () => undefined,
      () => undefined
    )

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.on('data', (chunk) => reader.feed(chunk))
      socket.write(
        encodeFrame({
          type: 'pull',
          from: 'node-receiver',
          transferId: 't-close',
          fileId: 'f1',
          offset: 0
        })
      )
      await waitFor(() => opened.length > 0)
      socket.destroy()
      await delay(50)

      expect(opened.every((stream) => stream.destroyed)).toBe(true)
    } finally {
      socket.destroy()
      for (const stream of opened) stream.destroy()
    }
  })

  it('未被授权的传输拒绝供流（accepted 才可拉取的最小闸门）', async () => {
    const dst = makeTmp()
    const port = await startServer(new Map()) // 服务器不认识任何传输

    await expect(
      pullTransfer({
        host: '127.0.0.1',
        port,
        selfId: 'node-x',
        transferId: 'unknown',
        files: [{ fileId: 'f', relPath: 'x.bin', size: 10 }],
        saveDir: dst,
        cancelRef: { canceled: false, socket: null },
        onProgress: () => undefined
      })
    ).rejects.toThrow(/peer:not-found/)
  })

  it('保存路径中间段被文件占用时返回 write-error 且进程存活', async () => {
    const src = makeTmp()
    const dst = makeTmp()
    writeFileSync(join(src, 'payload.bin'), 'payload')
    writeFileSync(join(dst, 'x'), 'not-a-dir')
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'payload.bin'), size: Buffer.byteLength('payload') }]
    ])
    const port = await startServer(new Map([['t-write-error', outgoing]]))

    await expect(
      Promise.race([
        pullTransfer({
          host: '127.0.0.1',
          port,
          selfId: 'node-receiver',
          transferId: 't-write-error',
          files: [{ fileId: 'f1', relPath: 'x/y.bin', size: Buffer.byteLength('payload') }],
          saveDir: dst,
          cancelRef: { canceled: false, socket: null },
          onProgress: () => undefined
        }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 500))
      ])
    ).rejects.toThrow(/write-error/)
  })

  it.each(['partial', 'oversized'])('已有 %s 断点时完整接收并校验落盘内容', async (kind) => {
    const src = makeTmp()
    const dst = makeTmp()
    const body = randomBytes(256 * 1024)
    const half = Math.floor(body.length / 2)
    writeFileSync(join(src, 'resume.bin'), body)
    const partial = kind === 'partial' ? body.subarray(0, half) : Buffer.concat([body, Buffer.from('old tail')])
    writeFileSync(join(dst, 'resume.bin.part'), partial)
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'resume.bin'), size: body.length }]
    ])
    const port = await startServer(new Map([['t-resume', outgoing]]))
    let bytes = 0
    await pullTransfer({
      host: '127.0.0.1',
      port,
      selfId: 'node-receiver',
      transferId: 't-resume',
      files: [{ fileId: 'f1', relPath: 'resume.bin', size: body.length }],
      saveDir: dst,
      cancelRef: { canceled: false, socket: null },
      onProgress: (d) => {
        bytes += d
      }
    })

    expect(readFileSync(join(dst, 'resume.bin')).equals(body)).toBe(true)
    expect(bytes).toBe(body.length)
  })

  it('接收端写盘慢时暂停 socket，避免写流缓冲无界增长', async () => {
    const src = makeTmp()
    const dst = makeTmp()
    const body = randomBytes(5 * 1024 * 1024)
    writeFileSync(join(src, 'slow.bin'), body)
    const slowWriters: SlowFileWritable[] = []
    const openWriteStream: WriteStreamFactory = (path, options) => {
      const writer = new SlowFileWritable(path, options?.flags ?? 'w', 2)
      slowWriters.push(writer)
      return writer as unknown as ReturnType<WriteStreamFactory>
    }
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'slow.bin'), size: body.length }]
    ])
    const port = await startServer(new Map([['t-slow-write', outgoing]]))

    await expect(
      Promise.race([
        pullTransfer({
          host: '127.0.0.1',
          port,
          selfId: 'node-receiver',
          transferId: 't-slow-write',
          files: [{ fileId: 'f1', relPath: 'slow.bin', size: body.length }],
          saveDir: dst,
          cancelRef: { canceled: false, socket: null },
          onProgress: () => undefined,
          openWriteStream
        }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 8_000))
      ])
    ).resolves.toBeUndefined()

    expect(readFileSync(join(dst, 'slow.bin')).equals(body)).toBe(true)
    expect(slowWriters).toHaveLength(1)
    expect(slowWriters[0].maxBuffered).toBeLessThan(1024 * 1024)
  }, 15_000)

  it('多文件 + 写盘背压：文件切换时不得永久 pause socket', async () => {
    // 回归：上一文件 end() 吞掉 drain 后 socket 仍 paused，下一文件 pull-ok 读不到 → 死锁
    const src = makeTmp()
    const dst = makeTmp()
    const a = randomBytes(256 * 1024)
    const b = randomBytes(128 * 1024)
    writeFileSync(join(src, 'a.bin'), a)
    writeFileSync(join(src, 'b.bin'), b)
    writeFileSync(join(src, 'c.empty'), '')
    const openWriteStream: WriteStreamFactory = (path, options) => {
      return new SlowFileWritable(path, options?.flags ?? 'w', 1) as unknown as ReturnType<WriteStreamFactory>
    }
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'a.bin'), size: a.length }],
      ['f2', { fileId: 'f2', absPath: join(src, 'b.bin'), size: b.length }],
      ['f3', { fileId: 'f3', absPath: join(src, 'c.empty'), size: 0 }]
    ])
    const port = await startServer(new Map([['t-multi-bp', outgoing]]))

    await expect(
      Promise.race([
        pullTransfer({
          host: '127.0.0.1',
          port,
          selfId: 'node-receiver',
          transferId: 't-multi-bp',
          files: [
            { fileId: 'f1', relPath: 'pack/a.bin', size: a.length },
            { fileId: 'f2', relPath: 'pack/b.bin', size: b.length },
            { fileId: 'f3', relPath: 'pack/c.empty', size: 0 }
          ],
          saveDir: dst,
          cancelRef: { canceled: false, socket: null },
          onProgress: () => undefined,
          openWriteStream
        }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 10_000))
      ])
    ).resolves.toBeUndefined()

    expect(readFileSync(join(dst, 'pack', 'a.bin')).equals(a)).toBe(true)
    expect(readFileSync(join(dst, 'pack', 'b.bin')).equals(b)).toBe(true)
    expect(readFileSync(join(dst, 'pack', 'c.empty')).length).toBe(0)
  }, 15_000)

  it('done 帧与尾部数据同批到达且写缓冲已满时不得死锁（决议 #205 确定性回归）', async () => {
    // 死锁精确条件：最后一块裸流 write 返回 false → socket.pause()，且 done 帧已随同批
    // 数据进入 FrameReader 被同步处理 → stream.end() 后 Node Writable 不再 emit drain。
    // 真实 TransferServer 下 done 是否与数据同批取决于回环时序（快盘机器跑不出来），
    // 这里用手工帧服务端把 pull-ok + 全部裸流 + done 一次性写出，配合 1 字节水位慢写流，
    // 使该条件在任何机器上都成立：修复前必死锁，修复后必通过。
    const dst = makeTmp()
    const a = randomBytes(32 * 1024)
    const b = randomBytes(4 * 1024)
    const bodies = new Map<string, Buffer>([
      ['f1', a],
      ['f2', b]
    ])
    const digest = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')
    const server = createServer((socket) => {
      const reader = new FrameReader(
        (frame) => {
          if (frame.type !== 'pull') return
          const body = bodies.get(frame.fileId)
          if (!body) {
            socket.destroy()
            return
          }
          socket.write(
            Buffer.concat([
              encodeFrame({ type: 'pull-ok', fileId: frame.fileId, len: body.length }),
              body,
              encodeFrame({ type: 'done', fileId: frame.fileId, sha256: digest(body) })
            ])
          )
        },
        () => undefined,
        () => socket.destroy()
      )
      socket.on('data', (chunk) => reader.feed(chunk))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port

    try {
      await expect(
        Promise.race([
          pullTransfer({
            host: '127.0.0.1',
            port,
            selfId: 'node-receiver',
            transferId: 't-batched-done',
            files: [
              { fileId: 'f1', relPath: 'pack/a.bin', size: a.length },
              { fileId: 'f2', relPath: 'pack/b.bin', size: b.length }
            ],
            saveDir: dst,
            cancelRef: { canceled: false, socket: null },
            onProgress: () => undefined,
            // 1 字节水位：每个入站 chunk 的 write 都返回 false，逼出末尾 pause
            openWriteStream: (path, options) =>
              new SlowFileWritable(path, options?.flags ?? 'w', 1, 1) as unknown as ReturnType<WriteStreamFactory>
          }),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('deadlock-timeout')), 5_000)
          )
        ])
      ).resolves.toBeUndefined()

      expect(readFileSync(join(dst, 'pack', 'a.bin')).equals(a)).toBe(true)
      expect(readFileSync(join(dst, 'pack', 'b.bin')).equals(b)).toBe(true)
    } finally {
      server.close()
    }
  }, 15_000)

  it('排队时向声明 tw1 的接收端发 wait 帧，槽位释放后正常完成（决议 #211）', async () => {
    const dst = makeTmp()
    const held = new HeldReadable()
    const body = Buffer.alloc(2048, 0x42)
    const server = new TransferServer(
      0,
      {
        resolve: (transferId, fileId) => {
          if (transferId === 't-hold' && fileId === 'fh') {
            return { fileId: 'fh', absPath: '/virtual/hold', size: 1 }
          }
          if (transferId === 't-queued' && fileId === 'fq') {
            return { fileId: 'fq', absPath: '/virtual/queued', size: body.length }
          }
          return null
        },
        supportsWait: (peerId) => peerId === 'node-new'
      },
      '127.0.0.1',
      (path) => {
        if (path === '/virtual/hold') return held as unknown as ReturnType<ReadStreamFactory>
        return Readable.from([body]) as ReturnType<ReadStreamFactory>
      },
      { maxConcurrentStreams: 1, waitHeartbeatMs: 30 }
    )
    const port = await listenServer(server)

    // 第一条连接占住唯一数据流槽位
    const holder = await connectSocket(port)
    holder.write(
      encodeFrame({ type: 'pull', from: 'node-old', transferId: 't-hold', fileId: 'fh', offset: 0 })
    )
    await delay(30)

    const queuedStates: boolean[] = []
    const pull = pullTransfer({
      host: '127.0.0.1',
      port,
      selfId: 'node-new',
      transferId: 't-queued',
      files: [{ fileId: 'fq', relPath: 'queued.bin', size: body.length }],
      saveDir: dst,
      cancelRef: { canceled: false, socket: null },
      onProgress: () => undefined,
      onQueued: (queued) => queuedStates.push(queued)
    })

    // 排队期间：立即一帧 + 心跳重发，接收端持续上报排队中
    await waitFor(() => queuedStates.length >= 2, 2_000)
    expect(queuedStates.every((state) => state)).toBe(true)

    held.release()
    holder.destroy()
    await pull
    expect(queuedStates[queuedStates.length - 1]).toBe(false)
    expect(readFileSync(join(dst, 'queued.bin')).equals(body)).toBe(true)
  }, 15_000)

  it('对端未声明 tw1 时排队不发 wait 帧（旧端遇未知帧型会断链）', async () => {
    const held = new HeldReadable()
    const server = new TransferServer(
      0,
      {
        resolve: (transferId) =>
          transferId === 't-hold' || transferId === 't-old'
            ? { fileId: 'f', absPath: '/virtual/x', size: 1 }
            : null
        // supportsWait 未提供 = 一律不发
      },
      '127.0.0.1',
      () => held as unknown as ReturnType<ReadStreamFactory>,
      { maxConcurrentStreams: 1, waitHeartbeatMs: 20 }
    )
    const port = await listenServer(server)

    const holder = await connectSocket(port)
    holder.write(
      encodeFrame({ type: 'pull', from: 'node-a', transferId: 't-hold', fileId: 'f', offset: 0 })
    )
    await delay(20)

    const queuedSocket = await connectSocket(port)
    const received: string[] = []
    const reader = new FrameReader(
      (frame) => received.push(frame.type),
      () => undefined,
      () => undefined
    )
    queuedSocket.on('data', (chunk) => reader.feed(chunk))
    queuedSocket.write(
      encodeFrame({ type: 'pull', from: 'node-old', transferId: 't-old', fileId: 'f', offset: 0 })
    )

    await delay(120)
    expect(received).toEqual([]) // 排队期间静默，尤其没有 wait

    held.destroy()
    holder.destroy()
    queuedSocket.destroy()
  })

  it('接收端空闲超时（决议 #211）：发送端静默时判 timeout 失败，不永久冻结', async () => {
    const dst = makeTmp()
    // 手工静默服务端：收下连接与 pull 后不回任何帧
    const silent = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    const port = (silent.address() as { port: number }).port

    try {
      await expect(
        pullTransfer({
          host: '127.0.0.1',
          port,
          selfId: 'node-receiver',
          transferId: 't-idle',
          files: [{ fileId: 'f1', relPath: 'x.bin', size: 8 }],
          saveDir: dst,
          cancelRef: { canceled: false, socket: null },
          onProgress: () => undefined,
          idleTimeoutMs: 120
        })
      ).rejects.toThrow(/timeout/)
    } finally {
      silent.close()
    }
  })

  it('wait 帧刷新接收端空闲计时：慢启动的发送端不被误判超时', async () => {
    const dst = makeTmp()
    const body = Buffer.from('slow-start-ok')
    const digest = createHash('sha256').update(body).digest('hex')
    // 手工服务端：先只发 wait 保活，超过一个空闲窗口后才供流
    const server = createServer((socket) => {
      const reader = new FrameReader(
        (frame) => {
          if (frame.type !== 'pull') return
          const beat = setInterval(() => socket.write(encodeFrame({ type: 'wait' })), 60)
          setTimeout(() => {
            clearInterval(beat)
            socket.write(
              Buffer.concat([
                encodeFrame({ type: 'pull-ok', fileId: frame.fileId, len: body.length }),
                body,
                encodeFrame({ type: 'done', fileId: frame.fileId, sha256: digest })
              ])
            )
          }, 400)
        },
        () => undefined,
        () => socket.destroy()
      )
      socket.on('data', (chunk) => reader.feed(chunk))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port

    const queuedStates: boolean[] = []
    try {
      await pullTransfer({
        host: '127.0.0.1',
        port,
        selfId: 'node-receiver',
        transferId: 't-keepalive',
        files: [{ fileId: 'f1', relPath: 'slow.bin', size: body.length }],
        saveDir: dst,
        cancelRef: { canceled: false, socket: null },
        onProgress: () => undefined,
        onQueued: (queued) => queuedStates.push(queued),
        idleTimeoutMs: 200 // 小于总等待 400ms：没有 wait 保活必超时
      })
      expect(readFileSync(join(dst, 'slow.bin')).equals(body)).toBe(true)
      expect(queuedStates[0]).toBe(true)
      expect(queuedStates[queuedStates.length - 1]).toBe(false)
    } finally {
      server.close()
    }
  })

  it('重名避让：name.ext → name(1).ext', () => {
    const dir = makeTmp()
    writeFileSync(join(dir, 'a.txt'), '1')
    expect(dedupeTargetPath(join(dir, 'a.txt'))).toBe(join(dir, 'a(1).txt'))
    expect(dedupeTargetPath(join(dir, 'b.txt'))).toBe(join(dir, 'b.txt'))
  })
})


it('诊断保留真实回环连接拒绝的阶段和系统错误码，不附带文件名', async () => {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  const phases: string[] = []
  await expect(pullTransfer({ host: '127.0.0.1', port, selfId: 'test', transferId: 'diagnostic-test',
    files: [], saveDir: tmpdir(), cancelRef: { canceled: false, socket: null },
    onProgress: () => undefined, onPhase: phase => phases.push(phase)
  })).rejects.toMatchObject({ message: 'socket-error', stage: 'connect', code: 'ECONNREFUSED' })
  expect(phases).toEqual(['connect'])
})
