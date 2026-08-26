import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../shared/ipc.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../renderer/src/App.vue', import.meta.url), 'utf8')

describe('Issue #29 / #31 截图兼容接线', () => {
  it('Wayland 启用 PipeWire 后仍继续尝试 desktopCapturer', () => {
    expect(mainSource).toContain("'WebRTCPipeWireCapturer'")
    expect(mainSource).toContain('await desktopCapturer.getSources')
    expect(mainSource).not.toContain(
      "process.env['XDG_SESSION_TYPE'] === 'wayland'"
    )
  })

  it('抓屏前确认主窗口已经隐藏', () => {
    expect(mainSource).toContain('await hideWindowForCapture')
    expect(mainSource).not.toContain('setTimeout(r, 180)')
  })

  it('失败信息通过 preload 到达主界面，不依赖系统通知', () => {
    expect(mainSource).toContain('IpcEvents.captureFailed')
    expect(ipcSource).toContain("captureFailed: 'capture:failed'")
    expect(ipcSource).toContain('onCaptureFailed(listener: (notice: CaptureFailureNotice) => void)')
    expect(preloadSource).toContain('subscribe<CaptureFailureNotice>(IpcEvents.captureFailed, listener)')
    expect(appSource).toContain('window.pantry.onCaptureFailed')
    expect(appSource).toContain('aria-live="assertive"')
  })
})
