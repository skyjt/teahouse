// IPC 契约：main 与 renderer 之间唯一的对话词汇表（tech-design §4）。
// 通道名、请求/响应类型、preload 暴露的 API 形状都只在这里定义。

import type { Platform } from './protocol'

export const IpcChannels = {
  appInfo: 'app:info',
  netState: 'net:get-state',
  peersList: 'peers:list',
  peersProbe: 'peers:probe',
  convList: 'conv:list',
  convOpen: 'conv:open',
  convMarkRead: 'conv:mark-read',
  msgPage: 'msg:page',
  msgSend: 'msg:send',
  msgResend: 'msg:resend',
  settingsGet: 'settings:get',
  settingsSaveProfile: 'settings:save-profile',
  settingsPickDir: 'settings:pick-dir',
  filePick: 'file:pick',
  fileOffer: 'file:offer',
  fileAccept: 'file:accept',
  fileDecline: 'file:decline',
  fileCancel: 'file:cancel',
  fileReveal: 'file:reveal',
  transferGet: 'transfer:get',
  imgSendBytes: 'img:send-bytes',
  imgOfferPath: 'img:offer-path',
  imgSaveAs: 'img:save-as'
} as const

/** main → renderer 的事件推送 */
export const IpcEvents = {
  peersUpdated: 'peers:updated',
  netState: 'net:state',
  msgNew: 'msg:new',
  msgStatus: 'msg:status',
  convsUpdated: 'convs:updated',
  transferUpdated: 'transfer:updated',
  /** 点击系统通知/托盘 → 主窗定位到会话 */
  openConv: 'ui:open-conv'
} as const

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
}

/** 通讯录条目（renderer 视图模型，由主进程的 PeerRecord 投影而来） */
export interface PeerView {
  nodeId: string
  nick: string
  company: string
  dept: string
  team: string
  avatar: number
  host: string
  platform: Platform
  ip: string
  online: boolean
  lastSeen: number
}

export interface NetState {
  ok: boolean
  udpPort: number
  /** 端口被占等启动失败原因；ok 时为空 */
  error: string
}

/** 会话视图（单聊；讨论组 v0.3 扩展） */
export interface ConversationView {
  id: string
  type: 'single'
  peerId: string
  lastTs: number
  unread: number
  pinned: boolean
  muted: boolean
  preview: string
}

/** 文件消息引用（messages.file_ref 的 JSON 结构） */
export interface FileRefView {
  transferId: string
  name: string
  size: number
  count: number
  dir: boolean
}

export interface MessageView {
  id: string
  convId: string
  senderId: string
  isMine: boolean
  kind: 'text' | 'file' | 'image'
  text: string
  fileRef?: FileRefView
  ts: number
  seq: number
  status: 'sending' | 'sent' | 'queued' | 'failed'
}

/** 传输状态视图（文件卡片的数据源） */
export interface TransferView {
  transferId: string
  msgId: string
  convId: string
  direction: 'in' | 'out'
  status: 'offering' | 'accepted' | 'done' | 'declined' | 'canceled' | 'failed'
  bytesDone: number
  totalSize: number
  fileCount: number
  name: string
  /** 完成后：接收侧的落盘根路径（用于"打开所在文件夹"） */
  savedPath: string
}

export interface MsgStatusEvent {
  id: string
  convId: string
  status: MessageView['status']
}

/** 我的资料 + 首启向导状态（F-SYS-6） */
export interface SettingsView {
  nick: string
  company: string
  dept: string
  team: string
  setupDone: boolean
  /** 用户自选的文件保存目录；空 = 跟随默认 */
  fileDir: string
  /** 系统默认下载目录（向导第三步展示用） */
  defaultFileDir: string
}

export interface ProfileSubmit {
  nick: string
  company: string
  dept: string
  team: string
  fileDir: string
}

/** preload 经 contextBridge 暴露到 window.pantry 的 API 形状 */
export interface PantryApi {
  getAppInfo(): Promise<AppInfo>
  getPeers(): Promise<PeerView[]>
  getNetState(): Promise<NetState>
  /** 按需探活（F-DISC-8）；返回是否已发出 */
  probePeer(nodeId: string): Promise<boolean>
  listConversations(): Promise<ConversationView[]>
  /** 打开（或创建）与某节点的会话：清未读 + 触发探活；存储不可用时返回 null */
  openConversation(peerNodeId: string): Promise<ConversationView | null>
  markRead(convId: string): Promise<void>
  /** 倒序游标分页；beforeSeq 传 null 取最新一页，返回按时间升序 */
  pageMessages(convId: string, beforeSeq: number | null, limit?: number): Promise<MessageView[]>
  /** 发文本；超长（>800 字节）或空白返回 null */
  sendText(peerNodeId: string, text: string): Promise<MessageView | null>
  resendMessage(msgId: string): Promise<boolean>
  getSettings(): Promise<SettingsView>
  /** 保存资料（向导/设置）：资料有变自动广播刷新全网 */
  saveProfile(submit: ProfileSubmit): Promise<SettingsView>
  /** 弹系统目录选择框；取消返回 null */
  pickDirectory(): Promise<string | null>
  /** 弹文件/文件夹选择框（发送用）；取消返回 null */
  pickFiles(directory: boolean): Promise<string[] | null>
  /** 发起文件传输（对方离线直接失败，不入队——决议 #4）；返回本地文件消息 */
  offerFiles(peerNodeId: string, paths: string[]): Promise<MessageView | null>
  /** 接收（saveAs=true 先弹目录选择）；返回是否开始 */
  acceptTransfer(transferId: string, saveAs: boolean): Promise<boolean>
  declineTransfer(transferId: string): Promise<void>
  cancelTransfer(transferId: string): Promise<void>
  /** 完成后在文件管理器中显示 */
  revealTransfer(transferId: string): Promise<void>
  getTransfer(transferId: string): Promise<TransferView | null>
  /** 粘贴的图片字节 → 落本机图片缓存 → 以 purpose:image 发起传输 */
  sendImageBytes(peerNodeId: string, name: string, bytes: ArrayBuffer): Promise<MessageView | null>
  /** 磁盘上的图片文件按图片消息发送（拖拽/选择器入口） */
  offerImagePath(peerNodeId: string, path: string): Promise<MessageView | null>
  /** 大图查看器"另存为" */
  saveImageAs(transferId: string): Promise<boolean>
  /** 订阅通讯录变化；返回退订函数 */
  onPeersUpdated(listener: (peers: PeerView[]) => void): () => void
  onMsgNew(listener: (msg: MessageView) => void): () => void
  onMsgStatus(listener: (event: MsgStatusEvent) => void): () => void
  onConvsUpdated(listener: (convs: ConversationView[]) => void): () => void
  onTransferUpdated(listener: (transfer: TransferView) => void): () => void
  /** 点通知/托盘后主进程要求打开某会话 */
  onOpenConv(listener: (convId: string) => void): () => void
}
