import { describe, expect, it, vi } from 'vitest'
import type { OcrLine } from './ocr'
import { getImageTextLineBoxes, layoutImageTextLines } from './image-text-layer'

function line(text: string, lineIndex = 0): OcrLine {
  return {
    id: `line-${lineIndex}`,
    text,
    lineIndex,
    tokenIds: [],
    bbox: { x0: 20, y0: lineIndex * 20, x1: 220, y1: lineIndex * 20 + 16 }
  }
}

describe('图片原生文字层布局', () => {
  it('按阅读顺序保留原文，将 19px 原生选区双轴拟合到 16px 行框', () => {
    const measure = vi.fn(() => ({ width: 100, height: 19, offsetX: 0, offsetY: -1.5 }))
    const boxes = getImageTextLineBoxes([line('茶话间 OCR', 1), line('AB  CD', 0)], 400, 300)
    const result = layoutImageTextLines(boxes, measure)
    expect(result.map((item) => item.text)).toEqual(['AB  CD', '茶话间 OCR'])
    expect(result[0].style).toMatchObject({
      left: '20px', top: '0px', width: '100px', height: '19px', fontSize: '16px',
      lineHeight: '19px', transform: `scale(2, ${16 / 19})`
    })
    expect(measure).toHaveBeenCalledTimes(2)
    expect(result[1].style.top).toBe('20px')
  })

  it('补偿实际文字盒的左右和基线偏移，行高变化后仍贴合目标位置', () => {
    const boxes = getImageTextLineBoxes([line('茶话间 OCR', 5)], 400, 300)
    const result = layoutImageTextLines(boxes, () => ({ width: 125, height: 20, offsetX: 2, offsetY: -3 }))
    expect(result[0].style).toMatchObject({
      left: '16.8px', top: '100.8px', width: '125px', height: '20px',
      fontSize: '16px', lineHeight: '20px', transform: 'scale(1.6, 0.8)'
    })
    // 变换后的原生盒为 x=20、y=100、宽200、高16。
    expect(16.8 + 2 * 1.6).toBe(20)
    expect(100.8 + (-3 + (20 - 16) / 2) * 0.8).toBe(100)
    expect(125 * 1.6).toBe(200)
    expect(20 * 0.8).toBe(16)
  })

  it('拒绝无效坐标与超限数据，合法长行原样保留', () => {
    const valid = line('字'.repeat(2000))
    const invalid = [
      { ...line('无穷'), bbox: { x0: 0, y0: 0, x1: Infinity, y1: 16 } },
      { ...line('反向'), bbox: { x0: 20, y0: 0, x1: 10, y1: 16 } },
      { ...line('图外'), bbox: { x0: 500, y0: 0, x1: 600, y1: 16 } },
      line('字'.repeat(2001))
    ]
    const boxes = getImageTextLineBoxes([...invalid, valid], 400, 300)
    expect(layoutImageTextLines(boxes, () => ({ width: 200, height: 19, offsetX: 0, offsetY: -1.5 })).map((item) => item.text)).toEqual([valid.text])
    expect(getImageTextLineBoxes([valid], NaN, 300)).toEqual([])
    expect(getImageTextLineBoxes(Array.from({ length: 5001 }, () => valid), 400, 300)).toEqual([])
    expect(layoutImageTextLines(boxes, () => ({ width: 0, height: 19, offsetX: 0, offsetY: -1.5 }))).toEqual([])
    expect(layoutImageTextLines(boxes, () => ({ width: 200, height: 0, offsetX: 0, offsetY: -1.5 }))).toEqual([])
    expect(layoutImageTextLines(boxes, () => ({ width: 200, height: 19, offsetX: NaN, offsetY: -1.5 }))).toEqual([])
    expect(layoutImageTextLines(boxes, () => undefined)).toEqual([])
  })

  it('千行长文本只生成千个行布局，每行只读取一次测量结果', () => {
    const measure = vi.fn(() => ({ width: 800, height: 19, offsetX: 0, offsetY: -1.5 }))
    const lines = Array.from({ length: 1000 }, (_, index) => line('中文 English '.repeat(20), index))
    const result = layoutImageTextLines(getImageTextLineBoxes(lines, 400, 20000), measure)
    expect(result).toHaveLength(1000)
    expect(measure).toHaveBeenCalledTimes(1000)
    expect(result[999].text).toBe(lines[999].text)
  })
})
