import { defineStore } from 'pinia'
import type {
  ConversationView,
  ForwardResult,
  ForwardTarget,
  MessageView,
  NudgeEvent,
  NudgeResult,
  ReplyMeta,
  TableTextMeta
} from '../../../shared/ipc'
import type { PkGame } from '../../../shared/pk'
import { isWindowAttended } from '../utils/window-attention'

// 主进程聊天数据的投影 + 乐观更新（tech-design §7 状态流）
let nudgeClearTimer: ReturnType<typeof setTimeout> | null = null
let nudgeOpenRun = 0
let navigationRun = 0
// 移除聊天的 10 秒撤回窗口（决议 #125）：commit 定时器 + 每秒倒计时
let removalCommitTimer: ReturnType<typeof setTimeout> | null = null
let removalTickTimer: ReturnType<typeof setInterval> | null = null

interface MessageCache {
  list: MessageView[]
  ids: Set<string>
  byId: Map<string, MessageView>
}

const messageCaches = new Map<string, MessageCache>()

function rebuildMessageCache(convId: string, list: MessageView[]): MessageCache {
  const cache: MessageCache = {
    list,
    ids: new Set<string>(),
    byId: new Map<string, MessageView>()
  }
  for (const msg of list) {
    cache.ids.add(msg.id)
    cache.byId.set(msg.id, msg)
  }
  messageCaches.set(convId, cache)
  return cache
}

function messageCacheFor(convId: string, list: MessageView[]): MessageCache {
  const cache = messageCaches.get(convId)
  return cache && cache.list === list ? cache : rebuildMessageCache(convId, list)
}

function dropMessageCache(convId: string): void {
  messageCaches.delete(convId)
}

interface PendingRemoval {
  convId: string
  name: string
  secondsLeft: number
}

type ConversationOpenScrollMode = 'restore' | 'latest' | 'target'

interface OpenConversationOptions {
  scroll?: ConversationOpenScrollMode
}

interface ConversationScrollPosition {
  top: number
  atBottom: boolean
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    convs: [] as ConversationView[],
    activeConvId: null as string | null,
    /** 本次打开会话后消息区应如何定位（纯渲染层状态，决议 #111） */
    openScrollMode: 'latest' as ConversationOpenScrollMode,
    openScrollRun: 0,
    /** convId → 离开会话时的滚动位置 */
    scrollPositions: {} as Record<string, ConversationScrollPosition>,
    /** convId → 已加载消息（按 seq 升序） */
    messages: {} as Record<string, MessageView[]>,
    /** 搜索跳转后的高亮目标（短暂） */
    highlightId: null as string | null,
    /** 正在查看历史窗口（非最新页）——显示"回到最新"按钮 */
    viewingHistory: false,
    selfId: '',
    selfNick: '',
    selfAvatar: -1,
    selfAvatarHash: '',
    lastNudge: null as NudgeEvent | null,
    /** 移除聊天的待删除项（决议 #125）：非空时该会话在列表中隐藏，10 秒倒计时内可撤回 */
    pendingRemoval: null as PendingRemoval | null,
    initialized: false
  }),
  getters: {
    activeConv(state): ConversationView | null {
      return state.convs.find((c) => c.id === state.activeConvId) ?? null
    },
    activeMessages(state): MessageView[] {
      return state.activeConvId ? (state.messages[state.activeConvId] ?? []) : []
    },
    /** 会话列表展示用：隐藏处于撤回窗口内的待删除会话（决议 #125） */
    visibleConvs(state): ConversationView[] {
      const hidden = state.pendingRemoval?.convId
      return hidden ? state.convs.filter((c) => c.id !== hidden) : state.convs
    },
    totalUnread(state): number {
      const hidden = state.pendingRemoval?.convId
      return state.convs.reduce((sum, c) => (c.id === hidden ? sum : sum + c.unread), 0)
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      this.convs = await window.pantry.listConversations()
      this.selfId = (await window.pantry.getAppInfo()).nodeId
      // 自己的昵称/头像（群成员列表里显示「昵称（我）」+ 真实头像，决议 #83）
      const selfSettings = await window.pantry.getSettings()
      if (selfSettings) {
        this.selfNick = selfSettings.nick
        this.selfAvatar = selfSettings.avatar
        this.selfAvatarHash = selfSettings.avatarHash
      }
      window.pantry.onSettingsUpdated((next) => {
        this.selfNick = next.nick
        this.selfAvatar = next.avatar
        this.selfAvatarHash = next.avatarHash
      })

      window.pantry.onConvsUpdated((convs) => {
        this.convs = convs
      })
      window.pantry.onMsgNew((msg) => {
        if (this.messages[msg.convId]) this.appendConversationMessage(msg.convId, msg)
        // 只有窗口可见且聚焦才把当前会话新消息即时置读；最小化 / 托盘 / 失焦时
        // 保留未读，托盘闪烁与角标才能被感知（决议 #220）
        if (msg.convId === this.activeConvId && isWindowAttended()) {
          void window.pantry.markRead(msg.convId)
        }
      })
      // 回到窗口时补置读当前会话攒下的未读，托盘闪烁与角标同步停止（决议 #220）
      window.addEventListener('focus', () => {
        const convId = this.activeConvId
        if (convId && this.convs.some((c) => c.id === convId && c.unread > 0)) {
          void window.pantry.markRead(convId)
        }
      })
      window.pantry.onMsgStatus((event) => {
        this.updateConversationMessageStatus(event.convId, event.id, event.status)
      })
      window.pantry.onNudgeReceived((event) => {
        const run = ++nudgeOpenRun
        void this.openConv(event.convId, { scroll: 'latest' }).then(() => {
          if (run !== nudgeOpenRun) return
          this.lastNudge = event
          if (nudgeClearTimer) clearTimeout(nudgeClearTimer)
          nudgeClearTimer = setTimeout(() => {
            if (this.lastNudge?.ts === event.ts && this.lastNudge.peerId === event.peerId) {
              this.lastNudge = null
            }
          }, 3000)
        })
      })
      // 点系统通知/托盘 → 直达对应会话（F-SYS-2），单聊群聊通用
      window.pantry.onOpenConv((convId) => {
        void this.openConv(convId, { scroll: 'latest' })
      })
      // 截图选择"发送"：发到当前会话（无可发送会话则只留在剪贴板）
      window.pantry.onCaptured((bytes) => {
        const conv = this.activeConv
        if (conv) void this.sendImageBytes('截图.png', bytes)
      })
    },

    /** 从通讯录或会话列表进入会话 */
    async openPeer(
      peerNodeId: string,
      options: OpenConversationOptions = { scroll: 'latest' },
      run = ++navigationRun
    ): Promise<void> {
      const scroll = options.scroll ?? 'latest'
      const conv = await window.pantry.openConversation(peerNodeId)
      if (!conv || run !== navigationRun) return
      this.upsertConversation(conv)
      this.activeConvId = conv.id
      this.viewingHistory = false
      // latest 语义 = 必看最新页：即使已缓存（可能是历史搜索上下文窗口或不完整页），
      // 也重载最新一页，确保贴的"底部"就是真正最新消息（震动 / 通知直达，决议 #133）
      if (scroll === 'latest' || !this.messages[conv.id]) {
        const messages = await window.pantry.pageMessages(conv.id, null, 50)
        if (run !== navigationRun) return
        this.setConversationMessages(conv.id, messages)
      }
      if (run !== navigationRun) return
      this.requestConversationScroll(scroll)
    },

    /** 按会话 id 打开（会话列表 / 群会话 / 通知跳转通用）：用户主动进入默认看最新（决议 #192）。 */
    async openConv(convId: string, options: OpenConversationOptions = { scroll: 'latest' }): Promise<void> {
      const run = ++navigationRun
      const scroll = options.scroll ?? 'latest'
      if (convId.startsWith('single:')) {
        await this.openPeer(convId.slice(7), { scroll }, run)
        return
      }
      this.activeConvId = convId
      this.viewingHistory = false
      // latest 入口（通知 / 托盘直达等）重载最新页，不复用可能过期 / 历史的缓存（决议 #133）
      if (scroll === 'latest' || !this.messages[convId]) {
        const messages = await window.pantry.pageMessages(convId, null, 50)
        if (run !== navigationRun) return
        this.setConversationMessages(convId, messages)
      }
      await window.pantry.markRead(convId)
      if (run !== navigationRun) return
      this.requestConversationScroll(scroll)
    },

    /** 搜索结果跳转：载入目标前后窗口并短暂高亮（ui-design §6） */
    async jumpToMessage(convId: string, seq: number, msgId: string): Promise<void> {
      const run = ++navigationRun
      if (convId.startsWith('single:')) {
        const conv = await window.pantry.openConversation(convId.slice(7))
        if (!conv || run !== navigationRun) return
      } else {
        await window.pantry.markRead(convId)
        if (run !== navigationRun) return
      }
      this.activeConvId = convId
      const ctx = await window.pantry.getMessageContext(convId, seq)
      if (run !== navigationRun || this.activeConvId !== convId) return
      this.setConversationMessages(convId, ctx)
      // 跳转窗口若已含会话最新消息（尾条 ts 触达 lastTs），则不算"看历史"，
      // 避免点最新命中 / 关闭搜索后仍误显"回到最新"（决议 #74）
      const conv = this.convs.find((c) => c.id === convId)
      const tail = ctx[ctx.length - 1]
      this.viewingHistory = !(conv && tail && tail.ts >= conv.lastTs)
      this.highlightId = msgId || null
      this.requestConversationScroll('target')
      setTimeout(() => {
        if (run === navigationRun && this.highlightId === msgId) this.highlightId = null
      }, 2600)
    },

    async backToLatest(): Promise<void> {
      const convId = this.activeConvId
      if (!convId) return
      const run = ++navigationRun
      const messages = await window.pantry.pageMessages(convId, null, 50)
      if (run !== navigationRun || this.activeConvId !== convId) return
      this.setConversationMessages(convId, messages)
      this.viewingHistory = false
      this.requestConversationScroll('latest')
    },

    requestConversationScroll(mode: ConversationOpenScrollMode): void {
      this.openScrollMode = mode
      this.openScrollRun += 1
    },

    setConversationMessages(convId: string, messages: MessageView[]): void {
      this.messages[convId] = messages
      rebuildMessageCache(convId, this.messages[convId] ?? [])
    },

    appendConversationMessage(convId: string, msg: MessageView): boolean {
      const list = (this.messages[convId] ??= [])
      const cache = messageCacheFor(convId, list)
      if (cache.ids.has(msg.id)) return false
      list.push(msg)
      const stored = list[list.length - 1]
      cache.ids.add(stored.id)
      cache.byId.set(stored.id, stored)
      return true
    },

    prependEarlierMessages(convId: string, messages: MessageView[]): number {
      const list = (this.messages[convId] ??= [])
      const cache = messageCacheFor(convId, list)
      const fresh = messages.filter((msg) => !cache.ids.has(msg.id))
      if (fresh.length === 0) return 0
      this.setConversationMessages(convId, [...fresh, ...list])
      return fresh.length
    },

    trimConversationHead(convId: string, keep = 300): number {
      const list = this.messages[convId]
      const normalizedKeep = Math.max(0, Math.floor(keep))
      if (!list || list.length <= normalizedKeep) return 0
      const trimmed = list.length - normalizedKeep
      this.setConversationMessages(convId, normalizedKeep > 0 ? list.slice(-normalizedKeep) : [])
      return trimmed
    },

    updateConversationMessageStatus(convId: string, msgId: string, status: MessageView['status']): void {
      const list = this.messages[convId]
      if (!list) return
      const target = messageCacheFor(convId, list).byId.get(msgId)
      if (target) target.status = status
    },

    rememberConversationScroll(convId: string, top: number, atBottom: boolean): void {
      this.scrollPositions[convId] = {
        top: Math.max(0, Math.round(top)),
        atBottom
      }
    },

    forgetConversationScrolls(): void {
      this.scrollPositions = {}
    },

    upsertConversation(conv: ConversationView): void {
      const index = this.convs.findIndex((item) => item.id === conv.id)
      if (index >= 0) this.convs[index] = conv
      else this.convs = [conv, ...this.convs]
    },

    async pinConversation(convId: string, pinned: boolean): Promise<void> {
      await window.pantry.pinConversation(convId, pinned)
    },

    async muteConversation(convId: string, muted: boolean): Promise<void> {
      await window.pantry.muteConversation(convId, muted)
    },

    /**
     * 移除聊天（决议 #125）：二次确认后调用——先本地隐藏会话并开 10 秒撤回窗口，期间不落库；
     * 10 秒内撤回则恢复，超时才真正删除聊天记录（消息 + 全文索引 + 会话条目）。
     */
    requestRemoveConversation(convId: string, name: string): void {
      // 一次只保留一个待删除项：已有未决删除先立即落库
      if (this.pendingRemoval) void this.commitRemoval()
      this.clearRemovalTimers()
      this.pendingRemoval = { convId, name, secondsLeft: 10 }
      if (this.activeConvId === convId) this.activeConvId = null
      removalTickTimer = setInterval(() => {
        if (this.pendingRemoval && this.pendingRemoval.secondsLeft > 0) {
          this.pendingRemoval.secondsLeft -= 1
        }
      }, 1000)
      removalCommitTimer = setTimeout(() => {
        void this.commitRemoval()
      }, 10000)
    },

    /** 撤回移除：取消倒计时并恢复会话（无任何落库删除） */
    undoRemoveConversation(): void {
      this.clearRemovalTimers()
      this.pendingRemoval = null
    },

    /** 倒计时结束或被新移除挤掉时落库：真正删除聊天记录 */
    async commitRemoval(): Promise<void> {
      const pending = this.pendingRemoval
      this.clearRemovalTimers()
      this.pendingRemoval = null
      if (!pending) return
      await window.pantry.removeConversation(pending.convId)
      delete this.messages[pending.convId]
      dropMessageCache(pending.convId)
      delete this.scrollPositions[pending.convId]
    },

    clearRemovalTimers(): void {
      if (removalCommitTimer) {
        clearTimeout(removalCommitTimer)
        removalCommitTimer = null
      }
      if (removalTickTimer) {
        clearInterval(removalTickTimer)
        removalTickTimer = null
      }
    },

    async loadEarlier(): Promise<number> {
      const convId = this.activeConvId
      if (!convId) return 0
      const list = this.messages[convId] ?? []
      const before = list.length > 0 ? list[0].seq : null
      const earlier = await window.pantry.pageMessages(convId, before, 50)
      return this.prependEarlierMessages(convId, earlier)
    },

    async send(text: string, mentions: string[] = [], replyTo?: ReplyMeta): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      // 防止 IPC 传递数据时，无法被结构化克隆（Structured Clone）的对象
      replyTo = JSON.parse(JSON.stringify(replyTo ?? {}))
      const view =
        conv.type === 'group'
          ? await window.pantry.sendGroupText(conv.peerId, text, mentions, replyTo)
          : await window.pantry.sendText(conv.peerId, text)
      return this.pushOwn(view)
    },

    async resend(msgId: string): Promise<void> {
      await window.pantry.resendMessage(msgId)
    },

    async recall(msgId: string): Promise<boolean> {
      return window.pantry.recallMessage(msgId)
    },

    async sendNudge(): Promise<NudgeResult> {
      const conv = this.activeConv
      if (!conv || conv.type !== 'single') return { ok: false, reason: 'invalid' }
      return window.pantry.sendNudge(conv.peerId)
    },

    async sendPk(game: PkGame): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      return this.pushOwn(await window.pantry.sendPk(conv.id, game))
    },

    async forward(msgId: string, targets: ForwardTarget[]): Promise<ForwardResult> {
      const result = await window.pantry.forwardMessage(msgId, targets)
      for (const msg of result.messages) {
        if (this.messages[msg.convId]) this.appendConversationMessage(msg.convId, msg)
      }
      return result
    },

    /** 发文件（选择器或拖拽）；对方离线时主进程返回 null（决议 #4） */
    async sendFilePaths(paths: string[]): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view =
        conv.type === 'group'
          ? await window.pantry.offerGroupFiles(conv.peerId, paths)
          : await window.pantry.offerFiles(conv.peerId, paths)
      return this.pushOwn(view)
    },

    /** 磁盘图片按图片消息发送（拖拽图片/选择器） */
    async sendImagePath(path: string): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view =
        conv.type === 'group'
          ? await window.pantry.offerGroupImagePath(conv.peerId, path)
          : await window.pantry.offerImagePath(conv.peerId, path)
      return this.pushOwn(view)
    },

    /** 粘贴的图片字节（截图 Ctrl+V） */
    async sendImageBytes(name: string, bytes: ArrayBuffer, tableText?: TableTextMeta): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view =
        conv.type === 'group'
          ? await window.pantry.sendGroupImageBytes(conv.peerId, name, bytes, tableText)
          : await window.pantry.sendImageBytes(conv.peerId, name, bytes, tableText)
      return this.pushOwn(view)
    },

    /** 发送收藏的表情包（单聊 / 群聊均复用图片传输通道） */
    async sendSticker(stickerId: string): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view = await window.pantry.sendSticker(conv.peerId, stickerId, conv.type === 'group')
      return this.pushOwn(view)
    },

    pushOwn(view: MessageView | null): boolean {
      if (!view) return false
      if (this.messages[view.convId]) this.appendConversationMessage(view.convId, view)
      if (view.convId === this.activeConvId) {
        this.viewingHistory = false
        this.requestConversationScroll('latest')
      }
      return true
    }
  }
})
