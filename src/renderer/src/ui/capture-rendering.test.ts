import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../CaptureApp.vue', import.meta.url), 'utf8').replace(
  /\r\n?/g,
  '\n'
)
const iconSource = readFileSync(new URL('../components/PantryIcon.vue', import.meta.url), 'utf8')

describe('截图框选软渲染约束（决议 #221）', () => {
  it('桌面位图只保留一个 img 图层，选区使用四块纯色遮罩', () => {
    expect(source.match(/class="desktop"/g)).toHaveLength(1)
    expect(source).not.toContain('backgroundImage')
    expect(source).toContain('dim-top')
    expect(source).toContain('dim-right')
    expect(source).toContain('dim-bottom')
    expect(source).toContain('dim-left')
  })

  it('高频鼠标移动按动画帧合并，马赛克预览不做实时模糊', () => {
    expect(source).toContain('moveFrame = requestAnimationFrame')
    expect(source).not.toContain('backdrop-filter')
  })

  it('截图自然尺寸通过独立 X/Y 比例映射到输出像素', () => {
    expect(source).toContain('mapCaptureRectToImage')
    expect(source).toContain('crop.scaleX')
    expect(source).toContain('crop.scaleY')
  })

  it('文字标注使用截图层输入框并避开 Electron 不支持的 prompt', () => {
    expect(source).not.toContain('window.prompt')
    expect(source).toContain('class="text-editor"')
    expect(source).toContain('@keydown.stop="onTextEditorKeydown"')
    expect(source).toContain('@compositionstart="onTextCompositionStart"')
    expect(source).toContain('shouldCommitCaptureText')
    expect(source).toContain('box-sizing: border-box')
  })

  it('文字预览与最终图片统一使用左上基线和粗体', () => {
    expect(source).toContain("ctx.textBaseline = 'top'")
    expect(source).toContain('ctx.font = `700 ${Math.round(18 * scaleY)}px sans-serif`')
  })

  it('标注按钮使用本地图标，复制和发送显示文字及目标', () => {
    const icons = [
      'capture-select',
      'capture-rect',
      'capture-arrow',
      'text-select',
      'capture-mosaic',
      'x'
    ]
    for (const name of icons) expect(source).toContain(`<PantryIcon name="${name}"`)
    for (const label of ['重新框选', '矩形', '箭头', '文字', '马赛克', '复制', '取消']) {
      expect(source).toContain(`:data-tooltip="tr('${label}')"`)
      expect(source).toContain(`:aria-label="tr('${label}')"`)
    }
    expect(source).toContain(':aria-label="tr(\'发送给 {0}\', { 0: selectedName })"')
    expect(source).toContain("{{ tr('发送给 {0}', { 0: selectedName }) }}")
    expect(source).toContain("{{ tr('复制') }}")
    expect(source.match(/data-tooltip=/g)).toHaveLength(8)
    expect(source.match(/:aria-pressed=/g)).toHaveLength(5)
    expect(source).toContain('class="toolbar-divider"')
  })

  it('每个图标按钮在悬停或键盘聚焦时显示自定义提示', () => {
    expect(source).toContain('content: attr(data-tooltip)')
    expect(source).toContain('.btn:hover::after')
    expect(source).toContain('.btn:focus-visible::after')
    expect(source).toContain("'tooltip-below': toolbarTooltipBelow")
    expect(source).toContain('.bar.tooltip-below .btn::after')
  })

  it('截图专用图标归入 PantryIcon 线性 SVG 体系', () => {
    for (const name of ['capture-select', 'capture-rect', 'capture-arrow', 'capture-mosaic']) {
      expect(iconSource).toContain(`name === '${name}'`)
    }
  })
})

describe('截图窗主色统一走 token（决议 #281）', () => {
  it('样式里不再散落茶青字面量', () => {
    const style = source.slice(source.indexOf('<style'))
    expect(style).not.toContain('#3d8b6b')
    expect(style).not.toContain('#327b5e')
    // 描边、箭头、文字标注与主按钮统一引用 --primary
    expect(style).toContain('border: 2px solid var(--primary)')
    expect(style).toContain('border: 3px solid var(--primary)')
    expect(style).toContain('background: var(--primary)')
  })

  it('主按钮按下态沿用项目既有的 brightness 惯例', () => {
    expect(source).toMatch(/\.btn\.primary:hover\s*\{[^}]*filter: brightness\(/)
  })

  it('canvas 标注色从 --primary 读取并缓存，导出与预览同色', () => {
    expect(source).toContain("getPropertyValue('--primary')")
    expect(source).toContain('ctx.strokeStyle = accent()')
    expect(source).toContain('ctx.fillStyle = accent()')
    // 读不到时仍要有确定的颜色兜底
    expect(source).toContain("|| '#4e79af'")
  })
})
