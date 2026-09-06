import { describe, expect, it } from 'vitest'
import { applyPerformanceProfile } from './performance-profile'

describe('低性能平台运行时画像', () => {
  it('把渲染方式写入页面根节点供 CSS 降级', () => {
    const root = { dataset: {} } as unknown as HTMLElement

    applyPerformanceProfile({ softwareRendering: true }, root)
    expect(root.dataset.rendering).toBe('software')

    applyPerformanceProfile({ softwareRendering: false }, root)
    expect(root.dataset.rendering).toBe('hardware')
  })
})
