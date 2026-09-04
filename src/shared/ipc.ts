// IPC 契约：main 与 renderer 之间唯一的对话词汇表（tech-design §4）。
// 通道名、请求/响应类型、preload 暴露的 API 形状都只在这里定义。

import type { Platform, ShareDenyReason, ShareEntry, ShareMode } from './protocol'
import type { PkGame, PkRefView } from './pk'

export const IpcChannels = {
  appInfo: 'app:info',
  appOpenUrl: 'app:open-url',
  netState: 'net:get-state',
  peersList: 'peers:list',
  peersProbe: 'peers:probe',
  convList: 'conv:list',
  convOpen: 'conv:open',
  convMarkRead: 'conv:mark-read',
  convPin: 'conv:pin',
  convMute: 'conv:mute',
  convRemove: 'conv:remove',
  msgPage: 'msg:page',
  msgSend: 'msg:send',
  msgResend: 'msg:resend',
  msgRecall: 'msg:recall',
  msgNudge: 'msg:nudge',
  msgPk: 'msg:pk',
  msgForward: 'msg:forward',
  settingsGet: 'settings:get',
  settingsSaveProfile: 'settings:save-profile',
  avatarPickSource: 'avatar:pick-source',
  profileSetAvatar: 'profile:set-avatar',
  groupSetAvatar: 'group:set-avatar',
  settingsPickDir: 'settings:pick-dir',
  filePick: 'file:pick',
  fileGrantPaths: 'file:grant-paths',
  fileOffer: 'file:offer',
  fileDirect: 'file:direct',
  groupFileOffer: 'group-file:offer',
  fileAccept: 'file:accept',
  fileDecline: 'file:decline',
  fileCancel: 'file:cancel',
  fileReveal: 'file:reveal',
  transferGet: 'transfer:get',
  transferList: 'transfer:list',
  dataExport: 'data:export',
  dataImport: 'data:import',
  imgPick: 'img:pick',
  imgSendBytes: 'img:send-bytes',
  imgOfferPath: 'img:offer-path',
  groupImgSendBytes: 'group-img:send-bytes',
  groupImgOfferPath: 'group-img:offer-path',
  imgOpenViewer: 'img:open-viewer',
  imgFitViewerWindow: 'img:fit-viewer-window',
  imgOcrSource: 'img:ocr-source',
  imgOcrResultGet: 'img:ocr-result-get',
  imgOcrResultSet: 'img:ocr-result-set',
  imgSaveAs: 'img:save-as',
  imgThumbnailHas: 'img:thumbnail-has',
  imgThumbnailCache: 'img:thumbnail-cache',
  searchQuery: 'search:query',
  msgSearch: 'msg:search',
  msgContext: 'msg:context',
  msgGet: 'msg:get',
  settingsSaveApp: 'settings:save-app',
  /** 我的文件柜（决议 #271/#277）：共享根与默认档随 settings:get / settings:updated 下发 */
  shareMySetRoot: 'share:my-set-root',
  shareMySetMode: 'share:my-set-mode',
  shareMyReveal: 'share:my-reveal',
  shareGrantList: 'share:grant-list',
  shareGrantSet: 'share:grant-set',
  /** 对方的文件柜（决议 #273/#275）：列目录与下载 */
  shareBrowse: 'share:browse',
  shareDownload: 'share:download',
  shareUpload: 'share:upload',
  /** 「最近有人放进来」（决议 #283）：读既有 transfers 里 purpose='share-put' 的入站完成记录 */
  shareRecentUploads: 'share:recent-uploads',
  netAddPeer: 'net:add-peer',
  netScan: 'net:scan',
  netScanAllRanges: 'net:scan-all-ranges',
  peersSetRemark: 'peers:set-remark',
  uiOpenSettings: 'ui:open-settings',
  /** 文件柜独立窗口（决议 #283）：懒创建 / 聚焦，可带 peerId 直接定位到某位同事 */
  uiOpenCabinet: 'ui:open-cabinet',
  groupCreate: 'group:create',
  groupUpdate: 'group:update',
  groupLeave: 'group:leave',
  groupGet: 'group:get',
  groupList: 'group:list',
  groupSend: 'group:send',
  captureStart: 'capture:start',
  /** 截图位图解码与首帧完成，主进程此时再显示截图窗（决议 #221） */
  captureReady: 'capture:ready',
  captureDone: 'capture:done',
  clipboardWriteImage: 'clipboard:write-image',
  clipboardReadImage: 'clipboard:read-image',
  stickerFetchSource: 'sticker:fetch-source',
  stickerImportSource: 'sticker:import-source',
  stickerAdd: 'sticker:add',
  stickerList: 'sticker:list',
  stickerRemove: 'sticker:remove',
  stickerReorder: 'sticker:reorder',
  stickerSend: 'sticker:send',
  /** 沉浸式无标题栏（决议 #49）：Windows/Linux 自绘窗口控制按钮用 */
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggle-maximize',
  winIsMaximized: 'win:is-maximized',
  /** 关闭必须走主进程（决议 #59）：DOM window.close() 会绕过 close 事件直接销毁 */
  winClose: 'win:close',
  /** Linux JS 拖拽（决议 #52）：CSS 拖拽区在 Linux 不可靠，主进程跟随光标移窗 */
  winBeginDrag: 'win:begin-drag',
  winEndDrag: 'win:end-drag',
  /** 局域网自更新：查询当前可用更新源（决议 #166） */
  updateCheck: 'update:check',
  /** 局域网自更新：向当前最佳更新源请求安装包（决议 #170） */
  updateRequest: 'update:request'
} as const

/** main → renderer 的事件推送 */
export const IpcEvents = {
  peersUpdated: 'peers:updated',
  netState: 'net:state',
  msgNew: 'msg:new',
  msgStatus: 'msg:status',
  nudgeReceived: 'msg:nudge-received',
  convsUpdated: 'convs:updated',
  transferUpdated: 'transfer:updated',
  groupUpdated: 'group:updated',
  /** 截图框选窗初始化（本地 PNG 字节） */
  captureInit: 'capture:init',
  /** 截图完成且选择"发送"→ 主窗（发到当前会话） */
  captured: 'ui:captured',
  /** 内置截图无法继续时给主窗的可见提示（系统通知不可用时也不能静默） */
  captureFailed: 'capture:failed',
  /** 点击系统通知/托盘 → 主窗定位到会话 */
  openConv: 'ui:open-conv',
  /** 设置页保存后广播给所有窗口，统一主题/字体等外观 */
  settingsUpdated: 'settings:updated',
  /** 自定义头像文件到达缓存，渲染层按哈希重试图片。 */
  avatarReady: 'avatar:ready',
  /** Windows / Linux 设置模态窗开关状态，主窗据此显示静态暗色遮罩（决议 #222） */
  settingsWindowState: 'ui:settings-window-state',
  /** 主界面全局网段刷新进度 */
  netScanProgress: 'net:scan-progress',
  /** 主窗收到 Command/Ctrl+V；renderer 只在输入框聚焦时兜底读图片剪贴板 */
  clipboardPasteImage: 'clipboard:paste-image',
  /** 窗口最大化状态变化 → 自绘控制按钮切换图标（决议 #49） */
  winMaximizeChanged: 'win:maximized-changed',
  /** 局域网自更新：可用更新源变化（决议 #166） */
  updateAvailable: 'update:available',
  /** 文件柜窗口已开着时再次请求打开某位同事的柜子（决议 #283） */
  cabinetFocusPeer: 'cabinet:focus-peer'
} as const

/** 全局快捷键出厂默认（决议 #57）：设置页"恢复默认"与主进程默认值的唯一来源 */
export const DEFAULT_CAPTURE_SHORTCUT = 'CommandOrControl+Alt+A'
export const DEFAULT_SHOWHIDE_SHORTCUT = 'CommandOrControl+Alt+P'

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  /** Win7 主聊天输入框启用 IMM32 caret 几何刷新（决议 #258）。 */
  windows7: boolean
  /** Win7 / Linux 默认禁用硬件加速时为 true，renderer 据此收敛高开销效果。 */
  softwareRendering: boolean
  /** 本机节点 ID（群成员面板等需区分"我"） */
  nodeId: string
  /** 当前用于局域网身份展示的本机 IPv4。 */
  localIp: string
}

/** 通讯录条目（renderer 视图模型，由主进程的 PeerRecord 投影而来） */
export interface PeerView {
  nodeId: string
  nick: string
  /** 本地备注名（F-DISC-9），展示时优先于 nick */
  remark: string
  company: string
  dept: string
  team: string
  host: string
  avatar: number
  avatarHash: string
  platform: Platform
  ip: string
  online: boolean
  lastSeen: number
  /** 应用版本（决议 #166，自更新版本比对依据） */
  ver: string
  /** 对端声明的能力位；未知位渲染层忽略。 */
  caps: string[]
}

/** 局域网自更新：当前可用的更新源（决议 #166）；无更新源时主进程返回 null。 */
export interface UpdateAvailability {
  /** 来源节点 nodeId */
  nodeId: string
  /** 来源节点展示名（备注优先，其次昵称） */
  fromName: string
  /** 来源节点的应用版本（高于本机） */
  version: string
  /** 本机当前版本 */
  currentVersion: string
}

export interface NetState {
  ok: boolean
  udpPort: number
  /** 端口被占等启动失败原因；ok 时为空 */
  error: string
}

export type ScanProgressStatus = 'idle' | 'running' | 'done' | 'empty' | 'unavailable'

export interface ScanProgressView {
  scanId: number
  status: ScanProgressStatus
  running: boolean
  done: number
  total: number
  rangeCount: number
  startedAt: number
  finishedAt: number
}

/** 会话视图：单聊（peerId=节点）或讨论组（peerId=groupId） */
export interface ConversationView {
  id: string
  type: 'single' | 'group'
  peerId: string
  lastTs: number
  unread: number
  pinned: boolean
  muted: boolean
  mentioned: boolean
  preview: string
}

export interface TableTextMeta {
  /** 表格图片消息的原始 TSV 文字视图；仅图片消息可有。 */
  tableText: string
  /** tableText 因上限被截断时为 true。 */
  tableTextTruncated?: boolean
}

/** 文件消息引用（messages.file_ref 的 JSON 结构） */
export interface FileRefView {
  transferId: string
  /** 群聊发送侧：同一条群消息对应的多个点对点 transfer */
  transferIds?: string[]
  name: string
  size: number
  count: number
  dir: boolean
  /** 表格图片消息的原始 TSV 文字视图；仅图片消息可有。 */
  tableText?: string
  /** tableText 因上限被截断时为 true。 */
  tableTextTruncated?: boolean
  /** 是否由发送方文件卡片请求直接发送，接收方按本地设置自动保存。 */
  direct?: boolean
}

export type { PkRefView }

export interface MessageView {
  id: string
  convId: string
  senderId: string
  isMine: boolean
  kind: 'text' | 'file' | 'image' | 'sticker' | 'system' | 'pk'
  text: string
  fileRef?: FileRefView
  pkRef?: PkRefView
  ts: number
  seq: number
  status: 'sending' | 'sent' | 'queued' | 'failed' | 'canceled' | 'recalled'
  /** 入站群消息是否 @ 到本机；用于本次事件的加强提醒 */
  mentioned?: boolean
  /** 本条消息引用的源消息（仅群聊文本消息携带） */
  replyTo?: string
}

/** 被引用消息的元数据：发送者展示名 + 首行文本摘要 */
export interface ReplyMeta {
  /** 源消息 id；接收方可用于查找原文或定位跳转 */
  id: string
  /** 源消息发送者显示名（备注优先，其次昵称）*/
  senderName: string
  /** 源消息文本；超长时截断并追加省略号 */
  text: string
}

/** 传输状态视图（文件卡片的数据源） */
export interface TransferView {
  transferId: string
  msgId: string
  convId: string
  /** 对端节点 id：出站=接收人，入站=发送人（群聊文件接收名单用，决议 #75） */
  peerId: string
  direction: 'in' | 'out'
  status: 'offering' | 'accepted' | 'done' | 'declined' | 'canceled' | 'failed' | 'expired'
  bytesDone: number
  totalSize: number
  fileCount: number
  name: string
  /** 普通文件领取截止时间；图片、表情和更新包为 0。 */
  expiresAt: number
  /** 完成后：接收侧的落盘根路径（用于"打开所在文件夹"） */
  savedPath: string
  /** 是否为直接发送传输；群文件不会为 true。 */
  direct: boolean
  /** 入站传输在发送端并发预算内排队中（决议 #211）：进度行显示「排队等待发送方」 */
  queued?: boolean
  /** 入站失败/取消后能否继续或重新下载（决议 #211）：本会话传输上下文仍在且对端语义支持 */
  retryable?: boolean
  /** 直接发送入站保存目录使用的发送人目录名。 */
  directPeerName?: string
}

/** 图片 OCR 只读源：主进程按 transferId 返回受限字节，不向渲染层暴露本地路径 */
export interface ImageOcrSource {
  name: string
  size: number
  bytes: ArrayBuffer
}

export interface ImageSourceBytes {
  bytes: ArrayBuffer
  ext: string
  width: number
  height: number
  animated: boolean
}

export interface ImageOcrBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface ImageOcrToken {
  id: string
  text: string
  confidence: number
  bbox: ImageOcrBox
  lineIndex: number
  wordIndex: number
  tokenIndex: number
}

export interface ImageOcrLine {
  id: string
  text: string
  bbox: ImageOcrBox
  tokenIds: string[]
  lineIndex: number
}

export interface ImageOcrResult {
  text: string
  tokens: ImageOcrToken[]
  lines: ImageOcrLine[]
  scale: number
}

export interface MsgStatusEvent {
  id: string
  convId: string
  status: MessageView['status']
}

export interface NudgeResult {
  ok: boolean
  reason?: 'rate-limited' | 'undelivered' | 'invalid'
  retryAfterMs?: number
}

export interface NudgeEvent {
  peerId: string
  convId: string
  ts: number
}

export interface ForwardTarget {
  type: 'single' | 'group'
  id: string
}

export interface ForwardResult {
  ok: number
  total: number
  messages: MessageView[]
}

export type ExportFormat = 'backup' | 'html' | 'txt'

export interface DataExportOptions {
  convId?: string
  fromTs?: number
  toTs?: number
}

export interface DataImportResult {
  imported: number
  skipped: number
  /** 备份中的本机头像；主进程确认受管文件已恢复后应用。 */
  profileAvatarHash?: string
}

/** 讨论组视图（F-MSG-4）：amMember=false 表示已退出/被移出（历史保留、禁发） */
export type GroupRole = 'owner' | 'admin' | 'member' | 'left'

export interface GroupView {
  groupId: string
  name: string
  members: string[]
  rev: number
  amMember: boolean
  creatorIp: string
  ownerId: string
  adminIds: string[]
  avatarHash: string
  selfRole: GroupRole
  hasAdminPassword: boolean
  adminHint: string
  /** 当前本机是否可不输入密码直接执行群管理动作（群主或管理员） */
  canManage: boolean
  /** 群简介；空串表示未设置 */
  description: string
  /** 群公告；空串表示未设置 */
  announce: string
}

/** 讨论组单操作变更；一次 IPC 只允许一种行为，防邀请权限与管理权限混用。 */
export type GroupPatch =
  | { kind: 'rename'; name: string; adminPassword?: string }
  | { kind: 'invite'; memberIds: string[] }
  | { kind: 'remove'; memberIds: string[]; adminPassword?: string }
  | { kind: 'set-admin'; memberId: string; enabled: boolean }
  | { kind: 'set-avatar'; avatarHash: string; adminPassword?: string }
  | { kind: 'set-description'; description: string; adminPassword?: string }
  | { kind: 'set-announce'; announce: string; adminPassword?: string }

/** 全局搜索（ui-design §6）：联系人 / 聊天记录（按会话聚合）/ 文件 */
export interface MessageGroupHit {
  convId: string
  peerId: string
  count: number
  snippet: string
  latestSeq: number
  latestMsgId: string
  ts: number
}

export interface FileHit {
  msgId: string
  convId: string
  peerId: string
  name: string
  ts: number
  seq: number
}

export interface SearchResult {
  peers: PeerView[]
  messageGroups: MessageGroupHit[]
  files: FileHit[]
}

export type ConversationSearchKind = 'all' | 'image' | 'file'

export interface ConversationSearchOptions {
  convId: string
  query: string
  kind: ConversationSearchKind
  fromTs?: number
  toTs?: number
  limit?: number
}

export interface ConversationMessageHit {
  msgId: string
  convId: string
  senderId: string
  isMine: boolean
  kind: 'text' | 'file' | 'image' | 'pk'
  title: string
  snippet: string
  fileRef?: FileRefView
  ts: number
  seq: number
}

/** 我的资料 + 首启向导状态（F-SYS-6） */
export interface SettingsView {
  nick: string
  company: string
  dept: string
  team: string
  host: string
  avatar: number
  avatarHash: string
  setupDone: boolean
  /** 用户自选的文件保存目录；空 = 跟随默认 */
  fileDir: string
  /** 系统默认下载目录（向导第三步展示用） */
  defaultFileDir: string
  notifications: boolean
  manualPeers: string[]
  scanRanges: string[]
  scanRangeItems: ScanRangeItemView[]
  udpPort: number
  tcpPort: number
  /** 截图时隐藏茶话间窗口（决议 #22） */
  hideOnCapture: boolean
  autoLaunch: boolean
  closeToTray: boolean
  theme: 'light' | 'dark'
  fontScale: 100 | 110 | 125
  showMessagePreview: boolean
  /** 是否允许私聊直接发送；默认接收落点为“保存位置/联系人名称”。 */
  allowDirectFileSend: boolean
  /** 我的文件柜（决议 #271）：共享根与默认权限档，按人例外走 share:grant-list。 */
  fileCabinet: FileCabinetView
  sound: 'none' | 'drop' | 'wood' | 'ding'
  sendKey: 'enter' | 'ctrlEnter'
  /** Electron accelerator；空串 = 禁用 */
  captureShortcut: string
  /** Electron accelerator；空串 = 禁用 */
  showHideShortcut: string
  /** 全局快捷键注册结果（决议 #57）：false = 被系统占用注册失败；禁用（空串）视为 true */
  shortcutStatus: {
    capture: boolean
    showHide: boolean
  }
}

export interface ScanRangeItemView {
  cidr: string
  source: 'self' | 'remote'
  sourceNodeId?: string
  sourceName?: string
  addedAt: number
  lastAutoScanAt?: number
  /** 该网段当前在线节点数（决议 #160）：online 且 IP ∈ CIDR 的节点计数 */
  nodeCount: number
}

/** 我的文件柜配置投影（决议 #271/#277） */
export interface FileCabinetView {
  /** 共享根绝对路径；空串 = 未设置，同事看不到任何内容 */
  root: string
  /** 默认权限档 */
  mode: ShareMode
  /** 按人例外条数，用于设置页概览 */
  grantCount: number
}

/** 例外列表的一行（决议 #271）：权限 + 联系人展示信息 */
export interface ShareGrantView {
  nodeId: string
  /** 显示名：本地备注优先，其次昵称 */
  name: string
  avatar: number
  avatarHash: string
  online: boolean
  mode: ShareMode
}

/** 共享根被拒原因（决议 #276），与 main/services/share.ts 的 ShareRootRejectReason 同域 */
export type ShareRootRejectReason = 'empty' | 'relative' | 'fs-root' | 'home' | 'app-data' | 'unreadable'

/** 共享根拒绝文案：主进程只回原因码，展示文字集中在此，避免两端各写一套 */
export const SHARE_ROOT_REJECT_TEXT: Record<ShareRootRejectReason, string> = {
  empty: '没有选择目录',
  relative: '请选择一个完整的目录路径',
  'fs-root': '不能共享整个磁盘根目录，请选择其中一个文件夹',
  home: '不能共享整个用户主目录，请选择其中一个文件夹',
  'app-data': '不能共享茶话间自己的数据目录，请换一个文件夹',
  unreadable: '这个目录读不到，请确认它还在且有访问权限'
}

/** 浏览失败的原因：协议侧 deny 原因码 + 三个本机侧原因 */
export type ShareBrowseFailReason = ShareDenyReason | 'offline' | 'unsupported' | 'timeout'

export const SHARE_FAIL_TEXT: Record<ShareBrowseFailReason, string> = {
  off: '对方没有对你开放文件柜',
  'no-perm': '对方没有给你这个权限',
  'not-found': '这个位置已经不在了，刷新试试',
  'too-deep': '目录层级太深，打不开',
  busy: '操作太频繁，稍等一下再试',
  gone: '列表已过期，正在重新获取',
  offline: '对方当前不在线',
  unsupported: '对方的版本还不支持文件柜',
  timeout: '对方没有响应，稍后重试'
}

export type ShareBrowseResult =
  | {
      ok: true
      path: string
      /** 对方判定的权限，仅用于本机 UI 决定是否显示上传入口 */
      perm: 'read' | 'write'
      snapshotId: string
      offset: number
      total: number
      truncated: boolean
      entries: ShareEntry[]
    }
  | { ok: false; reason: ShareBrowseFailReason }

export type ShareUploadResult =
  | { ok: true; canceled?: false; fileCount: number }
  | { ok: true; canceled: true }
  | { ok: false; reason: ShareUploadFailReason }

/** 上传失败原因：三个本机侧原因 + 对端拒绝 / 超限 */
export type ShareUploadFailReason =
  | 'offline'
  | 'unsupported'
  | 'no-perm'
  | 'too-large'
  | 'unreadable'
  | 'rejected'

export const SHARE_UPLOAD_FAIL_TEXT: Record<ShareUploadFailReason, string> = {
  offline: '对方当前不在线',
  unsupported: '对方的版本还不支持文件柜',
  'no-perm': '对方没有开放上传',
  'too-large': '这次选的内容超过 2 GB，分几次传',
  unreadable: '有文件读不到，检查一下是否被移动或删除',
  rejected: '对方拒收了这次上传'
}

export type ShareDownloadResult =
  | { ok: true; canceled?: false }
  | { ok: true; canceled: true }
  | { ok: false; reason: ShareBrowseFailReason }

/**
 * 「最近有人放进来」的一行（决议 #283）：由既有 `transfers` 里 `purpose='share-put'` 的
 * 入站完成记录汇总而来，不新增表也不新增列。
 */
export interface ShareRecentUploadView {
  transferId: string
  /** 上传者 nodeId */
  nodeId: string
  /** 上传者显示名：本地备注优先，其次昵称 */
  name: string
  avatar: number
  avatarHash: string
  fileCount: number
  totalSize: number
  /** 完成时间（毫秒） */
  ts: number
}

export type ShareRootPickResult =
  | { ok: true; canceled: false; view: SettingsView }
  | { ok: true; canceled: true }
  | { ok: false; reason: ShareRootRejectReason }

export interface AppSettingsPatch {
  notifications?: boolean
  manualPeers?: string[]
  scanRanges?: string[]
  udpPort?: number
  tcpPort?: number
  hideOnCapture?: boolean
  autoLaunch?: boolean
  closeToTray?: boolean
  theme?: SettingsView['theme']
  fontScale?: SettingsView['fontScale']
  showMessagePreview?: boolean
  allowDirectFileSend?: boolean
  sound?: SettingsView['sound']
  sendKey?: SettingsView['sendKey']
  captureShortcut?: string
  showHideShortcut?: string
}

export interface StickerView {
  id: string
  w: number
  h: number
  animated: boolean
}

export interface ProfileSubmit {
  nick: string
  company: string
  dept: string
  team: string
  avatar: number
  /** 显式空串表示切回数字头像；缺省用于首启向导兼容。 */
  avatarHash?: string
  fileDir: string
}

export type AvatarSourcePick =
  | {
      ok: true
      bytes: ArrayBuffer
      mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp'
      width: number
      height: number
    }
  | { ok: false; error: string }

export type ProfileAvatarChoice =
  | { kind: 'preset'; avatar: number }
  | { kind: 'custom'; bytes: ArrayBuffer }

export type CaptureFailureReason =
  | 'window-hide-failed'
  | 'screen-unavailable'
  | 'image-empty'
  | 'unexpected'

export interface CaptureFailureNotice {
  reason: CaptureFailureReason
  message: string
}

/** preload 经 contextBridge 暴露到 window.pantry 的 API 形状 */
export interface PantryApi {
  getAppInfo(): Promise<AppInfo>
  /** 用户点击聊天链接后交给系统浏览器；仅允许 http/https */
  openUrl(url: string): Promise<boolean>
  getPeers(): Promise<PeerView[]>
  getNetState(): Promise<NetState>
  /** 局域网自更新：查询当前可用更新源，无则 null（决议 #166） */
  checkUpdate(): Promise<UpdateAvailability | null>
  /** 局域网自更新：向当前最佳更新源请求安装包，返回请求是否已送达 */
  requestUpdate(): Promise<boolean>
  /** 局域网自更新：可用更新源变化推送（决议 #166） */
  onUpdateAvailable(listener: (info: UpdateAvailability | null) => void): () => void
  /** 按需探活（F-DISC-8）；返回是否已发出 */
  probePeer(nodeId: string): Promise<boolean>
  listConversations(): Promise<ConversationView[]>
  /** 打开（或创建）与某节点的会话：清未读 + 触发探活；存储不可用时返回 null */
  openConversation(peerNodeId: string): Promise<ConversationView | null>
  markRead(convId: string): Promise<void>
  pinConversation(convId: string, pinned: boolean): Promise<void>
  muteConversation(convId: string, muted: boolean): Promise<void>
  removeConversation(convId: string): Promise<void>
  /** 倒序游标分页；beforeSeq 传 null 取最新一页，返回按时间升序 */
  pageMessages(convId: string, beforeSeq: number | null, limit?: number): Promise<MessageView[]>
  /** 发文本；超长（>800 字节）或空白返回 null */
  sendText(peerNodeId: string, text: string): Promise<MessageView | null>
  resendMessage(msgId: string): Promise<boolean>
  recallMessage(msgId: string): Promise<boolean>
  sendNudge(peerNodeId: string): Promise<NudgeResult>
  sendPk(convId: string, game: PkGame): Promise<MessageView | null>
  forwardMessage(msgId: string, targets: ForwardTarget[]): Promise<ForwardResult>
  getSettings(): Promise<SettingsView>
  /** 保存资料（向导/设置）：资料有变自动广播刷新全网 */
  saveProfile(submit: ProfileSubmit): Promise<SettingsView>
  /** 选择并预校验单张本地静态头像源图；取消返回 null。 */
  pickAvatarSource(): Promise<AvatarSourcePick | null>
  /** 应用图片头像或切回数字头像。 */
  setProfileAvatar(choice: ProfileAvatarChoice): Promise<SettingsView>
  /** 弹系统目录选择框；取消返回 null */
  pickDirectory(): Promise<string | null>
  /** 弹文件/文件夹选择框（发送用）；取消返回 null */
  pickFiles(directory: boolean): Promise<string[] | null>
  /** 弹图片多选框；仅返回受支持图片路径，取消返回 null。 */
  pickImages(): Promise<string[] | null>
  /** 弹图片多选框并签发表情导入专用的一次性路径授权。 */
  pickStickerImages(): Promise<string[] | null>
  /** 授权用户拖拽 / 粘贴产生的本地文件路径用于一次发送。 */
  grantFilePaths(paths: string[]): Promise<string[]>
  /** 发起文件传输（对方离线直接失败，不入队——决议 #4）；返回本地文件消息 */
  offerFiles(peerNodeId: string, paths: string[]): Promise<MessageView | null>
  /** 发送方在已有私聊文件卡片上请求直接发送。 */
  directTransfer(transferId: string): Promise<boolean>
  /** 发起群聊文件传输：只投递给当前在线群成员 */
  offerGroupFiles(groupId: string, paths: string[]): Promise<MessageView | null>
  /** 接收（saveAs=true 先弹目录选择）；返回是否开始 */
  acceptTransfer(transferId: string, saveAs: boolean): Promise<boolean>
  declineTransfer(transferId: string): Promise<void>
  cancelTransfer(transferId: string): Promise<void>
  /** 完成后在文件管理器中显示 */
  revealTransfer(transferId: string): Promise<void>
  getTransfer(transferId: string): Promise<TransferView | null>
  listTransfers(limit?: number): Promise<TransferView[]>
  exportData(format: ExportFormat, options?: DataExportOptions): Promise<string | null>
  importData(): Promise<DataImportResult | null>
  /** 粘贴的图片字节 → 落本机图片缓存 → 以 purpose:image 发起传输 */
  sendImageBytes(
    peerNodeId: string,
    name: string,
    bytes: ArrayBuffer,
    tableText?: TableTextMeta
  ): Promise<MessageView | null>
  /** 磁盘上的图片文件按图片消息发送（拖拽/选择器入口） */
  offerImagePath(peerNodeId: string, path: string): Promise<MessageView | null>
  /** 群聊图片：≤10MB 按图片 offer，超限退化为普通文件 offer */
  sendGroupImageBytes(
    groupId: string,
    name: string,
    bytes: ArrayBuffer,
    tableText?: TableTextMeta
  ): Promise<MessageView | null>
  offerGroupImagePath(groupId: string, path: string): Promise<MessageView | null>
  /** 在独立图片窗口中查看，不遮挡主聊天窗口 */
  openImageViewer(transferId: string): Promise<boolean>
  /** 独立图片窗口按图片自然尺寸适配内容区，返回初始缩放比例 */
  fitImageViewerWindow(width: number, height: number): Promise<number>
  /** 图片窗口 OCR：读取已完成图片的受限字节源，不暴露路径 */
  getImageOcrSource(transferId: string): Promise<ImageOcrSource | null>
  /** 图片窗口 OCR：读取主进程会话级缓存结果，避免重新打开图片后重复识别 */
  getImageOcrResult(transferId: string, cacheKey: string): Promise<ImageOcrResult | null>
  /** 图片窗口 OCR：保存主进程会话级缓存结果，不落库 */
  saveImageOcrResult(transferId: string, cacheKey: string, result: ImageOcrResult): Promise<boolean>
  /** 大图查看器"另存为" */
  saveImageAs(transferId: string): Promise<boolean>
  /** 查询聊天流派生缩略图是否已存在。 */
  hasImageThumbnail(transferId: string): Promise<boolean>
  /** 写入 renderer 生成的 320px WebP 派生缩略图。 */
  cacheImageThumbnail(transferId: string, bytes: ArrayBuffer): Promise<boolean>
  /** 全局搜索（防抖在渲染层做） */
  search(query: string): Promise<SearchResult>
  /** 当前会话历史搜索：关键词 + 图片/文件/日期筛选 */
  searchMessages(options: ConversationSearchOptions): Promise<ConversationMessageHit[]>
  /** 搜索跳转：取目标 seq 前后窗口（按时间升序），用于会话内定位 */
  getMessageContext(convId: string, seq: number): Promise<MessageView[]>
  /** 按消息 ID 查询所在会话与 seq，供 jumpToMessage 跳转使用 */
  getMessageById(msgId: string): Promise<MessageView | null>
  /** 应用级设置（通知/手动节点/扫描网段） */
  saveAppSettings(patch: AppSettingsPatch): Promise<SettingsView>
  /** 我的文件柜：选共享根（打开目录选择器并校验）；clear=true 表示清除共享根 */
  setShareRoot(clear?: boolean): Promise<ShareRootPickResult>
  /** 我的文件柜：切换默认权限档 */
  setShareMode(mode: ShareMode): Promise<SettingsView>
  /** 我的文件柜：在系统文件管理器中打开共享根 */
  revealShareRoot(): Promise<boolean>
  /** 按联系人例外列表（含显示名与在线状态） */
  listShareGrants(): Promise<ShareGrantView[]>
  /** 写入例外；mode 传 null 表示恢复"跟随默认档" */
  setShareGrant(nodeId: string, mode: ShareMode | null): Promise<ShareGrantView[]>
  /** 浏览对方文件柜的一页；翻页须原样带回上次的 snapshotId */
  browseShare(
    peerId: string,
    path: string,
    offset: number,
    snapshotId?: string
  ): Promise<ShareBrowseResult>
  /** 下载对方文件柜里的若干条目；saveAs=true 时先弹目录选择器 */
  downloadShare(peerId: string, paths: string[], saveAs?: boolean): Promise<ShareDownloadResult>
  /**
   * 上传到对方文件柜。localPaths 省略时先弹选择器（directory=true 选文件夹）；
   * 传入拖拽得到的本地路径时须先经 grantFilePaths 授权。
   */
  uploadShare(
    peerId: string,
    localPaths?: string[],
    directory?: boolean
  ): Promise<ShareUploadResult>
  /** 「最近有人放进来」（决议 #283）：最近若干条别人上传到我文件柜的记录，新的在前 */
  listRecentShareUploads(limit?: number): Promise<ShareRecentUploadView[]>
  /** 手动添加节点（"ip" 或 "ip:port"）：持久化 + 立即探测 */
  addManualPeer(addr: string): Promise<boolean>
  /** 扫描一个 CIDR 网段；返回探测地址数，非法网段返回 -1 */
  scanRange(cidr: string): Promise<number>
  /** 扫描所有已保存 CIDR 网段；运行中重复调用返回当前进度 */
  scanAllRanges(): Promise<ScanProgressView>
  /** 设置联系人本地备注（空串=清除） */
  setPeerRemark(nodeId: string, remark: string): Promise<void>
  /** 打开设置窗口 */
  openSettings(): Promise<void>
  /** 打开文件柜窗口（决议 #283）；带 peerId 时直接定位到该同事的柜子 */
  openCabinet(peerId?: string): Promise<void>
  /** 建讨论组（自动含自己，≥2 人）；adminPassword/adminHint 可空；返回 null 表示参数不足 */
  createGroup(
    name: string,
    memberIds: string[],
    adminPassword?: string,
    adminHint?: string
  ): Promise<GroupView | null>
  /** 改名/邀请/移出/任免管理员/头像元数据；主进程按单操作权限矩阵校验 */
  updateGroup(groupId: string, patch: GroupPatch): Promise<GroupView | null>
  /** 应用裁剪后的群头像；bytes=null 恢复默认。 */
  setGroupAvatar(
    groupId: string,
    bytes: ArrayBuffer | null,
    adminPassword?: string
  ): Promise<GroupView | null>
  leaveGroup(groupId: string): Promise<void>
  getGroup(groupId: string): Promise<GroupView | null>
  listGroups(): Promise<GroupView[]>
  sendGroupText(groupId: string, text: string, mentions?: string[], replyTo?: string): Promise<MessageView | null>
  /** 触发截图（等价全局快捷键） */
  startCapture(): Promise<void>
  /** 截图窗：桌面位图已解码并完成首帧布局 */
  captureReady(): Promise<void>
  /** 截图框选完成：写剪贴板；send=true 时同时回推主窗发送到当前会话 */
  captureDone(bytes: ArrayBuffer, send: boolean): Promise<void>
  /** 写系统图片剪贴板；表情 / 图片消息复制用 */
  writeImageToClipboard(bytes: ArrayBuffer): Promise<boolean>
  /** 读系统图片剪贴板 PNG；输入框 Command+V 兜底用 */
  readImageFromClipboard(): Promise<ArrayBuffer | null>
  /** 读取通过像素门禁的原始字节与元数据（缩略图 / 复制 / 收藏使用）。 */
  fetchStickerSource(transferId: string): Promise<ImageSourceBytes | null>
  /** 读取刚由用户选择且持有一次性授权的本地表情源图。 */
  fetchStickerImportSource(path: string): Promise<ImageSourceBytes | null>
  /** 保存收藏（bytes 已经渲染层压缩）；返回新表情 */
  addSticker(bytes: ArrayBuffer, ext: string, w: number, h: number): Promise<StickerView | null>
  listStickers(): Promise<StickerView[]>
  removeSticker(id: string): Promise<void>
  reorderStickers(ids: string[]): Promise<StickerView[]>
  /** 发送收藏的表情到单聊节点或群聊。 */
  sendSticker(targetId: string, stickerId: string, isGroup: boolean): Promise<MessageView | null>
  /** 订阅通讯录变化；返回退订函数 */
  onPeersUpdated(listener: (peers: PeerView[]) => void): () => void
  onMsgNew(listener: (msg: MessageView) => void): () => void
  onMsgStatus(listener: (event: MsgStatusEvent) => void): () => void
  onNudgeReceived(listener: (event: NudgeEvent) => void): () => void
  onConvsUpdated(listener: (convs: ConversationView[]) => void): () => void
  onTransferUpdated(listener: (transfer: TransferView) => void): () => void
  onGroupUpdated(listener: (group: GroupView) => void): () => void
  /** 截图窗：接收本地 PNG 字节 */
  onCaptureInit(listener: (pngBytes: ArrayBuffer) => void): () => void
  /** 主窗：截图选择"发送"后的字节流 */
  onCaptured(listener: (bytes: ArrayBuffer) => void): () => void
  /** 主窗：截图未能启动时显示可见反馈。 */
  onCaptureFailed(listener: (notice: CaptureFailureNotice) => void): () => void
  /** 点通知/托盘后主进程要求打开某会话 */
  onOpenConv(listener: (convId: string) => void): () => void
  /** 设置变更后同步主窗/设置窗外观 */
  onSettingsUpdated(listener: (settings: SettingsView) => void): () => void
  onAvatarReady(listener: (hash: string) => void): () => void
  /** Windows / Linux 设置模态窗开关状态；主窗用来控制遮罩与交互层级 */
  onSettingsWindowState(listener: (open: boolean) => void): () => void
  /** 文件柜窗口：已开着时被要求切到某位同事的柜子（决议 #283） */
  onCabinetFocusPeer(listener: (peerId: string) => void): () => void
  /** 主界面全局网段刷新进度 */
  onScanProgress(listener: (progress: ScanProgressView) => void): () => void
  /** 主窗 Command/Ctrl+V 图片剪贴板兜底 */
  onClipboardPasteImage(listener: () => void): () => void
  /** 沉浸式无标题栏（决议 #49）：最小化当前窗口 */
  minimizeWindow(): Promise<void>
  /** 最大化/还原当前窗口；返回切换后是否处于最大化 */
  toggleMaximizeWindow(): Promise<boolean>
  isWindowMaximized(): Promise<boolean>
  /** 当前窗口最大化状态变化（自绘按钮切图标用） */
  onWinMaximizeChanged(listener: (maximized: boolean) => void): () => void
  /** 关闭当前窗口（决议 #59）：走主进程标准 close 流程，主窗会被拦截进托盘 */
  closeWindow(): Promise<void>
  /** Linux JS 拖拽（决议 #52）：按住拖拽带时主进程跟随光标移窗 */
  beginWindowDrag(): Promise<void>
  endWindowDrag(): Promise<void>
}
