import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { IpcChannels } from '../../shared/ipc'
import { showMainWindowOnLoad } from './main-window-startup'

function windowFixture() {
  let destroyed = false
  const webContents = Object.assign(new EventEmitter(), { isCrashed: () => false, mainFrame: {} })
  const win = Object.assign(new EventEmitter(), {
    webContents, isDestroyed: () => destroyed, show: vi.fn(),
    destroy: vi.fn(() => { destroyed = true; win.emit('closed') })
  })
  return win
}

function start(load = vi.fn().mockResolvedValue(undefined)) {
  vi.useFakeTimers()
  const windows = [windowFixture(), windowFixture()]
  let next = 0
  const startup = {
    create: vi.fn(() => windows[next++]! as unknown as BrowserWindow),
    load, isQuitting: vi.fn(() => false), onFailure: vi.fn(), onShown: vi.fn(), checkpoint: vi.fn()
  }
  showMainWindowOnLoad(startup)
  return { first: windows[0]!, second: windows[1]!, ...startup }
}
afterEach(() => vi.useRealTimers())

it('首次绘制前的崩溃换一个新窗口，忽略旧窗口随后到达的事件', async () => {
  const { first, second, load, onFailure, onShown } = start()
  first.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  first.emit('ready-to-show')
  await vi.advanceTimersByTimeAsync(0)
  expect(first.destroy).toHaveBeenCalledOnce()
  second.emit('ready-to-show')
  first.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(load).toHaveBeenCalledTimes(2)
  expect(first.show).not.toHaveBeenCalled()
  expect(second.show).toHaveBeenCalledOnce()
  expect(onShown).toHaveBeenCalledOnce()
  expect(onFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('首帧通知丢失时仅接受主窗口主框架的挂载通知，后来事件不会重新弹窗', () => {
  const { first, onShown } = start()
  const mounted = () => first.webContents.emit('ipc-message', { senderFrame: first.webContents.mainFrame }, IpcChannels.uiMainReady)
  first.webContents.emit('dom-ready')
  first.webContents.emit('ipc-message', { senderFrame: {} }, IpcChannels.uiMainReady)
  expect(first.show).not.toHaveBeenCalled()
  mounted()
  mounted()
  first.emit('ready-to-show')
  expect(first.show).toHaveBeenCalledOnce()
  expect(onShown).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('静默挂起超过时限后换窗，旧导航迟到的失败不会覆盖恢复结果', async () => {
  let rejectFirst!: (reason: Error) => void
  const load = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFirst = reject })).mockResolvedValue(undefined)
  const { first, second, onFailure, checkpoint } = start(load)
  await vi.advanceTimersByTimeAsync(15_001)
  expect(first.destroy).toHaveBeenCalledOnce()
  rejectFirst(new Error('old navigation'))
  await Promise.resolve()
  second.emit('ready-to-show')
  expect(second.show).toHaveBeenCalledOnce()
  expect(onFailure).not.toHaveBeenCalled()
  expect(checkpoint).toHaveBeenCalledWith('window-load', 'timeout', 1, undefined)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['timeout', 'rejection'])('连续两次 %s 只报告一次错误并移除监听', async mode => {
  const load = mode === 'timeout' ? vi.fn(() => new Promise<void>(() => {})) : vi.fn().mockRejectedValue(new Error('load'))
  const { second, onShown, onFailure } = start(load)
  await vi.runAllTimersAsync()
  second.emit('ready-to-show')
  second.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(load).toHaveBeenCalledTimes(2)
  expect(onFailure).toHaveBeenCalledOnce()
  expect(onShown).not.toHaveBeenCalled()
  expect(second.webContents.listenerCount('ipc-message')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['close', 'quit'])('%s 发生在重试前时不会重新打开窗口', async mode => {
  const { first, create, isQuitting, onFailure } = start()
  first.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  if (mode === 'close') first.destroy()
  else isQuitting.mockReturnValue(true)
  await vi.runAllTimersAsync()
  expect(create).toHaveBeenCalledOnce()
  expect(onFailure).not.toHaveBeenCalled()
})
