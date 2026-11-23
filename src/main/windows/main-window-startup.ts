import type { BrowserWindow } from 'electron'

/** A renderer can exit before its first paint, leaving an invisible native window. */
export function showMainWindowOnLoad(
  win: BrowserWindow,
  load: () => Promise<void>,
  isQuitting: () => boolean,
  onFailure: () => void
): void {
  let phase: 'first' | 'scheduled' | 'retry' | 'done' = 'first'
  const stopped = () => isQuitting() || win.isDestroyed() || phase === 'done'

  function failed(): void {
    if (stopped() || phase === 'scheduled') return
    if (phase === 'retry') {
      phase = 'done'
      onFailure()
      return
    }
    phase = 'scheduled'
    setImmediate(() => {
      if (stopped()) return
      phase = 'retry'
      navigate()
    })
  }

  function navigate(): void {
    const attempt = phase
    void load().catch((error: NodeJS.ErrnoException) => {
      if (attempt === phase && error.code !== 'ERR_ABORTED') failed()
    })
  }

  const gone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
    if (details.reason !== 'clean-exit') failed()
  }
  win.webContents.on('render-process-gone', gone)
  const ready = () => {
    if (stopped() || phase === 'scheduled' || win.webContents.isCrashed()) return
    phase = 'done'
    win.off('ready-to-show', ready)
    win.webContents.off('render-process-gone', gone)
    win.show()
  }
  win.on('ready-to-show', ready)
  navigate()
}
