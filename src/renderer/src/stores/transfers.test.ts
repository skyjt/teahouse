import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferView } from '../../../shared/ipc'
import { useTransfersStore } from './transfers'

const transfer: TransferView = {
  transferId: 't1', msgId: 'm1', convId: 'group:a', peerId: 'peer', direction: 'in',
  status: 'offering', bytesDone: 0, totalSize: 100, fileCount: 1, name: '验证.txt',
  expiresAt: 0, savedPath: '', direct: false
}

function deferred() {
  let resolve!: (value: TransferView | null) => void
  const promise = new Promise<TransferView | null>((done) => { resolve = done })
  return { promise, resolve }
}

describe('传输懒读取去重与实时状态优先', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('50 处同时展示仅查询一次，已有状态继续命中缓存', async () => {
    const pending = deferred()
    const getTransfer = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('window', { pantry: { getTransfer } })
    const store = useTransfersStore()
    const reads = Array.from({ length: 50 }, () => store.ensure('t1'))
    expect(getTransfer).toHaveBeenCalledTimes(1)
    pending.resolve(transfer)
    await Promise.all(reads)
    expect(store.byId.t1).toEqual(transfer)
    await store.ensure('t1')
    expect(getTransfer).toHaveBeenCalledTimes(1)
  })

  it.each(['accepted', 'done', 'canceled', 'expired'] as const)('旧读取不能覆盖后到的 %s 推送', async (status) => {
    const pending = deferred()
    let onUpdate!: (view: TransferView) => void
    vi.stubGlobal('window', { pantry: {
      getTransfer: vi.fn().mockReturnValue(pending.promise),
      onTransferUpdated: (listener: typeof onUpdate) => { onUpdate = listener }
    } })
    const store = useTransfersStore()
    store.init()
    const reading = store.ensure('t1')
    onUpdate({ ...transfer, status: 'accepted', bytesDone: 25 })
    const latest = { ...transfer, status, bytesDone: 75 }
    onUpdate(latest)
    const sample = store.samples.t1
    const speed = store.speed.t1
    pending.resolve(transfer)
    await reading
    expect(store.byId.t1).toEqual(latest)
    expect(store.samples.t1).toBe(sample)
    expect(store.speed.t1).toBe(speed)
  })

  it('不同传输独立读取，失败或缺失后可重新补载', async () => {
    const getTransfer = vi.fn().mockRejectedValueOnce(new Error('临时失败'))
      .mockResolvedValueOnce(null).mockResolvedValue(transfer)
    vi.stubGlobal('window', { pantry: { getTransfer } })
    const store = useTransfersStore()
    await Promise.all([store.ensure('t1'), store.ensure('t2')])
    expect(store.byId.t1).toBeUndefined()
    expect(store.byId.t2).toBeUndefined()
    await store.ensure('t1')
    await store.ensure('t2')
    expect(getTransfer.mock.calls).toEqual([['t1'], ['t2'], ['t1'], ['t2']])
  })

  function liveStore(getTransfer = vi.fn().mockResolvedValue(null)) {
    let onUpdate!: (view: TransferView) => void
    vi.stubGlobal('window', { pantry: {
      getTransfer, onTransferUpdated: (listener: typeof onUpdate) => { onUpdate = listener }
    } })
    const store = useTransfersStore()
    store.init()
    return { store, push: (view: TransferView) => onUpdate(view) }
  }

  it('终态仅保留最近 200 条且释放测速，活动传输和共享卡片不被淘汰', () => {
    const { store, push } = liveStore()
    push({ ...transfer, transferId: 'active', status: 'accepted', bytesDone: 25 })
    push({ ...transfer, transferId: 'waiting' })
    push({ ...transfer, status: 'done' })
    const releaseA = store.retain('t1')
    const releaseB = store.retain('t1')
    releaseA()
    releaseA()
    for (let i = 0; i < 1000; i++) push({ ...transfer, transferId: `done${i}`, status: 'done' })
    expect(Object.keys(store.byId)).toHaveLength(203)
    expect(store.byId.t1.status).toBe('done')
    expect(store.byId.active.status).toBe('accepted')
    expect(store.byId.waiting.status).toBe('offering')
    expect(Object.keys(store.samples).sort()).toEqual(['active', 'waiting'])
    expect(store.speed.t1).toBeUndefined()
    expect(store.references.get('t1')).toBe(1)
    releaseB()
    for (let i = 1000; i < 1200; i++) push({ ...transfer, transferId: `done${i}`, status: 'done' })
    expect(store.byId.t1).toBeUndefined()
    expect(store.references.size).toBe(0)
    expect(store.unusedCompleted.size).toBe(200)
  })

  it('终态推送在旧读取完成前受到保护，回收后可补载并继续重试', async () => {
    const pending = deferred()
    const getTransfer = vi.fn().mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ...transfer, status: 'failed', retryable: true })
    const { store, push } = liveStore(getTransfer)
    const reading = store.ensure('t1')
    push({ ...transfer, status: 'done' })
    for (let i = 0; i < 300; i++) push({ ...transfer, transferId: `done${i}`, status: 'done' })
    expect(store.byId.t1.status).toBe('done')
    pending.resolve(transfer)
    await reading
    expect(store.byId.t1.status).toBe('done')
    push({ ...transfer, transferId: 'next', status: 'done' })
    expect(store.byId.t1).toBeUndefined()
    const release = store.retain('t1')
    await store.ensure('t1')
    expect(store.byId.t1.retryable).toBe(true)
    expect(getTransfer).toHaveBeenCalledTimes(2)
    push({ ...transfer, status: 'accepted', bytesDone: 50 })
    release()
    expect(store.byId.t1.status).toBe('accepted')
    expect(store.unusedCompleted.has('t1')).toBe(false)
  })
})
