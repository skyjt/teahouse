import { beforeAll, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const g = globalThis as typeof globalThis & {
    window: Window & typeof globalThis
    document: Document
  }
  g.window = dom.window as unknown as Window & typeof globalThis
  g.document = dom.window.document
})

describe('renderMarkdown', () => {
  it('渲染 GFM 标题、列表、代码与表格', async () => {
    const { renderMarkdown } = await import('./markdown-message')
    const html = renderMarkdown(
      ['## 标题', '', '- 一项', '', '`code`', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    )
    expect(html).toContain('<h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>')
  })

  it('渲染行内与块级 LaTeX', async () => {
    const { renderMarkdown } = await import('./markdown-message')
    const inline = renderMarkdown('能量 $E=mc^2$ 成立')
    expect(inline).toContain('katex')
    expect(inline).toContain('E')
    const block = renderMarkdown('$$\\frac{a}{b}$$')
    expect(block).toContain('katex-display')
  })

  it('清洗脚本注入并拒绝可点击的 javascript 链接', async () => {
    const { renderMarkdown } = await import('./markdown-message')
    const html = renderMarkdown('正常 <script>alert(1)</script> [x](javascript:alert(1))')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i)
    expect(html.toLowerCase()).not.toContain('onerror=')
  })

  it('图片语法不输出 img 标签', async () => {
    const { renderMarkdown } = await import('./markdown-message')
    const html = renderMarkdown('![图](http://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('http://example.com/a.png')
  })

  it('isSafeHttpUrl 只接受 http(s)', async () => {
    const { isSafeHttpUrl } = await import('./markdown-message')
    expect(isSafeHttpUrl('https://example.com')).toBe(true)
    expect(isSafeHttpUrl('http://10.0.0.1/x')).toBe(true)
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpUrl('file:///tmp/x')).toBe(false)
  })
})