import { describe, expect, it } from 'vitest'
import type { ImageOcrResult } from '../../shared/ipc'
import { ImageOcrResultCache, normalizeImageOcrResult } from './image-ocr-cache'

function result(text = '茶话间'): ImageOcrResult {
  return {
    text,
    scale: 1,
    tokens: [
      {
        id: 'ocr-0',
        text: '茶',
        confidence: 92,
        bbox: { x0: 10, y0: 20, x1: 18, y1: 32 },
        lineIndex: 0,
        wordIndex: 0,
        tokenIndex: 0
      }
    ],
    lines: [
      {
        id: 'line-0',
        text,
        bbox: { x0: 10, y0: 20, x1: 18, y1: 32 },
        tokenIds: ['ocr-0'],
        lineIndex: 0
      }
    ]
  }
}

describe('ImageOcrResultCache', () => {
  it('按 transferId + cacheKey 保存和读取 OCR 结果副本', () => {
    const cache = new ImageOcrResultCache()
    const stored = result()

    expect(cache.set('t1', 't1:640x480', stored)).toBe(true)
    const cached = cache.get('t1', 't1:640x480')

    expect(cached).toEqual(stored)
    expect(cached).not.toBe(stored)
    cached!.tokens[0].text = '改'
    expect(cache.get('t1', 't1:640x480')!.tokens[0].text).toBe('茶')
  })

  it('超过容量时淘汰最旧结果', () => {
    const cache = new ImageOcrResultCache(1)

    expect(cache.set('t1', 'a', result('a'))).toBe(true)
    expect(cache.set('t2', 'b', result('b'))).toBe(true)

    expect(cache.get('t1', 'a')).toBeNull()
    expect(cache.get('t2', 'b')!.text).toBe('b')
  })

  it('拒绝不完整或过大的 OCR 结果', () => {
    expect(normalizeImageOcrResult({ text: 'x', scale: 1, tokens: [], lines: [] })).toEqual({
      text: 'x',
      scale: 1,
      tokens: [],
      lines: []
    })
    expect(normalizeImageOcrResult({ text: 'x', scale: Number.NaN, tokens: [], lines: [] })).toBeNull()
    expect(normalizeImageOcrResult({ text: 'x', scale: 1, tokens: new Array(20_001), lines: [] })).toBeNull()
  })

  it('缓存整行 token 允许超过 64 字，仍拒绝超过 2000 字的输入', () => {
    const cache = new ImageOcrResultCache()
    const stored = result('字'.repeat(2_000))
    stored.tokens[0].text = stored.text
    expect(cache.set('long', 'long:2200x1000', stored)).toBe(true)
    expect(cache.get('long', 'long:2200x1000')).toEqual(stored)
    stored.tokens[0].text += '字'
    expect(cache.set('oversized', 'oversized:2200x1000', stored)).toBe(false)
  })
})
