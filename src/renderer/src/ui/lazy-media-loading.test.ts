import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const imageBubbleSource = readFileSync(new URL('../components/ImageBubble.vue', import.meta.url), 'utf8')
const historySearchSource = readFileSync(new URL('../components/HistorySearch.vue', import.meta.url), 'utf8')
const emojiPanelSource = readFileSync(new URL('../components/EmojiPanel.vue', import.meta.url), 'utf8')
const imageViewerSource = readFileSync(new URL('../components/ImageViewer.vue', import.meta.url), 'utf8')
const captureSource = readFileSync(new URL('../CaptureApp.vue', import.meta.url), 'utf8')

function imageTagContaining(source: string, marker: string): string {
  const tags = source.match(/<img\b[\s\S]*?\/>/g) ?? []
  const tag = tags.find((item) => item.includes(marker))
  expect(tag, `缺少图片标签 ${marker}`).toBeDefined()
  return tag ?? ''
}

describe('滚动媒体惰性加载', () => {
  it.each([
    ['聊天图片与表情消息', imageBubbleSource, 'class="thumb"'],
    ['聊天记录搜索缩略图', historySearchSource, 'imageId(hit)'],
    ['表情包网格', emojiPanelSource, 'pantry-sticker://']
  ])('%s 使用惰性加载与异步解码', (_label, source, marker) => {
    const tag = imageTagContaining(source, marker)
    expect(tag).toContain('loading="lazy"')
    expect(tag).toContain('decoding="async"')
  })

  it('即时显示的看图原图与截图桌面图保持立即加载', () => {
    expect(imageViewerSource).not.toContain('loading="lazy"')
    expect(captureSource).not.toContain('loading="lazy"')
  })
})
