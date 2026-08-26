import type { CaptureFailureNotice, CaptureFailureReason } from '../../shared/ipc'

const DEFAULT_HIDE_EVENT_TIMEOUT_MS = 500
const DEFAULT_COMPOSITOR_SETTLE_MS = process.platform === 'linux' ? 350 : 180

interface CaptureHostWindow {
  hide(): void
  isDestroyed(): boolean
  isVisible(): boolean
  once(event: 'hide', listener: () => void): unknown
  removeListener(event: 'hide', listener: () => void): unknown
}

interface HideWindowOptions {
  hideEventTimeoutMs?: number
  compositorSettleMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wayland 只决定是否启用 portal/PipeWire 支持，不再直接判定截图不可用。 */
export function isWaylandSession(
  platform: NodeJS.Platform = process.platform,
  sessionType: string | undefined = process.env['XDG_SESSION_TYPE'],
  waylandDisplay: string | undefined = process.env['WAYLAND_DISPLAY']
): boolean {
  if (platform !== 'linux') return false
  const normalizedSession = sessionType?.trim().toLowerCase()
  if (normalizedSession) return normalizedSession === 'wayland'
  return Boolean(waylandDisplay?.trim())
}

/** 追加 Chromium feature 时保留部署方已有的 --enable-features。 */
export function mergeChromiumFeature(existing: string, required: string): string {
  const features = existing
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean)
  if (!features.includes(required)) features.push(required)
  return features.join(',')
}

function waitForHideSignal(win: CaptureHostWindow, timeoutMs: number): Promise<boolean> {
  if (win.isDestroyed() || !win.isVisible()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (signaled: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      win.removeListener('hide', onHide)
      resolve(signaled)
    }
    const onHide = (): void => finish(true)

    win.once('hide', onHide)
    win.hide()
    if (win.isDestroyed() || !win.isVisible()) {
      finish(true)
      return
    }
    timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
  })
}

/**
 * Electron 的 hide 事件只表示窗口状态已切换；Linux 合成器的淡出可能仍在屏幕上。
 * 等事件后再留出一小段退场时间，并在最终仍可见时拒绝抓屏，避免截入主窗口。
 */
export async function hideWindowForCapture(
  win: CaptureHostWindow,
  options: HideWindowOptions = {}
): Promise<boolean> {
  const hideEventTimeoutMs = options.hideEventTimeoutMs ?? DEFAULT_HIDE_EVENT_TIMEOUT_MS
  const compositorSettleMs = options.compositorSettleMs ?? DEFAULT_COMPOSITOR_SETTLE_MS
  const signaled = await waitForHideSignal(win, hideEventTimeoutMs)
  if (!signaled && !win.isDestroyed() && win.isVisible()) return false
  await delay(Math.max(0, compositorSettleMs))
  return win.isDestroyed() || !win.isVisible()
}

export function captureFailureNotice(
  reason: CaptureFailureReason,
  wayland: boolean
): CaptureFailureNotice {
  if (reason === 'window-hide-failed') {
    return {
      reason,
      message: '截图前未能完全隐藏茶话间窗口，请重试；仍失败可使用系统截图。'
    }
  }
  if (reason === 'screen-unavailable' && wayland) {
    return {
      reason,
      message:
        'Wayland 未能提供可用屏幕。请在系统授权窗口选择屏幕，或使用系统截图后在聊天框按 Ctrl+V 发送。'
    }
  }
  if (reason === 'screen-unavailable') {
    return {
      reason,
      message: '未找到可截图的屏幕，请重试；仍失败可使用系统截图后在聊天框按 Ctrl+V 发送。'
    }
  }
  if (reason === 'image-empty') {
    return {
      reason,
      message: '系统返回了空白截图，请重试；仍失败可使用系统截图后在聊天框按 Ctrl+V 发送。'
    }
  }
  return {
    reason,
    message: wayland
      ? '截图失败。请检查 Wayland 屏幕共享授权，或使用系统截图后在聊天框按 Ctrl+V 发送。'
      : '截图失败，请重试；仍失败可使用系统截图后在聊天框按 Ctrl+V 发送。'
  }
}
