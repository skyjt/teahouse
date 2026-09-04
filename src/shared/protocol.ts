// 协议常量与报文类型 —— docs/protocol.md 的 TS 化（唯一来源，main / renderer / 测试共用）

export const PROTOCOL_VERSION = 1

export const DEFAULT_UDP_PORT = 17878
export const DEFAULT_TCP_PORT = 17879

/** 出站单包上限，防 IP 分片（protocol §2） */
export const UDP_MAX_PAYLOAD = 1200
/** 入站硬上限，超过直接丢弃 */
export const UDP_MAX_INBOUND = 4096
/** 文本超过此长度走 TCP 控制帧（protocol §7.2 / §9） */
export const TEXT_UDP_LIMIT = 800
/** 文本输入硬上限；超出不发送 */
export const TEXT_TCP_LIMIT = 4096
/** 局域网自更新单包硬上限（决议 #208）。 */
export const UPDATE_PACKAGE_MAX_BYTES = 512 * 1024 * 1024
/** 自定义头像源文件读取上限（决议 #243）。 */
export const AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024
/** 自定义头像源图单边上限。 */
export const AVATAR_MAX_DIMENSION = 8192
/** 自定义头像固定输出边长。 */
export const AVATAR_OUTPUT_SIZE = 192
/** 自定义头像编码后硬上限，确保 base64 信封低于 TCP 64KiB 控制帧。 */
export const AVATAR_MAX_BYTES = 32 * 1024
/** 旧版昵称首字头像；背景颜色继续按昵称散列。 */
export const AVATAR_LEGACY_INITIAL_VALUE = -1
/** 动物表情头像编号上限：10 种背景色 * 20 个表情。 */
export const AVATAR_ANIMAL_MAX_VALUE = 199
/** 昵称首字显式背景颜色编号起点（决议 #245）。 */
export const AVATAR_INITIAL_COLOR_BASE = 200
export const AVATAR_INITIAL_COLOR_MAX = 209

export function isAvatarPresetValue(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= AVATAR_LEGACY_INITIAL_VALUE &&
    value <= AVATAR_INITIAL_COLOR_MAX
  )
}

/** 时序参数（protocol §9）。测试中可整体注入缩短。 */
export const TIMINGS = {
  presenceInterval: 30_000,
  offlineAfter: 90_000,
  sweepInterval: 10_000,
  /** entry 应答抖动起步窗口：0–2s（§6.1） */
  entryReplyJitterBase: 2_000,
  /** 抖动窗口按在线规模自适应的上限：0–8s（§6.1 批量开机对策） */
  entryReplyJitterMax: 8_000,
  /** 对同一节点 10s 内不重复应答 alive（§6.1） */
  aliveDedupWindow: 10_000,
  /** 探活超时（§6.2 按需探活） */
  probeTimeout: 2_000,
  /** msg 的 ACK 退避重传间隔（§7.2）：发送后依次等待，仍无 ACK 即入补发队列 */
  ackRetrySchedule: [1_000, 2_000, 4_000] as number[],
  /** 补发队列保留时长 / 单节点上限（决议 #6） */
  queueTtl: 7 * 24 * 3_600_000,
  queueMaxPerPeer: 200,
  /** 自己消息可撤回窗口（决议 #23；#63 起 2→5 分钟） */
  recallWindow: 5 * 60_000,
  /** 私聊窗口震动：同一对端两次至少间隔 15s（决议 #109） */
  nudgeMinInterval: 15_000,
  /** 私聊窗口震动：同一对端 60s 滑动窗口最多 2 次（决议 #109） */
  nudgeRateWindow: 60_000,
  nudgeMaxPerWindow: 2,
  /** 已收消息 ID 去重窗口（§7.2） */
  dedupTtl: 24 * 3_600_000,
  /** gossip 周期交换间隔（§6.3，另有"结识即交换"） */
  gossipInterval: 300_000,
  /** gossip 条目新鲜度门槛：lastSeen 超过此值的转述不予验证 */
  gossipFreshness: 600_000,
  /** 节点缓存启动探测范围：lastSeen 在此窗口内的离线节点逐个单播 entry（§6.3） */
  peerCacheProbeTtl: 7 * 24 * 3_600_000,
  /** 网段记录同步：启动/新增后的首次分享抖动窗口，避免同一时刻群发 */
  scanRangeShareInitialMin: 2 * 60_000,
  scanRangeShareInitialMax: 10 * 60_000,
  /** 网段记录同步：低频兜底周期 */
  scanRangeShareInterval: 60 * 60_000,
  /** 自动接收网段后的首次后台扫描抖动窗口 */
  scanRangeAutoScanInitialMin: 30 * 60_000,
  scanRangeAutoScanInitialMax: 90 * 60_000,
  /** 同一自动同步网段最短扫描间隔 */
  scanRangeAutoScanMinInterval: 12 * 60 * 60_000,
  /** 自动后台扫描限速：约 16 地址/秒，低于手动扫描 */
  scanRangeAutoScanHostDelay: 62,
  /** 在线规模较大时，只有部分客户端参与后台扫描 */
  scanRangeAutoScanLargeOnlineThreshold: 50,
  scanRangeAutoScanLargeOnlineModulo: 10
}
export type Timings = typeof TIMINGS

/** peers 报文单包条目上限（条目约 120B，保证 ≤ UDP_MAX_PAYLOAD） */
export const PEERS_PER_PACKET = 8
/** gossip 周期交换的扇出节点数 */
export const GOSSIP_FANOUT = 2
/** scan-ranges 报文单包条目上限（CIDR + 元数据，保证 ≤ UDP_MAX_PAYLOAD） */
export const SCAN_RANGES_PER_PACKET = 10

/** 字段长度上限（入站校验白名单，protocol §1 第 5 条） */
export const LIMITS = {
  nick: 32,
  company: 32,
  dept: 32,
  team: 32,
  host: 64,
  ver: 16,
  caps: 16,
  capItem: 16,
  type: 32,
  id: 64,
  from: 64,
  ip: 45,
  groupAdminPassword: 64,
  groupAdminHint: 40,
  groupAdminHash: 64,
  avatarHash: 64,
  groupDescription: 200,
  groupAnnounce: 1024
}

export type Platform = 'win' | 'mac' | 'linux'
export type RuntimeArch = 'x64' | 'ia32' | 'arm64'

/** 节点资料（protocol §3），随 entry / alive / profile 报文携带 */
export interface Profile {
  nodeId: string
  nick: string
  company: string
  dept: string
  team: string
  /** -1 = 旧昵称首字；0..199 = 背景色 * 20 + 动物；200..209 = 昵称首字背景色。 */
  avatar: number
  /** 自定义头像内容 SHA-256；缺省/空串时使用数字头像。 */
  avatarHash?: string
  /** 资料版本号，每次修改 +1；presence 携带，用于失配刷新 */
  profileRev: number
  host: string
  platform: Platform
  tcpPort: number
  /** 应用版本，"内网有新版"提示的依据 */
  ver: string
  /** 能力声明，供未来扩展探测 */
  caps: string[]
}

/** caps 能力位（protocol §3 / 决议 #166）：声明本节点能力，供对端探测；入站未知位忽略。 */
export const CAPS = {
  /** 可作为本平台更新源：运行于可分发形态（nsis 自留安装器 / deb 自重打包），能向同平台同架构低版本节点提供安装包。 */
  updateSource: 'upd1',
  /** 私聊文件支持发送方在文件卡片上请求免确认直接接收（收端仍受本地开关控制）。 */
  fileDirect: 'fd1',
  /** 支持 file-ctl offer.msgId，并可撤回图片 / 未完成文件。 */
  mediaRecall: 'mrec1',
  /** 支持表格图片消息在图片 / 原始 TSV 文本视图间本地切换。 */
  tableText: 'tbl1',
  /** 支持 TCP wait 排队帧；作为发送方时对端取消后保留供流授权，允许断点重拉（决议 #211）。 */
  transferWait: 'tw1',
  /** 支持讨论组群主/管理员角色、普通成员邀请与角色权限校验（决议 #241）。 */
  groupRoles: 'gr1',
  /** 支持资料/群头像哈希与可靠 avatar 按需取图（决议 #243）。 */
  avatarImages: 'av1',
  /**
   * 共享文件柜（决议 #271/#275）：能应答 share 报文并收发 purpose:"share-get"|"share-put"。
   * 只表示"支持这套协议"，不代表已开共享——是否可见、可下载、可上传一律由共享方本机当场判定。
   */
  fileCabinet: 'shr1'
} as const

/**
 * 共享文件柜权限档（protocol §8.2 / 决议 #271）：
 * off = 完全不可见，read = 可浏览与下载，write = 额外允许上传新文件（不可删改覆盖）。
 * 既是本机默认档与按人例外的取值，也是 `share{op:"list-ok"}` 里 `perm` 的取值域。
 */
export type ShareMode = 'off' | 'read' | 'write'

export function isShareMode(value: unknown): value is ShareMode {
  return value === 'off' || value === 'read' || value === 'write'
}

/**
 * 有效权限（决议 #271）：命中按人例外则用例外，否则回落默认档。
 * 判定只在共享方本机进行，不信任任何对端声明。
 */
export function effectiveShareMode(
  defaultMode: ShareMode,
  grant: ShareMode | null | undefined
): ShareMode {
  return grant ?? defaultMode
}

/** 报文信封（protocol §4） */
export interface Envelope<T = unknown> {
  v: number
  type: string
  id: string
  from: string
  ts: number
  payload: T
}

/** entry / alive / profile 的载荷 */
export interface ProfilePayload {
  profile: Profile
}

/** presence 心跳载荷（§6.2） */
export interface PresencePayload {
  seq: number
  profileRev: number
}

/** exit 载荷（空对象） */
export type ExitPayload = Record<string, never>

export interface PeerSummary {
  nodeId: string
  ip: string
  udpPort: number
  tcpPort: number
  lastSeen: number
}

/** gossip 节点摘要交换（§6.3）：收端对陌生且新鲜的条目单播 entry 验证，不直接入表 */
export interface PeersPayload {
  peers: PeerSummary[]
}

export interface ScanRangeSummary {
  cidr: string
  /** 源端首次记录该网段的大致时间，仅用于 UI/去重元数据，不参与权限判断 */
  addedAt: number
}

/** 低频同步网段记录；收端只入配置候选，扫描由本机后台节流器决定 */
export interface ScanRangesPayload {
  ranges: ScanRangeSummary[]
}

/** 群成员上限（requirements F-MSG-4，决议 #198 由 50 调至 200） */
export const GROUP_MAX_MEMBERS = 200

export const RECALL_WINDOW_MS = TIMINGS.recallWindow
export const NUDGE_MIN_INTERVAL_MS = TIMINGS.nudgeMinInterval
export const NUDGE_RATE_WINDOW_MS = TIMINGS.nudgeRateWindow
export const NUDGE_MAX_PER_WINDOW = TIMINGS.nudgeMaxPerWindow

/** 用户消息载荷（§7.1）。text=单聊；group-text=群聊；recall=撤回指令；nudge=私聊窗口震动；pk=分歧解决 */
export type MsgPayload =
  | {
      kind: 'text'
      text: string
      /** 补发标记：消息保持原 id/ts，落在历史正确位置 */
      resend?: boolean
    }
  | {
      kind: 'nudge'
    }
  | {
      kind: 'pk'
      game: PkGame
      result: PkResult
      groupId?: string
      groupRev?: number
    }
  | {
      kind: 'group-text'
      text: string
      groupId: string
      /** 发送方所见群元数据版本，落后方触发 need 同步（§7.4） */
      groupRev: number
      /** 被 @ 的成员 nodeId；仅用于本地加强提醒，不改变投递范围 */
      mentions?: string[]
      /** 补发标记：消息保持原 id/ts，落在历史正确位置 */
      resend?: boolean
      /** 被引用的源消息 ID；接收端在本地群会话内查询后生成展示内容，原字段不随报文传送 */
      replyTo?: string
    }
  | {
      kind: 'recall'
      /** 要撤回的原消息 id */
      targetId: string
      /** 群聊撤回时携带，用于定位会话与触发元数据补齐 */
      groupId?: string
      groupRev?: number
      /** 补发标记：消息保持原 id/ts，落在历史正确位置 */
      resend?: boolean
    }

/** 群元数据（§7.4）：rev 单调递增，冲突按 (rev, updatedTs) 取大（LWW） */
export interface GroupMeta {
  groupId: string
  name: string
  members: string[]
  rev: number
  updatedBy: string
  updatedTs: number
  /** 建群时记录的创建端 IPv4；无管理密码时仅该来源 IP 可管理群 */
  creatorIp: string
  /** 建群者 nodeId；v0.16.3 起用于多网卡环境下的无密码群管理校验 */
  creatorId: string
  /** 当前群主 nodeId；v0.43 起随 group.info 同步，旧包可缺省 */
  ownerId: string
  /** 管理员 nodeId 列表；必须属于 members 且不含 ownerId，旧包可缺省 */
  adminIds: string[]
  /** 自定义群头像 SHA-256；空串表示默认群图标，旧包可缺省。 */
  avatarHash?: string
  /** 管理密码摘要；空串表示无密码，密码明文不入库、不入协议 */
  adminSecretHash: string
  /** 管理密码提示；仅用于 UI 展示，不参与鉴权 */
  adminHint: string
  /** 群简介；空串表示未设置，仅群主、管理员或正确密码持有者可修改；旧 group.info 可缺省 */
  description: string
  /** 群公告；空串表示未设置，仅群主、管理员或正确密码持有者可修改；旧 group.info 可缺省 */
  announce: string
}

export type GroupPayload =
  | { op: 'info'; group: GroupMeta }
  | { op: 'need'; groupId: string }

/** 自定义头像按需取图（决议 #243）；groupId 缺省表示用户头像。
 *  miss（决议 #249）= 来源无法提供数据的尽力而为提示，只允许一次性 UDP 单发：
 *  v0.47 及更早端收到 miss 会整包忽略且不回 ACK，可靠发送会把旧端误判为离线。 */
export type AvatarPayload =
  | { op: 'get'; hash: string; groupId?: string }
  | { op: 'data'; hash: string; bytesBase64: string; groupId?: string }
  | { op: 'miss'; hash: string; groupId?: string }

/** ACK 载荷（§7.2） */
export interface AckPayload {
  ackFor: string
}

// ---------- 文件传输（§8） ----------

/** offer 单包最多携带的文件条目（保证 ≤ UDP_MAX_PAYLOAD，超出拆多条同 transferId） */
export const OFFER_FILES_PER_PACKET = 6
/** offer 分包组装超时 */
export const OFFER_ASSEMBLE_TIMEOUT = 10_000
/** 单次传输文件数上限（防恶意 offer 撑爆内存） */
export const MAX_FILES_PER_TRANSFER = 2000
/** 发送端排队 / 哈希收尾期间 wait 帧保活间隔（§8，决议 #211） */
export const PULL_WAIT_HEARTBEAT = 20_000
/** 接收端拉取空闲超时（§8，决议 #211）：超时判失败，可按 .part 断点续传重试 */
export const PULL_IDLE_TIMEOUT = 60_000
/** 私聊/群聊普通文件从发送时刻起的领取窗口（§8，决议 #263） */
export const FILE_OFFER_TTL = 24 * 60 * 60_000

export interface FileMeta {
  fileId: string
  /** 相对路径（文件夹传输保留结构）；接收侧必须经 sanitize 落盘 */
  path: string
  size: number
  isDir?: boolean
}

// ---------- 共享文件柜（§8.2，决议 #271–#277） ----------

/** 单页目录条目上限；与 SHARE_LIST_FRAME_MAX 同时生效，先到者收窄当页 */
export const SHARE_LIST_PAGE = 200
/** 单条 list-ok 信封上限；低于 TCP 帧上限 64KiB 留头 */
export const SHARE_LIST_FRAME_MAX = 32 * 1024
/** 单目录列举硬上限，超出取前 N 条并置 truncated */
export const SHARE_DIR_MAX_ENTRIES = 5000
/** 共享根以下可展开的目录层级上限（决议 #276） */
export const SHARE_MAX_DEPTH = 16
/** 相对路径与单个条目名长度上限（字节 / 字符） */
export const SHARE_PATH_MAX = 1024
export const SHARE_NAME_MAX = 255
/** 单次 get 可请求的条目数上限 */
export const SHARE_GET_MAX_PATHS = 64
/** list / get 未收到应答即超时，可手动重试 */
export const SHARE_REQ_TIMEOUT = 8_000
/** 同一对端列目录限流（决议 #276）：10 秒 5 次，超限回 deny{busy} */
export const SHARE_LIST_RATE_WINDOW = 10_000
export const SHARE_LIST_RATE_MAX = 5
/** 列表分页快照存活时间与缓存份数上限 */
export const SHARE_SNAPSHOT_TTL = 60_000
export const SHARE_SNAPSHOT_MAX = 8
/** 发出 get 后接受对方 share-get offer 的一次性授权时限（决议 #275） */
export const SHARE_GET_AUTH_TTL = 60_000
/** 单次上传到对方文件柜的总量上限（决议 #272，第 ③ 步启用） */
export const SHARE_PUT_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** 目录条目（list-ok 携带）；只含共享根下的名字，不含任何绝对路径 */
export interface ShareEntry {
  name: string
  size: number
  isDir: boolean
  /** 修改时间，Unix 毫秒 */
  mtime: number
}

/** deny 的原因码；渲染层据此给出可读提示，不重试 */
export type ShareDenyReason = 'off' | 'no-perm' | 'not-found' | 'too-deep' | 'busy' | 'gone'

export function isShareDenyReason(value: unknown): value is ShareDenyReason {
  return (
    value === 'off' ||
    value === 'no-perm' ||
    value === 'not-found' ||
    value === 'too-deep' ||
    value === 'busy' ||
    value === 'gone'
  )
}

/** share 报文载荷（§8.2）：控制面走 UDP，超 1200B 由既有 TCP 控制帧兜底 */
export type SharePayload =
  | {
      op: 'list'
      reqId: string
      /** 共享根下的相对路径；空串 = 根 */
      path: string
      offset: number
      /** 翻页时原样带回 list-ok 给的快照 ID */
      snapshotId?: string
    }
  | {
      op: 'list-ok'
      reqId: string
      path: string
      /** 共享方判定后告知的权限，仅用于对端 UI；每次请求仍各自复核 */
      perm: 'read' | 'write'
      snapshotId: string
      offset: number
      total: number
      truncated: boolean
      entries: ShareEntry[]
    }
  | {
      op: 'get'
      reqId: string
      paths: string[]
    }
  | {
      op: 'deny'
      reqId: string
      reason: ShareDenyReason
    }

/** 图片免确认上限（决议 #2，用户指定 20MB）；超限退化为普通文件流程 */
export const IMG_AUTO_ACCEPT = 20 * 1024 * 1024
/** 群聊图片内联上限（决议 #33）：超限按普通文件发送，由收端手动接收 */
export const GROUP_IMG_AUTO_ACCEPT = 10 * 1024 * 1024
/** 表格图片消息原始 TSV 文字视图上限（决议 #190） */
export const TABLE_TEXT_LIMIT_BYTES = TEXT_TCP_LIMIT

export interface FileCtlOffer {
  op: 'offer'
  transferId: string
  /** 聊天媒体消息 ID；图片 / 普通文件 / 群文件新端填写，用于跨端撤回锚点。 */
  msgId?: string
  /** 分包序号/总数（1-based） */
  seq: number
  total: number
  files: FileMeta[]
  totalSize: number
  fileCount: number
  /** 展示名：单文件=文件名，文件夹=目录名，多文件=首文件名 */
  rootName: string
  /**
   * image/sticker：聊天媒体；update：局域网自更新安装包（不入聊天/接收目录）；
   * share-get / share-put：共享文件柜的下载与上传（决议 #275，同样不入聊天、不套领取期限）。
   */
  purpose?: 'image' | 'sticker' | 'update' | 'share-get' | 'share-put'
  /** 普通文件领取截止时间（发送端 Unix 毫秒）；自动媒体/更新包禁止携带。 */
  expiresAt?: number
  /** 表格图片消息的原始 TSV 文字视图；仅 purpose=image 单图可携带。 */
  tableText?: string
  /** tableText 因上限被截断时为 true；仅与 tableText 同时出现。 */
  tableTextTruncated?: boolean
  /** 群聊媒体上下文；存在时收端把本地消息写入 group:<groupId> 会话 */
  groupId?: string
  groupRev?: number
}

export interface FileCtlSimple {
  op: 'accept' | 'decline' | 'cancel' | 'direct'
  transferId: string
}

export type FileCtlPayload = FileCtlOffer | FileCtlSimple

/** 局域网自更新控制报文（§8.1，决议 #166）：B 请求 A 发来其平台安装包 */
export interface UpdateReqPayload {
  op: 'req'
  /** 请求方平台，供 A 复核同平台、拒绝跨平台请求 */
  platform: Platform
  /** 请求方运行架构；用于避免 Windows/Linux 多架构安装包混用 */
  arch?: RuntimeArch
}
export type UpdatePayload = UpdateReqPayload

/** TCP 控制帧（4 字节大端长度前缀 + UTF-8 JSON；pull-ok 后紧跟 len 字节裸流） */
export interface PullFrame {
  type: 'pull'
  from: string
  transferId: string
  fileId: string
  offset: number
}
export interface PullOkFrame {
  type: 'pull-ok'
  fileId: string
  len: number
}
export interface DoneFrame {
  type: 'done'
  fileId: string
  sha256: string
}
export interface FinishFrame {
  type: 'finish'
  transferId: string
}
export interface ErrFrame {
  type: 'err'
  reason: string
}
/** 排队 / 哈希收尾保活（决议 #211）：仅发给声明 tw1 的对端，旧端遇未知帧型会断链 */
export interface WaitFrame {
  type: 'wait'
}
export interface TcpMsgFrame {
  type: 'msg'
  envelope: Envelope
}
export interface TcpMsgAckFrame {
  type: 'msg-ack'
  ackFor: string
}
export type TcpFrame =
  | PullFrame
  | PullOkFrame
  | DoneFrame
  | FinishFrame
  | ErrFrame
  | WaitFrame
  | TcpMsgFrame
  | TcpMsgAckFrame

export const MSG_TYPES = {
  entry: 'entry',
  alive: 'alive',
  exit: 'exit',
  presence: 'presence',
  profile: 'profile',
  peers: 'peers',
  scanRanges: 'scan-ranges',
  msg: 'msg',
  ack: 'ack',
  fileCtl: 'file-ctl',
  group: 'group',
  avatar: 'avatar',
  update: 'update',
  share: 'share'
} as const

export function isAvatarHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
import type { PkGame, PkResult } from './pk'
