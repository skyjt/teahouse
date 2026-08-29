import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Envelope, GroupMeta, MsgPayload } from '../../shared/protocol'
import type { ConversationView } from '../../shared/ipc'
import { ChatService } from './chat'
import type { Messenger, SendOutcome } from '../net/messenger'
import type { ConvRepo } from '../store/conv-repo'
import type { GroupRepo } from '../store/group-repo'
import type { MsgRepo, MsgRow, NewMessage } from '../store/msg-repo'

class FakeMessenger extends EventEmitter {
  sent: Array<{ peerId: string; env: Envelope<MsgPayload> }> = []
  reliableSent: Array<{ peerId: string; env: Envelope<MsgPayload> }> = []
  dropped: Array<{ msgId: string; peerIds: string[] }> = []
  reliableResult = true

  async sendUserMessage(peerId: string, env: Envelope<MsgPayload>): Promise<SendOutcome> {
    this.sent.push({ peerId, env })
    return 'queued'
  }

  async sendReliable(peerId: string, env: Envelope<MsgPayload>): Promise<boolean> {
    this.reliableSent.push({ peerId, env })
    return this.reliableResult
  }

  dropQueuedMessage(msgId: string, peerIds: string[]): void {
    this.dropped.push({ msgId, peerIds })
  }

  prune(): Array<{ msgId: string; peerId: string }> {
    return []
  }
}

class FakeMsgRepo {
  rows = new Map<string, MsgRow>()
  inserted: NewMessage[] = []

  get(msgId: string): MsgRow | undefined {
    return this.rows.get(msgId)
  }

  insert(msg: NewMessage): boolean {
    this.inserted.push(msg)
    this.rows.set(msg.id, {
      id: msg.id,
      conv_id: msg.convId,
      sender_id: msg.senderId,
      is_mine: msg.isMine ? 1 : 0,
      kind: msg.kind,
      content: msg.content,
      file_ref: msg.fileRef ?? null,
      ts: msg.ts,
      seq: this.rows.size + 1,
      status: msg.status,
      reply_to: msg.replyTo
    })
    return true
  }

  recall(msgId: string): boolean {
    const row = this.rows.get(msgId)
    if (!row) return false
    row.status = 'recalled'
    row.content = ''
    row.file_ref = null
    return true
  }

  updateStatus(msgId: string, status: MsgRow['status']): void {
    const row = this.rows.get(msgId)
    if (row) row.status = status
  }

  resetStaleSending(): number {
    return 0
  }
}

class FakeConvRepo {
  bumped: Array<{ convId: string; ts: number }> = []
  unread: string[] = []
  ensured: string[] = []
  muted = new Set<string>()

  ensureSingle(peerId: string): string {
    this.ensured.push(peerId)
    return `single:${peerId}`
  }

  markRead(): void {
    // no-op
  }

  bump(convId: string, ts: number): void {
    this.bumped.push({ convId, ts })
  }

  incUnread(convId: string): void {
    this.unread.push(convId)
  }

  get(convId: string): { muted: number } | undefined {
    return { muted: this.muted.has(convId) ? 1 : 0 }
  }

  list(): ConversationView[] {
    return []
  }
}

class FakeGroupRepo {
  constructor(private readonly meta: GroupMeta | null = null) {}

  get(): GroupMeta | null {
    return this.meta
  }
}

function makeRow(overrides: Partial<MsgRow> = {}): MsgRow {
  return {
    id: 'msg-original',
    conv_id: 'single:node-peer',
    sender_id: 'node-self',
    is_mine: 1,
    kind: 'text',
    content: '准备撤回的内容',
    file_ref: null,
    ts: Date.now(),
    seq: 1,
    status: 'queued',
    ...overrides
  }
}

describe('ChatService 会话设置', () => {
  it('同一同步批次内合并会话列表事件', async () => {
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      messenger: new FakeMessenger() as unknown as Messenger
    })
    const events: ConversationView[][] = []
    chat.on('convs', (convs: ConversationView[]) => events.push(convs))

    chat.sendText('node-a', '第一条')
    chat.sendText('node-b', '第二条')

    expect(events).toHaveLength(0)
    await Promise.resolve()
    expect(events).toHaveLength(1)
  })

  it('可直接查询单个会话的免打扰状态', () => {
    const convRepo = new FakeConvRepo()
    convRepo.muted.add('single:node-peer')
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      messenger: new FakeMessenger() as unknown as Messenger
    })

    expect(chat.isMuted('single:node-peer')).toBe(true)
    expect(chat.isMuted('single:node-other')).toBe(false)
  })
})

describe('ChatService 撤回', () => {
  it('撤回已排队的单聊消息时，先移除原文补发队列再发送 recall 指令', async () => {
    const msgRepo = new FakeMsgRepo()
    msgRepo.rows.set('msg-original', makeRow())
    const messenger = new FakeMessenger()
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger
    })

    expect(chat.recall('msg-original')).toBe(true)

    expect(messenger.dropped).toEqual([{ msgId: 'msg-original', peerIds: ['node-peer'] }])
    expect(messenger.sent).toHaveLength(1)
    expect(messenger.sent[0].peerId).toBe('node-peer')
    expect(messenger.sent[0].env.payload).toMatchObject({
      kind: 'recall',
      targetId: 'msg-original'
    })
    expect(msgRepo.get('msg-original')?.status).toBe('recalled')
    expect(msgRepo.get('msg-original')?.content).toBe('')
    expect(msgRepo.inserted[0]).toMatchObject({
      convId: 'single:node-peer',
      kind: 'system',
      content: '你撤回了一条消息',
      status: 'sent'
    })
  })

  it('自己的未完成文件消息可通过媒体撤回适配器撤回', () => {
    const msgRepo = new FakeMsgRepo()
    msgRepo.rows.set(
      'msg-file',
      makeRow({
        id: 'msg-file',
        kind: 'file',
        content: '[文件] 资料.txt',
        file_ref: JSON.stringify({
          transferId: 't-file',
          name: '资料.txt',
          size: 5,
          count: 1,
          dir: false
        }),
        status: 'sent'
      })
    )
    const messenger = new FakeMessenger()
    const recalled: string[] = []
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger,
      mediaRecall: {
        canRecall: (row: MsgRow) => row.id === 'msg-file',
        applyLocalRecall: (row: MsgRow) => recalled.push(row.id),
        applyIncomingRecall: () => true
      }
    } as never)

    expect(chat.recall('msg-file')).toBe(true)

    expect(recalled).toEqual(['msg-file'])
    expect(messenger.sent).toHaveLength(1)
    expect(messenger.sent[0].env.payload).toMatchObject({
      kind: 'recall',
      targetId: 'msg-file'
    })
    expect(msgRepo.get('msg-file')?.status).toBe('recalled')
  })

  it('收到已完成文件的迟到撤回时不隐藏本地消息', () => {
    const msgRepo = new FakeMsgRepo()
    msgRepo.rows.set(
      'msg-file-done',
      makeRow({
        id: 'msg-file-done',
        conv_id: 'single:node-bob',
        sender_id: 'node-bob',
        is_mine: 0,
        kind: 'file',
        content: '[文件] 资料.txt',
        file_ref: JSON.stringify({
          transferId: 't-file-done',
          name: '资料.txt',
          size: 5,
          count: 1,
          dir: false
        }),
        status: 'sent'
      })
    )
    const messenger = new FakeMessenger()
    new ChatService({
      selfId: 'node-self',
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger,
      mediaRecall: {
        canRecall: () => false,
        applyLocalRecall: () => undefined,
        applyIncomingRecall: () => false
      }
    } as never)

    messenger.emit('incoming', {
      v: 1,
      type: 'msg',
      id: 'recall-file-done',
      from: 'node-bob',
      ts: Date.now(),
      payload: { kind: 'recall', targetId: 'msg-file-done' }
    } satisfies Envelope<MsgPayload>)

    expect(msgRepo.get('msg-file-done')?.status).toBe('sent')
  })
})

describe('ChatService 私聊窗口震动', () => {
  it('发送震动走可靠通道并写本地系统提示，连续发送会被限流', async () => {
    const msgRepo = new FakeMsgRepo()
    const messenger = new FakeMessenger()
    const convRepo = new FakeConvRepo()
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger
    })

    await expect(chat.sendNudge('node-peer')).resolves.toEqual({ ok: true })
    expect(messenger.reliableSent).toHaveLength(1)
    expect(messenger.reliableSent[0]).toMatchObject({
      peerId: 'node-peer',
      env: { type: 'msg', payload: { kind: 'nudge' } }
    })
    expect(msgRepo.inserted).toHaveLength(1)
    expect(msgRepo.inserted[0]).toMatchObject({
      id: messenger.reliableSent[0].env.id,
      convId: 'single:node-peer',
      senderId: 'node-self',
      kind: 'system',
      content: '你发送了一次窗口震动',
      status: 'sent'
    })
    expect(convRepo.bumped).toHaveLength(1)
    expect(messenger.sent).toHaveLength(0)

    const limited = await chat.sendNudge('node-peer')
    expect(limited.ok).toBe(false)
    expect(limited.reason).toBe('rate-limited')
    expect(limited.retryAfterMs).toBeGreaterThan(0)
    expect(messenger.reliableSent).toHaveLength(1)
    expect(msgRepo.inserted).toHaveLength(1)
  })

  it('收到震动写本地系统提示并触发定位事件；重复入站被接收端限流', () => {
    const msgRepo = new FakeMsgRepo()
    const messenger = new FakeMessenger()
    const convRepo = new FakeConvRepo()
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger
    })
    const nudges: Array<{ peerId: string; convId: string }> = []
    const messages: Array<{ kind: string; text: string; convId: string }> = []
    chat.on('nudge', (event: { peerId: string; convId: string }) => nudges.push(event))
    chat.on('message', (msg: { kind: string; text: string; convId: string }) => messages.push(msg))

    const env: Envelope<MsgPayload> = {
      v: 1,
      type: 'msg',
      id: 'nudge-1',
      from: 'node-peer',
      ts: Date.now(),
      payload: { kind: 'nudge' }
    }
    messenger.emit('incoming', env)
    messenger.emit('incoming', { ...env, id: 'nudge-2' })

    expect(nudges).toHaveLength(1)
    expect(nudges[0]).toMatchObject({ peerId: 'node-peer', convId: 'single:node-peer' })
    expect(msgRepo.inserted).toHaveLength(1)
    expect(msgRepo.inserted[0]).toMatchObject({
      id: 'nudge-1',
      convId: 'single:node-peer',
      senderId: 'node-peer',
      kind: 'system',
      content: '对方发来一次窗口震动',
      status: 'sent'
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: 'system',
      text: '对方发来一次窗口震动',
      convId: 'single:node-peer'
    })
    expect(convRepo.bumped).toHaveLength(1)
    expect(convRepo.unread).toHaveLength(0)
  })

  it('免打扰会话收到震动只写提示，不触发窗口震动事件', () => {
    const msgRepo = new FakeMsgRepo()
    const messenger = new FakeMessenger()
    const convRepo = new FakeConvRepo()
    convRepo.muted.add('single:node-peer')
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger
    })
    const nudges: Array<{ peerId: string; convId: string }> = []
    chat.on('nudge', (event: { peerId: string; convId: string }) => nudges.push(event))

    const env: Envelope<MsgPayload> = {
      v: 1,
      type: 'msg',
      id: 'nudge-muted',
      from: 'node-peer',
      ts: Date.now(),
      payload: { kind: 'nudge' }
    }
    messenger.emit('incoming', env)

    expect(nudges).toHaveLength(0)
    expect(msgRepo.inserted).toHaveLength(1)
    expect(msgRepo.inserted[0]).toMatchObject({
      id: 'nudge-muted',
      convId: 'single:node-peer',
      kind: 'system',
      content: '对方发来一次窗口震动'
    })
    expect(convRepo.unread).toHaveLength(0)
  })
})

describe('ChatService PK', () => {
  it('发送 PK 走在线即时可靠通道，失败重试复用同一结果', async () => {
    const msgRepo = new FakeMsgRepo()
    const messenger = new FakeMessenger()
    messenger.reliableResult = false
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger,
      isOnline: (id) => id === 'node-peer'
    })

    const view = chat.sendPk('node-peer', 'dice')
    expect(view).toMatchObject({ kind: 'pk', text: '[PK] 骰子', status: 'sending' })
    expect(messenger.reliableSent).toHaveLength(1)
    const firstPayload = messenger.reliableSent[0].env.payload
    expect(firstPayload).toMatchObject({ kind: 'pk', game: 'dice' })
    await Promise.resolve()
    expect(msgRepo.get(view!.id)?.status).toBe('failed')

    messenger.reliableResult = true
    expect(chat.resend(view!.id)).toBe(true)
    expect(messenger.reliableSent).toHaveLength(2)
    expect(messenger.reliableSent[1].env.id).toBe(view!.id)
    expect(messenger.reliableSent[1].env.payload).toEqual(firstPayload)
  })

  it('收到 PK 落库为安全摘要，真实结果只放 file_ref', () => {
    const msgRepo = new FakeMsgRepo()
    const messenger = new FakeMessenger()
    const chat = new ChatService({
      selfId: 'node-self',
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      groupRepo: new FakeGroupRepo() as unknown as GroupRepo,
      messenger: messenger as unknown as Messenger
    })
    const messages: Array<{ kind: string; text: string; pkRef?: unknown }> = []
    chat.on('message', (msg: { kind: string; text: string; pkRef?: unknown }) => messages.push(msg))

    messenger.emit('incoming', {
      v: 1,
      type: 'msg',
      id: 'pk-1',
      from: 'node-peer',
      ts: Date.now(),
      payload: { kind: 'pk', game: 'rps', result: 'scissors' }
    } satisfies Envelope<MsgPayload>)

    expect(msgRepo.inserted[0]).toMatchObject({
      id: 'pk-1',
      convId: 'single:node-peer',
      kind: 'pk',
      content: '[PK] 猜拳',
      status: 'sent'
    })
    expect(JSON.parse(msgRepo.inserted[0].fileRef ?? '{}')).toEqual({
      game: 'rps',
      result: 'scissors'
    })
    expect(messages[0]).toMatchObject({
      kind: 'pk',
      text: '[PK] 猜拳',
      pkRef: { game: 'rps', result: 'scissors' }
    })
  })
})
