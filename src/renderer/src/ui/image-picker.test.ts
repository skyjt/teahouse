import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPaneSource = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
const emojiPanelSource = readFileSync(new URL('../components/EmojiPanel.vue', import.meta.url), 'utf8')
const stickerStoreSource = readFileSync(new URL('../stores/stickers.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../../preload/index.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')

function sourceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from, `缺少起始标记 ${start}`).toBeGreaterThanOrEqual(0)
  expect(to, `缺少结束标记 ${end}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('发送图片按钮选择范围', () => {
  it('渲染层调用专用图片选择器且不转入普通文件发送', () => {
    const sendImage = sourceBetween(
      chatPaneSource,
      'async function sendImage()',
      'interface ClipboardImagePayload'
    )
    expect(sendImage).toContain('window.pantry.pickImages()')
    expect(sendImage).toContain('chatStore.sendImagePath(path)')
    expect(sendImage).not.toContain('pickFiles(')
    expect(sendImage).not.toContain('sendFilePaths(')
  })

  it('preload 与主进程接入 img:pick、图片过滤器和二次白名单', () => {
    expect(preloadSource).toContain('ipcRenderer.invoke(IpcChannels.imgPick)')
    const picker = sourceBetween(mainSource, 'IpcChannels.imgPick', 'IpcChannels.fileGrantPaths')
    expect(picker).toContain("'选择要发送的图片'")
    expect(picker).toContain("'选择要导入的表情'")
    expect(picker).toContain("properties: ['openFile', 'multiSelections']")
    expect(picker).toContain('extensions: IMAGE_PICKER_EXTENSIONS')
    expect(picker).toContain('filterImagePickerPaths(result.filePaths)')
    expect(picker).toContain("purpose === 'sticker' ? stickerImportPathGrants : rendererPathGrants")
    expect(picker).toContain('grants.grant(event.sender.id, paths)')
  })

  it('表情导入复用图片选择器，并用独立的一次性授权读取源图', () => {
    expect(emojiPanelSource).toContain('aria-label="stickers.importing ?')
    expect(emojiPanelSource).toContain('@click="importStickers"')
    expect(stickerStoreSource).toContain('window.pantry.pickStickerImages()')
    expect(stickerStoreSource).toContain('window.pantry.fetchStickerImportSource(path)')
    expect(preloadSource).toContain("ipcRenderer.invoke(IpcChannels.imgPick, 'sticker')")
    expect(preloadSource).toContain('ipcRenderer.invoke(IpcChannels.stickerImportSource, path)')

    const picker = sourceBetween(mainSource, 'IpcChannels.imgPick', 'IpcChannels.fileGrantPaths')
    expect(picker).toContain("purpose === 'sticker' ? stickerImportPathGrants")
    const source = sourceBetween(
      mainSource,
      'IpcChannels.stickerImportSource',
      'IpcChannels.imgThumbnailHas'
    )
    expect(source).toContain('filterImagePickerPaths([pathValue])')
    expect(source).toContain('stickerImportPathGrants.consume(event.sender.id, [path])')
    expect(source).toContain('return readStickerSource(path)')
  })
})
