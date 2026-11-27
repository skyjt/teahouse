import type { CaptureInit } from '../shared/ipc'

type CaptureInitListener = (init: CaptureInit) => void

/**
 * 截图初始化是 main → renderer 的单次事件。动态入口可能晚于事件到达，
 * 因此由 preload 先接住并在 CaptureApp 订阅时回放最近一次数据。
 */
export function createCaptureInitReplay(): {
  publish: CaptureInitListener
  subscribe: (listener: CaptureInitListener) => () => void
} {
  let latest: CaptureInit | null = null
  const listeners = new Set<CaptureInitListener>()

  return {
    publish(init): void {
      latest = init
      for (const listener of listeners) listener(init)
    },
    subscribe(listener): () => void {
      listeners.add(listener)
      if (latest) listener(latest)
      return () => listeners.delete(listener)
    }
  }
}
