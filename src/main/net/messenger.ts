import type { RemoteInfo } from 'node:dgram'
import { createConnection } from 'node:net'
import { EventEmitter } from 'node:events'
import {
  MSG_TYPES,
  TIMINGS,
  UDP_MAX_PAYLOAD,
  type AckPayload,
  type Envelope,
  type Timings
} from '../../shared/protocol'
import { decodeTcpEnvelopeObject, makeEnvelope } from './codec'
import { encodeFrame, FrameReader } from './frame'
import type { UdpChannel } from './udp'
import type { PeerRegistry } from './peer-registry'

// 可靠消息通道（protocol §7.2）：msg + ack、退避重传、离线补发、持久化去重。
// 存储经接口注入：生产用 SQLite repo，测试用内存实现 —— 本模块保持零 Electron / 零 native 依赖。

export interface QueueStore {
  enqueue(msgId: string, peerId: string, envelopeJson: string, created: number): void
  listByPeer(peerId: string): Array<{ msgId: string; envelopeJson: string }>
  /** 复合键删除：群消息同一 msgId 会给多个收件人各排一条（§7.4） */
  remove(msgId: string, peerId: string): void
  /** 清理过期与超限条目，返回被裁剪的 (msgId, peerId) 对 */
  prune(ttlMs: number, maxPerPeer: number): Array<{ msgId: string; peerId: string }>
}

export interface DedupStore {
  has(msgId: string): boolean
  add(msgId: string, recvTs: number): void
  prune(ttlMs: number): void
}

export type SendOutcome = 'sent' | 'queued'

interface PendingEntry {
  timer: ReturnType<typeof setTimeout> | null
  settle: (acked: boolean) => void
}

export class Messenger extends EventEmitter {
  private readonly udp: UdpChannel
  private readonly registry: PeerRegistry
  private readonly selfId: string
  private readonly queue: QueueStore
  private readonly dedup: DedupStore
  private readonly t: Timings
  private readonly pending = new Map<string, PendingEntry>()
  private readonly flushing = new Set<string>()
  private readonly cancelledQueued = new Set<string>()

  constructor(opts: {
    udp: UdpChannel
    registry: PeerRegistry
    selfId: string
    queue: QueueStore
    dedup: DedupStore
    timings?: Partial<Timings>
  }) {
    super()
    this.udp = opts.udp
    this.registry = opts.registry
    this.selfId = opts.selfId
    this.queue = opts.queue
    this.dedup = opts.dedup
    this.t = { ...TIMINGS, ...opts.timings }

    this.udp.on('envelope', (env: Envelope, known: boolean, rinfo: RemoteInfo) => {
      if (known) this.handle(env, rinfo)
    })
    // 对端上线（发现层判定）→ 补发发车
    this.registry.on('online', (nodeId: string) => {
      this.flushQueueSafely(nodeId)
    })
  }

  /** 发送用户消息：ACK 确认即 sent；重传耗尽 → 入队 + 对端标离线，返回 queued */
  async sendUserMessage(peerId: string, env: Envelope): Promise<SendOutcome> {
    const key = this.queueKey(peerId, env.id)
    const acked = await this.sendAwaitAck(peerId, env)
    if (acked) {
      this.cancelledQueued.delete(key)
      return 'sent'
    }
    if (this.cancelledQueued.delete(key)) return 'queued'
    this.queue.enqueue(env.id, peerId, JSON.stringify(env), Date.now())
    this.registry.markOffline(peerId) // 连发不应 → 立即标离线，不等心跳超时（§6.2）
    return 'queued'
  }

  /** 可靠发送但不入队（文件控制报文用——对方离线时直接失败，决议 #4） */
  async sendReliable(peerId: string, env: Envelope): Promise<boolean> {
    const acked = await this.sendAwaitAck(peerId, env)
    if (!acked) this.registry.markOffline(peerId)
    return acked
  }

  /** 对端上线后按原顺序补发；中途再失败即停（保持顺序，等下次上线） */
  async flushQueue(peerId: string): Promise<void> {
    if (this.flushing.has(peerId)) return
    this.flushing.add(peerId)
    try {
      for (const item of this.queue.listByPeer(peerId)) {
        const key = this.queueKey(peerId, item.msgId)
        if (this.cancelledQueued.delete(key)) continue
        let env: Envelope
        try {
          env = JSON.parse(item.envelopeJson) as Envelope
        } catch {
          this.queue.remove(item.msgId, peerId) // 损坏条目直接清掉
          continue
        }
        ;(env.payload as { resend?: boolean }).resend = true
        const acked = await this.sendAwaitAck(peerId, env)
        if (!acked) break
        this.queue.remove(item.msgId, peerId)
        this.cancelledQueued.delete(key)
        this.emit('status', item.msgId, 'sent')
      }
    } finally {
      this.flushing.delete(peerId)
    }
  }

  /** 周期清理（启动 + 每小时）：返回被裁剪的 (msgId, peerId) 供上层标 failed */
  prune(): Array<{ msgId: string; peerId: string }> {
    this.dedup.prune(this.t.dedupTtl)
    return this.queue.prune(this.t.queueTtl, this.t.queueMaxPerPeer)
  }

  /** 上层撤回原消息后，补发队列里不能再保留原文信封。 */
  dropQueuedMessage(msgId: string, peerIds: string[]): void {
    for (const peerId of peerIds) {
      const key = this.queueKey(peerId, msgId)
      this.cancelledQueued.add(key)
      this.pending.get(key)?.settle(false)
      this.queue.remove(msgId, peerId)
    }
  }

  /** TCP 控制帧入口：复用同一套入站白名单、去重和事件分发。 */
  acceptTcpEnvelope(raw: Envelope): boolean {
    const result = decodeTcpEnvelopeObject(raw)
    if (!result.ok || !result.known) return false
    const env = result.env
    if (env.from === this.selfId) return false
    if (
      env.type !== MSG_TYPES.msg &&
      env.type !== MSG_TYPES.fileCtl &&
      env.type !== MSG_TYPES.group
    ) {
      return false
    }
    if (this.dedup.has(env.id)) return true
    this.dedup.add(env.id, Date.now())
    this.emit('incoming', env)
    return true
  }

  /** 发送并等待 ACK：按 ackRetrySchedule 退避重发，每次重发都重读对端最新地址。
   *  等待表按 (收件人, 信封 id) 复合键——群消息同一信封并发发往多个成员互不串线（§7.4） */
  private sendAwaitAck(peerId: string, env: Envelope): Promise<boolean> {
    if (Buffer.byteLength(JSON.stringify(env), 'utf8') > UDP_MAX_PAYLOAD) {
      return this.sendTcpAwaitAck(peerId, env)
    }
    return new Promise((resolve) => {
      const key = this.queueKey(peerId, env.id)
      const old = this.pending.get(key)
      old?.settle(false) // 同键重入（手动重发）：先了结旧等待

      const entry: PendingEntry = {
        timer: null,
        settle: (acked: boolean) => {
          if (!this.pending.has(key)) return
          this.pending.delete(key)
          if (entry.timer) clearTimeout(entry.timer)
          resolve(acked)
        }
      }
      this.pending.set(key, entry)

      const delays = this.t.ackRetrySchedule
      let attempt = 0
      const step = (): void => {
        if (attempt === delays.length) {
          entry.settle(false)
          return
        }
        const record = this.registry.get(peerId)
        if (record) this.udp.send(env, record.ip, record.udpPort)
        entry.timer = setTimeout(step, delays[attempt])
        attempt += 1
      }
      step()
    })
  }

  private sendTcpAwaitAck(peerId: string, env: Envelope): Promise<boolean> {
    const record = this.registry.get(peerId)
    if (!record) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const socket = createConnection({ host: record.ip, port: record.profile.tcpPort })
      let timer: ReturnType<typeof setTimeout>
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(ok)
      }
      timer = setTimeout(() => settle(false), 7_000)
      const reader = new FrameReader(
        (frame) => {
          if (frame.type === 'msg-ack' && frame.ackFor === env.id) {
            settle(true)
            return
          }
          if (frame.type === 'err') settle(false)
        },
        () => undefined,
        () => settle(false)
      )

      socket.setNoDelay(true)
      socket.on('connect', () => {
        socket.write(encodeFrame({ type: 'msg', envelope: env }))
      })
      socket.on('data', (chunk) => reader.feed(chunk))
      socket.on('error', () => settle(false))
      socket.on('close', () => settle(false))
    })
  }

  private queueKey(peerId: string, msgId: string): string {
    return `${peerId}|${msgId}`
  }

  private flushQueueSafely(peerId: string): void {
    this.flushQueue(peerId).catch((err) => {
      if (isDatabaseClosedError(err)) return
      console.warn('[messenger] 补发队列刷新失败：', err)
    })
  }

  private handle(env: Envelope, rinfo: RemoteInfo): void {
    if (env.from === this.selfId) return

    if (env.type === MSG_TYPES.ack) {
      const ackFor = (env.payload as AckPayload).ackFor
      this.pending.get(`${env.from}|${ackFor}`)?.settle(true)
      return
    }

    // 可靠类型（msg / file-ctl / group）：无条件回 ACK（含重复），让对端停止重传
    if (
      env.type === MSG_TYPES.msg ||
      env.type === MSG_TYPES.fileCtl ||
      env.type === MSG_TYPES.group
    ) {
      const ack = makeEnvelope<AckPayload>(MSG_TYPES.ack, this.selfId, { ackFor: env.id })
      this.udp.send(ack, rinfo.address, rinfo.port)

      if (this.dedup.has(env.id)) return // 补发/重传造成的重复，只应答不重复处理
      this.dedup.add(env.id, Date.now())
      this.registry.touch(env.from, rinfo.address, rinfo.port) // 能发报文=在线
      this.emit('incoming', env, rinfo)
    }
  }
}

function isDatabaseClosedError(err: unknown): boolean {
  return err instanceof Error && /database connection is not open/i.test(err.message)
}
