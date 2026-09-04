import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAPS,
  MSG_TYPES,
  type AvatarPayload,
  type Envelope,
  type GroupMeta,
  type Profile
} from '../../shared/protocol'
import { makeEnvelope } from '../net/codec'
import type { Messenger } from '../net/messenger'
import type { PeerRecord, PeerRegistry } from '../net/peer-registry'
import type { GroupRepo } from '../store/group-repo'
import { AvatarStore, avatarHashOf } from './avatar-store'
import { AvatarService } from './avatars'

function putAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
}
function avatarWebp(): Uint8Array {
  const bytes = new Uint8Array(30)
  putAscii(bytes, 0, 'RIFF')
  bytes[4] = 22
  putAscii(bytes, 8, 'WEBP')
  putAscii(bytes, 12, 'VP8 ')
  bytes[16] = 10
  bytes[23] = 0x9d
  bytes[24] = 0x01
  bytes[25] = 0x2a
  bytes[26] = 192
  bytes[28] = 192
  return bytes
}

function profile(nodeId: string, avatarHash?: string): Profile {
  return {
    nodeId,
    nick: nodeId,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    avatarHash,
    profileRev: 1,
    host: `${nodeId}.local`,
    platform: 'mac',
    tcpPort: 17879,
    ver: '0.42.0',
    caps: [CAPS.avatarImages]
  }
}

class FakeMessenger extends EventEmitter {
  sent: Array<{ peerId: string; env: Envelope }> = []
  bestEffort: Array<{ peerId: string; env: Envelope }> = []
  async sendReliable(peerId: string, env: Envelope): Promise<boolean> {
    this.sent.push({ peerId, env })
    return true
  }
  sendBestEffort(peerId: string, env: Envelope): void {
    this.bestEffort.push({ peerId, env })
  }
}

class FakeRegistry extends EventEmitter {
  readonly rows = new Map<string, PeerRecord>()
  get(nodeId: string): PeerRecord | undefined {
    return this.rows.get(nodeId)
  }
  values(): PeerRecord[] {
    return [...this.rows.values()]
  }
  put(nodeId: string, avatarHash: string | undefined, online = true): void {
    this.rows.set(nodeId, {
      profile: profile(nodeId, avatarHash),
      ip: '127.0.0.1',
      udpPort: 17878,
      lastSeen: Date.now(),
      online
    })
  }
}

class FakeGroupRepo {
  readonly rows = new Map<string, GroupMeta>()
  get(id: string): GroupMeta | undefined {
    return this.rows.get(id)
  }
  list(): GroupMeta[] {
    return [...this.rows.values()]
  }
}

async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

describe('AvatarService', () => {
  it('联系人头像按哈希去重请求，离线恢复上线后重试并通知就绪', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pantry-avatar-net-'))
    try {
      const bytes = avatarWebp()
      const hash = avatarHashOf(bytes)
      const messenger = new FakeMessenger()
      const registry = new FakeRegistry()
      const groups = new FakeGroupRepo()
      registry.put('node-peer', hash, false)
      const store = new AvatarStore(root)
      const service = new AvatarService({
        selfId: 'node-self',
        messenger: messenger as unknown as Messenger,
        registry: registry as unknown as PeerRegistry,
        groupRepo: groups as unknown as GroupRepo,
        store,
        getSelfProfile: () => profile('node-self')
      })
      const ready: string[] = []
      service.on('ready', (value: string) => ready.push(value))

      await service.ensurePeer('node-peer')
      expect(messenger.sent).toHaveLength(0)
      registry.get('node-peer')!.online = true
      registry.emit('online', 'node-peer')
      await waitFor(() => messenger.sent.length === 1)
      await service.ensurePeer('node-peer')
      expect(messenger.sent).toHaveLength(1)
      expect(messenger.sent[0]).toMatchObject({ peerId: 'node-peer', env: { type: MSG_TYPES.avatar } })

      const avatarReady = new Promise<string>((resolve) => service.once('ready', resolve))
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-peer', {
          op: 'data',
          hash,
          bytesBase64: Buffer.from(bytes).toString('base64')
        })
      )
      expect(await avatarReady).toBe(hash)
      expect(await store.has(hash)).toBe(true)
      expect(ready).toEqual([hash])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('群头像只向同群成员提供，也只接收当前群元数据匹配的哈希', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pantry-avatar-group-'))
    try {
      const bytes = avatarWebp()
      const hash = avatarHashOf(bytes)
      const messenger = new FakeMessenger()
      const registry = new FakeRegistry()
      const groups = new FakeGroupRepo()
      registry.put('node-member', undefined)
      registry.put('node-outsider', undefined)
      groups.rows.set('group-1', {
        groupId: 'group-1',
        name: '项目组',
        members: ['node-self', 'node-member'],
        rev: 1,
        updatedBy: 'node-self',
        updatedTs: 1,
        creatorIp: '127.0.0.1',
        creatorId: 'node-self',
        ownerId: 'node-self',
        adminIds: [],
        avatarHash: hash,
        adminSecretHash: '',
        adminHint: '',
        description: '',
        announce: ''
      })
      const store = new AvatarStore(root)
      await store.import(hash, bytes)
      new AvatarService({
        selfId: 'node-self',
        messenger: messenger as unknown as Messenger,
        registry: registry as unknown as PeerRegistry,
        groupRepo: groups as unknown as GroupRepo,
        store,
        getSelfProfile: () => profile('node-self')
      })

      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-outsider', {
          op: 'get',
          hash,
          groupId: 'group-1'
        })
      )
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-member', {
          op: 'get',
          hash,
          groupId: 'group-1'
        })
      )
      await waitFor(() => messenger.sent.length === 1)
      expect(messenger.sent).toHaveLength(1)
      expect(messenger.sent[0].peerId).toBe('node-member')
      expect(messenger.sent[0].env.payload).toMatchObject({ op: 'data', hash, groupId: 'group-1' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('来源无法提供数据时回尽力而为 miss；成员/权限不符保持沉默', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pantry-avatar-miss-serve-'))
    try {
      const hash = 'a'.repeat(64)
      const messenger = new FakeMessenger()
      const registry = new FakeRegistry()
      const groups = new FakeGroupRepo()
      registry.put('node-peer', undefined)
      registry.put('node-outsider', undefined)
      new AvatarService({
        selfId: 'node-self',
        messenger: messenger as unknown as Messenger,
        registry: registry as unknown as PeerRegistry,
        groupRepo: groups as unknown as GroupRepo,
        store: new AvatarStore(root),
        getSelfProfile: () => profile('node-self', hash) // 声明了哈希但缓存缺失
      })

      // 哈希匹配本人资料但文件缺失 → miss
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-peer', { op: 'get', hash })
      )
      await waitFor(() => messenger.bestEffort.length === 1)
      expect(messenger.bestEffort[0].peerId).toBe('node-peer')
      expect(messenger.bestEffort[0].env.payload).toMatchObject({ op: 'miss', hash })

      // 哈希不匹配本人资料 → miss；非群成员请求群头像 → 沉默
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-peer', {
          op: 'get',
          hash: 'b'.repeat(64)
        })
      )
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-outsider', {
          op: 'get',
          hash,
          groupId: 'group-x'
        })
      )
      await waitFor(() => messenger.bestEffort.length === 2)
      expect(messenger.bestEffort[1].env.payload).toMatchObject({
        op: 'miss',
        hash: 'b'.repeat(64)
      })
      expect(messenger.sent).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('群头像收到当前源 miss 后立即改试下一个在线成员，全部无着落则本轮冷却', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pantry-avatar-miss-failover-'))
    try {
      const hash = 'c'.repeat(64)
      const messenger = new FakeMessenger()
      const registry = new FakeRegistry()
      const groups = new FakeGroupRepo()
      registry.put('node-a', undefined)
      registry.put('node-b', undefined)
      groups.rows.set('group-1', {
        groupId: 'group-1',
        name: '项目组',
        members: ['node-self', 'node-a', 'node-b'],
        rev: 1,
        updatedBy: 'node-self',
        updatedTs: 1,
        creatorIp: '127.0.0.1',
        creatorId: 'node-self',
        ownerId: 'node-self',
        adminIds: [],
        avatarHash: hash,
        adminSecretHash: '',
        adminHint: '',
        description: '',
        announce: ''
      })
      const service = new AvatarService({
        selfId: 'node-self',
        messenger: messenger as unknown as Messenger,
        registry: registry as unknown as PeerRegistry,
        groupRepo: groups as unknown as GroupRepo,
        store: new AvatarStore(root),
        getSelfProfile: () => profile('node-self')
      })

      await service.ensureGroup('group-1', 'node-a')
      expect(messenger.sent).toHaveLength(1)
      expect(messenger.sent[0].peerId).toBe('node-a')

      // 非当前源的 miss 忽略；当前源 miss → 立即改试 node-b
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-b', {
          op: 'miss',
          hash,
          groupId: 'group-1'
        })
      )
      expect(messenger.sent).toHaveLength(1)
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-a', {
          op: 'miss',
          hash,
          groupId: 'group-1'
        })
      )
      await waitFor(() => messenger.sent.length === 2)
      expect(messenger.sent[1].peerId).toBe('node-b')

      // 所有源都 miss 后本轮冷却：ensureGroup 不再立即重发
      messenger.emit(
        'incoming',
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-b', {
          op: 'miss',
          hash,
          groupId: 'group-1'
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      await service.ensureGroup('group-1')
      expect(messenger.sent).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
