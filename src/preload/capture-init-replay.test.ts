import { describe, expect, it, vi } from 'vitest'
import { createCaptureInitReplay } from './capture-init-replay'

describe('截图初始化事件回放', () => {
  it('初始化先到达时，稍后订阅仍能立即收到最近数据', () => {
    const replay = createCaptureInitReplay()
    const listener = vi.fn()

    const init = { pngBytes: new ArrayBuffer(3), pinnedConvId: 'single:a', recipients: [{ convId: 'single:a', name: 'A' }] }
    replay.publish(init)
    replay.subscribe(listener)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(init)
  })

  it('订阅先建立时，初始化按正常时序送达', () => {
    const replay = createCaptureInitReplay()
    const listener = vi.fn()

    replay.subscribe(listener)
    const init = { pngBytes: new ArrayBuffer(3), pinnedConvId: null, recipients: [] }
    replay.publish(init)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(init)
  })

  it('退订后不再接收后续初始化', () => {
    const replay = createCaptureInitReplay()
    const listener = vi.fn()
    const unsubscribe = replay.subscribe(listener)

    unsubscribe()
    replay.publish({ pngBytes: new ArrayBuffer(1), pinnedConvId: null, recipients: [] })

    expect(listener).not.toHaveBeenCalled()
  })
})
