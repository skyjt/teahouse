import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applyMigrations } from './migrations'
import { MsgRepo } from './msg-repo'

/** 在 Electron 真实 SQLite ABI 上验证双向图片游标及完整历史。 */
export function verifyImageNavigationQueries(): void {
  const db = new Database(':memory:')
  try {
    applyMigrations(db)
    const repo = new MsgRepo(db)
    const expected: string[] = []
    db.transaction(() => {
      for (let i = 0; i < 125; i++) {
        for (const convId of ['single:peer', 'group:other']) {
          const id = `${convId}:${i}`
          repo.insert({ id, convId, senderId: 'peer', isMine: false, kind: 'image',
            content: '[图片]', fileRef: JSON.stringify({ transferId: `t${i}`, transferIds: [`t${i}`, `copy${i}`] }),
            ts: 1000 - i, status: 'sent' })
          if (convId === 'single:peer') expected.push(id)
        }
      }
      for (const kind of ['sticker', 'file', 'text'] as const) {
        repo.insert({ id: kind, convId: 'single:peer', senderId: 'peer', isMine: false, kind,
          content: '', fileRef: JSON.stringify({ transferId: kind }), ts: 1000, status: 'sent' })
      }
      repo.insert({ id: 'recalled', convId: 'single:peer', senderId: 'peer', isMine: false, kind: 'image',
        content: '', fileRef: '{}', ts: 1000, status: 'recalled' })
      repo.insert({ id: 'missing-ref', convId: 'single:peer', senderId: 'peer', isMine: false, kind: 'image',
        content: '', ts: 1000, status: 'sent' })
    })()

    for (const direction of ['previous', 'next'] as const) {
      let seq = direction === 'previous' ? Number.MAX_SAFE_INTEGER : 0
      const actual: string[] = []
      for (;;) {
        const page = repo.imagePage('single:peer', seq, direction, 50)
        if (!page.length) break
        actual.push(...page.map((row) => row.id))
        seq = page[page.length - 1].seq
      }
      assert.deepEqual(actual, direction === 'previous' ? [...expected].reverse() : expected,
        '完整历史按 seq 分页且隔离会话，群发只返回一条消息')
    }
    const middle = repo.get(expected[62])!
    assert.equal(repo.imagePage(middle.conv_id, middle.seq, 'previous', 1)[0].id, expected[61])
    assert.equal(repo.imagePage(middle.conv_id, middle.seq, 'next', 1)[0].id, expected[63])
    assert.equal(repo.imagePage('missing', 0, 'next', 50).length, 0)
    console.log('[db-selftest] 图片双向导航及完整历史 PASS')
  } finally {
    db.close()
  }
}
