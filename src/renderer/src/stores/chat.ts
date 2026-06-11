import { defineStore } from 'pinia'
import type { ConversationView, MessageView } from '../../../shared/ipc'

// 主进程聊天数据的投影 + 乐观更新（tech-design §7 状态流）
export const useChatStore = defineStore('chat', {
  state: () => ({
    convs: [] as ConversationView[],
    activeConvId: null as string | null,
    /** convId → 已加载消息（按 seq 升序） */
    messages: {} as Record<string, MessageView[]>,
    initialized: false
  }),
  getters: {
    activeConv(state): ConversationView | null {
      return state.convs.find((c) => c.id === state.activeConvId) ?? null
    },
    activeMessages(state): MessageView[] {
      return state.activeConvId ? (state.messages[state.activeConvId] ?? []) : []
    },
    totalUnread(state): number {
      return state.convs.reduce((sum, c) => sum + c.unread, 0)
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      this.convs = await window.pantry.listConversations()

      window.pantry.onConvsUpdated((convs) => {
        this.convs = convs
      })
      window.pantry.onMsgNew((msg) => {
        const list = this.messages[msg.convId]
        if (list && !list.some((m) => m.id === msg.id)) list.push(msg)
        if (msg.convId === this.activeConvId) void window.pantry.markRead(msg.convId)
      })
      window.pantry.onMsgStatus((event) => {
        const target = this.messages[event.convId]?.find((m) => m.id === event.id)
        if (target) target.status = event.status
      })
      // 点系统通知/托盘 → 直达对应会话（F-SYS-2）
      window.pantry.onOpenConv((convId) => {
        const peerId = convId.startsWith('single:') ? convId.slice(7) : null
        if (peerId) void this.openPeer(peerId)
      })
    },

    /** 从通讯录或会话列表进入会话 */
    async openPeer(peerNodeId: string): Promise<void> {
      const conv = await window.pantry.openConversation(peerNodeId)
      if (!conv) return
      this.activeConvId = conv.id
      if (!this.messages[conv.id]) {
        this.messages[conv.id] = await window.pantry.pageMessages(conv.id, null, 50)
      }
    },

    async loadEarlier(): Promise<number> {
      const convId = this.activeConvId
      if (!convId) return 0
      const list = this.messages[convId] ?? []
      const before = list.length > 0 ? list[0].seq : null
      const earlier = await window.pantry.pageMessages(convId, before, 50)
      this.messages[convId] = [...earlier, ...list]
      return earlier.length
    },

    async send(text: string): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view = await window.pantry.sendText(conv.peerId, text)
      if (!view) return false
      const list = (this.messages[conv.id] ??= [])
      if (!list.some((m) => m.id === view.id)) list.push(view)
      return true
    },

    async resend(msgId: string): Promise<void> {
      await window.pantry.resendMessage(msgId)
    },

    /** 发文件（选择器或拖拽）；对方离线时主进程返回 null（决议 #4） */
    async sendFilePaths(paths: string[]): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view = await window.pantry.offerFiles(conv.peerId, paths)
      return this.pushOwn(view)
    },

    /** 磁盘图片按图片消息发送（拖拽图片/选择器） */
    async sendImagePath(path: string): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view = await window.pantry.offerImagePath(conv.peerId, path)
      return this.pushOwn(view)
    },

    /** 粘贴的图片字节（截图 Ctrl+V） */
    async sendImageBytes(name: string, bytes: ArrayBuffer): Promise<boolean> {
      const conv = this.activeConv
      if (!conv) return false
      const view = await window.pantry.sendImageBytes(conv.peerId, name, bytes)
      return this.pushOwn(view)
    },

    pushOwn(view: MessageView | null): boolean {
      const conv = this.activeConv
      if (!view || !conv) return false
      const list = (this.messages[conv.id] ??= [])
      if (!list.some((m) => m.id === view.id)) list.push(view)
      return true
    }
  }
})
