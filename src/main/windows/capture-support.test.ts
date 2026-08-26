import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureFailureNotice,
  hideWindowForCapture,
  isWaylandSession,
  mergeChromiumFeature
} from './capture-support'

class FakeCaptureWindow extends EventEmitter {
  visible = true
  destroyed = false
  hideDelayMs: number | null = 0

  isVisible(): boolean {
    return this.visible
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  hide(): void {
    if (this.hideDelayMs === null) return
    setTimeout(() => {
      this.visible = false
      this.emit('hide')
    }, this.hideDelayMs)
  }
}

describe('Linux 截图兼容辅助', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('识别 Wayland 会话并合并 PipeWire feature，不覆盖现有 feature', () => {
    expect(isWaylandSession('linux', 'wayland')).toBe(true)
    expect(isWaylandSession('linux', 'Wayland')).toBe(true)
    expect(isWaylandSession('linux', 'x11')).toBe(false)
    expect(isWaylandSession('win32', 'wayland')).toBe(false)
    expect(isWaylandSession('linux', '', 'wayland-0')).toBe(true)
    expect(isWaylandSession('linux', '', '')).toBe(false)

    expect(mergeChromiumFeature('', 'WebRTCPipeWireCapturer')).toBe(
      'WebRTCPipeWireCapturer'
    )
    expect(mergeChromiumFeature('Foo,Bar', 'WebRTCPipeWireCapturer')).toBe(
      'Foo,Bar,WebRTCPipeWireCapturer'
    )
    expect(mergeChromiumFeature('Foo,WebRTCPipeWireCapturer', 'WebRTCPipeWireCapturer')).toBe(
      'Foo,WebRTCPipeWireCapturer'
    )
  })

  it('等 hide 事件后再留出合成器退场时间', async () => {
    vi.useFakeTimers()
    const win = new FakeCaptureWindow()
    win.hideDelayMs = 120
    let finished = false

    const hidden = hideWindowForCapture(win, {
      hideEventTimeoutMs: 500,
      compositorSettleMs: 300
    }).then((value) => {
      finished = true
      return value
    })

    await vi.advanceTimersByTimeAsync(419)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(hidden).resolves.toBe(true)
  })

  it('窗口在超时后仍可见时拒绝抓屏，避免把主窗口截进去', async () => {
    vi.useFakeTimers()
    const win = new FakeCaptureWindow()
    win.hideDelayMs = null

    const hidden = hideWindowForCapture(win, {
      hideEventTimeoutMs: 200,
      compositorSettleMs: 300
    })

    await vi.advanceTimersByTimeAsync(200)
    await expect(hidden).resolves.toBe(false)
  })

  it('Wayland 失败提示明确给出系统截图粘贴退路', () => {
    const notice = captureFailureNotice('screen-unavailable', true)
    expect(notice.reason).toBe('screen-unavailable')
    expect(notice.message).toContain('Wayland')
    expect(notice.message).toContain('Ctrl+V')

    expect(captureFailureNotice('window-hide-failed', false).message).toContain(
      '未能完全隐藏'
    )
  })
})
