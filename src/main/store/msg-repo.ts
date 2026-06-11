import type DatabaseT from 'better-sqlite3'
import type { FileRefView, MessageView } from '../../shared/ipc'
import { toFtsTokens } from './fts'

export interface MsgRow {
  id: string
  conv_id: string
  sender_id: string
  is_mine: number
  kind: string
  content: string
  file_ref: string | null
  ts: number
  seq: number
  status: string
}

export interface NewMessage {
  id: string
  convId: string
  senderId: string
  isMine: boolean
  kind: 'text' | 'file' | 'image'
  content: string
  /** 文件消息：FileRefView 的 JSON */
  fileRef?: string
  ts: number
  status: 'sending' | 'sent' | 'queued' | 'failed'
}

/** 行 → 渲染层视图（chat 与 files 服务共用） */
export function msgRowToView(row: MsgRow): MessageView {
  let fileRef: FileRefView | undefined
  if (row.file_ref) {
    try {
      fileRef = JSON.parse(row.file_ref) as FileRefView
    } catch {
      fileRef = undefined
    }
  }
  return {
    id: row.id,
    convId: row.conv_id,
    senderId: row.sender_id,
    isMine: row.is_mine !== 0,
    kind: row.kind === 'file' ? 'file' : row.kind === 'image' ? 'image' : 'text',
    text: row.content,
    fileRef,
    ts: row.ts,
    seq: row.seq,
    status: row.status as MessageView['status']
  }
}

export class MsgRepo {
  private readonly insertStmt: DatabaseT.Statement
  private readonly insertFtsStmt: DatabaseT.Statement
  private readonly nextSeqStmt: DatabaseT.Statement
  private readonly pageStmt: DatabaseT.Statement
  private readonly pageFirstStmt: DatabaseT.Statement
  private readonly statusStmt: DatabaseT.Statement
  private readonly getStmt: DatabaseT.Statement
  private readonly resetSendingStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO messages (id, conv_id, sender_id, is_mine, kind, content, file_ref, ts, seq, status)
      VALUES (@id, @convId, @senderId, @isMine, @kind, @content, @fileRef, @ts, @seq, @status)
    `)
    this.insertFtsStmt = db.prepare('INSERT INTO messages_fts (msg_id, text) VALUES (?, ?)')
    this.nextSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages')
    this.pageStmt = db.prepare(
      'SELECT * FROM messages WHERE conv_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
    )
    this.pageFirstStmt = db.prepare(
      'SELECT * FROM messages WHERE conv_id = ? ORDER BY seq DESC LIMIT ?'
    )
    this.statusStmt = db.prepare('UPDATE messages SET status = ? WHERE id = ?')
    this.getStmt = db.prepare('SELECT * FROM messages WHERE id = ?')
    // 启动自愈（决议 #22）：残留"发送中"复位为失败，杜绝永远转圈
    this.resetSendingStmt = db.prepare(
      "UPDATE messages SET status = 'failed' WHERE status = 'sending' AND is_mine = 1"
    )
  }

  /** 插入消息（按 id 幂等）+ 同步写入全文索引；返回是否真的插入了 */
  insert(msg: NewMessage): boolean {
    const seq = (this.nextSeqStmt.get() as { seq: number }).seq
    const info = this.insertStmt.run({
      id: msg.id,
      convId: msg.convId,
      senderId: msg.senderId,
      isMine: msg.isMine ? 1 : 0,
      kind: msg.kind,
      content: msg.content,
      fileRef: msg.fileRef ?? null,
      ts: msg.ts,
      seq,
      status: msg.status
    })
    if (info.changes === 0) return false
    const tokens = toFtsTokens(msg.content)
    if (tokens) this.insertFtsStmt.run(msg.id, tokens)
    return true
  }

  /** 倒序游标分页：beforeSeq 为 null 取最新一页；返回按 seq 升序（直接渲染） */
  page(convId: string, beforeSeq: number | null, limit: number): MsgRow[] {
    const rows = (
      beforeSeq === null
        ? this.pageFirstStmt.all(convId, limit)
        : this.pageStmt.all(convId, beforeSeq, limit)
    ) as MsgRow[]
    return rows.reverse()
  }

  updateStatus(msgId: string, status: string): void {
    this.statusStmt.run(status, msgId)
  }

  get(msgId: string): MsgRow | undefined {
    return this.getStmt.get(msgId) as MsgRow | undefined
  }

  resetStaleSending(): number {
    return this.resetSendingStmt.run().changes
  }
}
