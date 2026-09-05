import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../shared/ipc'
import { useGlobalSearch } from './global-search'

function deferred() {
  let resolve!: (value: SearchResult) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<SearchResult>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('全局搜索请求生命周期', () => {
  let scope = effectScope()
  const search = vi.fn()
  const empty: SearchResult = { peers: [], messageGroups: [], files: [] }

  beforeEach(() => {
    vi.useFakeTimers()
    search.mockReset()
    vi.stubGlobal('window', { pantry: { search } })
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('连续输入保留 200ms 防抖，卸载取消尚未启动的搜索', async () => {
    const query = ref('旧')
    scope.run(() => useGlobalSearch(() => query.value))!
    await vi.advanceTimersByTimeAsync(199)
    query.value = '新'
    await vi.advanceTimersByTimeAsync(199)
    expect(search).not.toHaveBeenCalled()
    scope.stop()
    await vi.runAllTimersAsync()
    expect(search).not.toHaveBeenCalled()
  })

  it('旧请求在新关键词防抖期间返回也不能提交，只有最新结果生效', async () => {
    const older = deferred()
    const newer = deferred()
    search.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const query = ref('旧')
    const state = scope.run(() => useGlobalSearch(() => query.value))!
    const initial = state.result.value
    await vi.advanceTimersByTimeAsync(200)
    query.value = '新'
    older.resolve(empty)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.searching.value).toBe(true)
    expect(state.result.value).toBe(initial)
    await vi.advanceTimersByTimeAsync(200)
    newer.resolve(empty)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.searching.value).toBe(false)
    expect(state.result.value).not.toBe(initial)
    expect(search.mock.calls).toEqual([['旧'], ['新']])
  })

  it.each(['成功', '失败'])('旧请求晚%s不覆盖新结果或状态', async (outcome) => {
    const older = deferred()
    search.mockReturnValueOnce(older.promise).mockResolvedValueOnce(empty)
    const query = ref('旧')
    const state = scope.run(() => useGlobalSearch(() => query.value))!
    await vi.advanceTimersByTimeAsync(200)
    query.value = '新'
    await vi.advanceTimersByTimeAsync(200)
    const latest = state.result.value
    if (outcome === '成功') older.resolve({ ...empty, files: [] })
    else older.reject(new Error('旧请求失败'))
    await vi.advanceTimersByTimeAsync(0)
    expect(state.result.value).toBe(latest)
    expect(state.searching.value).toBe(false)
    expect(state.failed.value).toBe(false)
  })

  it('失败结束等待，重新输入可再次成功', async () => {
    search.mockRejectedValueOnce(new Error('查询失败')).mockResolvedValueOnce(empty)
    const query = ref('旧')
    const state = scope.run(() => useGlobalSearch(() => query.value))!
    await vi.advanceTimersByTimeAsync(200)
    expect(state.failed.value).toBe(true)
    expect(state.searching.value).toBe(false)
    query.value = '新'
    expect(state.failed.value).toBe(false)
    expect(state.searching.value).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(state.failed.value).toBe(false)
    expect(state.searching.value).toBe(false)
  })

  it('卸载使正在进行的请求失效', async () => {
    const request = deferred()
    search.mockReturnValue(request.promise)
    const state = scope.run(() => useGlobalSearch(() => '关键词'))!
    await vi.advanceTimersByTimeAsync(200)
    const previous = state.result.value
    scope.stop()
    request.resolve(empty)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.result.value).toBe(previous)
  })
})
