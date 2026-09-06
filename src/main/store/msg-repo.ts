import type DatabaseT from 'better-sqlite3'
import type { FileRefView, MessageView, PkRefView } from '../../shared/ipc'
import { parsePkRef } from '../../shared/pk'
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
  reply_to?: string | null
}

export interface NewMessage {
  id: string
  convId: string
  senderId: string
  isMine: boolean
  kind: 'text' | 'file' | 'image' | 'sticker' | 'system' | 'pk'
  content: string
  /** 文件消息：FileRefView 的 JSON */
  fileRef?: string
  ts: number
  status: 'sending' | 'sent' | 'queued' | 'failed' | 'canceled' | 'recalled'
  /** 引用的源消息元数据（senderName + text），仅群聊文本消息可携带；存入 reply_to JSON */
  replyTo?: string
}

/** 行 → 渲染层视图（chat 与 files 服务共用） */
export function msgRowToView(row: MsgRow): MessageView {
  let fileRef: FileRefView | undefined
  let pkRef: PkRefView | undefined
  if (row.kind === 'pk') {
    pkRef = parsePkRef(row.file_ref) ?? undefined
  } else if (row.file_ref) {
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
    kind:
      row.kind === 'file' ||
      row.kind === 'image' ||
      row.kind === 'sticker' ||
      row.kind === 'system' ||
      row.kind === 'pk'
        ? (row.kind as MessageView['kind'])
        : 'text',
    text: row.content,
    fileRef,
    pkRef,
    ts: row.ts,
    seq: row.seq,
    status: row.status as MessageView['status'],
    replyTo: row.reply_to || undefined
  }
}

export class MsgRepo {
  private readonly insertStmt: DatabaseT.Statement
  private readonly insertFtsStmt: DatabaseT.Statement
  private readonly nextSeqStmt: DatabaseT.Statement
  private readonly pageStmt: DatabaseT.Statement
  private readonly pageFirstStmt: DatabaseT.Statement
  private readonly imagePreviousStmt: DatabaseT.Statement
  private readonly imageNextStmt: DatabaseT.Statement
  private readonly aroundStmt: DatabaseT.Statement
  private readonly statusStmt: DatabaseT.Statement
  private readonly recallStmt: DatabaseT.Statement
  private readonly deleteFtsStmt: DatabaseT.Statement
  private readonly deleteFtsByConvStmt: DatabaseT.Statement
  private readonly deleteByConvStmt: DatabaseT.Statement
  private readonly getStmt: DatabaseT.Statement
  private readonly resetSendingStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO messages (id, conv_id, sender_id, is_mine, kind, content, file_ref, ts, seq, status, reply_to)
      VALUES (@id, @convId, @senderId, @isMine, @kind, @content, @fileRef, @ts, @seq, @status, @replyTo)
    `)
    this.insertFtsStmt = db.prepare('INSERT INTO messages_fts (msg_id, text) VALUES (?, ?)')
    this.nextSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages')
    this.pageStmt = db.prepare(
      'SELECT * FROM messages WHERE conv_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
    )
    this.pageFirstStmt = db.prepare(
      'SELECT * FROM messages WHERE conv_id = ? ORDER BY seq DESC LIMIT ?'
    )
    this.imagePreviousStmt = db.prepare(`
      SELECT * FROM messages WHERE conv_id = ? AND seq < ?
        AND kind = 'image' AND status <> 'recalled' AND file_ref IS NOT NULL
      ORDER BY seq DESC LIMIT ?
    `)
    this.imageNextStmt = db.prepare(`
      SELECT * FROM messages WHERE conv_id = ? AND seq > ?
        AND kind = 'image' AND status <> 'recalled' AND file_ref IS NOT NULL
      ORDER BY seq ASC LIMIT ?
    `)
    this.aroundStmt = db.prepare(
      'SELECT * FROM messages WHERE conv_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC'
    )
    this.statusStmt = db.prepare('UPDATE messages SET status = ? WHERE id = ?')
    this.recallStmt = db.prepare(
      "UPDATE messages SET status = 'recalled', content = '', file_ref = NULL WHERE id = ?"
    )
    this.deleteFtsStmt = db.prepare('DELETE FROM messages_fts WHERE msg_id = ?')
    this.deleteFtsByConvStmt = db.prepare(
      'DELETE FROM messages_fts WHERE msg_id IN (SELECT id FROM messages WHERE conv_id = ?)'
    )
    this.deleteByConvStmt = db.prepare('DELETE FROM messages WHERE conv_id = ?')
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
      status: msg.status,
      replyTo: msg.replyTo
    })
    if (info.changes === 0) return false
    const tokens = msg.kind === 'system' ? '' : toFtsTokens(msg.content)
    if (tokens) this.insertFtsStmt.run(msg.id, tokens)
    return true
  }

  /** 搜索跳转用：取目标 seq 前后各 radius 条（含自身），按 seq 升序 */
  around(convId: string, seq: number, radius: number): MsgRow[] {
    const rows = this.aroundStmt.all(convId, seq - radius, seq + radius) as MsgRow[]
    return rows
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

  /** 图片导航按消息顺序向指定方向分页，最近的候选在前。 */
  imagePage(convId: string, seq: number, direction: 'previous' | 'next', limit: number): MsgRow[] {
    const statement = direction === 'previous' ? this.imagePreviousStmt : this.imageNextStmt
    return statement.all(convId, seq, limit) as MsgRow[]
  }

  updateStatus(msgId: string, status: string): void {
    this.statusStmt.run(status, msgId)
  }

  recall(msgId: string): boolean {
    const info = this.recallStmt.run(msgId)
    this.deleteFtsStmt.run(msgId)
    return info.changes > 0
  }

  /** 删除某会话的全部消息及其全文索引（移除聊天 = 删除聊天内容，决议 #125） */
  deleteByConv(convId: string): void {
    this.deleteFtsByConvStmt.run(convId)
    this.deleteByConvStmt.run(convId)
  }

  get(msgId: string): MsgRow | undefined {
    return this.getStmt.get(msgId) as MsgRow | undefined
  }

  resetStaleSending(): number {
    return this.resetSendingStmt.run().changes
  }
}
