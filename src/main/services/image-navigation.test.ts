import { describe, expect, it, vi } from 'vitest'
import type { MsgRepo, MsgRow } from '../store/msg-repo'
import { getImageViewerNavigation } from './image-navigation'

function image(seq: number, patch: Partial<MsgRow> = {}): MsgRow {
  return {
    id: `m${seq}`, conv_id: 'single:peer', sender_id: 'peer', is_mine: 0,
    kind: 'image', content: '[图片]', file_ref: JSON.stringify({ transferId: `t${seq}` }),
    ts: 1000 - seq, seq, status: 'sent', ...patch
  }
}

function setup(rows: MsgRow[]) {
  const imagePage = vi.fn((convId: string, seq: number, direction: 'previous' | 'next', limit: number) =>
    rows.filter((row) => row.conv_id === convId && row.kind === 'image' && row.status !== 'recalled' &&
      row.file_ref !== null && (direction === 'previous' ? row.seq < seq : row.seq > seq))
      .sort((a, b) => direction === 'previous' ? b.seq - a.seq : a.seq - b.seq).slice(0, limit))
  const messages = { get: (id: string) => rows.find((row) => row.id === id), imagePage } as unknown as MsgRepo
  const available = new Map(rows.map((row) => [`t${row.seq}`, { msgId: row.id, name: `${row.id}.png` }]))
  const resolve = vi.fn(async (id: string) => available.get(id) ?? null)
  return { messages, available, resolve, imagePage }
}

describe('聊天图片前后导航', () => {
  it('使用消息顺序隔离会话，忽略表情、文件、撤回，首末张不循环', async () => {
    const rows = [image(1), image(2, { conv_id: 'group:other' }), image(3),
      image(4, { kind: 'sticker' }), image(5, { kind: 'file' }), image(6, { status: 'recalled' }), image(7)]
    const { messages, resolve } = setup(rows)
    expect(await getImageViewerNavigation('t3', messages, resolve)).toEqual({ name: 'm3.png', previous: 't1', next: 't7' })
    expect(await getImageViewerNavigation('t1', messages, resolve)).toEqual({ name: 'm1.png', previous: null, next: 't3' })
    expect(await getImageViewerNavigation('t7', messages, resolve)).toEqual({ name: 'm7.png', previous: 't3', next: null })
  })

  it('跨多页跳过连续不可用媒体，完整历史不受 100 条搜索上限影响', async () => {
    const { messages, available, resolve, imagePage } = setup(Array.from({ length: 251 }, (_, i) => image(i + 1)))
    for (let i = 2; i < 251; i++) if (i !== 126) available.delete(`t${i}`)
    expect(await getImageViewerNavigation('t126', messages, resolve)).toEqual({ name: 'm126.png', previous: 't1', next: 't251' })
    expect(imagePage).toHaveBeenCalledTimes(6)
    expect(imagePage.mock.calls.every((call) => call[3] === 50)).toBe(true)
  })

  it('跳过坏 JSON、非法 ID 和错误消息引用，群发优先主引用并支持可用候补', async () => {
    const rows = [image(1), image(2, { file_ref: '{坏 JSON' }), image(3, { file_ref: 'null' }),
      image(4, { file_ref: JSON.stringify({ transferId: 't1' }) }),
      image(5, { file_ref: JSON.stringify({ transferId: '', transferIds: [2, '', 'x'.repeat(65)] }) }),
      image(6, { file_ref: JSON.stringify({ transferId: 't6', transferIds: ['t6', 'copy6', 'copy6'] }) }),
      image(7), image(8, { file_ref: JSON.stringify({ transferId: 't8', transferIds: ['copy8'] }) })]
    const { messages, available, resolve } = setup(rows)
    available.delete('t6')
    available.set('copy6', { msgId: 'm6', name: '群发.png' })
    available.set('copy8', { msgId: 'm8', name: '副本.png' })
    expect(await getImageViewerNavigation('t7', messages, resolve)).toEqual({ name: 'm7.png', previous: 'copy6', next: 't8' })
    expect(resolve).not.toHaveBeenCalledWith('copy8')
    resolve.mockClear()
    expect(await getImageViewerNavigation('copy6', messages, resolve)).toEqual({ name: '群发.png', previous: 't1', next: 't7' })
    expect(resolve.mock.calls.filter(([id]) => id === 'copy6')).toHaveLength(1)
  })

  it('当前图片不存在、已撤回或类型不符时不给出导航', async () => {
    const { messages, available, resolve, imagePage } = setup([image(1, { status: 'recalled' }), image(2, { kind: 'sticker' })])
    available.set('orphan', { msgId: 'missing', name: '失效.png' })
    for (const id of ['missing', 'orphan', 't1', 't2']) {
      expect(await getImageViewerNavigation(id, messages, resolve)).toBeNull()
    }
    expect(imagePage).not.toHaveBeenCalled()
  })

  it('异步媒体校验期间撤回的候选继续跳过，当前消息被删除则终止', async () => {
    const rows = [image(1), image(2), image(3)]
    const { messages, available } = setup(rows)
    const resolve = async (id: string) => {
      if (id === 't2') rows[1].status = 'recalled'
      return available.get(id) ?? null
    }
    expect(await getImageViewerNavigation('t3', messages, resolve)).toEqual({ name: 'm3.png', previous: 't1', next: null })
    expect(await getImageViewerNavigation('t3', messages, async (id) => {
      if (id === 't1') rows.pop()
      return available.get(id) ?? null
    })).toBeNull()
  })
})
