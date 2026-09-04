import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPS,
  FILE_OFFER_TTL,
  MSG_TYPES,
  type Envelope,
  type FileCtlOffer,
  type FileCtlPayload,
  type GroupMeta
} from '../../shared/protocol'
import type { ConversationView, MessageView } from '../../shared/ipc'
import type { Messenger } from '../net/messenger'
import type { PeerRegistry } from '../net/peer-registry'
import type { ConvRepo } from '../store/conv-repo'
import type { GroupRepo } from '../store/group-repo'
import type { MsgRepo, MsgRow, NewMessage } from '../store/msg-repo'
import type { TransferRepo, TransferRow } from '../store/transfer-repo'
import { FilesService } from './files'
import { makeEnvelope } from '../net/codec'

const tmpDirs: string[] = []

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        lastError = undefined
        break
      } catch (err) {
        lastError = err
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
      }
    }
    if (lastError) throw lastError
  }
})

class FakeMessenger extends EventEmitter {
  sent: Array<{ peerId: string; env: Envelope<FileCtlPayload> }> = []

  async sendReliable(peerId: string, env: Envelope<FileCtlPayload>): Promise<boolean> {
    this.sent.push({ peerId, env })
    return true
  }
}

class FakeRegistry {
  constructor(
    private readonly onlineIds: string[],
    private readonly caps: string[] | Record<string, string[]> = [],
    private readonly tcpPort = 17879
  ) {}

  get(nodeId: string): unknown {
    if (!this.onlineIds.includes(nodeId)) return undefined
    const caps = Array.isArray(this.caps) ? this.caps : (this.caps[nodeId] ?? [])
    return {
      online: true,
      ip: '127.0.0.1',
      udpPort: 17878,
      profile: { tcpPort: this.tcpPort, caps, nick: nodeId }
    }
  }
}

class FakeConvRepo {
  bumped: Array<{ convId: string; ts: number }> = []

  ensureSingle(peerId: string): string {
    return `single:${peerId}`
  }

  ensureGroup(groupId: string): string {
    return `group:${groupId}`
  }

  bump(convId: string, ts: number): void {
    this.bumped.push({ convId, ts })
  }

  incUnread(): void {
    // no-op
  }

  list(): ConversationView[] {
    return []
  }
}

class FakeMsgRepo {
  rows = new Map<string, MsgRow>()

  insert(msg: NewMessage): boolean {
    this.rows.set(msg.id, {
      id: msg.id,
      conv_id: msg.convId,
      sender_id: msg.senderId,
      is_mine: msg.isMine ? 1 : 0,
      kind: msg.kind,
      content: msg.content,
      file_ref: msg.fileRef ?? null,
      ts: msg.ts,
      seq: this.rows.size + 1,
      status: msg.status,
      reply_to: msg.replyTo
    })
    return true
  }

  get(msgId: string): MsgRow | undefined {
    return this.rows.get(msgId)
  }

  updateStatus(msgId: string, status: string): void {
    const row = this.rows.get(msgId)
    if (row) row.status = status
  }
}

class FakeTransferRepo {
  rows = new Map<string, TransferRow>()
  manifests = new Map<string, { msg_id: string; files: string; expires_at: number }>()

  resetLegacyActive(): number {
    return 0
  }

  insert(row: {
    transferId: string
    msgId: string
    peerId: string
    direction: 'in' | 'out'
    files: string
    status: string
    total: number
    ts: number
    expiresAt?: number
  }): void {
    this.rows.set(row.transferId, {
      transfer_id: row.transferId,
      msg_id: row.msgId,
      peer_id: row.peerId,
      direction: row.direction,
      files: row.files,
      status: row.status,
      bytes_done: 0,
      total: row.total,
      ts: row.ts,
      expires_at: row.expiresAt ?? 0
    })
  }

  updateStatus(transferId: string, status: string): void {
    const row = this.rows.get(transferId)
    if (row) row.status = status
  }

  updateProgress(): void {
    // no-op
  }

  updateFiles(transferId: string, filesJson: string): void {
    const row = this.rows.get(transferId)
    if (row) row.files = filesJson
  }

  clearExpiry(transferId: string): void {
    const row = this.rows.get(transferId)
    if (row) row.expires_at = 0
  }

  get(transferId: string): TransferRow | undefined {
    return this.rows.get(transferId)
  }

  list(): TransferRow[] {
    return [...this.rows.values()]
  }

  listSharePutIncoming(limit: number): TransferRow[] {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.direction === 'in' && row.status === 'done' && row.files.includes('"share-put"')
      )
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
  }

  listRecoverable(): TransferRow[] {
    return [...this.rows.values()].filter(
      (row) =>
        row.expires_at > 0 &&
        ((row.direction === 'out' &&
          ['offering', 'accepted', 'failed', 'canceled'].includes(row.status)) ||
          (row.direction === 'in' &&
            ['offering', 'accepted', 'failed', 'canceled'].includes(row.status)))
    )
  }

  saveOutgoingManifest(msgId: string, files: string, expiresAt: number): void {
    this.manifests.set(msgId, { msg_id: msgId, files, expires_at: expiresAt })
  }

  getOutgoingManifest(msgId: string): { msg_id: string; files: string; expires_at: number } | undefined {
    return this.manifests.get(msgId)
  }

  listOutgoingManifests(): Array<{ msg_id: string; files: string; expires_at: number }> {
    return [...this.manifests.values()]
  }

  deleteOutgoingManifest(msgId: string): void {
    this.manifests.delete(msgId)
  }
}

class FakeGroupRepo {
  constructor(private readonly meta: GroupMeta) {}

  get(groupId: string): GroupMeta | undefined {
    return groupId === this.meta.groupId ? this.meta : undefined
  }
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timeout'))
      }
    }, 10)
  })
}

describe('FilesService 群聊媒体', () => {
  it('同一同步批次内合并会话列表事件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-convs-batch-'))
    tmpDirs.push(dir)
    const firstPath = join(dir, '第一份.txt')
    const secondPath = join(dir, '第二份.txt')
    writeFileSync(firstPath, 'one')
    writeFileSync(secondPath, 'two')

    const service = new FilesService({
      selfId: 'node-self',
      messenger: new FakeMessenger() as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    const events: ConversationView[][] = []
    service.on('convs', (convs: ConversationView[]) => events.push(convs))

    const first = service.offerPaths('node-bob', [firstPath])
    const second = service.offerPaths('node-bob', [secondPath])

    expect(events).toHaveLength(0)
    await Promise.resolve()
    expect(events).toHaveLength(1)
    await Promise.all([first, second])
  })

  it('发送更新包 offer 不进入聊天与普通传输视图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-update-send-'))
    tmpDirs.push(dir)
    const pkgPath = join(dir, 'Teahouse-0.28.0-linux-amd64.deb')
    writeFileSync(pkgPath, 'deb')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const convRepo = new FakeConvRepo()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      getUpdateDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    await expect(svc.offerUpdatePackage('node-bob', pkgPath)).resolves.toBe(true)

    expect(msgRepo.rows.size).toBe(0)
    expect(convRepo.bumped).toHaveLength(0)
    expect(transferRepo.rows.size).toBe(1)
    const row = [...transferRepo.rows.values()][0]
    expect(row.direction).toBe('out')
    expect(row.msg_id).toMatch(/^update:/)
    expect(row.status).toBe('offering')
    expect(JSON.parse(row.files)).toMatchObject({
      name: 'Teahouse-0.28.0-linux-amd64.deb',
      savedPath: pkgPath,
      purpose: 'update'
    })
    expect(svc.transferView(row.transfer_id)).toBeNull()
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: {
        type: MSG_TYPES.fileCtl,
        payload: {
          op: 'offer',
          rootName: 'Teahouse-0.28.0-linux-amd64.deb',
          purpose: 'update'
        }
      }
    })
  })

  it('更新包 offer 不进入聊天与接收目录，并尝试自动 accept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    const updateDir = mkdtempSync(join(tmpdir(), 'pantry-update-service-'))
    tmpDirs.push(dir, updateDir)

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op !== 'accept'
    }
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const convRepo = new FakeConvRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      getUpdateDir: () => updateDir,
      authorizeUpdateOffer: () => true,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-update',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'Teahouse-0.28.0-linux-amd64.deb', size: 1024 }],
        totalSize: 1024,
        fileCount: 1,
        rootName: 'Teahouse-0.28.0-linux-amd64.deb',
        purpose: 'update'
      })
    )
    await waitTick()

    expect(msgRepo.rows.size).toBe(0)
    expect(convRepo.bumped).toHaveLength(0)
    expect(transferRepo.rows.size).toBe(1)
    const row = transferRepo.get('t-update')
    expect(row?.msg_id).toBe('update:t-update')
    expect(row?.status).toBe('failed')
    expect(JSON.parse(row!.files)).toMatchObject({
      name: 'Teahouse-0.28.0-linux-amd64.deb',
      purpose: 'update',
      savedPath: join(updateDir, 'Teahouse-0.28.0-linux-amd64.deb')
    })
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'accept', transferId: 't-update' } }
    })
  })

  it('未经用户请求授权的更新包 offer 直接拒绝且不入库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    const updateDir = mkdtempSync(join(tmpdir(), 'pantry-update-service-'))
    tmpDirs.push(dir, updateDir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      getUpdateDir: () => updateDir,
      authorizeUpdateOffer: () => false,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-update-unauthorized',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'Teahouse-0.28.0-linux-amd64.deb', size: 1024 }],
        totalSize: 1024,
        fileCount: 1,
        rootName: 'Teahouse-0.28.0-linux-amd64.deb',
        purpose: 'update'
      })
    )
    await waitTick()

    expect(msgRepo.rows.size).toBe(0)
    expect(transferRepo.rows.size).toBe(0)
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'decline', transferId: 't-update-unauthorized' } }
    })
  })

  it('拒绝声明总大小与文件清单不一致的图片 offer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.mediaRecall]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-bad-size',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'a.png', size: 30 }],
        totalSize: 1,
        fileCount: 1,
        rootName: 'a.png',
        purpose: 'image'
      })
    )
    await waitTick()

    expect(msgRepo.rows.size).toBe(0)
    expect(transferRepo.rows.size).toBe(0)
    expect(messenger.sent[0].peerId).toBe('node-bob')
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'decline',
      transferId: 't-bad-size'
    })
  })

  it('群文件发送只投递在线成员，并在本端只插入一条群消息', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '群文件.txt')
    writeFileSync(filePath, 'hello group')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob', 'node-carol', 'node-dan'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      ownerId: 'node-self',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob', 'node-dan']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath])
    expect(view?.convId).toBe('group:group-1')
    expect(view?.fileRef?.transferIds).toHaveLength(2)
    expect(msgRepo.rows.size).toBe(1)
    expect(transferRepo.rows.size).toBe(2)
    expect(transferRepo.manifests.size).toBe(1)
    const deadlines = new Set([...transferRepo.rows.values()].map((row) => row.expires_at))
    expect(deadlines.size).toBe(1)
    expect([...deadlines][0]).toBeGreaterThan(Date.now() + FILE_OFFER_TTL - 1_000)

    await waitTick()
    expect(messenger.sent.map((item) => item.peerId).sort()).toEqual(['node-bob', 'node-dan'])
    for (const item of messenger.sent) {
      expect(item.env.type).toBe(MSG_TYPES.fileCtl)
      expect(item.env.payload).toMatchObject({
        op: 'offer',
        groupId: 'group-1',
        groupRev: 3,
        rootName: '群文件.txt',
        expiresAt: [...deadlines][0]
      })
    }
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
  })

  it.each([
    ['图片', 'image', '群图片.png', 'image', '[图片]'],
    ['表情', 'sticker', '群表情.webp', 'sticker', '[表情]']
  ] as const)('群聊%s按 %s offer 投递', async (_label, want, name, kind, text) => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)
    const filePath = join(dir, name)
    writeFileSync(filePath, 'small image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      ownerId: 'node-self',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.mediaRecall]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath], want)
    expect(view?.kind).toBe(kind)
    expect(view?.text).toBe(text)

    await waitTick()
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'offer',
      purpose: want,
      groupId: 'group-1'
    })
    expect((messenger.sent[0].env.payload as FileCtlOffer).expiresAt).toBeUndefined()
    expect([...transferRepo.rows.values()][0].expires_at).toBe(0)
  })

  it('群聊表格图片按成员 tbl1 能力分别携带文字视图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-group-table-image-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '群表格.png')
    writeFileSync(filePath, 'small image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob', 'node-carol'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      ownerId: 'node-self',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob', 'node-carol'], {
        'node-bob': [CAPS.tableText],
        'node-carol': []
      }) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath], 'image', {
      tableText: 'A\tB\n1\t2'
    })
    await waitTick()

    expect(view?.fileRef?.tableText).toBe('A\tB\n1\t2')
    const byPeer = new Map(messenger.sent.map((item) => [item.peerId, item.env.payload]))
    expect(byPeer.get('node-bob')).toMatchObject({ tableText: 'A\tB\n1\t2' })
    expect('tableText' in byPeer.get('node-carol')!).toBe(false)
  })

  it('群聊图片超过 10MB 时退化为普通文件，等待成员手动接收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '超限群图片.png')
    writeFileSync(filePath, '')
    truncateSync(filePath, 10 * 1024 * 1024 + 1)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      ownerId: 'node-self',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath], 'image')
    expect(view?.kind).toBe('file')
    expect(view?.text).toBe('[文件] 超限群图片.png')

    await waitTick()
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'offer',
      groupId: 'group-1'
    })
    expect('purpose' in messenger.sent[0].env.payload).toBe(false)
    expect([...transferRepo.rows.values()][0].status).toBe('offering')
  })
})

describe('FilesService 默认接收目录', () => {
  it('手动接收默认保存到联系人目录，另存为直接使用用户选择目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-default-recv-'))
    tmpDirs.push(dir)
    const saveAsDir = join(dir, '用户选择目录')

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op !== 'accept'
    }
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      peerDisplayName: () => '李四/研发',
      bindAddress: '127.0.0.1'
    })
    const offer = (transferId: string, name: string): void => {
      messenger.emit(
        'incoming',
        makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
          op: 'offer',
          transferId,
          seq: 1,
          total: 1,
          files: [{ fileId: `${transferId}-f`, path: name, size: 5 }],
          totalSize: 5,
          fileCount: 1,
          rootName: name
        })
      )
    }

    offer('t-manual', '资料.txt')
    await waitTick()
    await expect(service.accept('t-manual')).resolves.toBe(false)
    expect(JSON.parse(transferRepo.get('t-manual')!.files)).toMatchObject({
      name: '资料.txt',
      savedPath: join(dir, '李四 研发', '资料.txt')
    })
    expect(JSON.parse(transferRepo.get('t-manual')!.files)).not.toHaveProperty('direct')

    offer('t-save-as', '方案.txt')
    await waitTick()
    await expect(service.accept('t-save-as', saveAsDir)).resolves.toBe(false)
    expect(JSON.parse(transferRepo.get('t-save-as')!.files)).toMatchObject({
      name: '方案.txt',
      savedPath: join(saveAsDir, '方案.txt')
    })
    expect(messenger.sent.filter((item) => item.env.payload.op === 'accept')).toHaveLength(2)
  })
})

describe('FilesService 私聊直接发送', () => {
  it('发送聊天媒体 offer 时携带本端消息 ID，供对端复用撤回锚点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-msgid-send-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '图片.png')
    writeFileSync(filePath, 'image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath], 'image')
    await waitTick()

    expect(view?.kind).toBe('image')
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'offer',
      msgId: view!.id,
      purpose: 'image'
    })
  })

  it('表格图片只向支持 tbl1 的单聊对端携带文字视图元数据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-table-image-send-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '表格.png')
    writeFileSync(filePath, 'image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.tableText]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath], 'image', {
      tableText: '姓名\t分数\n张三\t100',
      tableTextTruncated: true
    })
    await waitTick()

    expect(view?.fileRef).toMatchObject({
      tableText: '姓名\t分数\n张三\t100',
      tableTextTruncated: true
    })
    expect(messenger.sent[0].env.payload).toMatchObject({
      purpose: 'image',
      tableText: '姓名\t分数\n张三\t100',
      tableTextTruncated: true
    })
  })

  it('表格图片发给未声明 tbl1 的单聊对端时只保留本端文字视图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-table-image-legacy-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '表格.png')
    writeFileSync(filePath, 'image')

    const messenger = new FakeMessenger()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath], 'image', {
      tableText: '姓名\t分数\n张三\t100'
    })
    await waitTick()

    expect(view?.fileRef?.tableText).toBe('姓名\t分数\n张三\t100')
    expect('tableText' in messenger.sent[0].env.payload).toBe(false)
    expect('tableTextTruncated' in messenger.sent[0].env.payload).toBe(false)
  })

  it('接收表格图片 offer 时把文字视图元数据写入图片 fileRef', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-table-image-recv-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-table-img',
        msgId: 'msg-table-img',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'table.png', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: 'table.png',
        purpose: 'image',
        tableText: '姓名\t分数\n李四\t98',
        tableTextTruncated: true
      } as FileCtlPayload)
    )
    await waitTick()

    const ref = JSON.parse(msgRepo.get('msg-table-img')!.file_ref ?? '{}')
    expect(ref).toMatchObject({
      transferId: 't-table-img',
      tableText: '姓名\t分数\n李四\t98',
      tableTextTruncated: true
    })
  })

  it('接收带 msgId 的文件 offer 时用该 ID 入库并关联 transfer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-msgid-recv-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-shared-msg',
        msgId: 'msg-shared-media',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '资料.txt'
      } as FileCtlPayload)
    )
    await waitTick()

    expect(msgRepo.get('msg-shared-media')).toMatchObject({
      id: 'msg-shared-media',
      kind: 'file',
      conv_id: 'single:node-bob'
    })
    expect(transferRepo.get('t-shared-msg')?.msg_id).toBe('msg-shared-media')
  })

  it('文件只在关联 transfer 未完成时允许撤回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-recall-state-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '资料.txt')
    writeFileSync(filePath, 'hello')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.mediaRecall]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    const transferId = view!.fileRef!.transferId
    const mediaRecall = service as unknown as { canRecallMessage(msgId: string): boolean }

    expect(mediaRecall.canRecallMessage(view!.id)).toBe(true)
    transferRepo.updateStatus(transferId, 'done')
    expect(mediaRecall.canRecallMessage(view!.id)).toBe(false)
  })

  it('旧端未声明媒体撤回能力时不允许撤回聊天媒体', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-recall-cap-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '资料.txt')
    writeFileSync(filePath, 'hello')

    const service = new FilesService({
      selfId: 'node-self',
      messenger: new FakeMessenger() as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    const mediaRecall = service as unknown as { canRecallMessage(msgId: string): boolean }

    expect(mediaRecall.canRecallMessage(view!.id)).toBe(false)
  })

  it('发送侧在已有文件卡片上请求直接发送', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-send-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '资料.txt')
    writeFileSync(filePath, 'hello')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.fileDirect]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    expect(view?.fileRef?.direct).toBeUndefined()
    await waitTick()
    const row = [...transferRepo.rows.values()][0]
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: {
        type: MSG_TYPES.fileCtl,
        payload: {
          op: 'offer',
          rootName: '资料.txt'
        }
      }
    })
    expect('receiveMode' in messenger.sent[0].env.payload).toBe(false)

    await expect(service.requestDirect(row.transfer_id)).resolves.toBe(true)
    expect(messenger.sent[1]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'direct', transferId: row.transfer_id } }
    })
    expect(JSON.parse(transferRepo.get(row.transfer_id)!.files)).toMatchObject({
      name: '资料.txt',
      direct: true
    })
    expect(service.transferView(row.transfer_id)?.direct).toBe(true)
  })

  it('接收侧收到 direct 控制帧后自动保存到发送人目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-recv-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op !== 'accept'
    }
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      allowDirectFileSend: () => true,
      peerDisplayName: () => '张三/设计',
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-direct',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '资料.txt'
      })
    )
    await waitTick()

    const msg = [...msgRepo.rows.values()][0]
    expect(JSON.parse(msg.file_ref!)).not.toHaveProperty('direct')
    expect(transferRepo.get('t-direct')?.status).toBe('offering')

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'direct',
        transferId: 't-direct'
      })
    )
    await waitTick()

    const row = transferRepo.get('t-direct')
    expect(row?.status).toBe('failed')
    expect(JSON.parse(row!.files)).toMatchObject({
      name: '资料.txt',
      direct: true,
      directPeerName: '张三 设计',
      savedPath: join(dir, '张三 设计', '资料.txt')
    })
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'accept', transferId: 't-direct' } }
    })
  })

  it('接收侧关闭直接接收时忽略 direct 控制帧，保留普通文件卡片', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-disabled-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      allowDirectFileSend: () => false,
      peerDisplayName: () => '张三',
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-direct-disabled',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '资料.txt'
      })
    )
    await waitTick()

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'direct',
        transferId: 't-direct-disabled'
      })
    )
    await waitTick()

    const msg = [...msgRepo.rows.values()][0]
    expect(JSON.parse(msg.file_ref!)).not.toHaveProperty('direct')
    const row = transferRepo.get('t-direct-disabled')
    expect(row?.status).toBe('offering')
    expect(JSON.parse(row!.files)).not.toHaveProperty('direct')
    expect(messenger.sent).toHaveLength(0)
  })

  it('群聊文件即使收到 direct 控制帧也不自动接收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-group-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      allowDirectFileSend: () => true,
      peerDisplayName: () => '张三',
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-group-direct',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '群资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '群资料.txt',
        groupId: 'group-1',
        groupRev: 1
      })
    )
    await waitTick()

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'direct',
        transferId: 't-group-direct'
      })
    )
    await waitTick()

    const msg = [...msgRepo.rows.values()][0]
    expect(msg.conv_id).toBe('group:group-1')
    const row = transferRepo.get('t-group-direct')
    expect(row?.status).toBe('offering')
    expect(JSON.parse(row!.files)).not.toHaveProperty('direct')
    expect(messenger.sent.some((item) => item.env.payload.op === 'accept')).toBe(false)
  })
})

describe('FilesService 发送状态以数据面为准（issue #3）', () => {
  // 让 offer 控制报文的回程 ACK 结果可控（模拟 UDP 丢包后判负）；accept 等其它报文照常成功。
  function makeService(offerAck: boolean | Promise<boolean>) {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-issue3-'))
    tmpDirs.push(dir)
    const imgPath = join(dir, 'shot.png')
    writeFileSync(imgPath, 'small image bytes')

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op === 'offer' ? offerAck : true
    }

    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    return { service, messenger, msgRepo, transferRepo, imgPath }
  }

  it('offer 回程 ACK 丢失、但数据已送达 → 判已发送，不被迟到的失败覆盖', async () => {
    let failOffer!: (v: boolean) => void
    const { service, msgRepo, transferRepo, imgPath } = makeService(
      new Promise<boolean>((resolve) => {
        failOffer = resolve
      })
    )
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    expect(view).not.toBeNull()
    const tid = [...transferRepo.rows.keys()][0]

    // 数据先于 offer 判负通过 TCP 拉走完成
    ;(service as unknown as { server: EventEmitter }).server.emit('served', tid)
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
    expect(transferRepo.get(tid)?.status).toBe('done')

    // offer 回程 ACK 这才超时判负（迟到），不得翻回失败
    failOffer(false)
    await waitTick()
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
    expect(transferRepo.get(tid)?.status).toBe('done')
  })

  it('offer 回程 ACK 丢失、但对方已接受 → 判已发送', async () => {
    let failOffer!: (v: boolean) => void
    const { service, messenger, msgRepo, transferRepo, imgPath } = makeService(
      new Promise<boolean>((resolve) => {
        failOffer = resolve
      })
    )
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    const tid = [...transferRepo.rows.keys()][0]

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'accept',
        transferId: tid
      })
    )
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
    expect(transferRepo.get(tid)?.status).toBe('accepted')

    failOffer(false)
    await waitTick()
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
  })

  it('发送方主动取消后，迟到的 offer 失败与数据面完成都不得覆盖取消终态（决议 #236）', async () => {
    let failOffer!: (v: boolean) => void
    const { service, msgRepo, transferRepo, imgPath } = makeService(
      new Promise<boolean>((resolve) => {
        failOffer = resolve
      })
    )
    const view = await service.offerPaths('node-bob', [imgPath])
    expect(view).not.toBeNull()
    const tid = [...transferRepo.rows.keys()][0]

    await service.cancel(tid)
    expect(msgRepo.get(view!.id)?.status).toBe('canceled')
    expect(transferRepo.get(tid)?.status).toBe('canceled')

    failOffer(false)
    await waitTick()
    expect(msgRepo.get(view!.id)?.status).toBe('canceled')
    expect(transferRepo.get(tid)?.status).toBe('canceled')

    ;(service as unknown as { server: EventEmitter }).server.emit('served', tid)
    expect(msgRepo.get(view!.id)?.status).toBe('canceled')
    expect(transferRepo.get(tid)?.status).toBe('canceled')
  })

  it('offer 失败且无任何送达迹象 → 仍判失败', async () => {
    const { service, msgRepo, transferRepo, imgPath } = makeService(false)
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    await waitTick()
    const tid = [...transferRepo.rows.keys()][0]
    expect(msgRepo.get(view!.id)?.status).toBe('failed')
    expect(transferRepo.get(tid)?.status).toBe('failed')
  })

  it('offer 判负先标失败、数据随后送达 → served 以数据面为准救回已发送/完成（#164 测试盲区）', async () => {
    // #164 三个用例都只测了「served / accept 先、判负后」；这里是逆序：判负抢先删 outgoing，
    // 迟到的 served 仍须把误标的 failed 救回 done/sent（决议 #165 改动②的纵深防御行为）。
    const { service, msgRepo, transferRepo, imgPath } = makeService(false)
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    await waitTick() // offer 判负回调先跑：finish('failed') 删 outgoing、消息标 failed
    const tid = [...transferRepo.rows.keys()][0]
    expect(transferRepo.get(tid)?.status).toBe('failed')
    expect(msgRepo.get(view!.id)?.status).toBe('failed')

    // 接收方其实已收图、TCP 拉走整图并回 finish 帧 → served 迟到送达
    ;(service as unknown as { server: EventEmitter }).server.emit('served', tid)
    expect(transferRepo.get(tid)?.status).toBe('done')
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
  })
})

describe('FilesService 取消可恢复（决议 #211）', () => {
  function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer)
          reject(new Error('timeout'))
        }
      }, 10)
    })
  }

  function makeIncomingService(peerCaps: string[]): {
    service: FilesService
    messenger: FakeMessenger
    transferRepo: FakeTransferRepo
  } {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-retry-'))
    tmpDirs.push(dir)
    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], peerCaps) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-retry',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'a.bin', size: 8 }],
        totalSize: 8,
        fileCount: 1,
        rootName: 'a.bin'
      })
    )
    return { service, messenger, transferRepo }
  }

  it('接收方取消后（对端支持 tw1）可重新下载：上下文保留、再次 accept 成功', async () => {
    const { service, messenger, transferRepo } = makeIncomingService([CAPS.transferWait])
    await waitTick()
    expect(transferRepo.get('t-retry')?.status).toBe('offering')

    await service.cancel('t-retry')
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
    expect(service.transferView('t-retry')?.retryable).toBe(true)
    // 仍会通知发送方（发送方据此把卡片置为已取消，但保留供流授权）
    expect(
      messenger.sent.some((item) => item.env.payload.op === 'cancel')
    ).toBe(true)

    const ok = await service.accept('t-retry')
    expect(ok).toBe(true)
    expect(
      messenger.sent.some((item) => item.env.payload.op === 'accept')
    ).toBe(true)
    // 无真实供流端口，重拉很快失败 → 回到 failed 且上下文仍在，可继续重试
    await waitUntil(() => transferRepo.get('t-retry')?.status === 'failed')
    expect(service.transferView('t-retry')?.retryable).toBe(true)
  })

  it('对端为旧版本（无 tw1）时取消即终态：不提供重新下载', async () => {
    const { service, transferRepo } = makeIncomingService([])
    await waitTick()

    await service.cancel('t-retry')
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
    expect(JSON.parse(transferRepo.get('t-retry')!.files).plans).toBeUndefined()
    expect(service.transferView('t-retry')?.retryable).toBe(false)
    await expect(service.accept('t-retry')).resolves.toBe(false)
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')

    transferRepo.get('t-retry')!.expires_at = Date.now() + 20
    ;(service as unknown as { scheduleExpiry(): void }).scheduleExpiry()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
  })

  it('发送方主动取消是终态：接收方作废上下文，不再展示重新下载', async () => {
    const { service, transferRepo, messenger } = makeIncomingService([CAPS.transferWait])
    await waitTick()
    const events: Array<{ retryable?: boolean }> = []
    service.on('transfer', (view: { retryable?: boolean }) => events.push(view))

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'cancel',
        transferId: 't-retry'
      })
    )
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
    expect(JSON.parse(transferRepo.get('t-retry')!.files).plans).toBeUndefined()
    expect(service.transferView('t-retry')?.retryable).toBe(false)
    expect(events[events.length - 1]?.retryable).toBe(false)
    await expect(service.accept('t-retry')).resolves.toBe(false)
  })

  it('接收方已取消后再收到发送方取消，立即撤销原有重新下载上下文', async () => {
    const { service, transferRepo, messenger } = makeIncomingService([CAPS.transferWait])
    await waitTick()
    await service.cancel('t-retry')
    expect(service.transferView('t-retry')?.retryable).toBe(true)

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'cancel',
        transferId: 't-retry'
      })
    )
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
    expect(service.transferView('t-retry')?.retryable).toBe(false)
    expect(JSON.parse(transferRepo.get('t-retry')!.files).plans).toBeUndefined()
  })

  it('接收后传输中取消（用户反馈复现）：状态回 canceled 且重新下载仍可用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-midpull-'))
    tmpDirs.push(dir)
    // 静默供流端：接受连接与 pull 帧但永不回应，把接收方钉在「传输中」
    const { createServer } = await import('node:net')
    const silent = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    const port = (silent.address() as { port: number }).port

    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.transferWait], port) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo({
        groupId: 'g-1',
        name: '测试群',
        members: ['node-bob', 'node-self'],
        rev: 1,
        updatedBy: 'node-bob',
        updatedTs: 1,
        creatorIp: '127.0.0.1',
        creatorId: 'node-bob',
        ownerId: 'node-bob',
        adminIds: [],
        adminSecretHash: '',
        adminHint: '',
        description: '',
        announce: ''
      }) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    // 完整对齐用户场景：群聊文件 offer（带 groupId/groupRev/msgId）
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-midpull',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'a.bin', size: 8 }],
        totalSize: 8,
        fileCount: 1,
        rootName: 'a.bin',
        msgId: 'm-group-file',
        groupId: 'g-1',
        groupRev: 1
      })
    )
    await waitTick()

    try {
      // 用户点「接收」：进入传输中，拉取悬挂在静默供流端
      await expect(service.accept('t-midpull')).resolves.toBe(true)
      expect(transferRepo.get('t-midpull')?.status).toBe('accepted')
      await waitUntil(
        () =>
          (service as unknown as { incoming: Map<string, { cancelRef: { socket: unknown } }> })
            .incoming.get('t-midpull')?.cancelRef.socket !== null
      )

      // 用户点「取消」
      await service.cancel('t-midpull')
      expect(transferRepo.get('t-midpull')?.status).toBe('canceled')
      expect(service.transferView('t-midpull')?.retryable).toBe(true)

      // 拉取 promise 的失败回调随后落地，不得把状态/可恢复性冲掉
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(transferRepo.get('t-midpull')?.status).toBe('canceled')
      expect(service.transferView('t-midpull')?.retryable).toBe(true)

      // 再点「重新下载」仍可发起
      await expect(service.accept('t-midpull')).resolves.toBe(true)
    } finally {
      silent.close()
    }
  })

  it('发送方收到对端 cancel 保留供流授权：对方重新 accept 后卡片恢复传输中', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-out-cancel-'))
    tmpDirs.push(dir)
    const filePath = join(dir, 'payload.bin')
    writeFileSync(filePath, 'payload-data')

    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.transferWait]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    await service.offerPaths('node-bob', [filePath])
    await waitTick()
    const tid = [...transferRepo.rows.keys()][0]

    // 对端接受后又取消：状态置已取消，但供流授权保留
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'accept', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('accepted')
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'cancel', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('canceled')

    // 对端点「重新下载」再次 accept → 恢复传输中（证明 outgoing 未被作废）
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'accept', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('accepted')

    // 发送方自己取消才是终态：outgoing 作废，对端再 accept 不再恢复
    await service.cancel(tid)
    expect(transferRepo.get(tid)?.status).toBe('canceled')
    expect(transferRepo.manifests.size).toBe(0)
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'accept', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('canceled')
  })
})

describe('FilesService 普通文件 24 小时领取期限（决议 #263）', () => {
  it('普通文件 offer 回程判负后仍在期限内保留供流，迟到 accept 可以恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-offer-failed-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '可能已送达.txt')
    writeFileSync(filePath, 'offer')
    const messenger = new FakeMessenger()
    const send = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId, env) => {
      await send(peerId, env)
      return env.payload.op !== 'offer'
    }
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    await waitTick()
    const transferId = view!.fileRef!.transferId
    expect(transferRepo.get(transferId)?.status).toBe('failed')
    expect(transferRepo.manifests.size).toBe(1)
    expect(
      (service as unknown as { outgoing: Map<string, unknown> }).outgoing.has(transferId)
    ).toBe(true)

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'accept',
        transferId
      })
    )
    expect(transferRepo.get(transferId)?.status).toBe('accepted')
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
    await service.stop()
  })

  it('私聊发送端到期后关闭供流、直接发送与源文件清单', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-expire-out-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '期限测试.txt')
    writeFileSync(filePath, 'deadline')
    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.fileDirect]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    await waitTick()
    const transferId = view!.fileRef!.transferId
    const offer = messenger.sent.find((item) => item.env.payload.op === 'offer')!
      .env.payload as FileCtlOffer
    expect(offer.expiresAt).toBe(transferRepo.get(transferId)?.expires_at)
    expect(offer.expiresAt).toBeGreaterThan(Date.now() + FILE_OFFER_TTL - 1_000)
    expect(transferRepo.manifests.size).toBe(1)

    const deadline = Date.now() + 30
    transferRepo.get(transferId)!.expires_at = deadline
    const outgoing = (
      service as unknown as { outgoing: Map<string, { expiresAt: number }> }
    ).outgoing.get(transferId)!
    outgoing.expiresAt = deadline
    ;(service as unknown as { scheduleExpiry(): void }).scheduleExpiry()

    await waitFor(() => transferRepo.get(transferId)?.status === 'expired')
    expect(service.transferView(transferId)).toMatchObject({
      direction: 'out',
      status: 'expired',
      retryable: false
    })
    await expect(service.requestDirect(transferId)).resolves.toBe(false)
    expect(transferRepo.manifests.size).toBe(0)
    await service.stop()
  })

  it('接收端按发送端剩余时长换算本地截止时间，逾期后不再接收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-expire-in-'))
    tmpDirs.push(dir)
    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    const env = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
      op: 'offer',
      transferId: 't-short-expiry',
      seq: 1,
      total: 1,
      files: [{ fileId: 'f-1', path: 'a.bin', size: 8 }],
      totalSize: 8,
      fileCount: 1,
      rootName: 'a.bin',
      expiresAt: 1
    })
    ;(env.payload as FileCtlOffer).expiresAt = env.ts + 40
    messenger.emit('incoming', env)

    expect(transferRepo.get('t-short-expiry')?.status).toBe('offering')
    expect(transferRepo.get('t-short-expiry')!.expires_at).toBeLessThanOrEqual(Date.now() + 45)
    await waitFor(() => transferRepo.get('t-short-expiry')?.status === 'expired')
    expect(service.transferView('t-short-expiry')).toMatchObject({
      direction: 'in',
      status: 'expired',
      retryable: false
    })
    await expect(service.accept('t-short-expiry')).resolves.toBe(false)
    await service.stop()
  })

  it('旧发送端缺少 expiresAt 时从完整收包起执行本地 24 小时上限', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-legacy-expiry-'))
    tmpDirs.push(dir)
    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    const before = Date.now()
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-legacy-expiry',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'legacy.bin', size: 8 }],
        totalSize: 8,
        fileCount: 1,
        rootName: 'legacy.bin'
      })
    )
    expect(transferRepo.get('t-legacy-expiry')!.expires_at).toBeGreaterThanOrEqual(
      before + FILE_OFFER_TTL
    )
    expect(transferRepo.get('t-legacy-expiry')!.expires_at).toBeLessThanOrEqual(
      Date.now() + FILE_OFFER_TTL
    )
    await service.stop()
  })

  it('重启后在期限内恢复出站供流与入站断点上下文，过期记录安全收口', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-recover-expiry-'))
    tmpDirs.push(dir)
    const filePath = join(dir, 'recover.bin')
    writeFileSync(filePath, 'recover')
    const transferRepo = new FakeTransferRepo()
    const msgRepo = new FakeMsgRepo()
    const convRepo = new FakeConvRepo()
    const firstMessenger = new FakeMessenger()
    const common = {
      selfId: 'node-self',
      registry: new FakeRegistry(['node-bob'], [CAPS.transferWait]) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    }
    const first = new FilesService({
      ...common,
      messenger: firstMessenger as unknown as Messenger
    })
    const sent = await first.offerPaths('node-bob', [filePath])
    await waitTick()
    const outgoingId = sent!.fileRef!.transferId
    firstMessenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'cancel',
        transferId: outgoingId
      })
    )

    firstMessenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-recover-in',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-in', path: 'incoming.bin', size: 7 }],
        totalSize: 7,
        fileCount: 1,
        rootName: 'incoming.bin',
        expiresAt: Date.now() + FILE_OFFER_TTL
      })
    )
    transferRepo.updateStatus('t-recover-in', 'accepted')
    await first.stop()

    const secondMessenger = new FakeMessenger()
    const second = new FilesService({
      ...common,
      messenger: secondMessenger as unknown as Messenger
    })
    expect(
      (second as unknown as { outgoing: Map<string, unknown> }).outgoing.has(outgoingId)
    ).toBe(true)
    expect(transferRepo.get(outgoingId)?.status).toBe('canceled')
    secondMessenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'accept',
        transferId: outgoingId
      })
    )
    expect(transferRepo.get(outgoingId)?.status).toBe('accepted')
    expect(transferRepo.get('t-recover-in')?.status).toBe('failed')
    expect(second.transferView('t-recover-in')?.retryable).toBe(true)

    await second.cancel(outgoingId)
    transferRepo.get(outgoingId)!.expires_at = Date.now() - 1
    transferRepo.get('t-recover-in')!.expires_at = Date.now() - 1
    await second.stop()
    const third = new FilesService({
      ...common,
      messenger: new FakeMessenger() as unknown as Messenger
    })
    expect(transferRepo.get('t-recover-in')?.status).toBe('expired')
    expect(third.transferView('t-recover-in')?.retryable).toBe(false)
    expect(transferRepo.get(outgoingId)?.status).toBe('canceled')
    await third.stop()
  })

  it('截止前已开始的当前接收尝试可越过期限，失败后转为文件过期', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-active-expiry-'))
    tmpDirs.push(dir)
    const { createServer } = await import('node:net')
    const sockets = new Set<import('node:net').Socket>()
    const silent = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    const port = (silent.address() as { port: number }).port
    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.transferWait], port) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    const env = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
      op: 'offer',
      transferId: 't-active-expiry',
      seq: 1,
      total: 1,
      files: [{ fileId: 'f-1', path: 'active.bin', size: 8 }],
      totalSize: 8,
      fileCount: 1,
      rootName: 'active.bin',
      expiresAt: 1
    })
    ;(env.payload as FileCtlOffer).expiresAt = env.ts + 50
    messenger.emit('incoming', env)
    await expect(service.accept('t-active-expiry')).resolves.toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(transferRepo.get('t-active-expiry')?.status).toBe('accepted')

    await service.cancel('t-active-expiry')
    await waitFor(() => transferRepo.get('t-active-expiry')?.status === 'expired')
    expect(service.transferView('t-active-expiry')?.retryable).toBe(false)
    await service.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => silent.close(() => resolve()))
  })
})

describe('FilesService 共享文件柜下载（决议 #275）', () => {
  it('发出的 share-get offer 不进聊天流、不带聊天锚点与领取期限', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-share-out-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, '资料.txt'), 'hello')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const convRepo = new FakeConvRepo()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    await expect(svc.offerSharePaths('node-bob', [join(dir, '资料.txt')])).resolves.toBe(true)

    const offer = messenger.sent[0].env.payload as FileCtlOffer
    expect(offer.op).toBe('offer')
    expect(offer.purpose).toBe('share-get')
    expect(offer.msgId).toBeUndefined()
    expect(offer.expiresAt).toBeUndefined()
    expect(offer.groupId).toBeUndefined()
    expect(msgRepo.rows.size).toBe(0) // 不生成任何聊天消息
    expect(convRepo.bumped).toHaveLength(0)
    const row = [...transferRepo.rows.values()][0]
    expect(row.msg_id.startsWith('share:')).toBe(true)
    expect(row.expires_at).toBe(0)
    await svc.stop()
  })

  it('对方离线时不发 offer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-share-offline-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'a.txt'), 'x')
    const messenger = new FakeMessenger()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry([]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    await expect(svc.offerSharePaths('node-bob', [join(dir, 'a.txt')])).resolves.toBe(false)
    expect(messenger.sent).toHaveLength(0)
    await svc.stop()
  })

  it('未授权的 share-get 一律拒收，不落盘也不入聊天', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-share-unauth-'))
    tmpDirs.push(dir)
    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      authorizeShareDownload: () => null, // 本机没请求过
      bindAddress: '127.0.0.1'
    })

    messenger.emit('incoming', shareGetOffer('node-bob', 'transfer-unauth'))
    await Promise.resolve()

    expect(msgRepo.rows.size).toBe(0)
    expect(transferRepo.rows.size).toBe(0)
    const decline = messenger.sent.at(-1)?.env.payload as FileCtlPayload
    expect(decline.op).toBe('decline')
    await svc.stop()
  })

  it('已授权的 share-get 自动接收到指定目录，仍不进聊天流', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-share-auth-'))
    tmpDirs.push(dir)
    const downloadDir = join(dir, '文件柜-鲍勃')
    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const convRepo = new FakeConvRepo()
    let consumed = 0
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      authorizeShareDownload: () => {
        consumed += 1
        return consumed === 1 ? downloadDir : null // 一次性
      },
      bindAddress: '127.0.0.1'
    })

    messenger.emit('incoming', shareGetOffer('node-bob', 'transfer-auth'))
    await Promise.resolve()
    await Promise.resolve()

    expect(msgRepo.rows.size).toBe(0) // 不生成聊天消息
    expect(convRepo.bumped).toHaveLength(0)
    const row = transferRepo.rows.get('transfer-auth')
    expect(row?.direction).toBe('in')
    expect(row?.expires_at).toBe(0)
    expect(JSON.parse(row!.files).purpose).toBe('share-get')
    expect(JSON.parse(row!.files).savedPath.startsWith(downloadDir)).toBe(true)
    expect(messenger.sent.some((m) => (m.env.payload as FileCtlPayload).op === 'accept')).toBe(true)
    await svc.stop()
  })

})

describe('FilesService 共享文件柜上传（决议 #272/#274）', () => {
  function makeSvc(options: {
    dir: string
    authorizeShareUpload?: (peerId: string, totalSize: number) => string | null
    caps?: string[]
  }): {
    svc: FilesService
    messenger: FakeMessenger
    msgRepo: FakeMsgRepo
    transferRepo: FakeTransferRepo
    convRepo: FakeConvRepo
  } {
    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const convRepo = new FakeConvRepo()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(
        ['node-bob'],
        options.caps ?? [CAPS.fileCabinet]
      ) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => options.dir,
      getImagesDir: () => options.dir,
      peerDisplayName: () => '鲍勃',
      ...(options.authorizeShareUpload ? { authorizeShareUpload: options.authorizeShareUpload } : {}),
      bindAddress: '127.0.0.1'
    })
    return { svc, messenger, msgRepo, transferRepo, convRepo }
  }

  it('上传 offer 带 share-put，不进聊天流也不套领取期限', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-put-send-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, '周报.docx'), 'x')
    const { svc, messenger, msgRepo, transferRepo } = makeSvc({ dir })

    await expect(svc.offerSharePut('node-bob', [join(dir, '周报.docx')])).resolves.toBe(true)
    const offer = messenger.sent[0].env.payload as FileCtlOffer
    expect(offer.purpose).toBe('share-put')
    expect(offer.msgId).toBeUndefined()
    expect(offer.expiresAt).toBeUndefined()
    expect(msgRepo.rows.size).toBe(0)
    const row = [...transferRepo.rows.values()][0]
    expect(row.direction).toBe('out')
    expect(row.expires_at).toBe(0)
    await svc.stop()
  })

  it('对端未声明 shr1 时不发上传 offer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-put-nocap-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'a.txt'), 'x')
    const { svc, messenger } = makeSvc({ dir, caps: [] })
    await expect(svc.offerSharePut('node-bob', [join(dir, 'a.txt')])).resolves.toBe(false)
    expect(messenger.sent).toHaveLength(0)
    await svc.stop()
  })

  it('没有写权限时拒收上传，不落盘也不入聊天', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-put-noperm-'))
    tmpDirs.push(dir)
    const { svc, messenger, msgRepo, transferRepo } = makeSvc({
      dir,
      authorizeShareUpload: () => null
    })

    messenger.emit('incoming', sharePutOffer('node-bob', 'transfer-noperm'))
    await Promise.resolve()

    expect(msgRepo.rows.size).toBe(0)
    expect(transferRepo.rows.size).toBe(0)
    expect((messenger.sent.at(-1)?.env.payload as FileCtlPayload).op).toBe('decline')
    await svc.stop()
  })

  it('有写权限时自动接收到指定子目录，落点由本机算、上传方指定不了', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-put-ok-'))
    tmpDirs.push(dir)
    const landing = join(dir, '鲍勃')
    const sizes: number[] = []
    const { svc, messenger, msgRepo, transferRepo } = makeSvc({
      dir,
      authorizeShareUpload: (_peerId, totalSize) => {
        sizes.push(totalSize)
        return landing
      }
    })

    messenger.emit('incoming', sharePutOffer('node-bob', 'transfer-put-ok'))
    await Promise.resolve()

    expect(sizes).toEqual([5]) // 复核用的是清单实算大小，不是发送方声明值
    expect(msgRepo.rows.size).toBe(0) // 落盘完成前不产生任何提示
    const row = transferRepo.rows.get('transfer-put-ok')
    expect(row?.direction).toBe('in')
    expect(JSON.parse(row!.files).purpose).toBe('share-put')
    expect(JSON.parse(row!.files).savedPath.startsWith(landing)).toBe(true)
    await svc.stop()
  })

  it('上传完成后在私聊插一条汇总系统提示，计未读且可点开目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-put-note-'))
    tmpDirs.push(dir)
    const { svc, messenger, msgRepo, convRepo } = makeSvc({
      dir,
      authorizeShareUpload: () => join(dir, '鲍勃')
    })
    const messages: MessageView[] = []
    svc.on('message', (m: MessageView) => messages.push(m))

    messenger.emit('incoming', sharePutOffer('node-bob', 'transfer-note'))
    await Promise.resolve()
    ;(svc as unknown as { finish(id: string, status: string): void }).finish(
      'transfer-note',
      'done'
    )

    expect(msgRepo.rows.size).toBe(1)
    const row = [...msgRepo.rows.values()][0]
    expect(row.kind).toBe('system')
    expect(row.content).toBe('鲍勃 上传了 1 个文件到你的文件柜')
    expect(row.conv_id).toBe('single:node-bob')
    expect(JSON.parse(row.file_ref!).transferId).toBe('transfer-note')
    expect(messages).toHaveLength(1)
    expect(convRepo.bumped.at(-1)?.convId).toBe('single:node-bob')

    // 幂等：重复收口不再插第二条
    ;(svc as unknown as { finish(id: string, status: string): void }).finish(
      'transfer-note',
      'done'
    )
    expect(msgRepo.rows.size).toBe(1)
    await svc.stop()
  })

  it('下载完成不产生系统提示（只有上传才提示，决议 #274）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-get-note-'))
    tmpDirs.push(dir)
    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      authorizeShareDownload: () => dir,
      bindAddress: '127.0.0.1'
    })

    messenger.emit('incoming', shareGetOffer('node-bob', 'transfer-get-note'))
    await Promise.resolve()
    ;(svc as unknown as { finish(id: string, status: string): void }).finish(
      'transfer-get-note',
      'done'
    )
    expect(msgRepo.rows.size).toBe(0)
    await svc.stop()
  })
})

describe('最近有人放进来（决议 #283）', () => {
  function makeService(): {
    svc: FilesService
    msgRepo: FakeMsgRepo
    transferRepo: FakeTransferRepo
  } {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-share-recent-'))
    tmpDirs.push(dir)
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: new FakeMessenger() as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      getUpdateDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    return { svc, msgRepo, transferRepo }
  }

  it('只汇总别人上传到我柜子的已完成记录，文件数取自那条系统提示', () => {
    const { svc, msgRepo, transferRepo } = makeService()
    transferRepo.insert({
      transferId: 't-put',
      msgId: 'share:t-put',
      peerId: 'node-bob',
      direction: 'in',
      files: JSON.stringify({ name: '设计稿', purpose: 'share-put' }),
      status: 'done',
      total: 2048,
      ts: 3000
    })
    msgRepo.insert({
      id: 'share:t-put:uploaded',
      convId: 'c1',
      senderId: 'node-bob',
      isMine: false,
      kind: 'system',
      content: 'Bob 上传了 3 个文件到你的文件柜',
      fileRef: JSON.stringify({ transferId: 't-put', name: '文件柜', size: 0, count: 3, dir: true }),
      ts: 3000,
      status: 'sent'
    })
    // 我从对方柜子里下载的（share-get）与普通文件都不该出现在这里
    transferRepo.insert({
      transferId: 't-get',
      msgId: 'share:t-get',
      peerId: 'node-bob',
      direction: 'in',
      files: JSON.stringify({ name: '方案.pdf', purpose: 'share-get' }),
      status: 'done',
      total: 999,
      ts: 4000
    })

    expect(svc.listShareUploads(10)).toEqual([
      { transferId: 't-put', peerId: 'node-bob', fileCount: 3, totalSize: 2048, ts: 3000 }
    ])
  })

  it('系统提示缺失时文件数记 0，不因此丢掉这条记录', () => {
    const { svc, transferRepo } = makeService()
    transferRepo.insert({
      transferId: 't-orphan',
      msgId: 'share:t-orphan',
      peerId: 'node-bob',
      direction: 'in',
      files: JSON.stringify({ name: '归档', purpose: 'share-put' }),
      status: 'done',
      total: 10,
      ts: 1000
    })

    expect(svc.listShareUploads(10)).toEqual([
      { transferId: 't-orphan', peerId: 'node-bob', fileCount: 0, totalSize: 10, ts: 1000 }
    ])
  })
})

function sharePutOffer(from: string, transferId: string): Envelope<FileCtlOffer> {
  const env = shareGetOffer(from, transferId)
  env.payload.purpose = 'share-put'
  return env
}

function shareGetOffer(from: string, transferId: string): Envelope<FileCtlOffer> {
  return makeEnvelope<FileCtlOffer>(MSG_TYPES.fileCtl, from, {
    op: 'offer',
    transferId,
    seq: 1,
    total: 1,
    files: [{ fileId: 'f1', path: '资料.txt', size: 5 }],
    totalSize: 5,
    fileCount: 1,
    rootName: '资料.txt',
    purpose: 'share-get'
  })
}
