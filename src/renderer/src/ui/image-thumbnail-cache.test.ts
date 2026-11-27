import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { thumbnailTargetSize } from '../directives/cached-image'

const directiveSource = readFileSync(
  new URL('../directives/cached-image.ts', import.meta.url),
  'utf8'
)
const imageBubbleSource = readFileSync(new URL('../components/ImageBubble.vue', import.meta.url), 'utf8')
const historySearchSource = readFileSync(new URL('../components/HistorySearch.vue', import.meta.url), 'utf8')
const imageViewerAppSource = readFileSync(new URL('../ImageViewerApp.vue', import.meta.url), 'utf8')
const rendererHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')

describe('聊天图片近视口缩略图', () => {
  it('按最长边 320px 等比计算解码尺寸且不放大小图', () => {
    expect(thumbnailTargetSize(4000, 3000)).toEqual({ width: 320, height: 240 })
    expect(thumbnailTargetSize(200, 100)).toEqual({ width: 200, height: 100 })
  })

  it('共享一个近视口观察器并直接缩小解码为 WebP', () => {
    expect(directiveSource.match(/new IntersectionObserver/g)).toHaveLength(1)
    expect(directiveSource).toContain("rootMargin: '480px 0px'")
    expect(directiveSource).toContain('resizeWidth: target.width')
    expect(directiveSource).toContain('resizeHeight: target.height')
    expect(directiveSource).toContain("canvas.toBlob(resolve, 'image/webp', 0.82)")
    expect(directiveSource).toContain('window.pantry.hasImageThumbnail(transferId)')
    expect(directiveSource).toContain('window.pantry.cacheImageThumbnail(transferId, thumbnail)')
  })

  it('聊天流与记录搜索使用缩略图，大图查看器固定读取原图', () => {
    expect(imageBubbleSource).toContain('v-cached-image="{ transferId, cache: !isSticker }"')
    expect(historySearchSource).toContain(
      'v-cached-image="{ transferId: imageId(hit) }"'
    )
    expect(imageViewerAppSource).toContain('`pantry-img://${transferId.value}`')
    expect(imageViewerAppSource).not.toContain('pantry-thumb:')
    expect(rendererHtml).toContain('pantry-thumb:')
  })

  it('主进程对发送分类和两个图片协议复用内联像素门禁', () => {
    expect(mainSource).toContain("imagePreview.isInlineNamedBytes(name, bytes) ? 'image' : 'file'")
    expect(mainSource).toContain("(await imagePreview.inspectInlinePath(staged)) ? 'image' : 'file'")
    expect(mainSource).toContain("protocol.registerFileProtocol('pantry-img'")
    expect(mainSource).toContain("protocol.registerFileProtocol('pantry-thumb'")
    expect(mainSource.match(/managedInlineImageView\(transferId\)/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
  })
})
