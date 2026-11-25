import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc'
import type { StartupCheckpoint } from '../services/diagnostics'

const FIRST_FRAME_TIMEOUT = 15_000

interface MainWindowStartup {
  create: () => BrowserWindow
  load: (win: BrowserWindow) => Promise<void>
  isQuitting: () => boolean
  checkpoint: StartupCheckpoint
  onShown: () => void
  onFailure: () => void
}

/** A hidden window must either become visible, be replaced once, or give the user an error. */
export function showMainWindowOnLoad(startup: MainWindowStartup): void {
  function open(attempt: 1 | 2, previous?: BrowserWindow): void {
    if (startup.isQuitting() || previous?.isDestroyed()) return
    startup.checkpoint('window-create', 'starting', attempt)
    let win: BrowserWindow
    try {
      win = startup.create()
    } catch (error) {
      startup.checkpoint('window-create', 'failed', attempt, error)
      startup.onFailure()
      return
    }
    startup.checkpoint('window-create', 'ready', attempt)
    // Keep a native window alive across the swap so window-all-closed cannot quit the app.
    previous?.destroy()
    const contents = win.webContents
    let active = true
    const stopped = () => !active || startup.isQuitting() || win.isDestroyed()
    const timer = setTimeout(() => fail('window-load', 'timeout'), FIRST_FRAME_TIMEOUT)
    function detach(): void {
      active = false
      clearTimeout(timer)
      win.off('closed', detach)
      win.off('ready-to-show', ready)
      contents.off('dom-ready', domReady)
      contents.off('ipc-message', mounted)
      contents.off('render-process-gone', gone)
    }
    function fail(stage: 'window-load' | 'window-show', status: 'failed' | 'timeout', error?: unknown): void {
      if (stopped()) return
      detach()
      startup.checkpoint(stage, status, attempt, error)
      if (attempt === 2) startup.onFailure()
      else setImmediate(() => open(2, win))
    }
    function show(signal: 'ready-to-show' | 'ui-mounted'): void {
      if (stopped() || contents.isCrashed()) return
      startup.checkpoint(signal, 'ready', attempt)
      startup.checkpoint('window-show', 'starting', attempt)
      try {
        win.show()
      } catch (error) {
        fail('window-show', 'failed', error)
        return
      }
      detach()
      startup.checkpoint('window-show', 'ready', attempt)
      startup.onShown()
    }
    const ready = () => show('ready-to-show')
    const mounted = (event: Electron.Event, channel: string) => {
      if (channel === IpcChannels.uiMainReady && 'senderFrame' in event &&
          event.senderFrame === contents.mainFrame) show('ui-mounted')
    }
    const domReady = () => startup.checkpoint('dom-ready', 'ready', attempt)
    const gone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      if (details.reason !== 'clean-exit') fail('window-load', 'failed')
    }
    win.once('closed', detach)
    win.once('ready-to-show', ready)
    contents.once('dom-ready', domReady)
    contents.on('ipc-message', mounted)
    contents.on('render-process-gone', gone)
    startup.checkpoint('window-load', 'starting', attempt)
    try {
      void startup.load(win).catch(error => fail('window-load', 'failed', error))
    } catch (error) {
      fail('window-load', 'failed', error)
    }
  }
  open(1)
}
