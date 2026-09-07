// 隔离挂载真实组件，验证 Electron 22 的原生选区、剪贴板和编辑事务；不启动应用网络。
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repo = path.resolve(__dirname, '..')

async function buildFixture(directory) {
  const { build } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const source = path.join(repo, 'src/renderer/src')
  const entry = path.join(directory, 'fixture.js')
  writeFileSync(entry, `
import { createApp, h, ref, nextTick } from 'vue'
import CompatEmoji from ${JSON.stringify(path.join(source, 'components/CompatEmoji.vue'))}
import Win7ChatEditor from ${JSON.stringify(path.join(source, 'components/Win7ChatEditor.vue'))}
import { splitEmojiText } from ${JSON.stringify(path.join(source, 'utils/compat-emoji.ts'))}
import { copyEmojiSelection } from ${JSON.stringify(path.join(source, 'utils/clipboard.ts'))}
import { installLinuxNumpad } from ${JSON.stringify(path.join(source, 'utils/linux-numpad.ts'))}
const samples = ['😀', '甲😀乙', '甲😀😄❤️乙', '甲😀乙\\n丙❤️丁', '😀'.repeat(10)]
const draft = ref('')
const editor = ref(null)
createApp({ setup: () => () => h('main', [
  ...samples.map((text, index) => h('div', { id: 'sample' + index, class: 'sample' },
    splitEmojiText(text).map(part => part.emoji ? h(CompatEmoji, { emoji: part.text }) : part.text))),
  h('textarea', { id: 'plain' }),
  h('input', { id: 'field', type: 'text' }),
  h(Win7ChatEditor, { ref: editor, modelValue: draft.value, disabled: false, placeholder: '',
    'onUpdate:modelValue': value => { draft.value = value } })
]) }).mount('#app')
document.addEventListener('copy', copyEmojiSelection)
installLinuxNumpad()
window.inputTest = {
  samples,
  select(index, emojiIndex) {
    document.activeElement?.blur()
    const element = document.getElementById('sample' + index)
    const range = document.createRange()
    range.selectNodeContents(emojiIndex === undefined ? element :
      element.querySelectorAll('.compat-emoji-text')[emojiIndex].firstChild)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  },
  async setEditor(value, start = value.length, end = start) {
    draft.value = value
    await nextTick()
    editor.value.focus()
    editor.value.setSelectionRange(start, end)
  },
  async editorValue() { await nextTick(); return draft.value },
  numpad() {
    const plain = document.getElementById('plain')
    const field = document.getElementById('field')
    const results = []
    const eq = (actual, expected, label) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(label + ': ' + JSON.stringify(actual) + ' != ' + JSON.stringify(expected))
      }
      results.push(label)
    }
    let inputs = 0
    plain.addEventListener('input', () => { inputs++ })
    const press = (target, key, code, options = {}) => {
      const event = new KeyboardEvent('keydown', {
        key, code, bubbles: true, cancelable: true, modifierNumLock: true, ...options
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    plain.focus()
    plain.value = ''
    for (const [digit, key] of [['2', 'ArrowDown'], ['4', 'ArrowLeft'], ['6', 'ArrowRight'], ['8', 'ArrowUp']]) {
      eq(press(plain, key, 'Numpad' + digit), true, '接管异常小键盘' + digit)
    }
    eq(plain.value, '2468', '恢复四个方向数字')
    eq(inputs, 4, '每个数字仅触发一次 input')
    plain.value = ''
    for (const digit of '0123456789') press(plain, digit, 'Numpad' + digit)
    eq(plain.value, '0123456789', '正常小键盘十个数字')
    plain.value = 'AB'
    plain.setSelectionRange(1, 2)
    press(plain, 'ArrowDown', 'Numpad2')
    eq(plain.value, 'A2', '替换选区')
    document.execCommand('undo')
    eq(plain.value, 'AB', '原生撤销恢复选区内容')
    plain.maxLength = 2
    plain.setSelectionRange(2, 2)
    eq(press(plain, 'ArrowLeft', 'Numpad4'), true, 'maxlength 满时仍阻止方向键默认行为')
    eq(plain.value, 'AB', '遵守 maxlength')
    plain.removeAttribute('maxlength')
    for (const options of [{ modifierNumLock: false }, { shiftKey: true }, { ctrlKey: true },
      { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      eq(press(plain, 'ArrowDown', 'Numpad2', options), false, '保留修饰键/输入法 ' + JSON.stringify(options))
    }
    eq(press(plain, 'ArrowDown', 'ArrowDown'), false, '保留独立方向键')
    plain.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    eq(press(plain, 'ArrowDown', 'Numpad2'), false, '保留候选输入过程')
    plain.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    for (const property of ['readOnly', 'disabled']) {
      plain[property] = true
      eq(press(plain, 'ArrowDown', 'Numpad2'), false, '保留 ' + property)
      plain[property] = false
    }
    field.focus()
    eq(press(plain, 'ArrowDown', 'Numpad2'), false, '忽略非焦点控件')
    for (const type of ['text', 'search', 'tel', 'url', 'email', 'password', 'number']) {
      field.type = type
      field.value = ''
      field.focus()
      press(field, 'ArrowDown', 'Numpad2')
      eq(field.value, '2', '原生输入框 ' + type)
    }
    field.type = 'checkbox'
    field.focus()
    eq(press(field, 'ArrowDown', 'Numpad2'), false, '保留非文本控件')
    return results.length
  }
}
`)
  await build({
    configFile: false, root: repo, logLevel: 'error', plugins: [vue()],
    define: { 'process.env.NODE_ENV': '"production"' },
    resolve: { alias: { vue: path.join(repo, 'node_modules/vue/dist/vue.runtime.esm-bundler.js') } },
    build: {
      target: 'chrome108', outDir: path.join(directory, 'dist'), emptyOutDir: true,
      lib: { entry, name: 'InputSelftest', formats: ['iife'], fileName: () => 'fixture.js' }
    }
  })
  writeFileSync(path.join(directory, 'dist/index.html'), `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
<link rel="stylesheet" href="./style.css"><style>
body{font:14px/1.5 sans-serif;user-select:none}.sample{width:140px;white-space:pre-wrap;user-select:text}
.win7-chat-editor{height:80px!important}textarea{display:block;height:60px}
</style><div id="app"></div><script src="./fixture.js"></script>`)
}

async function runElectron(directory) {
  const { app, BrowserWindow, clipboard } = require('electron')
  app.setPath('userData', path.join(directory, 'profile'))
  app.commandLine.appendSwitch('no-proxy-server')
  await app.whenReady()
  // Electron 只能一次恢复标准格式；平台私有格式无法通过 writeBuffer 无损合并恢复。
  const formats = clipboard.availableFormats()
  const saved = {}
  if (formats.includes('text/plain')) saved.text = clipboard.readText()
  if (formats.includes('text/html')) saved.html = clipboard.readHTML()
  if (formats.includes('text/rtf')) saved.rtf = clipboard.readRTF()
  const savedImage = clipboard.readImage()
  if (!savedImage.isEmpty()) saved.image = savedImage
  const bookmark = clipboard.readBookmark()
  if (bookmark.url) { saved.bookmark = bookmark.title; saved.text = bookmark.url }
  const window = new BrowserWindow({
    show: false, width: 600, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error(message)
  })
  const evaluate = code => window.webContents.executeJavaScript(code, true)
    .catch(error => { throw new Error(`${code}: ${error.message}`) })
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  const copy = async () => { window.webContents.focus(); window.webContents.copy(); await settle() }
  const paste = async () => { window.webContents.focus(); window.webContents.paste(); await settle() }
  const plainClipboard = expected => {
    assert.equal(clipboard.readText(), expected, '剪贴板保留完整 Unicode')
    // macOS 的原生剪贴板可能把纯文本直接作为 readHTML 的返回值。
    assert.ok(['', expected].includes(clipboard.readHTML()), '剪贴板不残留透明文字或本地 SVG')
  }
  try {
    assert.equal(process.versions.electron, '22.3.27', '保持目标运行时基线')
    await window.loadFile(path.join(directory, 'dist/index.html'))
    const samples = await evaluate('inputTest.samples')
    for (const [index, expected] of samples.entries()) {
      assert.equal(await evaluate(`inputTest.select(${index})`), expected, '原生选区保留完整 emoji')
      await copy()
      plainClipboard(expected)
    }
    assert.equal(await evaluate('inputTest.select(2, 1)'), '😄', '仅选连续表情中间一个')
    await copy()
    plainClipboard('😄')

    const text = '甲😀😄❤️乙\n下一行'
    await evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)})`)
    assert.equal(clipboard.readText(), text, '右键复制使用的原生 writeText 保留 Unicode')
    await evaluate("document.getElementById('plain').focus(); document.getElementById('plain').value = ''")
    await paste()
    assert.equal(await evaluate("document.getElementById('plain').value"), text, '原生 textarea 粘贴完整文字')
    await evaluate("inputTest.setEditor('')")
    await paste()
    assert.equal(await evaluate('inputTest.editorValue()'), text, 'Win7 编辑器粘贴完整文字')
    await evaluate(`inputTest.setEditor(${JSON.stringify(text)}, 3, 7)`)
    await copy()
    plainClipboard('😄❤️')
    window.webContents.cut()
    await settle()
    assert.equal(clipboard.readText(), '😄❤️', 'Win7 编辑器剪切保留 Unicode')
    assert.equal(await evaluate('inputTest.editorValue()'), '甲😀乙\n下一行', '剪切只删除选区')
    window.webContents.undo()
    await settle()
    assert.equal(await evaluate('inputTest.editorValue()'), text, '原生撤销恢复剪切的表情')
    await evaluate(`inputTest.setEditor(${JSON.stringify(text)}, 0, ${text.length})`)
    window.webContents.cut()
    await settle()
    plainClipboard(text)
    assert.equal(await evaluate('inputTest.editorValue()'), '', '全选剪切清空草稿')
    window.webContents.undo()
    await settle()
    assert.equal(await evaluate('inputTest.editorValue()'), text, '全选剪切仍可原生撤销')
    await evaluate("inputTest.select(0); const plain = document.getElementById('plain'); plain.value = '独立选区'; plain.focus(); plain.setSelectionRange(0, 2)")
    await copy()
    assert.equal(clipboard.readText(), '独立', '页面表情旧选区不覆盖 textarea 的复制')
    const numpadChecks = await evaluate('inputTest.numpad()')
    console.log(`输入自测通过：Electron ${process.versions.electron}，emoji 原生复制/粘贴/剪切/撤销，${numpadChecks} 项小键盘检查。`)
  } finally {
    if (Object.keys(saved).length > 0) clipboard.write(saved)
    else clipboard.clear()
    window.destroy()
    app.quit()
  }
}

async function main() {
  if (process.versions.electron) return runElectron(process.argv[2])
  const directory = mkdtempSync(path.join(tmpdir(), 'pantry-input-selftest-'))
  try {
    await buildFixture(directory)
    const result = spawnSync(require('electron'), [__filename, directory], { stdio: 'inherit' })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'Electron 输入自测失败')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
