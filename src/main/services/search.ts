import type DatabaseT from 'better-sqlite3'
import type {
  ConversationMessageHit,
  ConversationSearchOptions,
  FileRefView,
  FileHit,
  MessageGroupHit,
  SearchResult
} from '../../shared/ipc'
import type { PeerRegistry } from '../net/peer-registry'
import { searchTerms } from '../../shared/search-terms'
import { toFtsQuery } from '../store/fts'
import { parsePkRef, pkPreview } from '../../shared/pk'
import { messagePreview } from '../store/msg-repo'

// 旧附件有时只把文件名写进正文，新附件也可能只写进 file_ref.name。
const fileNameSql = `COALESCE(
  NULLIF(CASE WHEN json_valid(file_ref) THEN
    CASE WHEN json_type(file_ref, '$.name') = 'text' THEN json_extract(file_ref, '$.name') END
  END, ''),
  CASE WHEN substr(content, 1, 4) IN ('[文件]', '[图片]') THEN ltrim(substr(content, 5)) ELSE content END
)`
const visibleTextSql = `CASE WHEN kind IN ('file', 'image') THEN ${fileNameSql} ELSE content END`
type Params = Record<string, string | number>

function matchTerms(column: string, terms: string[], params: Params): string {
  return terms.map((term, i) => {
    params['term' + i] = `%${escapeLike(term)}%`
    return `${column} LIKE @term${i} ESCAPE '\\'`
  }).join(' AND ')
}

export class SearchService {
  private readonly statementCache = new Map<string, DatabaseT.Statement>()

  constructor(
    private readonly db: DatabaseT.Database,
    private readonly registry: PeerRegistry,
    private readonly remarkOf: (nodeId: string) => string = () => ''
  ) {}

  query(raw: string): SearchResult {
    const q = raw.trim()
    if (!q) return { peers: [], messageGroups: [], files: [] }

    // 联系人：全量（含离线），按备注/昵称/公司/部门/团队/IP 命中。
    // 主机名不参与全局搜索：同一台机器上的联调身份会共享主机名，容易产生无关结果（决议 #250）。
    const needle = q.toLowerCase()
    const peers = this.registry
      .list()
      .filter((r) => {
        const p = r.profile
        return [p.nick, this.remarkOf(p.nodeId), p.company, p.dept, p.team, r.ip].some(
          (s) => s.toLowerCase().includes(needle)
        )
      })
      .slice(0, 20)
      .map((r) => ({
        nodeId: r.profile.nodeId,
        nick: r.profile.nick,
        remark: this.remarkOf(r.profile.nodeId),
        company: r.profile.company,
        dept: r.profile.dept,
        team: r.profile.team,
        avatar: r.profile.avatar,
        avatarHash: r.profile.avatarHash ?? '',
        host: r.profile.host,
        platform: r.profile.platform,
        ip: r.ip,
        online: r.online,
        lastSeen: r.lastSeen,
        ver: r.profile.ver,
        caps: Array.isArray(r.profile.caps) ? r.profile.caps : []
      }))

    const terms = searchTerms(q)
    const params: Params = {}
    const messageMatch = matchTerms('content', terms, params)
    // 连续汉字短语走 FTS 缩小候选范围，仍以可见原文核对标点和其他关键词。
    const fts = terms.filter(term => /^[㐀-䶿一-鿿豈-﫿]+$/u.test(term)).map(toFtsQuery).join(' AND ')
    const groups = this.statement(`
      SELECT conv_id AS convId, COUNT(*) AS n, MAX(ts) AS latestTs
      FROM messages m ${fts ? 'JOIN messages_fts f ON m.id = f.msg_id' : ''}
      WHERE ${fts ? 'messages_fts MATCH @fts AND' : ''} kind IN ('text', 'pk')
        AND status <> 'recalled' AND ${messageMatch}
      GROUP BY conv_id ORDER BY latestTs DESC, conv_id LIMIT 10
    `).all(fts ? { ...params, fts } : params) as Array<{ convId: string; n: number; latestTs: number }>
    const latest = this.statement(`
      SELECT id, kind, content, file_ref, ts, seq FROM messages
      WHERE conv_id = @convId AND ts = @latestTs AND kind IN ('text', 'pk')
        AND status <> 'recalled' AND ${messageMatch}
      ORDER BY seq DESC, id DESC LIMIT 1
    `)
    const messageGroups: MessageGroupHit[] = groups.map(({ convId, n, latestTs }) => {
      const row = latest.get({ ...params, convId, latestTs }) as {
        id: string; kind: string; content: string; file_ref: string | null; ts: number; seq: number
      }
      return {
        convId,
        peerId: convId.startsWith('single:') ? convId.slice(7) : convId,
        count: n,
        snippet: excerpt(row.content, terms),
        ...(row.kind === 'pk' ? { previewMessage: messagePreview(row) } : {}),
        latestSeq: row.seq,
        latestMsgId: row.id,
        ts: row.ts
      }
    })

    const fileMatch = matchTerms(fileNameSql, terms, params)
    const files = (this.statement(`
      SELECT id, conv_id AS convId, ${fileNameSql} AS name, ts, seq
      FROM messages WHERE kind IN ('file', 'image') AND status <> 'recalled' AND ${fileMatch}
      ORDER BY ts DESC, seq DESC, id DESC LIMIT 20
    `).all(params) as Array<{
      id: string; convId: string; name: string; ts: number; seq: number
    }>).map((row): FileHit => ({
      msgId: row.id,
      convId: row.convId,
      peerId: row.convId.startsWith('single:') ? row.convId.slice(7) : row.convId,
      name: row.name,
      ts: row.ts,
      seq: row.seq
    }))

    return { peers, messageGroups, files }
  }

  senders(convId: string | null): string[] {
    const filter = convId === null ? '' : 'AND conv_id = @convId'
    return this.statement(`
      SELECT DISTINCT sender_id FROM messages WHERE is_mine = 0 AND status <> 'recalled'
        AND kind IN ('text', 'pk', 'file', 'image') ${filter}
    `).pluck().all(convId === null ? {} : { convId }) as string[]
  }

  conversation(options: ConversationSearchOptions): ConversationMessageHit[] {
    const convId = options.convId?.trim()
    const terms = searchTerms(options.query)
    const kind =
      options.kind === 'image' || options.kind === 'file' || options.kind === 'message'
        ? options.kind
        : 'all'
    const limit =
      typeof options.limit === 'number' && Number.isInteger(options.limit)
        ? Math.max(1, Math.min(options.limit, 100))
        : 50
    const fromTs =
      typeof options.fromTs === 'number' && Number.isFinite(options.fromTs)
        ? Math.max(0, Math.floor(options.fromTs))
        : undefined
    const toTs =
      typeof options.toTs === 'number' && Number.isFinite(options.toTs)
        ? Math.max(0, Math.floor(options.toTs))
        : undefined
    if (options.convId !== null && (!convId || convId.length > 128)) return []
    if (fromTs !== undefined && toTs !== undefined && fromTs > toTs) return []

    const clauses = ["status <> 'recalled'"]
    if (kind === 'image') clauses.push("kind = 'image'")
    else if (kind === 'file') clauses.push("kind = 'file'")
    else if (kind === 'message') clauses.push("kind IN ('text', 'pk')")
    else clauses.push("kind IN ('text', 'image', 'file', 'pk')")

    const params: Record<string, string | number> = { limit }
    if (convId) {
      clauses.push('conv_id = @convId')
      params.convId = convId
    }
    if (options.fromMe) clauses.push('is_mine = 1')
    else if (options.senderId) {
      clauses.push('sender_id = @senderId')
      params.senderId = options.senderId
    }
    if (options.before) {
      clauses.push('(ts, seq, id) < (@beforeTs, @beforeSeq, @beforeId)')
      params.beforeTs = options.before.ts
      params.beforeSeq = options.before.seq
      params.beforeId = options.before.msgId
    }
    if (fromTs !== undefined) {
      clauses.push('ts >= @fromTs')
      params.fromTs = fromTs
    }
    if (toTs !== undefined) {
      clauses.push('ts <= @toTs')
      params.toTs = toTs
    }
    if (terms.length) clauses.push(matchTerms(visibleTextSql, terms, params))

    const sql = `
      SELECT id, conv_id AS convId, sender_id AS senderId, is_mine AS isMine,
             kind, content, file_ref AS fileRef, ts, seq
      FROM messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY ts DESC, seq DESC, id DESC
      LIMIT @limit
    `
    const stmt = this.statement(sql)
    const rows = stmt.all(params) as Array<{
      id: string
      convId: string
      senderId: string
      isMine: number
      kind: 'text' | 'file' | 'image' | 'pk'
      content: string
      fileRef: string | null
      ts: number
      seq: number
    }>
    return rows.map((row) => {
      const title = titleOf(row.kind, row.content, row.fileRef)
      const fileRef = parseFileRef(row.fileRef)
      const hit: ConversationMessageHit = {
        msgId: row.id,
        convId: row.convId,
        senderId: row.senderId,
        isMine: row.isMine !== 0,
        kind: row.kind,
        title,
        snippet: excerpt(row.kind === 'text' ? row.content : title, terms),
        ts: row.ts,
        seq: row.seq
      }
      if (fileRef) hit.fileRef = fileRef
      return hit
    })
  }

  private statement(sql: string): DatabaseT.Statement {
    const cached = this.statementCache.get(sql)
    if (cached) return cached
    const stmt = this.db.prepare(sql)
    if (this.statementCache.size >= 64) {
      const oldest = this.statementCache.keys().next()
      if (!oldest.done) this.statementCache.delete(oldest.value)
    }
    this.statementCache.set(sql, stmt)
    return stmt
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function titleOf(kind: 'text' | 'file' | 'image' | 'pk', content: string, fileRef: string | null): string {
  if (kind === 'text') return '文本消息'
  if (kind === 'pk') {
    const ref = parsePkRef(fileRef)
    return ref ? pkPreview(ref.game) : content || '[PK]'
  }
  const name = nameFromFileRef(fileRef)
  if (name) return name
  return content.replace(/^\[(文件|图片)\] ?/, '') || (kind === 'image' ? '图片' : '文件')
}

function excerpt(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  const positions = terms.map(term => lower.indexOf(term.toLowerCase())).filter(at => at >= 0)
  const first = positions.length ? Math.min(...positions) : 0
  const start = first <= 20 || text.length <= 36 ? 0 : first - 12
  const end = start + Math.max(96, ...terms.map(term => term.length + 24))
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

function nameFromFileRef(fileRef: string | null): string {
  if (!fileRef) return ''
  try {
    const parsed = JSON.parse(fileRef) as { name?: unknown }
    return typeof parsed.name === 'string' ? parsed.name : ''
  } catch {
    return ''
  }
}

function parseFileRef(fileRef: string | null): FileRefView | undefined {
  if (!fileRef) return undefined
  try {
    const parsed = JSON.parse(fileRef) as Partial<FileRefView>
    if (
      typeof parsed.transferId === 'string' &&
      typeof parsed.name === 'string' &&
      typeof parsed.size === 'number' &&
      typeof parsed.count === 'number' &&
      typeof parsed.dir === 'boolean'
    ) {
      const view: FileRefView = {
        transferId: parsed.transferId,
        name: parsed.name,
        size: parsed.size,
        count: parsed.count,
        dir: parsed.dir
      }
      const transferIds = Array.isArray(parsed.transferIds)
        ? parsed.transferIds.filter((id): id is string => typeof id === 'string')
        : []
      if (transferIds.length > 0) view.transferIds = transferIds
      return view
    }
    return undefined
  } catch {
    return undefined
  }
}
