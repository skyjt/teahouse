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
  /** 自己消息可撤回窗口（决议 #23） */
  recallWindow: 2 * 60_000,
  /** 已收消息 ID 去重窗口（§7.2） */
  dedupTtl: 24 * 3_600_000,
  /** gossip 周期交换间隔（§6.3，另有"结识即交换"） */
  gossipInterval: 300_000,
  /** gossip 条目新鲜度门槛：lastSeen 超过此值的转述不予验证 */
  gossipFreshness: 600_000,
  /** 节点缓存启动探测范围：lastSeen 在此窗口内的离线节点逐个单播 entry（§6.3） */
  peerCacheProbeTtl: 7 * 24 * 3_600_000
}
export type Timings = typeof TIMINGS

/** peers 报文单包条目上限（条目约 120B，保证 ≤ UDP_MAX_PAYLOAD） */
export const PEERS_PER_PACKET = 8
/** gossip 周期交换的扇出节点数 */
export const GOSSIP_FANOUT = 2

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
  groupAdminHash: 64
}

export type Platform = 'win' | 'mac' | 'linux'

/** 节点资料（protocol §3），随 entry / alive / profile 报文携带 */
export interface Profile {
  nodeId: string
  nick: string
  company: string
  dept: string
  team: string
  /** 头像模板编号；-1 = 昵称色块，>=0 = 背景色下标 * 20 + emoji 下标 */
  avatar: number
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

/** 群成员上限（requirements F-MSG-4） */
export const GROUP_MAX_MEMBERS = 50

export const RECALL_WINDOW_MS = TIMINGS.recallWindow

/** 用户消息载荷（§7.1）。text=单聊；group-text=群聊；recall=撤回指令 */
export type MsgPayload =
  | {
      kind: 'text'
      text: string
      /** 补发标记：消息保持原 id/ts，落在历史正确位置 */
      resend?: boolean
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
  /** 管理密码摘要；空串表示无密码，密码明文不入库、不入协议 */
  adminSecretHash: string
}

export type GroupPayload =
  | { op: 'info'; group: GroupMeta }
  | { op: 'need'; groupId: string }

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

export interface FileMeta {
  fileId: string
  /** 相对路径（文件夹传输保留结构）；接收侧必须经 sanitize 落盘 */
  path: string
  size: number
  isDir?: boolean
}

/** 图片免确认上限（决议 #2，用户指定 20MB）；超限退化为普通文件流程 */
export const IMG_AUTO_ACCEPT = 20 * 1024 * 1024

export interface FileCtlOffer {
  op: 'offer'
  transferId: string
  /** 分包序号/总数（1-based） */
  seq: number
  total: number
  files: FileMeta[]
  totalSize: number
  fileCount: number
  /** 展示名：单文件=文件名，文件夹=目录名，多文件=首文件名 */
  rootName: string
  /** image/sticker：单文件 ≤20MB 时收端免确认进图片缓存（§7.1）；缺省按普通文件 */
  purpose?: 'image' | 'sticker'
}

export interface FileCtlSimple {
  op: 'accept' | 'decline' | 'cancel'
  transferId: string
}

export type FileCtlPayload = FileCtlOffer | FileCtlSimple

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
  | TcpMsgFrame
  | TcpMsgAckFrame

export const MSG_TYPES = {
  entry: 'entry',
  alive: 'alive',
  exit: 'exit',
  presence: 'presence',
  profile: 'profile',
  peers: 'peers',
  msg: 'msg',
  ack: 'ack',
  fileCtl: 'file-ctl',
  group: 'group'
} as const
