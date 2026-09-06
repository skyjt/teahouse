import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensSource = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')
const imageViewerAppSource = readFileSync(new URL('../ImageViewerApp.vue', import.meta.url), 'utf8')
const imageViewerSource = readFileSync(new URL('../components/ImageViewer.vue', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')

describe('Win7 与 Linux 软渲染画像', () => {
  it('不携带对 Win7 无效的 TSF 输入法开关（决议 #254）', () => {
    // Chromium 108 在 Win7 上恒走 IMM32（工厂条件为「启用 TSFImeSupport 且系统 > Win7」），
    // 关闭 TSFImeSupport 对 Win7 是空操作——不许再以该开关名义修输入法问题。
    expect(mainSource).not.toContain('TSFImeSupport')
    expect(mainSource).toContain('isWindows7()')
  })

  it('主进程复用禁用硬件加速条件并通过 AppInfo 下发', () => {
    expect(mainSource).toContain('const SOFTWARE_RENDERING =')
    expect(mainSource).toContain('if (SOFTWARE_RENDERING)')
    expect(mainSource).toContain('softwareRendering: SOFTWARE_RENDERING')
  })

  it('软件渲染样式关闭浮层磨砂并缩短阴影', () => {
    expect(tokensSource).toContain("html[data-rendering='software']")
    expect(tokensSource).toContain('backdrop-filter: none')
    expect(tokensSource).toContain('--shadow-float: 0 4px 14px')
    expect(tokensSource).toContain('.viewer-menu')
  })

  it('图片查看窗口加载画像后再挂载，所有平台仅手动触发 OCR', () => {
    expect(imageViewerAppSource).toContain('runtimeReady')
    expect(imageViewerAppSource).toContain('applyPerformanceProfile(info)')
    expect(imageViewerSource).not.toContain('maybeStartAutoOcr')
    expect(imageViewerSource).toContain('void startOcr()')
    expect(imageViewerSource).toContain('cancelImageTextRecognition()')
  })
})
