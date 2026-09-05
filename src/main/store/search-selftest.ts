import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { MessageGroupHit } from '../../shared/ipc'
import { SearchService } from '../services/search'
import { PeerRegistry } from '../net/peer-registry'
import { MIGRATIONS, applyMigrations } from './migrations'
import { MsgRepo } from './msg-repo'
import { toFtsQuery, toFtsTokens } from './fts'

/** 在真实 Electron ABI 上锁定优化前的全局查询语义，避免改动旧数据的搜索结果。 */
export function verifyGlobalSearch(): void {
  const db = new Database(':memory:')
  try {
    // 从 v9 的真实表结构和旧消息升级，包含 v10 索引及后续追加列。
    for (const migration of MIGRATIONS.slice(0, 9)) db.exec(migration)
    db.pragma('user_version = 9')
    db.prepare(`INSERT INTO messages (id,conv_id,sender_id,is_mine,kind,content,ts,seq,status)
      VALUES ('legacy','single:legacy','sender',0,'text','项目 legacy',1,1,'sent')`).run()
    db.prepare('INSERT INTO messages_fts (msg_id,text) VALUES (?,?)').run('legacy', toFtsTokens('项目 legacy'))
    applyMigrations(db)

    const repo = new MsgRepo(db)
    const search = new SearchService(db, new PeerRegistry('self'))
    // 固定旧 SQL 为对照；计数只含 text/pk，摘要允许所有 FTS 匹配类型。
    const oldGroups = db.prepare(`SELECT m.conv_id AS convId, COUNT(*) AS n, MAX(m.seq) AS latestSeq
      FROM messages_fts f JOIN messages m ON m.id=f.msg_id
      WHERE messages_fts MATCH ? AND m.kind IN ('text','pk')
      GROUP BY m.conv_id ORDER BY MAX(m.ts) DESC LIMIT 10`)
    const oldLatest = db.prepare(`SELECT m.id,m.content,m.ts,m.seq
      FROM messages_fts f JOIN messages m ON m.id=f.msg_id
      WHERE messages_fts MATCH ? AND m.conv_id=? ORDER BY m.seq DESC LIMIT 1`)
    const oldQuery = (query: string): MessageGroupHit[] => {
      const q = toFtsQuery(query.trim())
      if (!q) return []
      return (oldGroups.all(q) as Array<{ convId: string; n: number; latestSeq: number }>).map((g) => {
        const latest = oldLatest.get(q, g.convId) as { id: string; content: string; ts: number; seq: number }
        return { convId: g.convId, peerId: g.convId.startsWith('single:') ? g.convId.slice(7) : g.convId,
          count: g.n, snippet: latest.content, latestSeq: latest.seq, latestMsgId: latest.id, ts: latest.ts }
      })
    }
    db.transaction(() => {
      const kinds = ['text', 'pk', 'file', 'image', 'sticker', 'system'] as const
      for (let c = 0; c < 24; c++) {
        for (let i = 0; i < 12; i++) {
          const id = `m${c}-${i}`
          repo.insert({ id, convId: c % 2 ? `group:g${c}` : `single:p${c}`, senderId: 'sender', isMine: false,
            kind: kinds[i % kinds.length], content: `${i % 2 ? '项目进度 Mixed Case' : '项目需求文档'} ${c} [文件] 100%_a\\b.txt`,
            ts: 1000 + c % 4, status: 'sent' })
          if (i === 1 && c % 3 === 0) repo.recall(id)
        }
      }
      // 文件独占的会话不贡献聊天记录；文件时间再新也不改变文本会话排序。
      repo.insert({ id: 'file-only', convId: 'single:file-only', senderId: 'sender', isMine: false,
        kind: 'file', content: '[文件] 项目需求文档', ts: 999999, status: 'sent' })
      // 同一会话的两个 seq 相同，其中一个不匹配；按 seq 直接拿首行会返回错误内容。
      repo.insert({ id: 'tie-no-match', convId: 'single:tie', senderId: 'sender', isMine: false,
        kind: 'text', content: '无关内容', ts: 9999, status: 'sent' })
      repo.insert({ id: 'tie-match', convId: 'single:tie', senderId: 'sender', isMine: false,
        kind: 'text', content: '项目需求文档', ts: 9999, status: 'sent' })
      db.exec("UPDATE messages SET seq=(SELECT seq FROM messages WHERE id='tie-no-match') WHERE id='tie-match'")
    })()
    for (const query of ['项目', '需求文档', '项目进度', 'mixed CASE', 'legacy', '100%_a\\b', 'missing', '   ', '🙂']) {
      assert.deepEqual(search.query(query).messageGroups, oldQuery(query), `全局搜索新旧不等价：${query}`)
    }
    assert.equal(search.query('项目').messageGroups.length, 10, '保留最多 10 个会话')
    assert.ok(search.query('项目').messageGroups.some((g) => g.latestMsgId === 'tie-match'), '重复 seq 应读取匹配行')
    const mixed = search.query('需求文档').messageGroups.find((g) => g.convId !== 'single:tie')!
    assert.equal(mixed.count, 2, '混合会话只计文本和 PK')
    assert.ok(mixed.latestMsgId.endsWith('-10'), '摘要仍可来自比文本更新的表情命中')
    for (const query of ['%', '_', '\\']) {
      const files = search.query(query).files
      assert.equal(files.length, 20, '文件上限保持 20')
      assert.ok(files.every((file) => file.name.includes(query)), 'LIKE 特殊字符必须按字面匹配')
    }
    console.log('[db-selftest] 全局搜索新旧对照及 v9 迁移 PASS')
  } finally {
    db.close()
  }
}
