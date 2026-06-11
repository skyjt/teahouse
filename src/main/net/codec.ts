import { randomUUID } from 'node:crypto'
import {
  LIMITS,
  MAX_FILES_PER_TRANSFER,
  MSG_TYPES,
  OFFER_FILES_PER_PACKET,
  PROTOCOL_VERSION,
  TEXT_UDP_LIMIT,
  UDP_MAX_INBOUND,
  type AckPayload,
  type Envelope,
  type FileCtlOffer,
  type FileCtlPayload,
  type MsgPayload,
  type PresencePayload,
  type Profile,
  type ProfilePayload
} from '../../shared/protocol'

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

export function validateProfile(p: unknown): p is Profile {
  if (!isRecord(p)) return false
  if (!isStr(p.nodeId, LIMITS.from)) return false
  if (!isStr(p.nick, LIMITS.nick)) return false
  if (!isStrAllowEmpty(p.company, LIMITS.company)) return false
  if (!isStrAllowEmpty(p.dept, LIMITS.dept)) return false
  if (!isStrAllowEmpty(p.team, LIMITS.team)) return false
  if (!isInt(p.avatar) || p.avatar < -1 || p.avatar > 999) return false
  if (!isInt(p.profileRev) || p.profileRev < 0) return false
  if (!isStr(p.host, LIMITS.host)) return false
  if (p.platform !== 'win' && p.platform !== 'mac' && p.platform !== 'linux') return false
  if (!isInt(p.tcpPort) || p.tcpPort < 1 || p.tcpPort > 65535) return false
  if (!isStrAllowEmpty(p.ver, LIMITS.ver)) return false
  if (!Array.isArray(p.caps) || p.caps.length > LIMITS.caps) return false
  if (!p.caps.every((c) => typeof c === 'string' && c.length <= LIMITS.capItem)) return false
  return true
}

function validatePayload(type: string, payload: unknown): boolean {
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
      if (m.kind !== 'text') return false // v0.1 白名单只放行 text
      if (typeof m.text !== 'string' || m.text.length === 0) return false
      if (Buffer.byteLength(m.text, 'utf8') > TEXT_UDP_LIMIT) return false
      if (m.resend !== undefined && typeof m.resend !== 'boolean') return false
      return true
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
      if (f.op === 'accept' || f.op === 'decline' || f.op === 'cancel') return true
      if (f.op !== 'offer') return false
      const o = f as Partial<FileCtlOffer>
      if (!isInt(o.seq) || !isInt(o.total) || o.seq! < 1 || o.total! < 1 || o.seq! > o.total!)
        return false
      if (o.total! > Math.ceil(MAX_FILES_PER_TRANSFER / OFFER_FILES_PER_PACKET)) return false
      if (!isInt(o.totalSize) || o.totalSize! < 0) return false
      if (!isInt(o.fileCount) || o.fileCount! < 1 || o.fileCount! > MAX_FILES_PER_TRANSFER)
        return false
      if (!isStr(o.rootName, 255)) return false
      if (o.purpose !== undefined && o.purpose !== 'image') return false
      if (!Array.isArray(o.files) || o.files.length === 0 || o.files.length > OFFER_FILES_PER_PACKET)
        return false
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
    case MSG_TYPES.exit:
      return isRecord(payload)
    default:
      // 其余已知类型（peers/group）随对应功能落地时补校验
      return isRecord(payload)
  }
}

export function decode(buf: Buffer): DecodeResult {
  if (buf.length > UDP_MAX_INBOUND) return { ok: false, reason: 'oversize' }

  let raw: unknown
  try {
    raw = JSON.parse(buf.toString('utf8'))
  } catch {
    return { ok: false, reason: 'bad-json' }
  }

  if (!isRecord(raw)) return { ok: false, reason: 'not-object' }
  if (raw.v !== PROTOCOL_VERSION) return { ok: false, reason: 'version' }
  if (!isStr(raw.type, LIMITS.type)) return { ok: false, reason: 'bad-type' }
  if (!isStr(raw.id, LIMITS.id)) return { ok: false, reason: 'bad-id' }
  if (!isStr(raw.from, LIMITS.from)) return { ok: false, reason: 'bad-from' }
  if (!isInt(raw.ts) || raw.ts <= 0) return { ok: false, reason: 'bad-ts' }
  if (raw.payload === undefined) return { ok: false, reason: 'no-payload' }

  const known = KNOWN_TYPES.has(raw.type)
  if (known && !validatePayload(raw.type, raw.payload)) {
    return { ok: false, reason: `bad-payload:${raw.type}` }
  }

  return { ok: true, env: raw as unknown as Envelope, known }
}
