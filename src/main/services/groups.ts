import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { RemoteInfo } from 'node:dgram'
import { EventEmitter } from 'node:events'
import {
  GROUP_MAX_MEMBERS,
  LIMITS,
  MSG_TYPES,
  TEXT_TCP_LIMIT,
  isAvatarHash,
  type Envelope,
  type GroupMeta,
  type GroupPayload,
  type MsgPayload
} from '../../shared/protocol'
import type { GroupPatch, GroupRole, GroupView, MessageView } from '../../shared/ipc'
import { makeEnvelope } from '../net/codec'
import type { Messenger } from '../net/messenger'
import { ConvRepo, convRowToView } from '../store/conv-repo'
import { MsgRepo, msgRowToView } from '../store/msg-repo'
import { GroupRepo } from '../store/group-repo'
import type { PeerClock } from '../net/peer-clock'
import { isPkGame, pkPreview, type PkGame, type PkRefView, type PkResult } from '../../shared/pk'

// 讨论组编排（§7.4 / F-MSG-4）：
// 群消息 = 同一信封逐成员单播（离线走补发）；元数据 LWW；
// 不认识的群/rev 落后 → 向发送者 need，对方回 info。
// 事件：'message' / 'convs' / 'group'（与 chat/files 同构，index 桥接到窗口）。

export interface GroupsDeps {
  selfId: string
  messenger: Messenger
  convRepo: ConvRepo
  msgRepo: MsgRepo
  groupRepo: GroupRepo
  /** 当前本机用于“创建 IP 管理”的 IPv4；测试可注入 */
  getSelfIp?: () => string
  /** 时钟偏移矫正（决议 #65）：把群成员消息显示时间换算到本机钟 */
  peerClock?: PeerClock
  /** 本地显示名解析：群系统提示优先用备注，其次昵称（决议 #87） */
  resolveDisplayName?: (nodeId: string) => string
  /** 在线即时能力（PK）：群 PK 只发给当前在线成员 */
  isOnline?: (nodeId: string) => boolean
}

export class GroupsService extends EventEmitter {
  private convsScheduled = false

  constructor(private readonly deps: GroupsDeps) {
    super()
    deps.messenger.on('incoming', (env: Envelope, rinfo?: RemoteInfo) => {
      if (env.type === MSG_TYPES.group) this.onGroupCtl(env, rinfo)
      else if (env.type === MSG_TYPES.msg) this.onIncomingMsg(env)
    })
  }

  // ---------- 查询 ----------

  toView(meta: GroupMeta): GroupView {
    const selfRole = groupRoleOf(meta, this.deps.selfId)
    return {
      groupId: meta.groupId,
      name: meta.name,
      members: meta.members,
      rev: meta.rev,
      amMember: meta.members.includes(this.deps.selfId),
      creatorIp: meta.creatorIp,
      ownerId: meta.ownerId,
      adminIds: meta.adminIds,
      avatarHash: meta.avatarHash ?? '',
      selfRole,
      hasAdminPassword: meta.adminSecretHash.length > 0,
      adminHint: meta.adminHint,
      canManage: selfRole === 'owner' || selfRole === 'admin',
      description: normalizeGroupText(meta.description ?? '', LIMITS.groupDescription),
      announce: normalizeGroupText(meta.announce ?? '', LIMITS.groupAnnounce)
    }
  }

  get(groupId: string): GroupView | null {
    const meta = this.deps.groupRepo.get(groupId)
    return meta ? this.toView(meta) : null
  }

  list(): GroupView[] {
    return this.deps.groupRepo.list().map((m) => this.toView(m))
  }

  // ---------- 建群 / 改群 / 退群 ----------

  createGroup(
    name: string,
    memberIds: string[],
    adminPassword = '',
    adminHint = ''
  ): GroupView | null {
    const members = [...new Set([this.deps.selfId, ...memberIds])].slice(0, GROUP_MAX_MEMBERS)
    if (members.length < 2) return null
    const groupId = randomUUID()
    const secret = normalizeAdminPassword(adminPassword)
    const meta: GroupMeta = {
      announce: "",
      description: "",
      groupId,
      name: name.trim().slice(0, 32) || '讨论组',
      members,
      rev: 1,
      updatedBy: this.deps.selfId,
      updatedTs: Date.now(),
      creatorIp: this.selfIp(),
      creatorId: this.deps.selfId,
      ownerId: this.deps.selfId,
      adminIds: [],
      avatarHash: '',
      adminSecretHash: secret ? groupAdminSecretHash(groupId, secret) : '',
      adminHint: secret ? normalizeAdminHint(adminHint) : ''
    }
    this.deps.groupRepo.save(meta)
    this.deps.convRepo.ensureGroup(meta.groupId)
    this.broadcastInfo(meta, members)
    this.emitConvs()
    this.emit('group', this.toView(meta))
    return this.toView(meta)
  }

  /** 单操作群变更按决议 #241 的角色/密码权限矩阵校验。 */
  updateGroup(groupId: string, patch: GroupPatch): GroupView | null {
    if (!isSingleOperationPatch(patch)) return null
    const meta = this.deps.groupRepo.get(groupId)
    if (!meta || !meta.members.includes(this.deps.selfId)) return null
    const role = groupRoleOf(meta, this.deps.selfId)
    let name = meta.name
    let members = [...meta.members]
    let adminIds = [...meta.adminIds]
    let avatarHash = meta.avatarHash ?? ''
    let description = meta.description ?? ''
    let announce = meta.announce ?? ''

    if (patch.kind === 'invite') {
      for (const id of patch.memberIds) {
        if (!members.includes(id) && members.length < GROUP_MAX_MEMBERS) members.push(id)
      }
    } else if (patch.kind === 'rename') {
      if (!this.canManage(meta, patch.adminPassword)) return null
      name = patch.name.trim().slice(0, 32) || meta.name
    } else if (patch.kind === 'remove') {
      if (!this.canManage(meta, patch.adminPassword)) return null
      const targets = [...new Set(patch.memberIds)].filter((id) => members.includes(id))
      if (targets.includes(this.deps.selfId)) return null
      if (role !== 'owner' && targets.some((id) => groupRoleOf(meta, id) !== 'member')) return null
      members = members.filter((id) => !targets.includes(id))
      adminIds = adminIds.filter((id) => members.includes(id))
    } else if (patch.kind === 'set-admin') {
      if (role !== 'owner') return null
      if (!members.includes(patch.memberId) || patch.memberId === meta.ownerId) return null
      adminIds = patch.enabled
        ? [...new Set([...adminIds, patch.memberId])]
        : adminIds.filter((id) => id !== patch.memberId)
    } else if (patch.kind === 'set-avatar') {
      if (!this.canManage(meta, patch.adminPassword)) return null
      avatarHash = patch.avatarHash
    } else if (patch.kind === 'set-description') {
      if (!this.canManage(meta, patch.adminPassword)) return null
      description = normalizeGroupText(patch.description, LIMITS.groupDescription)
    } else if (patch.kind === 'set-announce') {
      if (!this.canManage(meta, patch.adminPassword)) return null
      announce = normalizeGroupText(patch.announce, LIMITS.groupAnnounce)
    }

    if (members.length === 0) return null
    const rawDesc = patch.kind === 'set-description' ? patch.description : undefined
    const rawAnnounce = patch.kind === 'set-announce' ? patch.announce : undefined
    const descChanged = rawDesc !== undefined && (rawDesc.trim() !== (meta.description ?? ''))
    const announceChanged = rawAnnounce !== undefined && (rawAnnounce.trim() !== (meta.announce ?? ''))
    const changed =
      name !== meta.name ||
      !sameStringArray(members, meta.members) ||
      !sameStringArray(adminIds, meta.adminIds) ||
      avatarHash !== (meta.avatarHash ?? '') ||
      descChanged ||
      announceChanged
    if (!changed) return this.toView(meta)

    const next: GroupMeta = {
      ...meta,
      name,
      members,
      adminIds,
      avatarHash,
      description,
      announce,
      rev: meta.rev + 1,
      updatedBy: this.deps.selfId,
      updatedTs: Date.now()
    }
    this.deps.groupRepo.save(next)
    this.insertGroupChangeTip(meta, next, false)
    // 新旧成员全集都要收到 info：被移出者借此得知（§7.4）
    this.broadcastInfo(next, [...new Set([...meta.members, ...members])])
    this.emitConvs()
    this.emit('group', this.toView(next))
    return this.toView(next)
  }

  leaveGroup(groupId: string): void {
    const meta = this.deps.groupRepo.get(groupId)
    if (!meta || !meta.members.includes(this.deps.selfId)) return
    const members = meta.members.filter((id) => id !== this.deps.selfId)
    if (members.length === meta.members.length) return
    const wasOwner = meta.ownerId === this.deps.selfId
    const ownerId = wasOwner ? pickNextOwner(members, meta.adminIds) : meta.ownerId
    const adminIds = meta.adminIds.filter((id) => members.includes(id) && id !== ownerId)
    const next: GroupMeta = {
      ...meta,
      members,
      ownerId,
      adminIds,
      rev: meta.rev + 1,
      updatedBy: this.deps.selfId,
      updatedTs: Date.now()
    }
    this.deps.groupRepo.save(next)
    this.insertGroupChangeTip(meta, next, false)
    this.broadcastInfo(next, meta.members)
    this.emitConvs()
    this.emit('group', this.toView(next))
  }

  // ---------- 群消息 ----------

  sendText(groupId: string, text: string, mentions: string[] = [], replyTo?: string): MessageView | null {
    const meta = this.deps.groupRepo.get(groupId)
    const trimmed = text.trim()
    if (!meta || !meta.members.includes(this.deps.selfId) || !trimmed) return null
    if (Buffer.byteLength(trimmed, 'utf8') > TEXT_TCP_LIMIT) return null
    const cleanMentions = [...new Set(mentions)]
      .filter((id) => id !== this.deps.selfId && meta.members.includes(id))
      .slice(0, GROUP_MAX_MEMBERS)

    const convId = this.deps.convRepo.ensureGroup(groupId)
    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, this.deps.selfId, {
      kind: 'group-text',
      text: trimmed,
      groupId,
      groupRev: meta.rev,
      ...(cleanMentions.length > 0 ? { mentions: cleanMentions } : {}),
      replyTo: replyTo ? replyTo : ''
    })
    // 群消息不做按成员回执（v0.3 简化）：本端入库即 sent，离线成员由补发队列保送达
    this.deps.msgRepo.insert({
      id: env.id,
      convId,
      senderId: this.deps.selfId,
      isMine: true,
      kind: 'text',
      content: trimmed,
      ts: env.ts,
      status: 'sent',
      replyTo: replyTo
    })
    this.deps.convRepo.bump(convId, env.ts)
    this.emitConvs()

    for (const member of meta.members) {
      if (member !== this.deps.selfId) {
        void this.deps.messenger.sendUserMessage(member, env)
      }
    }
    const row = this.deps.msgRepo.get(env.id)
    return row ? msgRowToView(row) : null
  }

  sendPk(groupId: string, game: PkGame): MessageView | null {
    const meta = this.deps.groupRepo.get(groupId)
    if (!meta || !meta.members.includes(this.deps.selfId) || !isPkGame(game)) return null
    const recipients = meta.members.filter(
      (member) => member !== this.deps.selfId && this.deps.isOnline?.(member)
    )
    if (recipients.length === 0) return null

    const convId = this.deps.convRepo.ensureGroup(groupId)
    const ref = makePkRef(game)
    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, this.deps.selfId, {
      kind: 'pk',
      game: ref.game,
      result: ref.result,
      groupId,
      groupRev: meta.rev
    })
    this.deps.msgRepo.insert({
      id: env.id,
      convId,
      senderId: this.deps.selfId,
      isMine: true,
      kind: 'pk',
      content: pkPreview(game),
      fileRef: JSON.stringify(ref),
      ts: env.ts,
      status: 'sent'
    })
    this.deps.convRepo.bump(convId, env.ts)
    this.emitConvs()

    for (const member of recipients) {
      void this.deps.messenger.sendReliable(member, env)
    }
    const row = this.deps.msgRepo.get(env.id)
    return row ? msgRowToView(row) : null
  }

  // ---------- 入站 ----------

  private onIncomingMsg(env: Envelope): void {
    const payload = env.payload as MsgPayload
    if ((payload.kind !== 'group-text' && payload.kind !== 'pk') || !payload.groupId) return

    const convId = this.deps.convRepo.ensureGroup(payload.groupId)
    // 实时群消息校准时钟偏移；显示时间矫正到本机钟（决议 #65）；排序仍用本地 seq
    if (payload.kind === 'pk' || !payload.resend) this.deps.peerClock?.observe(env.from, env.ts, Date.now())
    const ts = this.deps.peerClock?.correct(env.from, env.ts) ?? env.ts
    if (payload.kind === 'pk') {
      const inserted = this.deps.msgRepo.insert({
        id: env.id,
        convId,
        senderId: env.from,
        isMine: false,
        kind: 'pk',
        content: pkPreview(payload.game),
        fileRef: JSON.stringify({ game: payload.game, result: payload.result } satisfies PkRefView),
        ts,
        status: 'sent'
      })
      if (inserted) {
        this.deps.convRepo.bump(convId, ts)
        this.deps.convRepo.incUnread(convId)
        const row = this.deps.msgRepo.get(env.id)
        if (row) this.emit('message', msgRowToView(row))
        this.emitConvs()
      }
      this.syncGroupMetaIfNeeded(payload, env.from)
      return
    }

    const inserted = this.deps.msgRepo.insert({
      id: env.id,
      convId,
      senderId: env.from,
      isMine: false,
      kind: 'text',
      content: payload.text,
      ts,
      status: 'sent',
      replyTo: payload.replyTo
    })
    if (inserted) {
      this.deps.convRepo.bump(convId, ts)
      this.deps.convRepo.incUnread(convId)
      const mentioned = Array.isArray(payload.mentions) && payload.mentions.includes(this.deps.selfId)
      if (mentioned) this.deps.convRepo.markMentioned(convId)
      const row = this.deps.msgRepo.get(env.id)
      if (row) {
        const view = msgRowToView(row)
        if (mentioned) view.mentioned = true
        this.emit('message', view)
      }
      this.emitConvs()
    }

    // 不认识该群或本地版本落后 → 向发送者索要全量元数据（§7.4）
    this.syncGroupMetaIfNeeded(payload, env.from)
  }

  private syncGroupMetaIfNeeded(payload: MsgPayload, from: string): void {
    if ((payload.kind !== 'group-text' && payload.kind !== 'pk') || !payload.groupId) return
    const meta = this.deps.groupRepo.get(payload.groupId)
    if (!meta || (payload.groupRev ?? 0) > meta.rev) {
      void this.deps.messenger.sendReliable(
        from,
        makeEnvelope<GroupPayload>(MSG_TYPES.group, this.deps.selfId, {
          op: 'need',
          groupId: payload.groupId
        })
      )
    }
  }

  private onGroupCtl(env: Envelope, rinfo?: RemoteInfo): void {
    const payload = env.payload as GroupPayload
    if (payload.op === 'info') {
      const local = this.deps.groupRepo.get(payload.group.groupId)
      const incoming = normalizeGroupMeta(payload.group, local)
      if (!this.canApplyRemoteInfo(local, incoming, env.from, rinfo?.address)) return
      const applied = this.deps.groupRepo.applyRemote(incoming)
      if (applied) {
        this.deps.convRepo.ensureGroup(incoming.groupId)
        this.insertGroupChangeTip(local, incoming, local?.members.includes(this.deps.selfId) ?? false)
        this.emitConvs()
        this.emit('group', this.toView(incoming))
      }
      return
    }
    if (payload.op === 'need') {
      const meta = this.deps.groupRepo.get(payload.groupId)
      if (meta && meta.members.includes(this.deps.selfId)) {
        void this.deps.messenger.sendReliable(
          env.from,
          makeEnvelope<GroupPayload>(MSG_TYPES.group, this.deps.selfId, {
            op: 'info',
            group: meta
          })
        )
      }
    }
  }

  /** 元数据投递走可靠通道且离线入队（成员回来即知道自己进了群） */
  private broadcastInfo(meta: GroupMeta, recipients: string[]): void {
    for (const member of recipients) {
      if (member === this.deps.selfId) continue
      const env = makeEnvelope<GroupPayload>(MSG_TYPES.group, this.deps.selfId, {
        op: 'info',
        group: meta
      })
      void this.deps.messenger.sendUserMessage(member, env)
    }
  }

  private emitConvs(): void {
    if (this.convsScheduled) return
    this.convsScheduled = true
    queueMicrotask(() => {
      this.convsScheduled = false
      this.emit('convs', this.deps.convRepo.list().map(convRowToView))
    })
  }

  private insertGroupChangeTip(
    previous: GroupMeta | undefined,
    next: GroupMeta,
    countUnread: boolean
  ): void {
    const content = this.describeGroupChange(previous, next)
    if (!content) return
    const convId = this.deps.convRepo.ensureGroup(next.groupId)
    const id = `group:${next.groupId}:event:${next.rev}`
    const inserted = this.deps.msgRepo.insert({
      id,
      convId,
      senderId: next.updatedBy,
      isMine: false,
      kind: 'system',
      content,
      ts: next.updatedTs,
      status: 'sent'
    })
    if (!inserted) return
    this.deps.convRepo.bump(convId, next.updatedTs)
    if (countUnread) this.deps.convRepo.incUnread(convId)
    const row = this.deps.msgRepo.get(id)
    if (row) this.emit('message', msgRowToView(row))
  }

  private describeGroupChange(previous: GroupMeta | undefined, next: GroupMeta): string {
    const actor = this.memberLabel(next.updatedBy)
    if (!previous) {
      return next.rev > 1 && next.members.includes(this.deps.selfId)
        ? `${actor}邀请你加入群聊`
        : ''
    }

    const added = next.members.filter((id) => !previous.members.includes(id))
    const removed = previous.members.filter((id) => !next.members.includes(id))
    if (previous.ownerId !== next.ownerId && removed.includes(next.updatedBy)) {
      return `${actor}退出群聊，${this.memberLabel(next.ownerId)}自动成为新群主`
    }
    if (added.length > 0) return `${actor}邀请${this.memberListLabel(added)}加入群聊`
    if (removed.length > 0) {
      return removed.includes(next.updatedBy)
        ? `${actor}退出了群聊`
        : `${actor}将${this.memberListLabel(removed)}移出群聊`
    }
    if (previous.name !== next.name) {
      return `${actor}把群名「${previous.name}」改成了「${next.name}」`
    }
    if ((previous.avatarHash ?? '') !== (next.avatarHash ?? '')) {
      return next.avatarHash ? `${actor}修改了群头像` : `${actor}恢复了默认群头像`
    }
    if ((previous.description ?? '') !== (next.description ?? '')) {
      return `${actor}修改了群简介`
    }
    if ((previous.announce ?? '') !== (next.announce ?? '')) {
      return `${actor}修改了群公告`
    }
    const promoted = next.adminIds.filter((id) => !previous.adminIds.includes(id))
    if (promoted.length > 0) return `${actor}将${this.memberListLabel(promoted)}设为管理员`
    const demoted = previous.adminIds.filter((id) => !next.adminIds.includes(id))
    if (demoted.length > 0) return `${actor}取消了${this.memberListLabel(demoted)}的管理员身份`
    return ''
  }

  private memberListLabel(memberIds: string[]): string {
    const shown = memberIds.slice(0, 5).map((id) => this.memberLabel(id)).join('、')
    return memberIds.length > 5 ? `${shown}等${memberIds.length}人` : shown
  }

  private memberLabel(memberId: string): string {
    if (memberId === this.deps.selfId) return '你'
    const resolved = this.deps.resolveDisplayName?.(memberId).trim()
    return resolved || '有人'
  }

  private selfIp(): string {
    return this.deps.getSelfIp?.() ?? '127.0.0.1'
  }

  private canManage(meta: GroupMeta, adminPassword?: string): boolean {
    if (!meta.members.includes(this.deps.selfId)) return false
    const role = groupRoleOf(meta, this.deps.selfId)
    if (role === 'owner' || role === 'admin') return true
    if (!meta.adminSecretHash) return false
    const secret = normalizeAdminPassword(adminPassword ?? '')
    return secret.length > 0 && groupAdminSecretHash(meta.groupId, secret) === meta.adminSecretHash
  }

  private canApplyRemoteInfo(
    local: GroupMeta | undefined,
    incoming: GroupMeta,
    senderId: string,
    sourceIp: string | undefined
  ): boolean {
    if (!local) return true
    if (!sameManagementIdentity(local, incoming)) return false

    const actorId = incoming.updatedBy
    const added = incoming.members.filter((id) => !local.members.includes(id))
    const removed = local.members.filter((id) => !incoming.members.includes(id))
    const nameChanged = incoming.name !== local.name
    const ownerChanged = incoming.ownerId !== local.ownerId
    const adminsChanged = !sameStringSet(incoming.adminIds, local.adminIds)
    const avatarChanged = (incoming.avatarHash ?? '') !== (local.avatarHash ?? '')
    const actorRole = groupRoleOf(local, actorId)
    const actorWasMember = local.members.includes(actorId)
    const passwordCompatible =
      actorWasMember &&
      local.adminSecretHash.length > 0 &&
      incoming.adminSecretHash === local.adminSecretHash
    const legacyCreatorSource =
      (local.creatorIp.length > 0 && sourceIp === local.creatorIp) ||
      (local.creatorId.length > 0 && senderId === local.creatorId && actorId === local.creatorId)

    const descriptionChanged =
      incoming.description !== normalizeGroupText(local.description ?? '', LIMITS.groupDescription)
    const announceChanged =
      incoming.announce !== normalizeGroupText(local.announce ?? '', LIMITS.groupAnnounce)
    const textChanged = descriptionChanged || announceChanged
    const structuralChanged =
      added.length > 0 ||
      removed.length > 0 ||
      nameChanged ||
      ownerChanged ||
      adminsChanged ||
      avatarChanged
    if (textChanged) {
      if (actorRole !== 'owner' && actorRole !== 'admin' && !passwordCompatible) return false
      // info 是全量快照：漏掉中间 rev 时可累积变化，但版本差须覆盖操作数。
      const operations = Number(descriptionChanged) + Number(announceChanged) + Number(structuralChanged)
      if (operations > 1 && incoming.rev - local.rev < operations) return false
      if (!structuralChanged) return true
      // 文本权限通过后，结构变化继续按原有权限矩阵逐项校验。
    }

    if (isSelfLeave(local, incoming)) return true
    if (ownerChanged) return isOwnerLeave(local, incoming)

    if (added.length > 0) {
      return (
        actorWasMember &&
        removed.length === 0 &&
        !nameChanged &&
        !adminsChanged &&
        !avatarChanged
      )
    }

    if (removed.length > 0) {
      if (nameChanged || avatarChanged || added.length > 0) return false
      const expectedAdmins = local.adminIds.filter((id) => incoming.members.includes(id))
      if (!sameStringSet(incoming.adminIds, expectedAdmins)) return false
      if (removed.includes(actorId)) return false
      if (actorRole === 'owner') return true
      if (actorRole !== 'admin' && !passwordCompatible && !legacyCreatorSource) return false
      return removed.every((id) => groupRoleOf(local, id) === 'member')
    }

    if (nameChanged) {
      return (
        !adminsChanged &&
        !avatarChanged &&
        (actorRole === 'owner' ||
          actorRole === 'admin' ||
          passwordCompatible ||
          legacyCreatorSource)
      )
    }

    if (avatarChanged) {
      return (
        !adminsChanged &&
        (actorRole === 'owner' ||
          actorRole === 'admin' ||
          passwordCompatible ||
          legacyCreatorSource)
      )
    }

    if (adminsChanged) {
      const roleDiff = symmetricDifferenceSize(local.adminIds, incoming.adminIds)
      return actorId === local.ownerId && actorWasMember && roleDiff === 1
    }

    return actorWasMember
  }
}

function normalizeAdminPassword(raw: string): string {
  return raw.trim().slice(0, LIMITS.groupAdminPassword)
}

function normalizeAdminHint(raw: string): string {
  return raw.trim().slice(0, LIMITS.groupAdminHint)
}

function normalizeGroupText(raw: string, max: number): string {
  return raw.trim().slice(0, max)
}

function groupAdminSecretHash(groupId: string, password: string): string {
  return createHash('sha256').update(`${groupId}\n${password}`).digest('hex')
}

function normalizeGroupMeta(meta: GroupMeta, local?: GroupMeta): GroupMeta {
  const raw = meta as GroupMeta & {
    creatorIp?: unknown
    creatorId?: unknown
    ownerId?: unknown
    adminIds?: unknown
    avatarHash?: unknown
    adminSecretHash?: unknown
    adminHint?: unknown
    description?: unknown
    announce?: unknown
  }
  const members = [...new Set(meta.members)].filter((id) => id.length > 0)
  const adminSecretHash = typeof raw.adminSecretHash === 'string' ? raw.adminSecretHash : ''
  const creatorId =
    typeof raw.creatorId === 'string' && raw.creatorId.length > 0
      ? raw.creatorId
      : local?.creatorId || (adminSecretHash ? '' : meta.updatedBy)
  const rawOwnerId =
    typeof raw.ownerId === 'string' && members.includes(raw.ownerId) ? raw.ownerId : ''
  const preservedOwnerId =
    local?.ownerId && members.includes(local.ownerId) ? local.ownerId : ''
  const legacyOwnerId = [creatorId, meta.updatedBy].find((id) => members.includes(id)) ?? ''
  const ownerId =
    rawOwnerId ||
    preservedOwnerId ||
    (local?.ownerId ? pickNextOwner(members, local.adminIds) : legacyOwnerId || members[0] || '')
  const adminIds = Array.isArray(raw.adminIds)
    ? [...new Set(raw.adminIds)].filter(
        (id): id is string => typeof id === 'string' && id !== ownerId && members.includes(id)
      )
    : (local?.adminIds ?? []).filter((id) => id !== ownerId && members.includes(id))
  const avatarHash =
    typeof raw.avatarHash === 'string'
      ? raw.avatarHash
      : local?.avatarHash ?? ''
  const description = normalizeGroupText(
    typeof raw.description === 'string' ? raw.description : local?.description ?? '',
    LIMITS.groupDescription
  )
  const announce = normalizeGroupText(
    typeof raw.announce === 'string' ? raw.announce : local?.announce ?? '',
    LIMITS.groupAnnounce
  )
  return {
    ...meta,
    members,
    creatorIp:
      typeof raw.creatorIp === 'string' && raw.creatorIp.length > 0
        ? raw.creatorIp
        : local?.creatorIp ?? '',
    creatorId,
    ownerId,
    adminIds,
    avatarHash,
    adminSecretHash,
    adminHint:
      adminSecretHash && typeof raw.adminHint === 'string'
        ? normalizeAdminHint(raw.adminHint)
        : '',
    description,
    announce
  }
}

function isSelfLeave(local: GroupMeta, incoming: GroupMeta): boolean {
  const removed = local.members.filter((id) => !incoming.members.includes(id))
  const added = incoming.members.filter((id) => !local.members.includes(id))
  const actorId = incoming.updatedBy
  const expectedAdmins = local.adminIds.filter((id) => id !== actorId)
  return (
    removed.length === 1 &&
    removed[0] === actorId &&
    actorId !== local.ownerId &&
    added.length === 0 &&
    incoming.name === local.name &&
    (incoming.avatarHash ?? '') === (local.avatarHash ?? '') &&
    incoming.ownerId === local.ownerId &&
    sameStringSet(incoming.adminIds, expectedAdmins)
  )
}

function isOwnerLeave(local: GroupMeta, incoming: GroupMeta): boolean {
  const removed = local.members.filter((id) => !incoming.members.includes(id))
  const added = incoming.members.filter((id) => !local.members.includes(id))
  const expectedOwnerId = pickNextOwner(incoming.members, local.adminIds)
  const expectedAdmins = local.adminIds.filter(
    (id) => incoming.members.includes(id) && id !== expectedOwnerId
  )
  return (
    incoming.updatedBy === local.ownerId &&
    removed.length === 1 &&
    removed[0] === local.ownerId &&
    added.length === 0 &&
    incoming.name === local.name &&
    (incoming.avatarHash ?? '') === (local.avatarHash ?? '') &&
    incoming.ownerId === expectedOwnerId &&
    sameStringSet(incoming.adminIds, expectedAdmins)
  )
}

function sameManagementIdentity(left: GroupMeta, right: GroupMeta): boolean {
  return (
    left.creatorIp === right.creatorIp &&
    left.creatorId === right.creatorId &&
    left.adminSecretHash === right.adminSecretHash &&
    left.adminHint === right.adminHint
  )
}

function groupRoleOf(meta: GroupMeta, nodeId: string): GroupRole {
  if (!meta.members.includes(nodeId)) return 'left'
  if (meta.ownerId === nodeId) return 'owner'
  if (meta.adminIds.includes(nodeId)) return 'admin'
  return 'member'
}

function pickNextOwner(members: string[], adminIds: string[]): string {
  return members.find((id) => adminIds.includes(id)) ?? members[0] ?? ''
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function symmetricDifferenceSize(left: string[], right: string[]): number {
  return left.filter((value) => !right.includes(value)).length +
    right.filter((value) => !left.includes(value)).length
}

function isSingleOperationPatch(patch: GroupPatch): boolean {
  const raw = patch as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  const hasOnly = (allowed: string[]): boolean =>
    Object.keys(value).every((key) => allowed.includes(key))
  const validPassword =
    value.adminPassword === undefined ||
    (typeof value.adminPassword === 'string' && value.adminPassword.length <= LIMITS.groupAdminPassword)
  const validMemberIds = (memberIds: unknown): memberIds is string[] =>
    Array.isArray(memberIds) &&
    memberIds.length > 0 &&
    memberIds.length <= GROUP_MAX_MEMBERS &&
    memberIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= LIMITS.from)

  if (value.kind === 'rename') {
    return (
      hasOnly(['kind', 'name', 'adminPassword']) &&
      typeof value.name === 'string' &&
      value.name.length <= 32 &&
      validPassword
    )
  }
  if (value.kind === 'invite') {
    return hasOnly(['kind', 'memberIds']) && validMemberIds(value.memberIds)
  }
  if (value.kind === 'remove') {
    return (
      hasOnly(['kind', 'memberIds', 'adminPassword']) &&
      validMemberIds(value.memberIds) &&
      validPassword
    )
  }
  if (value.kind === 'set-avatar') {
    return (
      hasOnly(['kind', 'avatarHash', 'adminPassword']) &&
      (value.avatarHash === '' || isAvatarHash(value.avatarHash)) &&
      validPassword
    )
  }
  if (value.kind === 'set-description') {
    return (
      hasOnly(['kind', 'description', 'adminPassword']) &&
      typeof value.description === 'string' &&
      value.description.length <= LIMITS.groupDescription &&
      validPassword
    )
  }
  if (value.kind === 'set-announce') {
    return (
      hasOnly(['kind', 'announce', 'adminPassword']) &&
      typeof value.announce === 'string' &&
      value.announce.length <= LIMITS.groupAnnounce &&
      validPassword
    )
  }
  return (
    value.kind === 'set-admin' &&
    hasOnly(['kind', 'memberId', 'enabled']) &&
    typeof value.memberId === 'string' &&
    value.memberId.length > 0 &&
    value.memberId.length <= LIMITS.from &&
    typeof value.enabled === 'boolean'
  )
}

function makePkRef(game: PkGame): PkRefView {
  return {
    game,
    result: game === 'dice' ? randomInt(1, 7) : randomRps()
  }
}

function randomRps(): PkResult {
  return ['rock', 'paper', 'scissors'][randomInt(0, 3)] as PkResult
}
