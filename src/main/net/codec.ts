import { randomUUID } from 'node:crypto'
import {
  AVATAR_MAX_BYTES,
  isAvatarPresetValue,
  GROUP_IMG_AUTO_ACCEPT,
  GROUP_MAX_MEMBERS,
  LIMITS,
  MAX_FILES_PER_TRANSFER,
  MSG_TYPES,
  OFFER_FILES_PER_PACKET,
  PROTOCOL_VERSION,
  SCAN_RANGES_PER_PACKET,
  SHARE_GET_MAX_PATHS,
  SHARE_LIST_PAGE,
  SHARE_NAME_MAX,
  SHARE_PATH_MAX,
  TABLE_TEXT_LIMIT_BYTES,
  TEXT_TCP_LIMIT,
  TEXT_UDP_LIMIT,
  UDP_MAX_INBOUND,
  UPDATE_PACKAGE_MAX_BYTES,
  type AckPayload,
  type AvatarPayload,
  type Envelope,
  type FileCtlOffer,
  type FileCtlPayload,
  type GroupPayload,
  type MsgPayload,
  type PeersPayload,
  type PresencePayload,
  type Profile,
  type ProfilePayload,
  type ScanRangesPayload,
  type SharePayload,
  type UpdateReqPayload
} from '../../shared/protocol'
import { isShareDenyReason } from '../../shared/protocol'
import { isAvatarHash } from '../../shared/protocol'
import { PEERS_PER_PACKET } from '../../shared/protocol'
import { isPkGame, isPkRef } from '../../shared/pk'
import { normalizeCidr } from './cidr'

// 信封编解码 + 入站校验（protocol §1/§4）：
// 一切来自网络的报文按不可信输入处理 —— 字段白名单、类型、长度全检；
// 未知 type 不算错误（known: false），由上层按协议忽略，保证向前兼容。

export function makeEnvelope<T>(type: string, from: string, payload: T): Envelope<T> {
  return { v: PROTOCOL_VERSION, type, id: randomUUID(), from, ts: Date.now(), payload }
}

export function encode(env: Envelope): Buffer {
  return Buffer.from(JSON.stringify(env), 'utf8')
}

export type DecodeResult =
  | { ok: true; env: Envelope; known: boolean }
  | { ok: false; reason: string }

const KNOWN_TYPES = new Set<string>(Object.values(MSG_TYPES))

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isStr(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= max
}

/** 允许空串的字符串字段（company/dept/team 可空） */
function isStrAllowEmpty(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.length <= max
}

function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && Number.isInteger(x)
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function isCidr(x: unknown): x is string {
  return typeof x === 'string' && x.length <= 18 && normalizeCidr(x) !== null
}

function isRuntimeArch(x: unknown): x is 'x64' | 'ia32' | 'arm64' {
  return x === 'x64' || x === 'ia32' || x === 'arm64'
}

export function validateProfile(p: unknown): p is Profile {
  if (!isRecord(p)) return false
  if (!isStr(p.nodeId, LIMITS.from)) return false
  if (!isStr(p.nick, LIMITS.nick)) return false
  if (!isStrAllowEmpty(p.company, LIMITS.company)) return false
  if (!isStrAllowEmpty(p.dept, LIMITS.dept)) return false
  if (!isStrAllowEmpty(p.team, LIMITS.team)) return false
  if (!isAvatarPresetValue(p.avatar)) return false
  if (p.avatarHash !== undefined && !isAvatarHash(p.avatarHash)) return false
  if (!isInt(p.profileRev) || p.profileRev < 0) return false
  if (!isStr(p.host, LIMITS.host)) return false
  if (p.platform !== 'win' && p.platform !== 'mac' && p.platform !== 'linux') return false
  if (!isInt(p.tcpPort) || p.tcpPort < 1 || p.tcpPort > 65535) return false
  if (!isStrAllowEmpty(p.ver, LIMITS.ver)) return false
  if (!Array.isArray(p.caps) || p.caps.length > LIMITS.caps) return false
  if (!p.caps.every((c) => typeof c === 'string' && c.length <= LIMITS.capItem)) return false
  return true
}

function validatePayload(type: string, payload: unknown, textLimit = TEXT_UDP_LIMIT): boolean {
  switch (type) {
    case MSG_TYPES.entry:
    case MSG_TYPES.alive:
    case MSG_TYPES.profile: {
      return isRecord(payload) && validateProfile((payload as Partial<ProfilePayload>).profile)
    }
    case MSG_TYPES.presence: {
      if (!isRecord(payload)) return false
      const p = payload as Partial<PresencePayload>
      return isInt(p.seq) && p.seq >= 0 && isInt(p.profileRev) && p.profileRev >= 0
    }
    case MSG_TYPES.msg: {
      if (!isRecord(payload)) return false
      const m = payload as Partial<MsgPayload>
      if (
        m.kind !== 'text' &&
        m.kind !== 'group-text' &&
        m.kind !== 'recall' &&
        m.kind !== 'nudge' &&
        m.kind !== 'pk'
      ) {
        return false
      }
      const resend = (m as { resend?: unknown }).resend
      if (resend !== undefined && typeof resend !== 'boolean') return false
      if (m.kind === 'nudge') return resend === undefined
      if (m.kind === 'pk') {
        if (resend !== undefined) return false
        if (!isPkGame(m.game)) return false
        if (!isPkRef({ game: m.game, result: m.result })) return false
        if (m.groupId !== undefined) {
          if (!isStr(m.groupId, LIMITS.id)) return false
          if (!isInt(m.groupRev) || m.groupRev < 0) return false
        } else if (m.groupRev !== undefined) {
          return false
        }
        return true
      }
      if (m.kind === 'recall') {
        if (!isStr(m.targetId, LIMITS.id)) return false
        if (m.groupId !== undefined) {
          if (!isStr(m.groupId, LIMITS.id)) return false
          if (!isInt(m.groupRev) || m.groupRev < 0) return false
        } else if (m.groupRev !== undefined) {
          return false
        }
        return true
      }
      const text = (m as { text?: unknown }).text
      if (typeof text !== 'string' || text.length === 0) return false
      if (Buffer.byteLength(text, 'utf8') > textLimit) return false
      if (m.kind === 'group-text') {
        if (!isStr(m.groupId, LIMITS.id)) return false
        if (!isInt(m.groupRev) || m.groupRev! < 0) return false
        if (m.mentions !== undefined) {
          if (!Array.isArray(m.mentions) || m.mentions.length > GROUP_MAX_MEMBERS) return false
          if (!m.mentions.every((id) => isStr(id, LIMITS.from))) return false
        }
        // replyTo：只允许携带源消息 ID；拒绝不可信字段（决议 #reply）
        if (m.replyTo !== undefined && (typeof m.replyTo !== 'string' || m.replyTo.length > LIMITS.id)) return false
        if (!Object.keys(payload).every((key) =>
          key === 'kind' || key === 'text' || key === 'groupId' || key === 'groupRev' ||
          key === 'mentions' || key === 'resend' || key === 'replyTo'
        )) return false
      }
      return true
    }
    case MSG_TYPES.group: {
      if (!isRecord(payload)) return false
      const g = payload as Partial<GroupPayload>
      if (g.op === 'need') {
        return isStr((g as { groupId?: unknown }).groupId, LIMITS.id)
      }
      if (g.op !== 'info') return false
      const meta = (g as { group?: unknown }).group
      if (!isRecord(meta)) return false
      if (!isStr(meta.groupId, LIMITS.id)) return false
      if (!isStr(meta.name, 32)) return false
      if (!Array.isArray(meta.members) || meta.members.length === 0) return false
      if (meta.members.length > GROUP_MAX_MEMBERS) return false
      if (!meta.members.every((m2) => typeof m2 === 'string' && m2.length <= LIMITS.from))
        return false
      const members = meta.members as string[]
      if (!isInt(meta.rev) || meta.rev < 1) return false
      if (!isStr(meta.updatedBy, LIMITS.from)) return false
      if (!isInt(meta.updatedTs) || meta.updatedTs <= 0) return false
      if (meta.creatorIp !== undefined && !isStrAllowEmpty(meta.creatorIp, LIMITS.ip)) return false
      if (meta.creatorId !== undefined && !isStrAllowEmpty(meta.creatorId, LIMITS.from)) return false
      const hasOwnerId = meta.ownerId !== undefined
      const hasAdminIds = meta.adminIds !== undefined
      if (hasOwnerId !== hasAdminIds) return false
      if (hasOwnerId) {
        if (!isStr(meta.ownerId, LIMITS.from) || !members.includes(meta.ownerId)) return false
        if (!Array.isArray(meta.adminIds) || meta.adminIds.length > GROUP_MAX_MEMBERS) return false
        if (!meta.adminIds.every((id) => isStr(id, LIMITS.from))) return false
        if (new Set(meta.adminIds).size !== meta.adminIds.length) return false
        if (meta.adminIds.includes(meta.ownerId)) return false
        if (!meta.adminIds.every((id) => members.includes(id))) return false
      }
      if (
        meta.avatarHash !== undefined &&
        meta.avatarHash !== '' &&
        !isAvatarHash(meta.avatarHash)
      ) {
        return false
      }
      if (
        meta.adminSecretHash !== undefined &&
        !(
          meta.adminSecretHash === '' ||
          (typeof meta.adminSecretHash === 'string' &&
            meta.adminSecretHash.length === LIMITS.groupAdminHash &&
            /^[a-f0-9]+$/.test(meta.adminSecretHash))
        )
      ) {
        return false
      }
      if (
        meta.adminHint !== undefined &&
        !isStrAllowEmpty(meta.adminHint, LIMITS.groupAdminHint)
      ) {
        return false
      }
      // v0.54 新字段对旧端保持向前兼容：字段缺省交给服务层按本地值补齐；
      // 显式提供时仍必须是合法字符串，空串用于清空。
      if (meta.description !== undefined && !isStrAllowEmpty(meta.description, LIMITS.groupDescription)) return false
      if (meta.announce !== undefined && !isStrAllowEmpty(meta.announce, LIMITS.groupAnnounce)) return false
      return true
    }
    case MSG_TYPES.avatar: {
      if (!isRecord(payload)) return false
      const avatar = payload as Partial<AvatarPayload>
      if (!isAvatarHash(avatar.hash)) return false
      if (avatar.groupId !== undefined && !isStr(avatar.groupId, LIMITS.id)) return false
      if (avatar.op === 'get' || avatar.op === 'miss') {
        return Object.keys(payload).every((key) => key === 'op' || key === 'hash' || key === 'groupId')
      }
      if (avatar.op !== 'data' || typeof avatar.bytesBase64 !== 'string') return false
      if (!Object.keys(payload).every((key) =>
        key === 'op' || key === 'hash' || key === 'bytesBase64' || key === 'groupId'
      )) {
        return false
      }
      if (!isStrictBase64(avatar.bytesBase64)) return false
      return Buffer.from(avatar.bytesBase64, 'base64').length <= AVATAR_MAX_BYTES
    }
    case MSG_TYPES.ack: {
      if (!isRecord(payload)) return false
      const a = payload as Partial<AckPayload>
      return isStr(a.ackFor, LIMITS.id)
    }
    case MSG_TYPES.fileCtl: {
      if (!isRecord(payload)) return false
      const f = payload as Partial<FileCtlPayload>
      if (!isStr(f.transferId, LIMITS.id)) return false
      if (f.op === 'accept' || f.op === 'decline' || f.op === 'cancel' || f.op === 'direct') {
        return true
      }
      if (f.op !== 'offer') return false
      const o = f as Partial<FileCtlOffer>
      if (o.msgId !== undefined && !isStr(o.msgId, LIMITS.id)) return false
      if (!isInt(o.seq) || !isInt(o.total) || o.seq! < 1 || o.total! < 1 || o.seq! > o.total!)
        return false
      if (o.total! > Math.ceil(MAX_FILES_PER_TRANSFER / OFFER_FILES_PER_PACKET)) return false
      if (!isInt(o.totalSize) || o.totalSize! < 0) return false
      if (!isInt(o.fileCount) || o.fileCount! < 1 || o.fileCount! > MAX_FILES_PER_TRANSFER)
        return false
      if (!isStr(o.rootName, 255)) return false
      if (
        o.purpose !== undefined &&
        o.purpose !== 'image' &&
        o.purpose !== 'sticker' &&
        o.purpose !== 'update' &&
        o.purpose !== 'share-get' &&
        o.purpose !== 'share-put'
      ) {
        return false
      }
      // 文件柜传输永不属于群聊，也不带聊天消息锚点（§8.2）
      if (
        (o.purpose === 'share-get' || o.purpose === 'share-put') &&
        (o.groupId !== undefined || o.msgId !== undefined)
      ) {
        return false
      }
      if (
        o.expiresAt !== undefined &&
        (!Number.isSafeInteger(o.expiresAt) || o.expiresAt <= 0)
      ) {
        return false
      }
      if (o.purpose !== undefined && o.expiresAt !== undefined) return false
      if (
        o.purpose === 'update' &&
        (o.groupId !== undefined ||
          o.fileCount !== 1 ||
          o.totalSize! <= 0 ||
          o.totalSize! > UPDATE_PACKAGE_MAX_BYTES)
      ) {
        return false
      }
      if (o.groupId !== undefined) {
        if (!isStr(o.groupId, LIMITS.id)) return false
        if (!isInt(o.groupRev) || o.groupRev < 0) return false
        if (o.purpose !== undefined && o.purpose !== 'update' && o.totalSize! > GROUP_IMG_AUTO_ACCEPT)
          return false
      } else if (o.groupRev !== undefined) {
        return false
      }
      if (!Array.isArray(o.files) || o.files.length === 0 || o.files.length > OFFER_FILES_PER_PACKET)
        return false
      if (
        o.tableText !== undefined ||
        (o as { tableTextTruncated?: unknown }).tableTextTruncated !== undefined
      ) {
        if (
          typeof o.tableText !== 'string' ||
          o.tableText.length === 0 ||
          utf8ByteLength(o.tableText) > TABLE_TEXT_LIMIT_BYTES
        ) {
          return false
        }
        if (
          (o as { tableTextTruncated?: unknown }).tableTextTruncated !== undefined &&
          (o as { tableTextTruncated?: unknown }).tableTextTruncated !== true
        ) {
          return false
        }
        if (o.purpose !== 'image' || o.fileCount !== 1 || o.files.length !== 1 || o.files[0].isDir) {
          return false
        }
      }
      return o.files.every(
        (m) =>
          isRecord(m) &&
          isStr(m.fileId, LIMITS.id) &&
          isStr(m.path, 512) &&
          isInt(m.size) &&
          m.size >= 0 &&
          (m.isDir === undefined || typeof m.isDir === 'boolean')
      )
    }
    case MSG_TYPES.peers: {
      if (!isRecord(payload)) return false
      const p = payload as Partial<PeersPayload>
      if (!Array.isArray(p.peers) || p.peers.length === 0 || p.peers.length > PEERS_PER_PACKET * 2)
        return false
      return p.peers.every(
        (s) =>
          isRecord(s) &&
          isStr(s.nodeId, LIMITS.from) &&
          isStr(s.ip, 45) &&
          isInt(s.udpPort) &&
          s.udpPort >= 1 &&
          s.udpPort <= 65535 &&
          isInt(s.tcpPort) &&
          s.tcpPort >= 1 &&
          s.tcpPort <= 65535 &&
          isInt(s.lastSeen) &&
          s.lastSeen >= 0
      )
    }
    case MSG_TYPES.scanRanges: {
      if (!isRecord(payload)) return false
      const p = payload as Partial<ScanRangesPayload>
      if (
        !Array.isArray(p.ranges) ||
        p.ranges.length === 0 ||
        p.ranges.length > SCAN_RANGES_PER_PACKET
      ) {
        return false
      }
      return p.ranges.every(
        (r) =>
          isRecord(r) &&
          isCidr(r.cidr) &&
          isInt(r.addedAt) &&
          r.addedAt > 0
      )
    }
    case MSG_TYPES.share: {
      // 共享文件柜控制面（§8.2）：路径一律当相对路径校验，绝对路径 / .. / 盘符全部拒绝；
      // 真实路径是否越出共享根由 ShareService 再用 realpath 复核。
      if (!isRecord(payload)) return false
      const sh = payload as Partial<SharePayload> & Record<string, unknown>
      if (!isStr(sh.reqId, LIMITS.id)) return false
      if (sh.op === 'list') {
        if (!isSharePath(sh.path)) return false
        if (!isInt(sh.offset) || (sh.offset as number) < 0) return false
        if (sh.snapshotId !== undefined && !isStr(sh.snapshotId, LIMITS.id)) return false
        return Object.keys(payload).every(
          (key) => key === 'op' || key === 'reqId' || key === 'path' || key === 'offset' || key === 'snapshotId'
        )
      }
      if (sh.op === 'list-ok') {
        if (!isSharePath(sh.path)) return false
        if (sh.perm !== 'read' && sh.perm !== 'write') return false
        if (!isStr(sh.snapshotId, LIMITS.id)) return false
        if (!isInt(sh.offset) || (sh.offset as number) < 0) return false
        if (!isInt(sh.total) || (sh.total as number) < 0) return false
        if (typeof sh.truncated !== 'boolean') return false
        if (!Array.isArray(sh.entries) || sh.entries.length > SHARE_LIST_PAGE) return false
        return sh.entries.every(
          (e) =>
            isRecord(e) &&
            isShareEntryName(e.name) &&
            isInt(e.size) &&
            (e.size as number) >= 0 &&
            typeof e.isDir === 'boolean' &&
            isInt(e.mtime) &&
            (e.mtime as number) >= 0
        )
      }
      if (sh.op === 'get') {
        if (!Array.isArray(sh.paths) || sh.paths.length === 0) return false
        if (sh.paths.length > SHARE_GET_MAX_PATHS) return false
        // 根目录整取无意义且会绕过逐条校验，因此 get 不接受空路径
        return sh.paths.every((p) => isSharePath(p) && (p as string).length > 0)
      }
      if (sh.op === 'deny') return isShareDenyReason(sh.reason)
      return false
    }
    case MSG_TYPES.update: {
      // 自更新请求（§8.1，决议 #166/#181）：只认 op:'req' + 合法平台；
      // arch 可选，存在时用于避免 Windows/Linux 多架构安装包混用。
      if (!isRecord(payload)) return false
      const u = payload as Partial<UpdateReqPayload>
      if (u.op !== 'req') return false
      if (u.arch !== undefined && !isRuntimeArch(u.arch)) return false
      return u.platform === 'win' || u.platform === 'mac' || u.platform === 'linux'
    }
    case MSG_TYPES.exit:
      return isRecord(payload)
    default:
      return isRecord(payload)
  }
}

/** 共享文件柜相对路径的格式校验（§8.2）：空串=共享根；深度与越界另由 ShareService 复核 */
function isSharePath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (utf8ByteLength(value) > SHARE_PATH_MAX) return false
  if (value.length === 0) return true
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  if (value.includes('\\') || value.includes('\u0000')) return false
  const segments = value.split('/')
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && seg.length <= SHARE_NAME_MAX)
}

/** 目录条目名：非空、不含路径分隔符、不是 . / .. */
function isShareEntryName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SHARE_NAME_MAX &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\u0000') &&
    value !== '.' &&
    value !== '..'
  )
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4) return false
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Buffer.from(value, 'base64').length === (value.length / 4) * 3 - padding
}

export function decode(buf: Buffer): DecodeResult {
  if (buf.length > UDP_MAX_INBOUND) return { ok: false, reason: 'oversize' }

  let raw: unknown
  try {
    raw = JSON.parse(buf.toString('utf8'))
  } catch {
    return { ok: false, reason: 'bad-json' }
  }

  return decodeEnvelopeObject(raw)
}

export function decodeEnvelopeObject(raw: unknown, textLimit = TEXT_UDP_LIMIT): DecodeResult {
  if (!isRecord(raw)) return { ok: false, reason: 'not-object' }
  if (raw.v !== PROTOCOL_VERSION) return { ok: false, reason: 'version' }
  if (!isStr(raw.type, LIMITS.type)) return { ok: false, reason: 'bad-type' }
  if (!isStr(raw.id, LIMITS.id)) return { ok: false, reason: 'bad-id' }
  if (!isStr(raw.from, LIMITS.from)) return { ok: false, reason: 'bad-from' }
  if (!isInt(raw.ts) || raw.ts <= 0) return { ok: false, reason: 'bad-ts' }
  if (raw.payload === undefined) return { ok: false, reason: 'no-payload' }

  const known = KNOWN_TYPES.has(raw.type)
  if (known && !validatePayload(raw.type, raw.payload, textLimit)) {
    return { ok: false, reason: `bad-payload:${raw.type}` }
  }

  return { ok: true, env: raw as unknown as Envelope, known }
}

export function decodeTcpEnvelopeObject(raw: unknown): DecodeResult {
  return decodeEnvelopeObject(raw, TEXT_TCP_LIMIT)
}
