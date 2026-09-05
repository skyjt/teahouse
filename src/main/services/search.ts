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
import { toFtsQuery } from '../store/fts'
import { parsePkRef, pkPreview } from '../../shared/pk'

// 全局搜索（F-MSG-5 / ui-design §6）：联系人（全量含离线）/ 聊天记录（按会话聚合）/ 文件。
// 中文按字短语匹配走 FTS5；联系人与文件名走 LIKE（千级数据量足够）。

export class SearchService {
  private readonly msgGroupStmt: DatabaseT.Statement
  private readonly msgLatestStmt: DatabaseT.Statement
  private readonly msgLatestFallbackStmt: DatabaseT.Statement
  private readonly fileStmt: DatabaseT.Statement
  private readonly conversationStmtCache = new Map<string, DatabaseT.Statement>()

  constructor(
    private readonly db: DatabaseT.Database,
    private readonly registry: PeerRegistry,
    private readonly remarkOf: (nodeId: string) => string = () => ''
  ) {
    this.msgGroupStmt = db.prepare(`
      SELECT m.conv_id AS convId, SUM(m.kind IN ('text', 'pk')) AS n, MAX(m.seq) AS latestSeq
      FROM messages_fts f JOIN messages m ON m.id = f.msg_id
      WHERE messages_fts MATCH ?
      GROUP BY m.conv_id HAVING n > 0
      ORDER BY MAX(CASE WHEN m.kind IN ('text', 'pk') THEN m.ts END) DESC LIMIT 10
    `)
    this.msgLatestStmt = db.prepare(`
      SELECT id, content, ts, seq FROM messages WHERE conv_id = ? AND seq = ? LIMIT 2
    `)
    // 旧库 seq 无唯一约束；异常同序号保留原 MATCH 的选择方式。
    this.msgLatestFallbackStmt = db.prepare(`
      SELECT m.id, m.content, m.ts, m.seq
      FROM messages_fts f JOIN messages m ON m.id = f.msg_id
      WHERE messages_fts MATCH ? AND m.conv_id = ?
      ORDER BY m.seq DESC LIMIT 1
    `)
    this.fileStmt = db.prepare(`
      SELECT id, conv_id AS convId, content, ts, seq
      FROM messages
      WHERE kind IN ('file', 'image') AND content LIKE ? ESCAPE '\\'
      ORDER BY ts DESC LIMIT 20
    `)
  }

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

    // 聊天记录：FTS 短语匹配，按会话聚合 + 各会话最新命中作摘要
    const messageGroups: MessageGroupHit[] = []
    const ftsQuery = toFtsQuery(q)
    if (ftsQuery) {
      const groups = this.msgGroupStmt.all(ftsQuery) as Array<{
        convId: string
        n: number
        latestSeq: number
      }>
      for (const g of groups) {
        type Latest = { id: string; content: string; ts: number; seq: number }
        const indexed = this.msgLatestStmt.all(g.convId, g.latestSeq) as Latest[]
        const latest = indexed.length === 1
          ? indexed[0]
          : this.msgLatestFallbackStmt.get(ftsQuery, g.convId) as Latest | undefined
        messageGroups.push({
          convId: g.convId,
          peerId: g.convId.startsWith('single:') ? g.convId.slice(7) : g.convId,
          count: g.n,
          snippet: latest?.content ?? '',
          latestSeq: latest?.seq ?? g.latestSeq,
          latestMsgId: latest?.id ?? '',
          ts: latest?.ts ?? 0
        })
      }
    }

    // 文件/图片：按展示名模糊匹配（content 形如 "[文件] 名字"）
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`)
    const files = (
      this.fileStmt.all(`%${escaped}%`) as Array<{
        id: string
        convId: string
        content: string
        ts: number
        seq: number
      }>
    ).map(
      (row): FileHit => ({
        msgId: row.id,
        convId: row.convId,
        peerId: row.convId.startsWith('single:') ? row.convId.slice(7) : row.convId,
        name: row.content.replace(/^\[(文件|图片)\] ?/, ''),
        ts: row.ts,
        seq: row.seq
      })
    )

    return { peers, messageGroups, files }
  }

  conversation(options: ConversationSearchOptions): ConversationMessageHit[] {
    const convId = options.convId.trim()
    const query = options.query.trim()
    const kind =
      options.kind === 'image' || options.kind === 'file' || options.kind === 'all'
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
    if (!convId || convId.length > 128) return []
    if (fromTs !== undefined && toTs !== undefined && fromTs > toTs) return []

    const clauses = ["conv_id = @convId", "status <> 'recalled'"]
    if (kind === 'image') clauses.push("kind = 'image'")
    else if (kind === 'file') clauses.push("kind = 'file'")
    else clauses.push("kind IN ('text', 'image', 'file', 'pk')")

    const params: Record<string, string | number> = { convId, limit }
    if (fromTs !== undefined) {
      clauses.push('ts >= @fromTs')
      params.fromTs = fromTs
    }
    if (toTs !== undefined) {
      clauses.push('ts <= @toTs')
      params.toTs = toTs
    }
    if (query) {
      params.like = `%${escapeLike(query)}%`
      clauses.push(
        "(content LIKE @like ESCAPE '\\' OR (kind IN ('image', 'file') AND COALESCE(file_ref, '') LIKE @like ESCAPE '\\'))"
      )
    }

    const sql = `
      SELECT id, conv_id AS convId, sender_id AS senderId, is_mine AS isMine,
             kind, content, file_ref AS fileRef, ts, seq
      FROM messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY ts DESC, seq DESC
      LIMIT @limit
    `
    const stmt = this.prepareConversationStatement(sql)
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
        snippet: snippetOf(row.kind, row.content, title),
        ts: row.ts,
        seq: row.seq
      }
      if (fileRef) hit.fileRef = fileRef
      return hit
    })
  }

  private prepareConversationStatement(sql: string): DatabaseT.Statement {
    const cached = this.conversationStmtCache.get(sql)
    if (cached) return cached
    const stmt = this.db.prepare(sql)
    this.conversationStmtCache.set(sql, stmt)
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

function snippetOf(kind: 'text' | 'file' | 'image' | 'pk', content: string, title: string): string {
  if (kind === 'text') return content
  if (kind === 'pk') return title
  const stripped = content.replace(/^\[(文件|图片)\] ?/, '')
  return stripped || title
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
