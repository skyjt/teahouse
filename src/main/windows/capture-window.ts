import { app, BrowserWindow, type Rectangle, type WebContents } from 'electron'
import type { CaptureInit } from '../../shared/ipc'
import { join } from 'node:path'
import { resolveDevRendererUrl } from '../util/renderer-url'

// 截图框选窗（F-CAP-1）：覆盖主屏的无边框置顶窗，经 #/capture 挂 CaptureApp。
// 窗口加载后一次性注入位图及本次可选的收件人。

let win: BrowserWindow | null = null
let readyFallbackTimer: ReturnType<typeof setTimeout> | null = null

function clearReadyFallback(): void {
  if (!readyFallbackTimer) return
  clearTimeout(readyFallbackTimer)
  readyFallbackTimer = null
}

function revealCaptureWindow(target: BrowserWindow): void {
  if (target.isDestroyed()) return
  clearReadyFallback()
  target.show()
  target.focus()
}

export function isCaptureSender(sender: WebContents): boolean {
  return !!win && !win.isDestroyed() && win.webContents === sender
}

/** 只接受当前截图窗的就绪回执，其他 renderer 无法借此操作窗口。 */
export function showCaptureWindow(sender: WebContents): void {
  if (!win || win.isDestroyed() || win.webContents !== sender) return
  revealCaptureWindow(win)
}

export function openCaptureWindow(
  bounds: Rectangle,
  init: CaptureInit,
  onClosed: () => void
): void {
  closeCaptureWindow()
  const captureWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#000000',
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // 隐藏期间仍要及时完成 PNG 解码与首帧，Win7 上避免显示后才开始卡顿加载。
      backgroundThrottling: false
    }
  })
  win = captureWin
  captureWin.setAlwaysOnTop(true, 'screen-saver')
  captureWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  captureWin.webContents.on('will-navigate', (event) => event.preventDefault())
  captureWin.on('closed', () => {
    clearReadyFallback()
    if (win === captureWin) win = null
    onClosed()
  })
  captureWin.webContents.on('did-finish-load', () => {
    captureWin.webContents.send('capture:init', init)
    // renderer 正常会在首帧后立即回执；超时兜底保证解码异常时仍可按 Esc 退出。
    clearReadyFallback()
    readyFallbackTimer = setTimeout(() => revealCaptureWindow(captureWin), 2500)
  })

  const rendererUrl = resolveDevRendererUrl(
    process.env['ELECTRON_RENDERER_URL'],
    '/capture',
    app.isPackaged
  )
  if (rendererUrl) {
    void captureWin.loadURL(rendererUrl)
  } else {
    void captureWin.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/capture' })
  }
}

export function closeCaptureWindow(): void {
  clearReadyFallback()
  if (win && !win.isDestroyed()) win.close()
  win = null
}
