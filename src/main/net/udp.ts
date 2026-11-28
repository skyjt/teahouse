import { createSocket, type Socket, type RemoteInfo } from 'node:dgram'
import { EventEmitter } from 'node:events'
import { computeBroadcastTargets as computeBroadcastTargetsForIp } from '../util/local-network'
import { UDP_MAX_PAYLOAD, type Envelope } from '../../shared/protocol'
import { decode, encode } from './codec'

export interface UdpChannelOptions {
  port: number
  /** 测试用：绑定 127.0.0.1 可避免触发系统防火墙询问 */
  bindAddress?: string
  /** 测试用：覆盖广播目标（默认按网卡枚举 + 255.255.255.255） */
  broadcastTargets?: string[]
  /** 每源 IP 限速（protocol §1 入站校验 + tech-design §9 防泛洪） */
  rate?: { perSecond: number; burst: number }
  /** 首选本机 IPv4；空=全部网卡广播 */
  preferredLocalIp?: string
}

interface Bucket {
  tokens: number
  last: number
}

const BUCKET_CLEANUP_THRESHOLD = 2048
const BUCKET_TTL_MS = 10 * 60_000

/**
 * UDP 通道：收发信封、广播目标计算、每源令牌桶限速。
 * 事件：'envelope' (env, known, rinfo)、'drop' (reason, rinfo?)。
 * 不依赖 Electron，可在 vitest 中直接实例化。
 */
export class UdpChannel extends EventEmitter {
  private socket: Socket | null = null
  private readonly buckets = new Map<string, Bucket>()
  private readonly rate: { perSecond: number; burst: number }

  constructor(private readonly opts: UdpChannelOptions) {
    super()
    this.rate = opts.rate ?? { perSecond: 30, burst: 60 }
  }

  get port(): number {
    return this.socket?.address().port ?? this.opts.port
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      const onBindError = (err: Error): void => reject(err)
      socket.once('error', onBindError)
      socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo))
      socket.bind(this.opts.port, this.opts.bindAddress, () => {
        socket.removeListener('error', onBindError)
        // bind 之后的运行期错误（如发广播被网卡拒绝）不致命，记录即可
        socket.on('error', () => this.emit('drop', 'socket-error'))
        try {
          socket.setBroadcast(true)
        } catch {
          // 个别受限环境不允许广播，仅单播仍可用（手动节点/扫描兜底）
        }
        this.socket = socket
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve()
      this.socket.close(() => resolve())
      this.socket = null
    })
  }

  send(env: Envelope, address: string, port: number): void {
    this.sendBuffer(encode(env), address, port)
  }

  sendBuffer(buf: Buffer, address: string, port: number): void {
    if (!this.socket) return
    if (buf.length > UDP_MAX_PAYLOAD) {
      this.emit('drop', 'outbound-oversize')
      return
    }
    // 发送失败（断网/不可达广播地址）静默丢弃，靠协议自身的重试与心跳自愈
    this.socket.send(buf, port, address, () => undefined)
  }

  /** 向所有目标地址广播（同端口） */
  broadcast(env: Envelope): void {
    for (const addr of this.broadcastAddrs()) {
      this.send(env, addr, this.port)
    }
  }

  private broadcastAddrs(): string[] {
    if (this.opts.broadcastTargets) return this.opts.broadcastTargets
    return computeBroadcastTargets(this.opts.preferredLocalIp ?? '')
  }

  private allow(ip: string): boolean {
    const now = Date.now()
    let b = this.buckets.get(ip)
    if (!b) {
      b = { tokens: this.rate.burst, last: now }
      this.buckets.set(ip, b)
    }
    b.tokens = Math.min(this.rate.burst, b.tokens + ((now - b.last) / 1000) * this.rate.perSecond)
    b.last = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  private onMessage(buf: Buffer, rinfo: RemoteInfo): void {
    this.cleanupBuckets()
    if (!this.allow(rinfo.address)) {
      this.emit('drop', 'rate-limit', rinfo)
      return
    }
    const result = decode(buf)
    if (!result.ok) {
      this.emit('drop', result.reason, rinfo)
      return
    }
    this.emit('envelope', result.env, result.known, rinfo)
  }

  private cleanupBuckets(): void {
    if (this.buckets.size <= BUCKET_CLEANUP_THRESHOLD) return
    const cutoff = Date.now() - BUCKET_TTL_MS
    for (const [ip, bucket] of this.buckets) {
      if (bucket.last < cutoff) this.buckets.delete(ip)
    }
  }
}

/** 枚举所有非回环 IPv4 网卡的子网定向广播地址 + 受限广播（protocol §6.1） */
export function computeBroadcastTargets(preferredLocalIp = ''): string[] {
  return computeBroadcastTargetsForIp(preferredLocalIp)
}
