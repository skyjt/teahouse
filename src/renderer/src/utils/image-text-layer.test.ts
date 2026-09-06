import { describe, expect, it, vi } from 'vitest'
import type { OcrLine } from './ocr'
import { layoutImageTextLines } from './image-text-layer'

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
  it('按阅读顺序保留原文和空格，用一次测宽将整行拟合原图检测框', () => {
    const measure = vi.fn(() => 100)
    const result = layoutImageTextLines([line('茶话间 OCR', 1), line('AB  CD', 0)], 400, 300, measure)
    expect(result.map((item) => item.text)).toEqual(['AB  CD', '茶话间 OCR'])
    expect(result[0].style).toMatchObject({
      left: '20px', top: '0px', height: '16px', fontSize: '16px', transform: 'scaleX(2)'
    })
    expect(measure.mock.calls).toEqual([['AB  CD', 16], ['茶话间 OCR', 16]])
  })

  it('拒绝无效坐标与超限数据，合法长行原样保留', () => {
    const valid = line('字'.repeat(2000))
    const invalid = [
      { ...line('无穷'), bbox: { x0: 0, y0: 0, x1: Infinity, y1: 16 } },
      { ...line('反向'), bbox: { x0: 20, y0: 0, x1: 10, y1: 16 } },
      { ...line('图外'), bbox: { x0: 500, y0: 0, x1: 600, y1: 16 } },
      line('字'.repeat(2001))
    ]
    expect(layoutImageTextLines([...invalid, valid], 400, 300, () => 200).map((item) => item.text)).toEqual([valid.text])
    expect(layoutImageTextLines([valid], NaN, 300, () => 200)).toEqual([])
    expect(layoutImageTextLines([valid], 400, 300, () => 0)).toEqual([])
    expect(layoutImageTextLines(Array.from({ length: 5001 }, () => valid), 400, 300, () => 200)).toEqual([])
  })

  it('千行长文本只生成千个行布局，每行只测宽一次', () => {
    const measure = vi.fn(() => 800)
    const lines = Array.from({ length: 1000 }, (_, index) => line('中文 English '.repeat(20), index))
    const result = layoutImageTextLines(lines, 400, 20000, measure)
    expect(result).toHaveLength(1000)
    expect(measure).toHaveBeenCalledTimes(1000)
    expect(result[999].text).toBe(lines[999].text)
  })
})
