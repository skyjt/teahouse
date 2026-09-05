import { createPinia, setActivePinia } from 'pinia'
import { computed, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationView, MessageView } from '../../../shared/ipc'
import { useChatStore } from './chat'

function msg(id: string, convId = 'single:node-bob', seq = 1): MessageView {
  return {
    id,
    convId,
    senderId: 'node-self',
    isMine: true,
    kind: 'image',
    text: '[图片]',
    ts: Date.now(),
    seq,
    status: 'sending'
  }
}

function conv(id = 'single:node-bob'): ConversationView {
  return {
    id,
    type: id.startsWith('group:') ? 'group' : 'single',
    peerId: id.startsWith('group:') ? id.slice(6) : id.slice(7),
    unread: 0,
    lastTs: Date.now(),
    preview: '',
    pinned: false,
    muted: false,
    mentioned: false
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('引用消息索引与进行中读取去重', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each([50, 300, 1000])('%s 条缓存按 ID 读取，保持所属会话隔离', (count) => {
    const store = useChatStore()
    store.setConversationMessages('group:a', Array.from({ length: count }, (_, i) => msg(`m${i}`, 'group:a', i)))
    store.setConversationMessages('group:b', [msg('other', 'group:b')])
    const find = vi.spyOn(store.messages['group:a'], 'find')
    expect(store.getCachedMessage('group:a', `m${count - 1}`)?.seq).toBe(count - 1)
    expect(store.getCachedMessage('group:a', 'other')).toBeUndefined()
    expect(store.getCachedMessage('group:b', 'm0')).toBeUndefined()
    expect(find).not.toHaveBeenCalled()
  })

  it('引用订阅跟随追加、撤回、同数组重建、重载与裁剪，其他 ID 更新不触发重算', () => {
    const store = useChatStore()
    store.setConversationMessages('group:a', [])
    const read = vi.fn(() => {
      const target = store.getCachedMessage('group:a', 'target')
      return target ? `${target.text}:${target.status}` : '缺失'
    })
    const summary = computed(read)
    const changes: string[] = []
    const stop = watch(summary, (next) => changes.push(next), { immediate: true, flush: 'sync' })
    store.appendConversationMessage('group:a', msg('other', 'group:a'))
    expect(read).toHaveBeenCalledTimes(1)
    store.appendConversationMessage('group:a', msg('target', 'group:a'))
    store.updateConversationMessageStatus('group:a', 'target', 'recalled')
    store.setConversationMessages('group:a', store.messages['group:a'])
    store.updateConversationMessageStatus('group:a', 'target', 'sent')
    store.setConversationMessages('group:a', [{ ...msg('target', 'group:a'), text: '重新加载' }])
    store.trimConversationHead('group:a', 0)
    store.prependEarlierMessages('group:a', [msg('target', 'group:a')])
    expect(changes).toEqual(['缺失', '[图片]:sending', '[图片]:recalled', '[图片]:sent', '重新加载:sending', '缺失', '[图片]:sending'])
    stop()
  })

  it('50 个相同页外目标合并成一次读取，结束后重新读取最新值', async () => {
    const pending = deferred<MessageView | null>()
    const source = msg('source', 'group:a')
    const getMessageById = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...source, status: 'recalled' })
    vi.stubGlobal('window', { pantry: { getMessageById } })
    const store = useChatStore()
    const reads = Array.from({ length: 50 }, () => store.getMessageById('source'))
    expect(getMessageById).toHaveBeenCalledTimes(1)
    pending.resolve(source)
    const results = await Promise.all(reads)
    expect(results.every((value) => value === source)).toBe(true)
    expect((await store.getMessageById('source'))?.status).toBe('recalled')
    expect(getMessageById).toHaveBeenCalledTimes(2)
  })

  it('不同目标独立读取，失败与缺失均释放并允许重试', async () => {
    const getMessageById = vi.fn()
      .mockRejectedValueOnce(new Error('临时失败'))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(msg('a'))
    vi.stubGlobal('window', { pantry: { getMessageById } })
    const store = useChatStore()
    expect(await Promise.all([store.getMessageById('a'), store.getMessageById('b')])).toEqual([null, null])
    await store.getMessageById('a')
    await store.getMessageById('b')
    expect(getMessageById.mock.calls).toEqual([['a'], ['b'], ['a'], ['b']])
  })
})

describe('闲置会话缓存边界', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.stubGlobal('window', { pantry: {
      pageMessages: vi.fn(async (id: string) => Array.from({ length: 50 }, (_, i) => msg(`${id}-${i}`, id, i + 1))),
      markRead: vi.fn().mockResolvedValue(undefined),
      getMessageContext: vi.fn(async (id: string, seq: number) => [msg('target', id, seq)])
    } })
  })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('100 会话只保留最近 10 个闲置快照，淘汰后最新页和指定历史仍可加载', async () => {
    const store = useChatStore()
    for (let i = 0; i < 100; i++) await store.openConv(`group:${i}`)
    expect(Object.keys(store.messages)).toHaveLength(11)
    expect(store.getCachedMessage('group:0', 'group:0-0')).toBeUndefined()
    expect(store.messages['group:89']).toHaveLength(50)
    await store.openConv('group:0')
    expect(window.pantry.pageMessages).toHaveBeenLastCalledWith('group:0', null, 50)
    expect(store.messages['group:0']).toHaveLength(50)
    expect(store.openScrollMode).toBe('latest')
    await store.jumpToMessage('group:1', 500, 'target')
    expect(store.getCachedMessage('group:1', 'target')?.seq).toBe(500)
    expect(store.highlightId).toBe('target')
    expect(store.openScrollMode).toBe('target')
  })

  it('闲置消息总量受限，当前历史和移除撤回项保持完整，外部引用仍可转发', async () => {
    const store = useChatStore()
    store.activeConvId = 'group:active'
    store.setConversationMessages('group:active', Array.from({ length: 5000 }, (_, i) => msg(`a${i}`, 'group:active', i)))
    store.requestRemoveConversation('group:active', '待撤回')
    const source = store.messages['group:active'][0]
    await store.openConv('group:reading')
    store.setConversationMessages('group:reading', Array.from({ length: 5000 }, (_, i) => msg(`r${i}`, 'group:reading', i)))
    store.viewingHistory = true
    for (let i = 0; i < 10; i++) {
      store.setConversationMessages(`group:idle${i}`, Array.from({ length: 1000 }, (_, j) => msg(`${i}-${j}`, `group:idle${i}`, j)))
    }
    expect(Object.keys(store.messages)).toHaveLength(5)
    expect(store.messages['group:active']).toHaveLength(5000)
    expect(store.activeMessages).toHaveLength(5000)
    expect(store.viewingHistory).toBe(true)
    store.undoRemoveConversation()
    store.pruneInactiveMessages()
    expect(store.messages['group:active']).toBeUndefined()
    expect(source.id).toBe('a0')
    const forwardMessage = vi.fn().mockResolvedValue({ messages: [], failed: [] })
    window.pantry.forwardMessage = forwardMessage
    await store.forward(source.id, [{ type: 'group', id: 'target' }])
    expect(forwardMessage).toHaveBeenCalledWith('a0', [{ type: 'group', id: 'target' }])
  })

  it('离开且淘汰后，迟到分页不能复活缓存或改变当前视图', async () => {
    const store = useChatStore()
    await store.openConv('group:old')
    const earlier = deferred<MessageView[]>()
    vi.mocked(window.pantry.pageMessages).mockReturnValueOnce(earlier.promise)
    const loading = store.loadEarlier()
    for (let i = 0; i < 12; i++) await store.openConv(`group:${i}`)
    earlier.resolve([msg('stale', 'group:old')])
    expect(await loading).toBe(0)
    expect(store.messages['group:old']).toBeUndefined()
    expect(store.activeConvId).toBe('group:11')
    expect(store.activeMessages).toHaveLength(50)
  })
})

describe('chat store 自己发送后的滚动意图', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('当前会话追加自己发送的媒体消息后请求定位到最新', () => {
    const store = useChatStore()
    store.activeConvId = 'single:node-bob'
    store.viewingHistory = true
    store.messages['single:node-bob'] = []

    expect(store.pushOwn(msg('img-1'))).toBe(true)

    expect(store.messages['single:node-bob'].map((item) => item.id)).toEqual(['img-1'])
    expect(store.viewingHistory).toBe(false)
    expect(store.openScrollMode).toBe('latest')
    expect(store.openScrollRun).toBe(1)
  })

  it('非当前会话的自己消息不抢当前滚动位置', () => {
    const store = useChatStore()
    store.activeConvId = 'single:node-alice'
    store.messages['single:node-bob'] = []

    expect(store.pushOwn(msg('img-2'))).toBe(true)

    expect(store.openScrollRun).toBe(0)
  })

  it('群聊发送收藏表情时携带群目标并追加本地消息', async () => {
    const sent = { ...msg('sticker-1', 'group:team'), kind: 'sticker' as const, text: '[表情]' }
    const sendSticker = vi.fn().mockResolvedValue(sent)
    vi.stubGlobal('window', { pantry: { sendSticker } })
    const store = useChatStore()
    store.convs = [conv('group:team')]
    store.activeConvId = 'group:team'
    store.messages['group:team'] = []

    await expect(store.sendSticker('saved-1')).resolves.toBe(true)

    expect(sendSticker).toHaveBeenCalledWith('team', 'saved-1', true)
    expect(store.messages['group:team']).toEqual([sent])
    expect(store.openScrollMode).toBe('latest')
  })

  it('默认打开群会话时重载最新页并定位到底部', async () => {
    const latest = [msg('latest-1', 'group:team')]
    const pageMessages = vi.fn().mockResolvedValue(latest)
    const markRead = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      pantry: {
        pageMessages,
        markRead
      }
    })
    const store = useChatStore()
    store.messages['group:team'] = [msg('old-1', 'group:team')]
    store.scrollPositions['group:team'] = { top: 120, atBottom: false }

    await store.openConv('group:team')

    expect(pageMessages).toHaveBeenCalledWith('group:team', null, 50)
    expect(markRead).toHaveBeenCalledWith('group:team')
    expect(store.messages['group:team']).toEqual(latest)
    expect(store.openScrollMode).toBe('latest')
    expect(store.openScrollRun).toBe(1)
  })

  it('默认打开单聊会话时也按最新入口处理', async () => {
    const latest = [msg('latest-1', 'single:node-bob')]
    const pageMessages = vi.fn().mockResolvedValue(latest)
    const openConversation = vi.fn().mockResolvedValue(conv('single:node-bob'))
    vi.stubGlobal('window', {
      pantry: {
        openConversation,
        pageMessages
      }
    })
    const store = useChatStore()
    store.messages['single:node-bob'] = [msg('old-1')]
    store.scrollPositions['single:node-bob'] = { top: 240, atBottom: false }

    await store.openConv('single:node-bob')

    expect(openConversation).toHaveBeenCalledWith('node-bob')
    expect(pageMessages).toHaveBeenCalledWith('single:node-bob', null, 50)
    expect(store.messages['single:node-bob']).toEqual(latest)
    expect(store.openScrollMode).toBe('latest')
    expect(store.openScrollRun).toBe(1)
  })

  it('A 单聊打开迟到时不得覆盖已完成的 B 会话导航', async () => {
    const openingA = deferred<ConversationView | null>()
    const openingB = deferred<ConversationView | null>()
    const openConversation = vi.fn((peerId: string) =>
      peerId === 'node-a' ? openingA.promise : openingB.promise
    )
    const pageMessages = vi.fn(async (convId: string) => [msg(`latest-${convId}`, convId)])
    vi.stubGlobal('window', { pantry: { openConversation, pageMessages } })
    const store = useChatStore()

    const openA = store.openConv('single:node-a')
    const openB = store.openConv('single:node-b')
    openingB.resolve(conv('single:node-b'))
    await openB
    openingA.resolve(conv('single:node-a'))
    await openA

    expect(store.activeConvId).toBe('single:node-b')
    expect(store.messages['single:node-b']?.map((item) => item.id)).toEqual([
      'latest-single:node-b'
    ])
    expect(store.messages['single:node-a']).toBeUndefined()
  })

  it('迟到的历史搜索上下文不得改写新会话的高亮与滚动意图', async () => {
    const contextA = deferred<MessageView[]>()
    const pageMessages = vi.fn(async (convId: string) => [msg(`latest-${convId}`, convId)])
    const markRead = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      pantry: {
        getMessageContext: vi.fn(() => contextA.promise),
        pageMessages,
        markRead
      }
    })
    const store = useChatStore()
    store.convs = [conv('group:a'), conv('group:b')]

    const jump = store.jumpToMessage('group:a', 10, 'target-a')
    await Promise.resolve()
    await store.openConv('group:b')
    const scrollRun = store.openScrollRun
    contextA.resolve([msg('target-a', 'group:a', 10)])
    await jump

    expect(store.activeConvId).toBe('group:b')
    expect(store.highlightId).toBeNull()
    expect(store.openScrollMode).toBe('latest')
    expect(store.openScrollRun).toBe(scrollRun)
    expect(store.messages['group:a']).toBeUndefined()
  })

  it('迟到的返回最新结果不得覆盖离开会话后的状态', async () => {
    const latestA = deferred<MessageView[]>()
    const oldA = [msg('old-a', 'group:a')]
    const pageMessages = vi.fn((convId: string) =>
      convId === 'group:a' ? latestA.promise : Promise.resolve([msg('latest-b', 'group:b')])
    )
    vi.stubGlobal('window', {
      pantry: {
        pageMessages,
        markRead: vi.fn().mockResolvedValue(undefined)
      }
    })
    const store = useChatStore()
    store.activeConvId = 'group:a'
    store.messages['group:a'] = oldA

    const back = store.backToLatest()
    await store.openConv('group:b')
    const scrollRun = store.openScrollRun
    latestA.resolve([msg('latest-a', 'group:a')])
    await back

    expect(store.activeConvId).toBe('group:b')
    expect(store.messages['group:a'].map((item) => item.id)).toEqual(['old-a'])
    expect(store.openScrollRun).toBe(scrollRun)
  })

  it('裁剪长会话头部消息后保持消息缓存一致', () => {
    const store = useChatStore()
    const convId = 'single:node-bob'
    store.setConversationMessages(
      convId,
      Array.from({ length: 5 }, (_item, index) => msg(`msg-${index + 1}`, convId, index + 1))
    )

    const trimmed = store.trimConversationHead(convId, 3)

    expect(trimmed).toBe(2)
    expect(store.messages[convId].map((item) => item.id)).toEqual(['msg-3', 'msg-4', 'msg-5'])

    store.updateConversationMessageStatus(convId, 'msg-4', 'sent')
    expect(store.messages[convId][1].status).toBe('sent')
    expect(store.appendConversationMessage(convId, msg('msg-4', convId, 4))).toBe(false)
    expect(store.prependEarlierMessages(convId, [msg('msg-1', convId, 1), msg('msg-3', convId, 3)])).toBe(1)
    expect(store.messages[convId].map((item) => item.id)).toEqual([
      'msg-1',
      'msg-3',
      'msg-4',
      'msg-5'
    ])
  })
})

describe('未读置读需窗口可见且聚焦（决议 #220）', () => {
  let msgNewHandler: ((m: MessageView) => void) | null
  let focusHandler: (() => void) | null

  function stubEnv(options: { visibilityState: DocumentVisibilityState; focused: boolean }) {
    msgNewHandler = null
    focusHandler = null
    const markRead = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('document', {
      visibilityState: options.visibilityState,
      hasFocus: () => options.focused
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'focus') focusHandler = handler
      }),
      pantry: {
        listConversations: vi.fn().mockResolvedValue([]),
        getAppInfo: vi.fn().mockResolvedValue({ nodeId: 'node-self' }),
        getSettings: vi.fn().mockResolvedValue(null),
        onSettingsUpdated: vi.fn(),
        onConvsUpdated: vi.fn(),
        onMsgNew: vi.fn((handler: (m: MessageView) => void) => {
          msgNewHandler = handler
        }),
        onMsgStatus: vi.fn(),
        onNudgeReceived: vi.fn(),
        onOpenConv: vi.fn(),
        onCaptured: vi.fn(),
        markRead
      }
    })
    return { markRead }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('窗口可见且聚焦时，当前会话新消息即时置读', async () => {
    const { markRead } = stubEnv({ visibilityState: 'visible', focused: true })
    const store = useChatStore()
    await store.init()
    store.activeConvId = 'single:node-bob'

    msgNewHandler?.(msg('in-1'))

    expect(markRead).toHaveBeenCalledWith('single:node-bob')
  })

  it('窗口最小化 / 隐藏到托盘时，当前会话新消息保留未读', async () => {
    const { markRead } = stubEnv({ visibilityState: 'hidden', focused: false })
    const store = useChatStore()
    await store.init()
    store.activeConvId = 'single:node-bob'

    msgNewHandler?.(msg('in-2'))

    expect(markRead).not.toHaveBeenCalled()
  })

  it('淘汰会话收到后台消息时不重新建缓存，也不置读', async () => {
    const { markRead } = stubEnv({ visibilityState: 'visible', focused: true })
    const store = useChatStore()
    await store.init()
    store.activeConvId = 'group:active'
    store.convs = [{ ...conv(), unread: 3 }]
    for (let i = 0; i < 12; i++) store.setConversationMessages(`group:${i}`, [msg(`m${i}`, `group:${i}`)])
    expect(store.messages['group:0']).toBeUndefined()
    msgNewHandler?.(msg('background', 'group:0'))
    expect(store.messages['group:0']).toBeUndefined()
    expect(store.totalUnread).toBe(3)
    expect(markRead).not.toHaveBeenCalled()
  })

  it('窗口可见但被其他窗口压住失焦时，同样保留未读', async () => {
    const { markRead } = stubEnv({ visibilityState: 'visible', focused: false })
    const store = useChatStore()
    await store.init()
    store.activeConvId = 'single:node-bob'

    msgNewHandler?.(msg('in-3'))

    expect(markRead).not.toHaveBeenCalled()
  })

  it('重新聚焦窗口时补置读当前会话攒下的未读', async () => {
    const { markRead } = stubEnv({ visibilityState: 'visible', focused: false })
    const store = useChatStore()
    await store.init()
    store.activeConvId = 'single:node-bob'
    store.convs = [{ ...conv('single:node-bob'), unread: 2 }]

    focusHandler?.()

    expect(markRead).toHaveBeenCalledWith('single:node-bob')
  })

  it('重新聚焦时当前会话无未读则不重复置读', async () => {
    const { markRead } = stubEnv({ visibilityState: 'visible', focused: false })
    const store = useChatStore()
    await store.init()
    store.activeConvId = 'single:node-bob'
    store.convs = [conv('single:node-bob')]

    focusHandler?.()

    expect(markRead).not.toHaveBeenCalled()
  })
})
