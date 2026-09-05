import { describe, expect, it } from 'vitest'
import { clampMenuPosition } from './menu-position'

describe('会话菜单视口避让', () => {
  it.each([1, 1.1, 1.25])('页面缩放 %s 时四角均完整可见', (zoom) => {
    const viewportWidth = 960 / zoom
    const viewportHeight = 640 / zoom
    for (const x of [0, viewportWidth]) {
      for (const y of [0, viewportHeight]) {
        const position = clampMenuPosition(x, y, 126.5, 109.5, viewportWidth, viewportHeight)
        expect(position.x).toBeGreaterThanOrEqual(8)
        expect(position.y).toBeGreaterThanOrEqual(8)
        expect(position.x + 126.5).toBeLessThanOrEqual(viewportWidth - 8)
        expect(position.y + 109.5).toBeLessThanOrEqual(viewportHeight - 8)
      }
    }
  })

  it('保留中央指针位置，窗口缩小后重新避让', () => {
    const initial = clampMenuPosition(700, 500, 140, 110, 1200, 800)
    expect(initial).toEqual({ x: 700, y: 500 })
    const resized = clampMenuPosition(initial.x, initial.y, 140, 110, 768, 512)
    expect(resized).toEqual({ x: 620, y: 394 })
  })
})
