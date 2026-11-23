import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { showMainWindowOnLoad } from './main-window-startup'

function windowFixture() {
  const webContents = Object.assign(new EventEmitter(), { isCrashed: () => false })
  return Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false, show: vi.fn() })
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

it('首次绘制前的渲染器退出只重试一次，成功后正常显示', async () => {
  const win = windowFixture()
  const load = vi.fn().mockResolvedValue(undefined)
  const failed = vi.fn()
  showMainWindowOnLoad(win as unknown as BrowserWindow, load, () => false, failed)
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  win.emit('ready-to-show')
  expect(win.show).not.toHaveBeenCalled()
  await nextTurn()
  win.emit('ready-to-show')
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(load).toHaveBeenCalledTimes(2)
  expect(win.show).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
})

it('两次加载失败后报告一次启动错误并停止重试', async () => {
  const win = windowFixture()
  const load = vi.fn().mockRejectedValue(new Error('load failed'))
  const failed = vi.fn()
  showMainWindowOnLoad(win as unknown as BrowserWindow, load, () => false, failed)
  await nextTurn()
  await nextTurn()
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(load).toHaveBeenCalledTimes(2)
  expect(failed).toHaveBeenCalledOnce()
  expect(win.show).not.toHaveBeenCalled()
})
