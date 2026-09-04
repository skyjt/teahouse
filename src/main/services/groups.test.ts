import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { MSG_TYPES, LIMITS, type Envelope, type GroupMeta, type GroupPayload, type MsgPayload } from '../../shared/protocol'
import type { ConversationView, GroupPatch } from '../../shared/ipc'
import { decode, encode, makeEnvelope } from '../net/codec'
import type { Messenger, SendOutcome } from '../net/messenger'
import type { ConvRepo } from '../store/conv-repo'
import type { GroupRepo } from '../store/group-repo'
import type { MsgRepo } from '../store/msg-repo'
import { GroupsService } from './groups'

class FakeMessenger extends EventEmitter {
  sent: Array<{ peerId: string; env: Envelope }> = []

  async sendUserMessage(peerId: string, env: Envelope): Promise<SendOutcome> {
    this.sent.push({ peerId, env })
    return 'sent'
  }

  async sendReliable(peerId: string, env: Envelope): Promise<boolean> {
    this.sent.push({ peerId, env })
    return true
  }
}

class FakeConvRepo {
  bump(): void {}
  incUnread(): void {}
  ensureGroup(groupId: string): string {
    return `group:${groupId}`
  }

  list(): ConversationView[] {
    return []
  }
}

class FakeGroupRepo {
  readonly rows = new Map<string, GroupMeta>()

  save(meta: GroupMeta): void {
    this.rows.set(meta.groupId, meta)
  }

  get(groupId: string): GroupMeta | undefined {
    return this.rows.get(groupId)
  }

  list(): GroupMeta[] {
    return [...this.rows.values()]
  }

  applyRemote(meta: GroupMeta): boolean {
    const local = this.rows.get(meta.groupId)
    if (
      local &&
      (meta.rev < local.rev || (meta.rev === local.rev && meta.updatedTs <= local.updatedTs))
    ) {
      return false
    }
    this.save(meta)
    return true
  }
}

class FakePkMsgRepo {
  rows = new Map<string, {
    id: string
    conv_id: string
    sender_id: string
    is_mine: number
    kind: string
    content: string
    file_ref: string | null
    ts: number
    seq: number
    status: string
  }>()

  insert(m: {
    id: string
    convId: string
    senderId: string
    isMine: boolean
    kind: string
    content: string
    fileRef?: string
    ts: number
    status: string
  }): boolean {
    this.rows.set(m.id, {
      id: m.id,
      conv_id: m.convId,
      sender_id: m.senderId,
      is_mine: m.isMine ? 1 : 0,
      kind: m.kind,
      content: m.content,
      file_ref: m.fileRef ?? null,
      ts: m.ts,
      seq: this.rows.size + 1,
      status: m.status
    })
    return true
  }

  get(id: string) {
    return this.rows.get(id)
  }
}

function service(opts: {
  selfIp: string
  selfId?: string
  groupRepo?: FakeGroupRepo
  messenger?: FakeMessenger
}): GroupsService {
  return new GroupsService({
    selfId: opts.selfId ?? 'node-self',
    messenger: (opts.messenger ?? new FakeMessenger()) as unknown as Messenger,
    convRepo: new FakeConvRepo() as unknown as ConvRepo,
    msgRepo: { insert: () => false, get: () => undefined } as unknown as MsgRepo,
    groupRepo: (opts.groupRepo ?? new FakeGroupRepo()) as unknown as GroupRepo,
    getSelfIp: () => opts.selfIp
  })
}

describe('GroupsService 群管理权限', () => {
  it('同一同步批次内合并会话列表事件', async () => {
    const groups = service({ selfIp: '10.0.0.1' })
    const events: ConversationView[][] = []
    groups.on('convs', (convs: ConversationView[]) => events.push(convs))

    groups.createGroup('一组', ['node-a'])
    groups.createGroup('二组', ['node-b'])

    expect(events).toHaveLength(0)
    await Promise.resolve()
    expect(events).toHaveLength(1)
  })

  it('无密码组允许创建者直接管理，其他成员不能管理', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('项目组', ['node-bob'])
    expect(group?.creatorIp).toBe('10.0.0.1')
    expect(repo.get(group!.groupId)?.creatorId).toBe('node-self')
    expect(group?.hasAdminPassword).toBe(false)
    expect(group?.canManage).toBe(true)

    expect(owner.updateGroup(group!.groupId, { kind: 'rename', name: '项目组-改名' })?.name).toBe('项目组-改名')

    const movedIp = service({ selfIp: '10.0.0.2', groupRepo: repo })
    expect(movedIp.updateGroup(group!.groupId, { kind: 'rename', name: '换 IP 后仍可改名' })?.name).toBe(
      '换 IP 后仍可改名'
    )

    const otherMember = service({ selfId: 'node-bob', selfIp: '10.0.0.2', groupRepo: repo })
    expect(otherMember.updateGroup(group!.groupId, { kind: 'rename', name: '不应改名' })).toBeNull()
    expect(repo.get(group!.groupId)?.name).toBe('换 IP 后仍可改名')
  })

  it('有密码组的群主免密码，普通成员需输入正确密码，且不保存明文', () => {
    const repo = new FakeGroupRepo()
    const groups = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = groups.createGroup('加密管理组', ['node-bob'], 's3cret', '项目代号')
    const meta = repo.get(group!.groupId)

    expect(group?.hasAdminPassword).toBe(true)
    expect(group?.adminHint).toBe('项目代号')
    expect(group?.canManage).toBe(true)
    expect(meta?.adminSecretHash).toMatch(/^[a-f0-9]{64}$/)
    expect(meta?.adminSecretHash.includes('s3cret')).toBe(false)
    expect(meta?.adminHint).toBe('项目代号')

    expect(groups.updateGroup(group!.groupId, { kind: 'rename', name: '群主免密码' })?.name).toBe('群主免密码')

    const member = service({ selfId: 'node-bob', selfIp: '10.0.0.2', groupRepo: repo })
    expect(member.updateGroup(group!.groupId, { kind: 'rename', name: '错误密码', adminPassword: 'bad' })).toBeNull()
    expect(member.updateGroup(group!.groupId, { kind: 'rename', name: '正确密码', adminPassword: 's3cret' })?.name).toBe(
      '正确密码'
    )
  })

  it('群主可任免管理员，管理员可改名并只能移出普通成员', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('项目组', ['node-admin', 'node-member', 'node-other'])!

    const promoted = owner.updateGroup(group.groupId, {
      kind: 'set-admin',
      memberId: 'node-admin',
      enabled: true
    })
    expect(promoted).toMatchObject({ ownerId: 'node-self', adminIds: ['node-admin'] })

    const admin = service({ selfId: 'node-admin', selfIp: '10.0.0.2', groupRepo: repo })
    expect(admin.get(group.groupId)?.selfRole).toBe('admin')
    expect(admin.get(group.groupId)?.canManage).toBe(true)
    expect(admin.updateGroup(group.groupId, { kind: 'rename', name: '管理员改名' })?.name).toBe(
      '管理员改名'
    )
    expect(
      admin.updateGroup(group.groupId, { kind: 'remove', memberIds: ['node-member'] })?.members
    ).not.toContain('node-member')
    expect(admin.updateGroup(group.groupId, { kind: 'remove', memberIds: ['node-self'] })).toBeNull()
    expect(admin.updateGroup(group.groupId, { kind: 'set-admin', memberId: 'node-other', enabled: true })).toBeNull()

    const ownerAfter = service({ selfIp: '10.0.0.1', groupRepo: repo })
    expect(
      ownerAfter.updateGroup(group.groupId, { kind: 'remove', memberIds: ['node-admin'] })?.members
    ).not.toContain('node-admin')
    expect(repo.get(group.groupId)?.adminIds).toEqual([])
  })

  it('普通成员可直接邀请，管理密码持有者仍不能移出群主或管理员', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup(
      '密码组',
      ['node-admin', 'node-member', 'node-other'],
      's3cret'
    )!
    owner.updateGroup(group.groupId, { kind: 'set-admin', memberId: 'node-admin', enabled: true })

    const member = service({ selfId: 'node-member', selfIp: '10.0.0.3', groupRepo: repo })
    expect(
      member.updateGroup(group.groupId, { kind: 'invite', memberIds: ['node-new'] })?.members
    ).toContain('node-new')
    expect(member.updateGroup(group.groupId, { kind: 'rename', name: '无密码改名' })).toBeNull()
    expect(
      member.updateGroup(group.groupId, {
        kind: 'rename',
        name: '密码成员改名',
        adminPassword: 's3cret'
      })?.name
    ).toBe('密码成员改名')
    expect(
      member.updateGroup(group.groupId, {
        kind: 'remove',
        memberIds: ['node-other'],
        adminPassword: 's3cret'
      })?.members
    ).not.toContain('node-other')
    expect(
      member.updateGroup(group.groupId, {
        kind: 'remove',
        memberIds: ['node-admin'],
        adminPassword: 's3cret'
      })
    ).toBeNull()
    expect(
      member.updateGroup(group.groupId, {
        kind: 'remove',
        memberIds: ['node-self'],
        adminPassword: 's3cret'
      })
    ).toBeNull()
    expect(
      member.updateGroup(group.groupId, { kind: 'set-admin', memberId: 'node-new', enabled: true })
    ).toBeNull()
  })

  it('群头像沿用改名权限，单次设置只递增一次版本', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('头像组', ['node-admin', 'node-member'], 's3cret')!
    owner.updateGroup(group.groupId, {
      kind: 'set-admin',
      memberId: 'node-admin',
      enabled: true
    })
    const hashA = 'a'.repeat(64)
    const hashB = 'b'.repeat(64)
    const before = repo.get(group.groupId)!.rev

    const updated = owner.updateGroup(group.groupId, { kind: 'set-avatar', avatarHash: hashA })
    expect(updated).toMatchObject({ avatarHash: hashA, rev: before + 1 })
    expect(owner.updateGroup(group.groupId, { kind: 'set-avatar', avatarHash: hashA })?.rev).toBe(
      before + 1
    )

    const admin = service({ selfId: 'node-admin', selfIp: '10.0.0.2', groupRepo: repo })
    expect(admin.updateGroup(group.groupId, { kind: 'set-avatar', avatarHash: hashB })?.avatarHash).toBe(
      hashB
    )

    const member = service({ selfId: 'node-member', selfIp: '10.0.0.3', groupRepo: repo })
    expect(member.updateGroup(group.groupId, { kind: 'set-avatar', avatarHash: hashA })).toBeNull()
    expect(
      member.updateGroup(group.groupId, {
        kind: 'set-avatar',
        avatarHash: hashA,
        adminPassword: 's3cret'
      })?.avatarHash
    ).toBe(hashA)
    expect(
      member.updateGroup(group.groupId, {
        kind: 'set-avatar',
        avatarHash: '',
        adminPassword: 's3cret'
      })?.avatarHash
    ).toBe('')
  })

  it('拒绝夹带其他操作字段的混合变更', () => {
    const repo = new FakeGroupRepo()
    const member = service({ selfId: 'node-member', selfIp: '10.0.0.2', groupRepo: repo })
    repo.save({
      groupId: 'g-mixed',
      name: '原群名',
      members: ['node-owner', 'node-member'],
      rev: 1,
      updatedBy: 'node-owner',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-owner',
      ownerId: 'node-owner',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    })
    const mixed = {
      kind: 'invite',
      memberIds: ['node-new'],
      name: '夹带改名'
    } as unknown as GroupPatch
    expect(member.updateGroup('g-mixed', mixed)).toBeNull()
    expect(repo.get('g-mixed')).toMatchObject({ name: '原群名', members: ['node-owner', 'node-member'] })
  })

  it('群主退出优先按成员顺序转让给管理员，并清理离群管理员', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('转让组', ['node-a', 'node-b', 'node-c'])!
    owner.updateGroup(group.groupId, { kind: 'set-admin', memberId: 'node-b', enabled: true })
    owner.updateGroup(group.groupId, { kind: 'set-admin', memberId: 'node-a', enabled: true })

    owner.leaveGroup(group.groupId)
    expect(repo.get(group.groupId)).toMatchObject({
      members: ['node-a', 'node-b', 'node-c'],
      ownerId: 'node-a',
      adminIds: ['node-b']
    })

    const admin = service({ selfId: 'node-b', selfIp: '10.0.0.2', groupRepo: repo })
    admin.leaveGroup(group.groupId)
    expect(repo.get(group.groupId)?.adminIds).toEqual([])
  })

  it('群主退出且没有管理员时转让给首位剩余成员', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('普通组', ['node-a', 'node-b'])!

    owner.leaveGroup(group.groupId)

    expect(repo.get(group.groupId)).toMatchObject({
      members: ['node-a', 'node-b'],
      ownerId: 'node-a',
      adminIds: []
    })
  })

  it('建群支持 150 个成员并保留创建者', () => {
    const repo = new FakeGroupRepo()
    const groups = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const members = Array.from({ length: 150 }, (_item, i) => `node-member-${i}`)

    const group = groups.createGroup('大讨论组', members)

    expect(group?.members).toHaveLength(151)
    expect(group?.members).toContain('node-self')
    expect(group?.members).toEqual(['node-self', ...members])
  })

  it('远端 group.info 按角色校验；成员自行退组放行', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-1',
      name: '项目组',
      members: ['node-self', 'node-bob'],
      rev: 1,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-self',
      ownerId: 'node-self',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    const unauthorized = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-bob', {
      op: 'info',
      group: { ...local, name: '不应采纳', rev: 2, updatedBy: 'node-bob', updatedTs: 2000 }
    })
    messenger.emit('incoming', unauthorized, { address: '10.0.0.2' })
    expect(repo.get('g-1')?.name).toBe('项目组')

    const leave = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-bob', {
      op: 'info',
      group: {
        ...local,
        members: ['node-self'],
        rev: 2,
        updatedBy: 'node-bob',
        updatedTs: 2000
      }
    })
    messenger.emit('incoming', leave, { address: '10.0.0.2' })
    expect(repo.get('g-1')?.members).toEqual(['node-self'])
  })

  it('远端 group.info 源 IP 不匹配时，创建者 nodeId 匹配仍可改名', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-b', selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-vm',
      name: '项目组',
      members: ['node-a', 'node-b'],
      rev: 1,
      updatedBy: 'node-a',
      updatedTs: 1000,
      creatorIp: '192.168.1.10',
      creatorId: 'node-a',
      ownerId: 'node-a',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    const rename = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-a', {
      op: 'info',
      group: { ...local, name: '新群名', rev: 2, updatedBy: 'node-a', updatedTs: 2000 }
    })
    messenger.emit('incoming', rename, { address: '172.16.56.1' })
    expect(repo.get('g-vm')?.name).toBe('新群名')
  })

  it('远端管理员可改名，普通成员可邀请', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-self', selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-roles',
      name: '项目组',
      members: ['node-owner', 'node-admin', 'node-member', 'node-self'],
      rev: 1,
      updatedBy: 'node-owner',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-owner',
      ownerId: 'node-owner',
      adminIds: ['node-admin'],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    const adminRename = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-admin', {
      op: 'info',
      group: { ...local, name: '管理员改名', rev: 2, updatedBy: 'node-admin', updatedTs: 2000 }
    })
    messenger.emit('incoming', adminRename, { address: '10.0.0.2' })
    expect(repo.get(local.groupId)?.name).toBe('管理员改名')

    const afterRename = repo.get(local.groupId)!
    const memberInvite = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-member', {
      op: 'info',
      group: {
        ...afterRename,
        members: [...afterRename.members, 'node-new'],
        rev: 3,
        updatedBy: 'node-member',
        updatedTs: 3000
      }
    })
    messenger.emit('incoming', memberInvite, { address: '10.0.0.3' })
    expect(repo.get(local.groupId)?.members).toContain('node-new')
  })

  it('远端群头像只接受群主或管理员的独立变更', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-self', selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-avatar',
      name: '头像组',
      members: ['node-owner', 'node-admin', 'node-member', 'node-self'],
      rev: 1,
      updatedBy: 'node-owner',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-owner',
      ownerId: 'node-owner',
      adminIds: ['node-admin'],
      avatarHash: '',
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    messenger.emit(
      'incoming',
      makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-member', {
        op: 'info',
        group: {
          ...local,
          avatarHash: 'a'.repeat(64),
          rev: 2,
          updatedBy: 'node-member',
          updatedTs: 2000
        }
      }),
      { address: '10.0.0.3' }
    )
    expect(repo.get(local.groupId)?.avatarHash).toBe('')

    messenger.emit(
      'incoming',
      makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-admin', {
        op: 'info',
        group: {
          ...local,
          avatarHash: 'b'.repeat(64),
          rev: 2,
          updatedBy: 'node-admin',
          updatedTs: 2100
        }
      }),
      { address: '10.0.0.2' }
    )
    expect(repo.get(local.groupId)?.avatarHash).toBe('b'.repeat(64))

    const current = repo.get(local.groupId)!
    messenger.emit(
      'incoming',
      makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-admin', {
        op: 'info',
        group: {
          ...current,
          name: '夹带改名',
          avatarHash: 'c'.repeat(64),
          rev: 3,
          updatedBy: 'node-admin',
          updatedTs: 3000
        }
      }),
      { address: '10.0.0.2' }
    )
    expect(repo.get(local.groupId)).toMatchObject({ name: '头像组', avatarHash: 'b'.repeat(64), rev: 2 })
  })

  it('旧报文缺角色字段时保留本地角色，夹带邀请和改名的入站变更拒绝', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-self', selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-legacy-role',
      name: '项目组',
      members: ['node-owner', 'node-admin', 'node-member', 'node-self'],
      rev: 1,
      updatedBy: 'node-owner',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-owner',
      ownerId: 'node-owner',
      adminIds: ['node-admin'],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    const legacyRenameGroup = {
      ...local,
      name: '旧报文改名',
      rev: 2,
      updatedBy: 'node-admin',
      updatedTs: 2000,
      ownerId: undefined,
      adminIds: undefined
    } as unknown as GroupMeta
    messenger.emit(
      'incoming',
      makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-admin', { op: 'info', group: legacyRenameGroup }),
      { address: '10.0.0.2' }
    )
    expect(repo.get(local.groupId)).toMatchObject({
      name: '旧报文改名',
      ownerId: 'node-owner',
      adminIds: ['node-admin']
    })

    const current = repo.get(local.groupId)!
    const mixed = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-member', {
      op: 'info',
      group: {
        ...current,
        name: '夹带改名',
        members: [...current.members, 'node-new'],
        rev: 3,
        updatedBy: 'node-member',
        updatedTs: 3000
      }
    })
    messenger.emit('incoming', mixed, { address: '10.0.0.3' })
    expect(repo.get(local.groupId)).toMatchObject({ name: '旧报文改名', rev: 2 })
  })

  it('入站管理员任免只接受群主，群主退出必须遵循确定性转让', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-self', selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-inbound-roles',
      name: '项目组',
      members: ['node-owner', 'node-a', 'node-b', 'node-self'],
      rev: 1,
      updatedBy: 'node-owner',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-owner',
      ownerId: 'node-owner',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    const unauthorizedAdmin = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-b', {
      op: 'info',
      group: {
        ...local,
        adminIds: ['node-a'],
        rev: 2,
        updatedBy: 'node-b',
        updatedTs: 2000
      }
    })
    messenger.emit('incoming', unauthorizedAdmin, { address: '10.0.0.3' })
    expect(repo.get(local.groupId)?.adminIds).toEqual([])

    const ownerPromotes = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-owner', {
      op: 'info',
      group: {
        ...local,
        adminIds: ['node-a'],
        rev: 2,
        updatedBy: 'node-owner',
        updatedTs: 2100
      }
    })
    messenger.emit('incoming', ownerPromotes, { address: '10.0.0.1' })
    expect(repo.get(local.groupId)?.adminIds).toEqual(['node-a'])

    const afterPromote = repo.get(local.groupId)!
    const invalidTransfer = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-owner', {
      op: 'info',
      group: {
        ...afterPromote,
        members: ['node-a', 'node-b', 'node-self'],
        ownerId: 'node-b',
        rev: 3,
        updatedBy: 'node-owner',
        updatedTs: 3000
      }
    })
    messenger.emit('incoming', invalidTransfer, { address: '10.0.0.1' })
    expect(repo.get(local.groupId)?.ownerId).toBe('node-owner')

    const validTransfer = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-owner', {
      op: 'info',
      group: {
        ...afterPromote,
        members: ['node-a', 'node-b', 'node-self'],
        ownerId: 'node-a',
        adminIds: [],
        rev: 3,
        updatedBy: 'node-owner',
        updatedTs: 3100
      }
    })
    messenger.emit('incoming', validTransfer, { address: '10.0.0.1' })
    expect(repo.get(local.groupId)).toMatchObject({ ownerId: 'node-a', adminIds: [] })
  })
})

describe('GroupsService PK', () => {
  it('群 PK 只发给当前在线成员', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    const msgRepo = new FakePkMsgRepo()
    const groups = new GroupsService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: repo as unknown as GroupRepo,
      getSelfIp: () => '10.0.0.1',
      isOnline: (id) => id === 'node-a'
    })
    const group = groups.createGroup('项目组', ['node-a', 'node-b'])

    const view = groups.sendPk(group!.groupId, 'rps')
    expect(view).toMatchObject({ kind: 'pk', text: '[PK] 猜拳', status: 'sent' })
    const pkSends = messenger.sent.filter((item) => item.env.type === 'msg')
    expect(pkSends.map((item) => item.peerId)).toEqual(['node-a'])
    expect(pkSends[0].env.payload).toMatchObject({ kind: 'pk', game: 'rps', groupId: group!.groupId })
  })
})

class FakeMsgRepo {
  inserted: Array<{
    id: string
    conv_id: string
    sender_id: string
    is_mine: number
    kind: string
    content: string
    file_ref: string | null
    ts: number
    seq: number
    status: string
    reply_to?: string | null
    // Test-friendly aliases
    convId?: string
    replyTo?: string
  }> = []
  insert(m: { id: string; kind: string; content: string; convId: string; replyTo?: string }): boolean {
    if (this.inserted.some((x) => x.id === m.id)) return false
    const row = {
      id: m.id,
      conv_id: m.convId,
      sender_id: '',
      is_mine: 0,
      kind: m.kind,
      content: m.content,
      file_ref: null,
      ts: Date.now(),
      seq: this.inserted.length + 1,
      status: 'sent',
      reply_to: m.replyTo ?? null,
      // aliases for test assertions
      convId: m.convId,
      replyTo: m.replyTo
    }
    this.inserted.push(row)
    return true
  }
  get(id: string) {
    return this.inserted.find((x) => x.id === id)
  }
}

function groupInfos(messenger: FakeMessenger): Envelope[] {
  return messenger.sent
    .filter((s) => s.env.type === 'group' && (s.env.payload as GroupPayload).op === 'info')
    .map((s) => s.env)
}

describe('GroupsService 群变更系统提示（决议 #87/#241/#242/#243）', () => {
  function member(
    selfId: string,
    selfIp: string,
    displayName?: string | ((nodeId: string) => string)
  ) {
    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const groupRepo = new FakeGroupRepo()
    const svc = new GroupsService({
      selfId,
      messenger: messenger as unknown as Messenger,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: groupRepo as unknown as GroupRepo,
      getSelfIp: () => selfIp,
      resolveDisplayName:
        typeof displayName === 'function'
          ? displayName
          : displayName
            ? () => displayName
            : undefined
    })
    return { svc, messenger, msgRepo, groupRepo }
  }

  it('改名人自己看到“你把群名…”系统提示', () => {
    const a = member('node-a', '10.0.0.1')
    const g = a.svc.createGroup('茶水间', ['node-b'])!
    a.svc.updateGroup(g.groupId, { kind: 'rename', name: '午餐群' })
    const sys = a.msgRepo.inserted.filter((m) => m.kind === 'system')
    expect(sys).toHaveLength(1)
    expect(sys[0].content).toBe('你把群名「茶水间」改成了「午餐群」')
    expect(sys[0].convId).toBe(`group:${g.groupId}`)
  })

  it('远端成员收到改名 info 后本地生成系统提示并幂等', () => {
    const a = member('node-a', '10.0.0.1')
    const g = a.svc.createGroup('茶水间', ['node-b'])!
    a.svc.updateGroup(g.groupId, { kind: 'rename', name: '午餐群' })

    const b = member('node-b', '10.0.0.2', '阿明')
    const infos = groupInfos(a.messenger)
    // 依次投递建群(rev1)与改名(rev2)：首条让 B 认识群，第二条触发改名提示
    for (const env of infos) {
      b.messenger.emit('incoming', env, { address: '10.0.0.1' })
    }
    const sysB = b.msgRepo.inserted.filter((m) => m.kind === 'system')
    expect(sysB).toHaveLength(1)
    expect(sysB[0].content).toBe('阿明把群名「茶水间」改成了「午餐群」')

    // 幂等：重复投递改名 info 不再追加系统提示
    const renameInfo = infos[infos.length - 1]
    b.messenger.emit('incoming', renameInfo, { address: '10.0.0.1' })
    expect(b.msgRepo.inserted.filter((m) => m.kind === 'system')).toHaveLength(1)
  })

  it('首次入群（本地无该群）不误报改名提示', () => {
    const a = member('node-a', '10.0.0.1')
    a.svc.createGroup('研发组', ['node-b'])!
    const b = member('node-b', '10.0.0.2', '阿明')
    // 只投递建群 info（rev1）：B 首次认识该群，不应产生改名系统提示
    for (const env of groupInfos(a.messenger)) {
      b.messenger.emit('incoming', env, { address: '10.0.0.1' })
    }
    expect(b.msgRepo.inserted.filter((m) => m.kind === 'system')).toHaveLength(0)
  })

  it('邀请与任免管理员生成可去重的系统提示', () => {
    const names: Record<string, string> = {
      'node-b': '阿明',
      'node-c': '小陈',
      'node-d': '小杜'
    }
    const a = member('node-a', '10.0.0.1', (nodeId) => names[nodeId] ?? '联系人')
    const g = a.svc.createGroup('研发组', ['node-b'])!
    const revBeforeInvite = g.rev

    const invited = a.svc.updateGroup(g.groupId, {
      kind: 'invite',
      memberIds: ['node-c', 'node-d']
    })
    expect(invited?.members).toEqual(['node-a', 'node-b', 'node-c', 'node-d'])
    expect(invited?.rev).toBe(revBeforeInvite + 1)
    a.svc.updateGroup(g.groupId, { kind: 'set-admin', memberId: 'node-b', enabled: true })
    a.svc.updateGroup(g.groupId, { kind: 'set-admin', memberId: 'node-b', enabled: false })
    a.svc.updateGroup(g.groupId, { kind: 'remove', memberIds: ['node-b'] })

    expect(a.msgRepo.inserted.filter((m) => m.kind === 'system').map((m) => m.content)).toEqual([
      '你邀请小陈、小杜加入群聊',
      '你将阿明设为管理员',
      '你取消了阿明的管理员身份',
      '你将阿明移出群聊'
    ])
  })

  it('设置和恢复群头像分别生成一条幂等系统提示', () => {
    const a = member('node-a', '10.0.0.1')
    const g = a.svc.createGroup('研发组', ['node-b'])!
    a.svc.updateGroup(g.groupId, { kind: 'set-avatar', avatarHash: 'a'.repeat(64) })
    a.svc.updateGroup(g.groupId, { kind: 'set-avatar', avatarHash: 'a'.repeat(64) })
    a.svc.updateGroup(g.groupId, { kind: 'set-avatar', avatarHash: '' })

    expect(a.msgRepo.inserted.filter((m) => m.kind === 'system').map((m) => m.content)).toEqual([
      '你修改了群头像',
      '你恢复了默认群头像'
    ])
  })

  it('受邀成员首次收到高版本群信息时生成邀请提示并幂等', () => {
    const a = member('node-a', '10.0.0.1')
    const g = a.svc.createGroup('研发组', ['node-b'])!
    a.svc.updateGroup(g.groupId, { kind: 'invite', memberIds: ['node-c'] })
    const inviteInfo = a.messenger.sent.find(
      (item) => item.peerId === 'node-c' && item.env.type === MSG_TYPES.group
    )!.env

    const c = member('node-c', '10.0.0.3', '阿明')
    c.messenger.emit('incoming', inviteInfo, { address: '10.0.0.1' })
    c.messenger.emit('incoming', inviteInfo, { address: '10.0.0.1' })

    expect(c.msgRepo.inserted.filter((m) => m.kind === 'system').map((m) => m.content)).toEqual([
      '阿明邀请你加入群聊'
    ])
  })

  it('群主退出使用合并系统提示', () => {
    const a = member('node-a', '10.0.0.1', '阿明')
    const g = a.svc.createGroup('研发组', ['node-b', 'node-c'])!
    a.svc.updateGroup(g.groupId, { kind: 'set-admin', memberId: 'node-c', enabled: true })

    a.svc.leaveGroup(g.groupId)

    expect(a.msgRepo.inserted.filter((m) => m.kind === 'system').at(-1)?.content).toBe(
      '你退出群聊，阿明自动成为新群主'
    )
  })

  it('普通成员自行退群生成系统提示', () => {
    const a = member('node-a', '10.0.0.1')
    a.svc.createGroup('研发组', ['node-b'])!
    const b = member('node-b', '10.0.0.2')
    for (const env of groupInfos(a.messenger)) {
      b.messenger.emit('incoming', env, { address: '10.0.0.1' })
    }
    const groupId = b.groupRepo.list()[0].groupId

    b.svc.leaveGroup(groupId)

    expect(b.msgRepo.inserted.filter((m) => m.kind === 'system').map((m) => m.content)).toEqual([
      '你退出了群聊'
    ])
  })

  it('发送带引用的群文本消息：replyTo 入库存且随报文广播', () => {
    const a = member('node-a', '10.0.0.1', '阿明')
    a.svc.createGroup('茶水间', ['node-b', 'node-c'])!
    const g = a.groupRepo.list()[0]
    const view = a.svc.sendText(g.groupId, '回复你', [], 'msg-source')
    expect(view).not.toBeNull()
    expect(view!.kind).toBe('text')
    expect(view!.text).toBe('回复你')
    // replyTo 写入本地消息行
    const sentMsg = a.msgRepo.inserted.find((m) => m.id === view!.id)
    expect(sentMsg).toBeDefined()
    expect(sentMsg!.replyTo).toBe('msg-source')
    // 报文载荷携带 replyTo
    const textSends = a.messenger.sent.filter((s) => s.env.type === MSG_TYPES.msg)
    expect(textSends.map((s) => s.peerId)).toEqual(['node-b', 'node-c'])
    for (const s of textSends) {
      const p = s.env.payload as Extract<MsgPayload, { kind: 'group-text' }>
      expect(p.kind).toBe('group-text')
      expect(p.groupId).toBe(g.groupId)
      expect(p.replyTo).toBe('msg-source')
    }
    // 接收方 view 携带 replyTo id
    expect(view!.replyTo).toEqual('msg-source')
  })

  it('入站群文本消息携带 replyTo 时存入本地库并触发 message 事件', () => {
    const b = member('node-b', '10.0.0.2', '小陈')
    // 先让 B 认识群
    const a = member('node-a', '10.0.0.1', '阿明')
    const g = a.svc.createGroup('茶水间', ['node-b'])!
    for (const env of groupInfos(a.messenger)) {
      b.messenger.emit('incoming', env, { address: '10.0.0.1' })
    }
    // 模拟 A 发带引用的消息给 B
    const replyEnv = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-a', {
      kind: 'group-text',
      text: '这条是引用',
      groupId: g.groupId,
      groupRev: g.rev,
      replyTo: 'existing-msg-id'
    })
    const events: Array<{ event: string; msg: unknown }> = []
    b.svc.on('message', (msg) => events.push({ event: 'message', msg }))
    b.messenger.emit('incoming', replyEnv, { address: '10.0.0.1' })
    expect(events).toHaveLength(1)
    const received = events[0].msg as { id: string; replyTo?: string; text: string }
    expect(received.text).toBe('这条是引用')
    expect(received.replyTo).toEqual('existing-msg-id')
    // 入库确认
    const stored = b.msgRepo.inserted.find((m) => m.id === received.id)
    expect(stored).toBeDefined()
    expect(stored!.replyTo).toBe('existing-msg-id')
  })

  it('空字符串 replyTo ', () => {
    const b = member('node-b', '10.0.0.2')
    const emptyReply = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-a', {
      kind: 'group-text',
      text: '无效引用',
      groupId: 'g-1',
      groupRev: 1,
      replyTo: ''
    })
    const decoded = decode(encode(emptyReply))
    expect(decoded).toMatchObject({ ok: true })
    expect(b.msgRepo.inserted).toBeDefined()
  })

  it('伪造对象 replyTo 在 codec 层被拒绝', () => {
    const fake = makeEnvelope(MSG_TYPES.msg, 'node-a', {
      kind: 'group-text',
      text: '冒充回复',
      groupId: 'g-1',
      groupRev: 1,
      replyTo: { id: 'msg-source', senderName: '管理员', text: '原始消息内容' }
    })
    const decoded = decode(encode(fake))
    expect(decoded).toMatchObject({ ok: false })
  })

  it('replyTo 指向不存在的消息时接收正常，跳转由渲染层处理', () => {
    const b = member('node-b', '10.0.0.2', '小陈')
    const a = member('node-a', '10.0.0.1', '阿明')
    const g = a.svc.createGroup('茶水间', ['node-b'])!
    for (const env of groupInfos(a.messenger)) {
      b.messenger.emit('incoming', env, { address: '10.0.0.1' })
    }
    // 引用的目标 ID 在本机仓库中不存在
    const noTarget = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-a', {
      kind: 'group-text',
      text: '引用不存在的消息',
      groupId: g.groupId,
      groupRev: g.rev,
      replyTo: 'nonexistent-msg-id'
    })
    const events: Array<{ event: string; msg: unknown }> = []
    b.svc.on('message', (msg) => events.push({ event: 'message', msg }))
    b.messenger.emit('incoming', noTarget, { address: '10.0.0.1' })
    expect(events).toHaveLength(1)
    const received = events[0].msg as { id: string; replyTo?: string; text: string }
    expect(received.text).toBe('引用不存在的消息')
    expect(received.replyTo).toEqual('nonexistent-msg-id')
    // 目标 ID 不在 B 的仓库中，但本条消息本身仍入库
    expect(b.msgRepo.get(received.id)).toBeDefined()
    expect(b.msgRepo.get('nonexistent-msg-id')).toBeUndefined()
  })
})

describe('GroupsService 群简介与群公告', () => {
  it('群主可直接设置群简介和群公告', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('项目组', ['node-bob'])!
    const updated = owner.updateGroup(group.groupId, {
      kind: 'set-description',
      description: '我们是一个前端团队'
    })
    expect(updated?.description).toBe('我们是一个前端团队')
    expect(updated?.rev).toBe(2)
    const updated2 = owner.updateGroup(group.groupId, {
      kind: 'set-announce',
      announce: '欢迎大家加入'
    })
    expect(updated2?.announce).toBe('欢迎大家加入')
    expect(updated2?.rev).toBe(3)
  })

  it('管理员可设置群简介和群公告', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('项目组', ['node-admin', 'node-member'])!
    owner.updateGroup(group.groupId, { kind: 'set-admin', memberId: 'node-admin', enabled: true })

    const admin = service({ selfId: 'node-admin', selfIp: '10.0.0.2', groupRepo: repo })
    const desc = admin.updateGroup(group.groupId, {
      kind: 'set-description',
      description: '管理员设置的简介'
    })
    expect(desc?.description).toBe('管理员设置的简介')

    const announce = admin.updateGroup(group.groupId, {
      kind: 'set-announce',
      announce: '管理员公告'
    })
    expect(announce?.announce).toBe('管理员公告')
  })

  it('普通成员（无密码）不能设置群简介和群公告', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('项目组', ['node-member'])!

    const member = service({ selfId: 'node-member', selfIp: '10.0.0.2', groupRepo: repo })
    expect(
      member.updateGroup(group.groupId, { kind: 'set-description', description: '不应生效' })
    ).toBeNull()
    expect(
      member.updateGroup(group.groupId, { kind: 'set-announce', announce: '不应生效' })
    ).toBeNull()
  })

  it('有管理密码的普通成员输入正确密码可设置简介和公告', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('加密组', ['node-member'], 's3cret')!

    const member = service({ selfId: 'node-member', selfIp: '10.0.0.2', groupRepo: repo })
    expect(
      member.updateGroup(group.groupId, {
        kind: 'set-description',
        description: '密码成员简介',
        adminPassword: 's3cret'
      })?.description
    ).toBe('密码成员简介')
    expect(
      member.updateGroup(group.groupId, {
        kind: 'set-announce',
        announce: '密码成员公告',
        adminPassword: 's3cret'
      })?.announce
    ).toBe('密码成员公告')

    expect(
      member.updateGroup(group.groupId, {
        kind: 'set-description',
        description: '错误密码',
        adminPassword: 'wrong'
      })
    ).toBeNull()
  })

  it('群简介截断到 200 字符，群公告截断到 1024 字符', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('长度组', ['node-bob'])!

    // 服务层：patch 校验要求 description.length <= LIMITS.groupDescription（200）
    // 发送合法长度值，验证往返正常
    const withinLimit = '界'.repeat(LIMITS.groupDescription)
    const updated = owner.updateGroup(group.groupId, { kind: 'set-description', description: withinLimit })
    expect(updated?.description).toBe(withinLimit)

    const withinAnnounce = '告'.repeat(LIMITS.groupAnnounce)
    const updated2 = owner.updateGroup(group.groupId, { kind: 'set-announce', announce: withinAnnounce })
    expect(updated2?.announce).toBe(withinAnnounce)

    // 超长 patch 被 isSingleOperationPatch 拒绝
    const tooLongDesc = '界'.repeat(LIMITS.groupDescription + 1)
    expect(
      owner.updateGroup(group.groupId, { kind: 'set-description', description: tooLongDesc })
    ).toBeNull()
    const tooLongAnnounce = '告'.repeat(LIMITS.groupAnnounce + 1)
    expect(
      owner.updateGroup(group.groupId, { kind: 'set-announce', announce: tooLongAnnounce })
    ).toBeNull()
  })

  it('混合 patch（夹带 description/announce 到其他操作）被拒绝', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfIp: '10.0.0.1', groupRepo: repo })
    const group = owner.createGroup('混合组', ['node-bob'])!

    const mixed = {
      kind: 'rename',
      name: '夹带改名',
      description: '同时设置简介'
    } as unknown as GroupPatch
    expect(owner.updateGroup(group.groupId, mixed)).toBeNull()
  })

  it('更新群简介/公告生成系统提示并幂等', () => {
    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const groupRepo = new FakeGroupRepo()
    const owner = new GroupsService({
      selfId: 'node-a',
      messenger: messenger as unknown as Messenger,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: groupRepo as unknown as GroupRepo,
      getSelfIp: () => '10.0.0.1'
    })
    const g = owner.createGroup('提示组', ['node-b'])!

    owner.updateGroup(g.groupId, { kind: 'set-description', description: '新简介' })
    owner.updateGroup(g.groupId, { kind: 'set-description', description: '新简介' })
    owner.updateGroup(g.groupId, { kind: 'set-announce', announce: '新公告' })

    const systemMsgs = msgRepo.inserted.filter((m) => m.kind === 'system')
    expect(systemMsgs.map((m) => m.content)).toEqual([
      '你修改了群简介',
      '你修改了群公告'
    ])
  })

  it('旧端 group.info 缺少简介/公告时保留本地值，首次接收填充空串', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-b', selfIp: '10.0.0.2', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-legacy-text',
      name: '同步组',
      members: ['node-a', 'node-b'],
      rev: 1,
      updatedBy: 'node-a',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-a',
      ownerId: 'node-a',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '本地简介',
      announce: '本地公告'
    }
    repo.save(local)

    messenger.emit(
      'incoming',
      makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-a', {
        op: 'info',
        group: {
          ...local,
          name: '旧端改名',
          description: undefined,
          announce: undefined,
          rev: 2,
          updatedBy: 'node-a',
          updatedTs: 2000
        } as unknown as GroupMeta
      }),
      { address: '10.0.0.1' }
    )
    expect(repo.get(local.groupId)).toMatchObject({
      name: '旧端改名',
      description: '本地简介',
      announce: '本地公告',
      rev: 2
    })

    const first = {
      ...local,
      groupId: 'g-first-text',
      description: undefined,
      announce: undefined,
      rev: 1,
      updatedBy: 'node-a',
      updatedTs: 1000
    } as unknown as GroupMeta
    messenger.emit(
      'incoming',
      makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-a', { op: 'info', group: first }),
      { address: '10.0.0.1' }
    )
    expect(repo.get('g-first-text')).toMatchObject({ description: '', announce: '' })
  })

  it('远端群主按 rev 单独同步简介和公告，空白或空串可清空', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-b', selfIp: '10.0.0.2', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-sync',
      name: '同步组',
      members: ['node-a', 'node-b'],
      rev: 1,
      updatedBy: 'node-a',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-a',
      ownerId: 'node-a',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    const send = (group: GroupMeta): void => {
      messenger.emit(
        'incoming',
        makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-a', { op: 'info', group }),
        { address: '10.0.0.1' }
      )
    }
    send({ ...local, description: '远端简介', rev: 2, updatedTs: 2000 })
    expect(repo.get(local.groupId)).toMatchObject({ description: '远端简介', announce: '', rev: 2 })

    send({ ...repo.get(local.groupId)!, announce: '远端公告', rev: 3, updatedTs: 3000 })
    expect(repo.get(local.groupId)).toMatchObject({ description: '远端简介', announce: '远端公告', rev: 3 })

    send({ ...repo.get(local.groupId)!, description: '   ', rev: 4, updatedTs: 4000 })
    expect(repo.get(local.groupId)).toMatchObject({ description: '', announce: '远端公告', rev: 4 })

    send({ ...repo.get(local.groupId)!, announce: '', rev: 5, updatedTs: 5000 })
    expect(repo.get(local.groupId)).toMatchObject({ description: '', announce: '', rev: 5 })
  })

  it('远端管理员单独修改简介或公告可接受', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-self', selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-admin-text',
      name: '管理员组',
      members: ['node-owner', 'node-admin', 'node-self'],
      rev: 1,
      updatedBy: 'node-owner',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-owner',
      ownerId: 'node-owner',
      adminIds: ['node-admin'],
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    repo.save(local)

    const send = (group: GroupMeta): void => {
      messenger.emit(
        'incoming',
        makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-admin', { op: 'info', group }),
        { address: '10.0.0.2' }
      )
    }
    send({ ...local, description: '管理员简介', rev: 2, updatedBy: 'node-admin', updatedTs: 2000 })
    expect(repo.get(local.groupId)).toMatchObject({ description: '管理员简介', announce: '', rev: 2 })

    send({ ...repo.get(local.groupId)!, announce: '管理员公告', rev: 3, updatedBy: 'node-admin', updatedTs: 3000 })
    expect(repo.get(local.groupId)).toMatchObject({ description: '管理员简介', announce: '管理员公告', rev: 3 })
  })

  it('远端文本每 rev 仅允许一个字段，普通成员与夹带结构变更均拒绝', () => {
    const repo = new FakeGroupRepo()
    const messenger = new FakeMessenger()
    service({ selfId: 'node-self', selfIp: '10.0.0.8', groupRepo: repo, messenger })
    const local: GroupMeta = {
      groupId: 'g-text-guard',
      name: '项目组',
      members: ['node-owner', 'node-admin', 'node-member', 'node-self'],
      rev: 1,
      updatedBy: 'node-owner',
      updatedTs: 1000,
      creatorIp: '10.0.0.1',
      creatorId: 'node-owner',
      ownerId: 'node-owner',
      adminIds: ['node-admin'],
      adminSecretHash: '',
      adminHint: '',
      description: '本地简介',
      announce: '本地公告'
    }
    repo.save(local)

    const send = (from: string, group: GroupMeta, address: string): void => {
      messenger.emit(
        'incoming',
        makeEnvelope<GroupPayload>(MSG_TYPES.group, from, { op: 'info', group }),
        { address }
      )
    }
    send(
      'node-member',
      { ...local, description: '成员改简介', rev: 2, updatedBy: 'node-member', updatedTs: 2000 },
      '10.0.0.3'
    )
    expect(repo.get(local.groupId)).toEqual(local)

    send(
      'node-member',
      { ...local, announce: '成员冒用创建 IP', rev: 2, updatedBy: 'node-member', updatedTs: 2001 },
      local.creatorIp
    )
    expect(repo.get(local.groupId)).toEqual(local)

    send(
      'node-member',
      {
        ...local,
        members: [...local.members, 'node-new'],
        announce: '邀请夹带公告',
        rev: 2,
        updatedBy: 'node-member',
        updatedTs: 2002
      },
      '10.0.0.3'
    )
    expect(repo.get(local.groupId)).toEqual(local)

    send(
      'node-owner',
      {
        ...local,
        description: '同时改简介',
        announce: '同时改公告',
        rev: 2,
        updatedBy: 'node-owner',
        updatedTs: 2003
      },
      '10.0.0.1'
    )
    expect(repo.get(local.groupId)).toEqual(local)

    send(
      'node-admin',
      {
        ...local,
        name: '改名夹带简介',
        description: '结构夹带简介',
        rev: 2,
        updatedBy: 'node-admin',
        updatedTs: 2004
      },
      '10.0.0.2'
    )
    expect(repo.get(local.groupId)).toEqual(local)
  })
})


describe('GroupsService 跨版本全量快照补齐', () => {
  it('漏掉中间 rev 后通过 need/info 补齐文本与各类合法管理变化', () => {
    const secondOperations: GroupPatch[] = [
      { kind: 'set-announce', announce: '新的群公告' },
      { kind: 'rename', name: '新的群名' },
      { kind: 'set-avatar', avatarHash: 'a'.repeat(64) },
      { kind: 'invite', memberIds: ['node-new'] },
      { kind: 'remove', memberIds: ['node-target'] },
      { kind: 'set-admin', memberId: 'node-target', enabled: true }
    ]
    for (const patch of secondOperations) {
      const ownerRepo = new FakeGroupRepo()
      const ownerMessenger = new FakeMessenger()
      const owner = service({ selfId: 'node-owner', selfIp: '127.0.0.1', groupRepo: ownerRepo, messenger: ownerMessenger })
      const memberRepo = new FakeGroupRepo()
      const memberMessenger = new FakeMessenger()
      service({ selfId: 'node-member', selfIp: '127.0.0.1', groupRepo: memberRepo, messenger: memberMessenger })
      const group = owner.createGroup('补齐测试组', ['node-member', 'node-target'])!
      memberMessenger.emit('incoming', ownerMessenger.sent[0].env)
      owner.updateGroup(group.groupId, { kind: 'set-description', description: '新的群简介' })
      owner.updateGroup(group.groupId, patch)
      ownerMessenger.emit('incoming', makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-member', { op: 'need', groupId: group.groupId }))
      const latest = ownerMessenger.sent[ownerMessenger.sent.length - 1].env
      expect(decode(encode(latest))).toMatchObject({ ok: true, known: true })
      memberMessenger.emit('incoming', latest)
      expect(memberRepo.get(group.groupId), patch.kind).toEqual(ownerRepo.get(group.groupId))
      expect(memberRepo.get(group.groupId)?.rev).toBe(3)
    }
  })

  it('跨版本快照仍拒绝文本越权、结构越权与不足以覆盖操作数的版本差', () => {
    const repo = new FakeGroupRepo()
    const owner = service({ selfId: 'node-owner', selfIp: '127.0.0.1', groupRepo: repo })
    const group = owner.createGroup('权限测试组', ['node-admin', 'node-member'])!
    owner.updateGroup(group.groupId, { kind: 'set-admin', memberId: 'node-admin', enabled: true })
    const local = repo.get(group.groupId)!
    const messenger = new FakeMessenger()
    service({ selfId: 'node-member', selfIp: '127.0.0.1', groupRepo: repo, messenger })
    const invalidSnapshots: Array<Partial<GroupMeta>> = [
      { updatedBy: 'node-member', description: '越权简介', announce: '越权公告' },
      { updatedBy: 'node-member', description: '邀请夹带', members: [...local.members, 'node-new'] },
      { updatedBy: 'node-admin', description: '角色夹带', adminIds: ['node-admin', 'node-member'] },
      { updatedBy: 'node-admin', description: '移出群主', members: ['node-admin', 'node-member'], ownerId: 'node-admin', adminIds: [] },
      { updatedBy: 'node-owner', description: '未知结构组合', name: '改名', avatarHash: 'a'.repeat(64) },
      { updatedBy: 'node-owner', description: '简介', announce: '公告', name: '改名', rev: local.rev + 2 }
    ]
    for (const patch of invalidSnapshots) {
      const incoming = { ...local, rev: local.rev + 10, updatedTs: local.updatedTs + 1000, ...patch }
      messenger.emit('incoming', makeEnvelope<GroupPayload>(MSG_TYPES.group, incoming.updatedBy, { op: 'info', group: incoming }))
      expect(repo.get(group.groupId)).toEqual(local)
    }
  })
})
