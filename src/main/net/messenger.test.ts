import { afterEach, describe, expect, it, vi } from 'vitest'
import { MSG_TYPES, type Envelope, type MsgPayload, type Profile, type Timings } from '../../shared/protocol'
import { makeEnvelope } from './codec'
import { UdpChannel } from './udp'
import { PeerRegistry } from './peer-registry'
import { Discovery } from './discovery'
import { Messenger, type DedupStore, type QueueStore } from './messenger'
import { TransferServer } from './transfer'

// 消息层回环集成：两套完整栈（udp+registry+discovery+messenger）在 127.0.0.1 对发。
// 存储用内存实现 —— vitest 不碰 native 模块；SQLite 实现由 npm run test:db 验证。

class MemQueue implements QueueStore {
  items: Array<{ msgId: string; peerId: string; envelopeJson: string; created: number }> = []
  enqueue(msgId: string, peerId: string, envelopeJson: string, created: number): void {
    this.items = this.items.filter((i) => i.msgId !== msgId)
    this.items.push({ msgId, peerId, envelopeJson, created })
  }
  listByPeer(peerId: string): Array<{ msgId: string; envelopeJson: string }> {
    return this.items
      .filter((i) => i.peerId === peerId)
      .sort((a, b) => a.created - b.created)
      .map((i) => ({ msgId: i.msgId, envelopeJson: i.envelopeJson }))
  }
  remove(msgId: string, peerId: string): void {
    this.items = this.items.filter((i) => !(i.msgId === msgId && i.peerId === peerId))
  }
  prune(ttlMs: number, maxPerPeer: number): Array<{ msgId: string; peerId: string }> {
    const cutoff = Date.now() - ttlMs
    const pruned = this.items
      .filter((i) => i.created < cutoff)
      .map((i) => ({ msgId: i.msgId, peerId: i.peerId }))
    this.items = this.items.filter((i) => i.created >= cutoff)
    void maxPerPeer
    return pruned
  }
}

class MemDedup implements DedupStore {
  private readonly seen = new Map<string, number>()
  has(msgId: string): boolean {
    return this.seen.has(msgId)
  }
  add(msgId: string, recvTs: number): void {
    this.seen.set(msgId, recvTs)
  }
  prune(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs
    for (const [id, ts] of this.seen) if (ts < cutoff) this.seen.delete(id)
  }
}

class ClosedQueue implements QueueStore {
  enqueue(): void {
    throw new Error('The database connection is not open')
  }
  listByPeer(): Array<{ msgId: string; envelopeJson: string }> {
    throw new Error('The database connection is not open')
  }
  remove(): void {
    throw new Error('The database connection is not open')
  }
  prune(): Array<{ msgId: string; peerId: string }> {
    throw new Error('The database connection is not open')
  }
}

let nextPort = 43000 + Math.floor(Math.random() * 1000)

const FAST: Partial<Timings> = {
  presenceInterval: 100,
  offlineAfter: 400,
  sweepInterval: 50,
  entryReplyJitterBase: 1,
  entryReplyJitterMax: 1,
  ackRetrySchedule: [60, 120, 180]
}

function makeProfile(name: string, port: number): Profile {
  return {
    nodeId: `node-${name}`,
    nick: name,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    profileRev: 1,
    host: `${name}-host`,
    platform: 'linux',
    tcpPort: port + 1,
    ver: '0.0.0-test',
    caps: []
  }
}

interface Stack {
  udp: UdpChannel
  registry: PeerRegistry
  discovery: Discovery
  messenger: Messenger
  queue: MemQueue
  profile: Profile
  port: number
  incoming: Envelope[]
}

const stacks: Stack[] = []
const tcpServers: TransferServer[] = []

async function makeStack(
  name: string,
  port: number,
  manualPeers: Array<{ host: string; port: number }> = []
): Promise<Stack> {
  const profile = makeProfile(name, port)
  const udp = new UdpChannel({ port, bindAddress: '127.0.0.1', broadcastTargets: [] })
  const registry = new PeerRegistry(profile.nodeId)
  const discovery = new Discovery({ udp, registry, profile, manualPeers, timings: FAST })
  const queue = new MemQueue()
  const messenger = new Messenger({
    udp,
    registry,
    selfId: profile.nodeId,
    queue,
    dedup: new MemDedup(),
    timings: FAST
  })
  const incoming: Envelope[] = []
  messenger.on('incoming', (env: Envelope) => incoming.push(env))
  await udp.start()
  const stack: Stack = { udp, registry, discovery, messenger, queue, profile, port, incoming }
  stacks.push(stack)
  return stack
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(25)
  }
  throw new Error('waitFor 超时')
}

afterEach(async () => {
  for (const server of tcpServers.splice(0)) await server.stop()
  for (const stack of stacks.splice(0)) {
    stack.discovery.stop()
    await stack.udp.stop()
  }
})

async function startTcpReceiver(stack: Stack): Promise<void> {
  const server = new TransferServer(
    stack.profile.tcpPort,
    {
      resolve: () => null,
      receiveMessage: (env) => stack.messenger.acceptTcpEnvelope(env)
    },
    '127.0.0.1'
  )
  tcpServers.push(server)
  await server.start()
}

function textEnv(from: string, text: string): Envelope<MsgPayload> {
  return makeEnvelope<MsgPayload>(MSG_TYPES.msg, from, { kind: 'text', text })
}

describe('messenger 回环集成', () => {
  it('在线直达：ACK 确认，sendUserMessage 返回 sent', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    const outcome = await a.messenger.sendUserMessage(
      b.profile.nodeId,
      textEnv(a.profile.nodeId, '你好，鲍勃')
    )
    expect(outcome).toBe('sent')
    expect(b.incoming).toHaveLength(1)
    const payload = b.incoming[0].payload as MsgPayload
    expect(payload.kind).toBe('text')
    if (payload.kind === 'text') expect(payload.text).toBe('你好，鲍勃')
    expect(a.queue.items).toHaveLength(0)
  })

  it('超长文本通过 TCP 控制帧直达', async () => {
    nextPort += 20
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 5, [{ host: '127.0.0.1', port: a.port }])
    await startTcpReceiver(b)
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    const longText = '这是一段超长文本'.repeat(150)
    const outcome = await a.messenger.sendUserMessage(
      b.profile.nodeId,
      textEnv(a.profile.nodeId, longText)
    )
    expect(outcome).toBe('sent')
    expect(b.incoming).toHaveLength(1)
    const payload = b.incoming[0].payload as MsgPayload
    expect(payload.kind).toBe('text')
    if (payload.kind === 'text') expect(payload.text).toBe(longText)
    expect(a.queue.items).toHaveLength(0)
  })

  it('重复消息：只入账一次，但每次都回 ACK', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    const env = textEnv(a.profile.nodeId, '只该看到一次')
    const first = await a.messenger.sendUserMessage(b.profile.nodeId, env)
    expect(first).toBe('sent')
    // 模拟网络重复/补发重放：同 id 再发，对端应只入账一次且仍回 ACK
    const again = await a.messenger.sendUserMessage(b.profile.nodeId, env)
    expect(again).toBe('sent')
    expect(b.incoming).toHaveLength(1)
  })

  it('群扇出：同一信封并发发给两个成员，互不串线（等待表复合键）', async () => {
    nextPort += 4
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    const c = await makeStack('carol', nextPort + 2, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    c.discovery.start()
    await waitFor(
      () =>
        a.registry.get(b.profile.nodeId)?.online === true &&
        a.registry.get(c.profile.nodeId)?.online === true
    )

    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, a.profile.nodeId, {
      kind: 'group-text',
      text: '群里好',
      groupId: 'g-test',
      groupRev: 1
    })
    const [r1, r2] = await Promise.all([
      a.messenger.sendUserMessage(b.profile.nodeId, env),
      a.messenger.sendUserMessage(c.profile.nodeId, env)
    ])
    expect(r1).toBe('sent')
    expect(r2).toBe('sent')
    expect(b.incoming).toHaveLength(1)
    expect(c.incoming).toHaveLength(1)
    expect(a.queue.items).toHaveLength(0)
  })

  it('离线入队 → 对方上线自动补发（含跨"重启"）', async () => {
    nextPort += 4
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    // B 突然消失（不发 exit）
    b.discovery.stop()
    await b.udp.stop()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === false)

    const outcome = await a.messenger.sendUserMessage(
      b.profile.nodeId,
      textEnv(a.profile.nodeId, '你不在的时候发的')
    )
    expect(outcome).toBe('queued')
    expect(a.queue.items).toHaveLength(1)

    // B "重启"：同身份新栈、同端口
    const b2 = await makeStack('bob', b.port, [{ host: '127.0.0.1', port: a.port }])
    const sentStatuses: string[] = []
    a.messenger.on('status', (_id: string, status: string) => sentStatuses.push(status))
    b2.discovery.start() // entry → A 的 registry 翻在线 → 补发发车

    await waitFor(() => b2.incoming.length === 1)
    const payload = b2.incoming[0].payload as MsgPayload
    expect(payload.kind).toBe('text')
    if (payload.kind === 'text') expect(payload.text).toBe('你不在的时候发的')
    expect((b2.incoming[0].payload as { resend?: boolean }).resend).toBe(true)
    await waitFor(() => a.queue.items.length === 0)
    expect(sentStatuses).toContain('sent')
  })

  it('撤回发送中的消息会取消后续入队，避免原文离线补发', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const env = textEnv(a.profile.nodeId, '这条会立刻撤回')

    const sending = a.messenger.sendUserMessage('node-missing', env)
    a.messenger.dropQueuedMessage(env.id, ['node-missing'])

    await expect(sending).resolves.toBe('queued')
    expect(a.queue.items).toHaveLength(0)
  })

  it('退出期数据库已关闭时忽略晚到的补发触发', async () => {
    nextPort += 2
    const udp = new UdpChannel({ port: nextPort, bindAddress: '127.0.0.1', broadcastTargets: [] })
    const registry = new PeerRegistry('node-alice')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    new Messenger({
      udp,
      registry,
      selfId: 'node-alice',
      queue: new ClosedQueue(),
      dedup: new MemDedup(),
      timings: FAST
    })

    registry.touch('node-bob', '127.0.0.1', nextPort + 1, makeProfile('bob', nextPort + 1))
    await sleep(0)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
