import { screenRecordText, systemMessage } from '../../i18n/messages'
import { formatTemplate } from '../../i18n'
import { parseScreenRecord, type ScreenRecord, type ScreenState } from '../../shared/remote-view'
import type { SystemMessageKey } from '../../shared/i18n'
import { randomInt } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  MSG_TYPES,
  NUDGE_MAX_PER_WINDOW,
  NUDGE_MIN_INTERVAL_MS,
  NUDGE_RATE_WINDOW_MS,
  RECALL_WINDOW_MS,
  TEXT_TCP_LIMIT,
  type Envelope,
  type MsgPayload
} from '../../shared/protocol'
import type {
  ConversationView,
  MessageView,
  MsgStatusEvent,
  NudgeEvent,
  NudgeResult
} from '../../shared/ipc'
import { makeEnvelope } from '../net/codec'
import type { Messenger } from '../net/messenger'
import { ConvRepo, convRowToView, type ConvRow } from '../store/conv-repo'
import { GroupRepo } from '../store/group-repo'
import { MsgRepo, msgRowToView, type MsgRow } from '../store/msg-repo'
import type { PeerClock } from '../net/peer-clock'
import {
  isPkGame,
  parsePkRef,
  pkPreview,
  type PkGame,
  type PkRefView,
  type PkResult
} from '../../shared/pk'

// 聊天用例编排（tech-design §3）：发消息 = 写库 → 网络 → 状态回推。
// 事件出口：'message'（新消息入库）、'status'（发送状态变化）、'convs'（会话列表变化）。
// 不依赖 Electron —— index.ts 负责把事件桥接到窗口。

export interface ChatDeps {
  selfId: string
  convRepo: ConvRepo
  msgRepo: MsgRepo
  groupRepo?: GroupRepo
  messenger: Messenger
  /** 打开会话时的探活回调（F-DISC-8），由 index 接 discovery.probeNode */
  probe?: (peerId: string) => void
  /** 时钟偏移矫正（决议 #65）：把对方消息显示时间换算到本机钟 */
  peerClock?: PeerClock
  /** 在线即时能力（PK）：发送前确认对端仍在线 */
  isOnline?: (peerId: string) => boolean
  /** 媒体撤回由文件服务判断 transfer 状态并取消未完成传输。 */
  mediaRecall?: {
    canRecall: (row: MsgRow) => boolean
    applyLocalRecall: (row: MsgRow) => void
    applyIncomingRecall: (row: MsgRow) => boolean
  }
}

const toConvView = convRowToView
const toMsgView = msgRowToView

export class ChatService extends EventEmitter {
  private readonly pendingRecalls = new Map<
    string,
    { env: Envelope<MsgPayload>; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly outgoingNudges = new Map<string, number[]>()
  private readonly incomingNudges = new Map<string, number[]>()
  private convsScheduled = false

  constructor(private readonly deps: ChatDeps) {
    super()

    deps.messenger.on('incoming', (env: Envelope) => this.onIncoming(env))
    deps.messenger.on('status', (msgId: string, status: 'sent') => {
      // 补发成功（queued → sent）
      this.applyStatus(msgId, status)
    })

    const reset = deps.msgRepo.resetStaleSending()
    if (reset > 0) console.warn(`[chat] 启动自愈：${reset} 条残留"发送中"已复位为失败`)
  }

  listConversations(): ConversationView[] {
    return this.deps.convRepo.list().map(toConvView)
  }

  /** 打开会话时探活；未读由真正展示消息面板的窗口清除。 */
  openConversation(peerId: string): ConversationView {
    const convId = this.deps.convRepo.ensureSingle(peerId)
    this.deps.probe?.(peerId)
    this.emitConvs()
    const row = this.deps.convRepo.get(convId)
    return toConvView(row as ConvRow)
  }

  openGroupConversation(groupId: string): ConversationView | null {
    if (!this.deps.groupRepo?.get(groupId)?.members.includes(this.deps.selfId)) return null
    const id = this.deps.convRepo.ensureGroup(groupId)
    this.emitConvs()
    return toConvView(this.deps.convRepo.get(id) as ConvRow)
  }

  pageMessages(convId: string, beforeSeq: number | null, limit = 50): MessageView[] {
    return this.deps.msgRepo.page(convId, beforeSeq, limit).map(toMsgView)
  }

  /** 本机服务生命周期记录；与线上消息发送、帧流和未读计数无关。 */
  recordScreen(state: ScreenState, initial: boolean): void {
    const { role, phase, requestedAt, startedAt, endedAt, durationMs, reason } = state
    const record: ScreenRecord = { v: 1, role, phase, requestedAt, startedAt, endedAt, durationMs, reason }
    const id = `screen:${state.peerId}:${state.sessionId}`
    const previous = this.deps.msgRepo.get(id)
    if (!previous) {
      // 只有新邀请/当场拒绝可插入，用户删掉聊天后后续状态不能复活它。
      if (!initial) return
      const convId = this.deps.convRepo.ensureSingle(state.peerId)
      this.deps.msgRepo.insert({ id, convId, senderId: role === 'viewer' ? this.deps.selfId : state.peerId,
        isMine: role === 'viewer', kind: 'system', content: screenRecordText(record, formatTemplate),
        fileRef: JSON.stringify({ screen: record }), ts: requestedAt, status: 'sent' })
      this.deps.convRepo.bump(convId, requestedAt)
    } else {
      if (parseScreenRecord(previous.file_ref)?.phase === 'ended' || previous.file_ref === JSON.stringify({ screen: record })) return
      this.deps.msgRepo.updateScreen(id, record)
    }
    const row = this.deps.msgRepo.get(id)
    if (row) this.emit(previous ? 'message-updated' : 'message', toMsgView(row))
    this.emitConvs()
  }

  markRead(convId: string): void {
    this.deps.convRepo.markRead(convId)
    this.emitConvs()
  }

  setPinned(convId: string, pinned: boolean): void {
    this.deps.convRepo.setPinned(convId, pinned)
    this.emitConvs()
  }

  setMuted(convId: string, muted: boolean): void {
    this.deps.convRepo.setMuted(convId, muted)
    this.emitConvs()
  }

  isMuted(convId: string): boolean {
    return this.isConversationMuted(convId)
  }

  // 移除聊天（决议 #125）：删除该会话的全部聊天记录（消息 + 全文索引）后再移除会话条目；
  // 渲染层在调用前已做二次确认与 10 秒撤回窗口，到这里即真正落库删除。
  removeConversation(convId: string): void {
    this.deps.msgRepo.deleteByConv(convId)
    this.deps.convRepo.remove(convId)
    this.emitConvs()
  }

  /** 发文本：入库（sending）→ 立即回显 → 异步走网络，结果经 status 事件回推 */
  sendText(peerId: string, text: string): MessageView | null {
    const trimmed = text.trim()
    if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > TEXT_TCP_LIMIT) return null

    const convId = this.deps.convRepo.ensureSingle(peerId)
    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, this.deps.selfId, {
      kind: 'text',
      text: trimmed
    })
    this.deps.msgRepo.insert({
      id: env.id,
      convId,
      senderId: this.deps.selfId,
      isMine: true,
      kind: 'text',
      content: trimmed,
      ts: env.ts,
      status: 'sending'
    })
    this.deps.convRepo.bump(convId, env.ts)
    this.emitConvs()

    void this.deps.messenger.sendUserMessage(peerId, env).then((outcome) => {
      this.applyStatus(env.id, outcome)
    })

    const row = this.deps.msgRepo.get(env.id)
    return row ? toMsgView(row) : null
  }

  /** 私聊窗口震动：可靠即时动作，不离线补发；发送成功后写本地系统提示（决议 #109/#110）。 */
  async sendNudge(peerId: string): Promise<NudgeResult> {
    if (!peerId || peerId.length > 64) return { ok: false, reason: 'invalid' }
    const convId = this.deps.convRepo.ensureSingle(peerId)
    const limit = this.consumeNudgeLimit(this.outgoingNudges, peerId, Date.now())
    if (!limit.ok) return limit

    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, this.deps.selfId, { kind: 'nudge' })
    const delivered = await this.deps.messenger.sendReliable(peerId, env)
    if (!delivered) return { ok: false, reason: 'undelivered' }

    this.insertSystemTip(env.id, convId, this.deps.selfId, 'nudge.sent', env.ts, false)
    return { ok: true }
  }

  sendPk(peerId: string, game: PkGame): MessageView | null {
    if (!peerId || peerId.length > 64 || !isPkGame(game)) return null
    if (!this.deps.isOnline?.(peerId)) return null
    const convId = this.deps.convRepo.ensureSingle(peerId)
    const ref = makePkRef(game)
    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, this.deps.selfId, {
      kind: 'pk',
      game: ref.game,
      result: ref.result
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
      status: 'sending'
    })
    this.deps.convRepo.bump(convId, env.ts)
    this.emitConvs()

    void this.deps.messenger.sendReliable(peerId, env).then((ok) => {
      this.applyStatus(env.id, ok ? 'sent' : 'failed')
    })

    const row = this.deps.msgRepo.get(env.id)
    return row ? toMsgView(row) : null
  }

  /** 手动重发（失败/排队中的自己的消息）：沿用原 id，对端凭 id 去重 */
  resend(msgId: string): boolean {
    const row = this.deps.msgRepo.get(msgId)
    if (!row || row.is_mine === 0) return false
    if (row.status !== 'failed' && row.status !== 'queued') return false
    const peerId = row.conv_id.startsWith('single:') ? row.conv_id.slice(7) : ''
    if (!peerId) return false

    if (row.kind === 'pk') {
      const ref = parsePkRef(row.file_ref)
      if (!ref) return false
      const env: Envelope<MsgPayload> = {
        v: 1,
        type: MSG_TYPES.msg,
        id: row.id,
        from: this.deps.selfId,
        ts: row.ts,
        payload: { kind: 'pk', game: ref.game, result: ref.result }
      }
      this.applyStatus(msgId, 'sending')
      void this.deps.messenger.sendReliable(peerId, env).then((ok) => {
        this.applyStatus(msgId, ok ? 'sent' : 'failed')
      })
      return true
    }

    if (row.kind !== 'text') return false
    const env: Envelope<MsgPayload> = {
      v: 1,
      type: MSG_TYPES.msg,
      id: row.id,
      from: this.deps.selfId,
      ts: row.ts,
      payload: { kind: 'text', text: row.content, resend: true }
    }
    this.applyStatus(msgId, 'sending')
    void this.deps.messenger.sendUserMessage(peerId, env).then((outcome) => {
      this.applyStatus(msgId, outcome)
    })
    return true
  }

  /** 撤回自己的消息：本地先隐藏，撤回指令复用可靠消息通道投递给对端/群成员 */
  recall(msgId: string): boolean {
    const row = this.deps.msgRepo.get(msgId)
    if (!row || !this.canRecall(row)) return false

    const payload = this.recallPayloadFor(row)
    if (!payload) return false
    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, this.deps.selfId, payload)

    if (row.conv_id.startsWith('single:')) {
      const peerId = row.conv_id.slice(7)
      this.deps.messenger.dropQueuedMessage(row.id, [peerId])
      this.applyRecall(row, env.id, 'recall.self', env.ts, false)
      void this.deps.messenger.sendUserMessage(peerId, env)
      return true
    }

    const groupId = row.conv_id.startsWith('group:') ? row.conv_id.slice(6) : ''
    const meta = groupId ? this.deps.groupRepo?.get(groupId) : null
    if (!meta || !meta.members.includes(this.deps.selfId)) return false
    const recipients = meta.members.filter((member) => member !== this.deps.selfId)
    this.deps.messenger.dropQueuedMessage(row.id, recipients)
    this.applyRecall(row, env.id, 'recall.self', env.ts, false)
    for (const member of meta.members) {
      if (member !== this.deps.selfId) void this.deps.messenger.sendUserMessage(member, env)
    }
    return true
  }

  /** 周期清理：被裁剪出队的单聊消息标记为失败（群消息按成员排队，单成员裁剪不改全局状态） */
  prune(): void {
    for (const { msgId } of this.deps.messenger.prune()) {
      const row = this.deps.msgRepo.get(msgId)
      if (row && row.conv_id.startsWith('single:')) this.applyStatus(msgId, 'failed')
    }
  }

  private onIncoming(env: Envelope): void {
    if (env.type !== MSG_TYPES.msg) return // file-ctl 等其他可靠类型由对应服务处理
    const payload = env.payload as MsgPayload
    if (payload.kind === 'recall') {
      this.onIncomingRecall(env as Envelope<MsgPayload>)
      return
    }
    if (payload.kind === 'nudge') {
      this.onIncomingNudge(env as Envelope<MsgPayload>)
      return
    }
    if (payload.kind === 'pk') {
      if (payload.groupId) return
      this.onIncomingPk(env as Envelope<MsgPayload>)
      return
    }
    if (payload.kind === 'group-text') {
      this.deferPendingRecall(env.id)
      return
    }
    if (payload.kind !== 'text') return
    const convId = this.deps.convRepo.ensureSingle(env.from)
    // 实时消息（非补发）顺带校准时钟偏移；显示时间矫正到本机钟（决议 #65）；排序仍用本地 seq
    if (!payload.resend) this.deps.peerClock?.observe(env.from, env.ts, Date.now())
    const ts = this.deps.peerClock?.correct(env.from, env.ts) ?? env.ts
    const inserted = this.deps.msgRepo.insert({
      id: env.id,
      convId,
      senderId: env.from,
      isMine: false,
      kind: 'text',
      content: payload.text,
      ts,
      status: 'sent'
    })
    if (!inserted) return // 持久化去重之外的最后一道闸（messages 主键幂等）
    this.deps.convRepo.bump(convId, ts)
    this.deps.convRepo.incUnread(convId)
    const row = this.deps.msgRepo.get(env.id)
    if (row) this.emit('message', toMsgView(row))
    this.emitConvs()
    this.deferPendingRecall(env.id)
  }

  private onIncomingPk(env: Envelope<MsgPayload>): void {
    const payload = env.payload
    if (payload.kind !== 'pk' || payload.groupId) return
    const convId = this.deps.convRepo.ensureSingle(env.from)
    this.deps.peerClock?.observe(env.from, env.ts, Date.now())
    const ts = this.deps.peerClock?.correct(env.from, env.ts) ?? env.ts
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
    if (!inserted) return
    this.deps.convRepo.bump(convId, ts)
    this.deps.convRepo.incUnread(convId)
    const row = this.deps.msgRepo.get(env.id)
    if (row) this.emit('message', toMsgView(row))
    this.emitConvs()
    this.deferPendingRecall(env.id)
  }

  private onIncomingRecall(env: Envelope<MsgPayload>): void {
    const payload = env.payload
    if (payload.kind !== 'recall') return
    const target = this.deps.msgRepo.get(payload.targetId)
    if (!target) {
      this.rememberPendingRecall(payload.targetId, env)
      return
    }
    this.applyIncomingRecall(env, target)
  }

  private onIncomingNudge(env: Envelope<MsgPayload>): void {
    const payload = env.payload
    if (payload.kind !== 'nudge') return
    if (this.deps.msgRepo.get(env.id)) return
    const limit = this.consumeNudgeLimit(this.incomingNudges, env.from, Date.now())
    if (!limit.ok) return
    const ts = Date.now()
    const convId = this.deps.convRepo.ensureSingle(env.from)
    const inserted = this.insertSystemTip(
      env.id,
      convId,
      env.from,
      'nudge.received',
      ts,
      false
    )
    if (!inserted) return
    if (this.isConversationMuted(convId)) return
    const event: NudgeEvent = {
      peerId: env.from,
      convId,
      ts
    }
    this.emit('nudge', event)
  }

  private rememberPendingRecall(targetId: string, env: Envelope<MsgPayload>): void {
    const old = this.pendingRecalls.get(targetId)
    if (old) clearTimeout(old.timer)
    const timer = setTimeout(() => this.pendingRecalls.delete(targetId), RECALL_WINDOW_MS)
    timer.unref?.()
    this.pendingRecalls.set(targetId, { env, timer })
  }

  private deferPendingRecall(targetId: string): void {
    if (!this.pendingRecalls.has(targetId)) return
    setTimeout(() => {
      const pending = this.pendingRecalls.get(targetId)
      const target = this.deps.msgRepo.get(targetId)
      if (!pending || !target) return
      this.pendingRecalls.delete(targetId)
      clearTimeout(pending.timer)
      this.applyIncomingRecall(pending.env, target)
    }, 0)
  }

  private applyIncomingRecall(env: Envelope<MsgPayload>, target: MsgRow): void {
    const payload = env.payload
    if (payload.kind !== 'recall') return
    if (target.sender_id !== env.from) return
    const expectedConv = payload.groupId ? `group:${payload.groupId}` : `single:${env.from}`
    if (target.conv_id !== expectedConv) return
    if (target.status === 'recalled') return
    if (isMediaRecallKind(target.kind) && !this.deps.mediaRecall?.applyIncomingRecall(target)) {
      return
    }
    this.applyRecall(target, env.id, 'recall.peer', env.ts, true, false)
  }

  private canRecall(row: MsgRow): boolean {
    if (row.is_mine === 0) return false
    if (row.status === 'recalled') return false
    if (isMediaRecallKind(row.kind) && !this.deps.mediaRecall?.canRecall(row)) return false
    if (row.kind !== 'text' && row.kind !== 'pk' && !isMediaRecallKind(row.kind)) return false
    return Date.now() - row.ts <= RECALL_WINDOW_MS
  }

  private recallPayloadFor(row: MsgRow): MsgPayload | null {
    if (row.conv_id.startsWith('single:')) {
      return { kind: 'recall', targetId: row.id }
    }
    if (!row.conv_id.startsWith('group:')) return null
    const groupId = row.conv_id.slice(6)
    const meta = this.deps.groupRepo?.get(groupId)
    if (!meta) return null
    return { kind: 'recall', targetId: row.id, groupId, groupRev: meta.rev }
  }

  private applyRecall(
    target: MsgRow,
    tipId: string,
    tip: SystemMessageKey,
    ts: number,
    countUnread: boolean,
    applyMediaRecall = true
  ): void {
    if (applyMediaRecall && isMediaRecallKind(target.kind)) this.deps.mediaRecall?.applyLocalRecall(target)
    this.deps.msgRepo.recall(target.id)
    this.emit('status', { id: target.id, convId: target.conv_id, status: 'recalled' } satisfies MsgStatusEvent)

    const inserted = this.deps.msgRepo.insert({
      id: tipId,
      convId: target.conv_id,
      senderId: target.sender_id,
      isMine: false,
      kind: 'system',
      ...systemMessage(tip),
      ts,
      status: 'sent'
    })
    this.deps.convRepo.bump(target.conv_id, ts)
    if (countUnread && inserted) this.deps.convRepo.incUnread(target.conv_id)
    const row = this.deps.msgRepo.get(tipId)
    if (row && inserted) this.emit('message', toMsgView(row))
    this.emitConvs()
  }

  private insertSystemTip(
    id: string,
    convId: string,
    senderId: string,
    content: SystemMessageKey,
    ts: number,
    countUnread: boolean
  ): boolean {
    const inserted = this.deps.msgRepo.insert({
      id,
      convId,
      senderId,
      isMine: false,
      kind: 'system',
      ...systemMessage(content),
      ts,
      status: 'sent'
    })
    if (!inserted) return false
    this.deps.convRepo.bump(convId, ts)
    if (countUnread) this.deps.convRepo.incUnread(convId)
    const row = this.deps.msgRepo.get(id)
    if (row) this.emit('message', toMsgView(row))
    this.emitConvs()
    return true
  }

  private applyStatus(msgId: string, status: MessageView['status']): void {
    const row = this.deps.msgRepo.get(msgId)
    if (!row) return
    if (row.status === 'recalled' && status !== 'recalled') return
    this.deps.msgRepo.updateStatus(msgId, status)
    const event: MsgStatusEvent = { id: msgId, convId: row.conv_id, status }
    this.emit('status', event)
  }

  private emitConvs(): void {
    if (this.convsScheduled) return
    this.convsScheduled = true
    queueMicrotask(() => {
      this.convsScheduled = false
      this.emit('convs', this.listConversations())
    })
  }

  private isConversationMuted(convId: string): boolean {
    return (this.deps.convRepo.get(convId)?.muted ?? 0) !== 0
  }

  private consumeNudgeLimit(
    bucket: Map<string, number[]>,
    peerId: string,
    now: number
  ): NudgeResult {
    const windowStart = now - NUDGE_RATE_WINDOW_MS
    const recent = (bucket.get(peerId) ?? []).filter((ts) => ts > windowStart)
    const last = recent[recent.length - 1]
    let retryAfterMs = 0

    if (last !== undefined && now - last < NUDGE_MIN_INTERVAL_MS) {
      retryAfterMs = Math.max(retryAfterMs, NUDGE_MIN_INTERVAL_MS - (now - last))
    }
    if (recent.length >= NUDGE_MAX_PER_WINDOW) {
      retryAfterMs = Math.max(retryAfterMs, NUDGE_RATE_WINDOW_MS - (now - recent[0]))
    }
    if (retryAfterMs > 0) {
      bucket.set(peerId, recent)
      return { ok: false, reason: 'rate-limited', retryAfterMs }
    }

    recent.push(now)
    bucket.set(peerId, recent)
    return { ok: true }
  }
}

function makePkRef(game: PkGame): PkRefView {
  return {
    game,
    result: game === 'dice' ? randomInt(1, 7) : randomRps()
  }
}

function isMediaRecallKind(kind: string): boolean {
  return kind === 'image' || kind === 'file'
}

function randomRps(): PkResult {
  return ['rock', 'paper', 'scissors'][randomInt(0, 3)] as PkResult
}
