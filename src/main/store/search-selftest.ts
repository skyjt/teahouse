import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { ConversationMessageHit, ConversationSearchOptions } from '../../shared/ipc'
import { SearchService } from '../services/search'
import { PeerRegistry } from '../net/peer-registry'
import { MIGRATIONS, applyMigrations } from './migrations'
import { MsgRepo } from './msg-repo'
import { toFtsTokens } from './fts'

/** 在真实的旧库升级后验证概览、逐条结果与原文定位。 */
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
    for (const query of ['项目', '需求文档', '项目进度', 'mixed CASE', 'ixe', 'legacy', '100%_a\\b', 'missing', '🙂']) {
      for (const group of search.query(query).messageGroups) {
        const rows = search.conversation({ convId: group.convId, kind: 'message', query, limit: 100 })
        assert.equal(group.count, rows.length, '展开会话后数量须一致')
        assert.equal(group.latestMsgId, rows[0]?.msgId, '摘要必须来自最新的同一条命中记录')
      }
    }
    assert.equal(search.query('legacy').messageGroups[0]?.latestMsgId, 'legacy', '可搜索迁移前的消息')
    assert.equal(search.query('ixe').messageGroups.length, 10, '支持部分英文单词')
    assert.equal(search.query('项目').messageGroups.length, 10, '保留最多 10 个会话')
    assert.ok(search.query('项目').messageGroups.some((g) => g.latestMsgId === 'tie-match'), '重复 seq 应读取匹配行')
    const mixed = search.query('需求文档').messageGroups.find((g) => g.convId !== 'single:tie')!
    assert.equal(mixed.count, 2, '混合会话只计文本和 PK')
    assert.ok(mixed.latestMsgId.endsWith('-6'), '摘要应来自计入数量的文字消息')
    for (const query of ['%', '_', '\\']) {
      const files = search.query(query).files
      assert.equal(files.length, 20, '文件上限保持 20')
      assert.ok(files.every((file) => file.name.includes(query)), 'LIKE 特殊字符必须按字面匹配')
    }
    const insert = (id: string, content: string, convId = 'single:cursor') =>
      repo.insert({ id, convId, senderId: 'amy', isMine: false, kind: 'text', content, ts: 88888, status: 'sent' })
    insert('page-a', '🙂 交接')
    insert('page-b', '🙂 交接')
    insert('page-c', '中间插入其他会话', 'single:other')
    insert('page-d', '交。接 🙂')
    db.exec("UPDATE messages SET seq=(SELECT seq FROM messages WHERE id='page-a') WHERE id='page-b'")
    const opts: ConversationSearchOptions = { convId: null, query: '🙂', kind: 'all', senderId: 'amy', limit: 1 }
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      const hit: ConversationMessageHit | undefined = search.conversation(opts)[0]
      if (!hit) break
      seen.push(hit.msgId)
      opts.before = { ts: hit.ts, seq: hit.seq, msgId: hit.msgId }
    }
    assert.deepEqual(seen, ['page-d', 'page-b', 'page-a'], '跨会话游标在同时间、同序号时仍不漏不重')
    assert.equal(search.query('🙂').messageGroups[0]?.count, 3)
    assert.equal(search.query('交接 🙂').messageGroups[0]?.count, 2, '多个关键词可以乱序匹配')
    assert.equal(search.conversation({ convId: null, query: '交接 🙂', kind: 'message' }).length, 2)
    assert.equal(search.query('交接').messageGroups[0]?.count, 2, '标点分隔的字不应造成虚假命中')
    const before = repo.get('page-a')!
    for (let i = 0; i < 60; i++) insert('gap-' + i, '其他会话消息', 'single:other')
    insert('after-gap', '这是一条跟进')
    assert.ok(repo.around(before.conv_id, before.seq, 2).some(m => m.id === 'after-gap'), '定位取同一会话的相邻消息')
    const ref = { transferId: 'internal-only', name: '值班清单.png', size: 123, count: 1, dir: false }
    repo.insert({ id: 'named-image', convId: 'group:past', senderId: 'amy', isMine: false, kind: 'image',
      content: '[图片]', fileRef: JSON.stringify(ref), ts: 9999, status: 'sent' })
    assert.equal(search.query('班清').files[0]?.name, ref.name, '全局概览按真实文件名搜索')
    const scoped = { convId: null, kind: 'image' as const, query: '班清', senderId: 'amy', fromTs: 9999, toTs: 9999 }
    assert.deepEqual(search.conversation(scoped).map(h => h.msgId), ['named-image'])
    assert.deepEqual(search.conversation({ ...scoped, senderId: 'other' }), [])
    assert.deepEqual(search.conversation({ ...scoped, query: 'internal-only' }), [])
    assert.deepEqual(search.senders('group:past'), ['amy'])
    repo.insert({ id: 'past-self', convId: 'group:past', senderId: 'previous-machine', isMine: true,
      kind: 'text', content: '移机前发送', ts: 8000, status: 'sent' })
    assert.deepEqual(search.conversation({ convId: 'group:past', kind: 'all', query: '', fromMe: true }).map(h => h.msgId), ['past-self'])
    repo.recall('named-image')
    assert.deepEqual(search.conversation(scoped), [])
    assert.deepEqual(search.query('班清').files, [])
    console.log('[db-selftest] 搜索范围、摘要、文件名、分页与 v9 迁移 PASS')
  } finally {
    db.close()
  }
}
