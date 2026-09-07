import { TABLE_TEXT_LIMIT_BYTES } from '../../../shared/protocol'
import type { TableTextMeta } from '../../../shared/ipc'

export interface ClipboardTextSource {
  getData(type: string): string
}

export type ClipboardTableText = TableTextMeta

export function hasClipboardText(data: ClipboardTextSource): boolean {
  return data.getData('text/plain').length > 0
}

/** 表情的透明文字只复制为 Unicode，避免富文本接收方粘贴出透明字或本地 SVG。 */
export function copyEmojiSelection(event: ClipboardEvent): void {
  if (event.defaultPrevented || !event.clipboardData) return
  // input / textarea 的选区独立于 window.getSelection，不能拿页面旧选区覆盖它。
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  const ancestor = range.commonAncestorContainer
  const element = ancestor instanceof Element ? ancestor : ancestor.parentElement
  if (!element?.closest('.compat-emoji') && !range.cloneContents().querySelector('.compat-emoji')) return
  event.clipboardData.setData('text/plain', selection.toString())
  event.preventDefault()
}

/**
 * 只把「整段剪贴板确实就是一张表」判为表格粘贴（决议 #270）。
 * 旧口径是「HTML 任意位置有 <table>」或「纯文本含任意一个 \t 且至少两行」，
 * 前者会把「正文 + 表格」的网页片段整块吃掉（且只取第一张表，图片与文字视图对不上），
 * 后者会把随手打的制表符、Tab 缩进的代码和日志全判成表格（Issue #19）。
 */
export function readClipboardTableText(data: ClipboardTextSource): ClipboardTableText | null {
  const plain = normalizeClipboardText(data.getData('text/plain'))
  const htmlText = readHtmlTableText(data.getData('text/html'))
  const text = htmlText ?? plain
  if (!text) return null
  if (htmlText === null && !isTsvTableText(text)) return null
  const truncated = truncateUtf8(text, TABLE_TEXT_LIMIT_BYTES)
  return {
    tableText: truncated.text,
    tableTextTruncated: truncated.truncated
  }
}

export const NATIVE_IMAGE_FALLBACK_SUPPRESS_MS = 300

export function shouldSuppressNativeImageFallback(
  lastPasteHandledAt: number,
  now = Date.now()
): boolean {
  return (
    lastPasteHandledAt > 0 &&
    now >= lastPasteHandledAt &&
    now - lastPasteHandledAt < NATIVE_IMAGE_FALLBACK_SUPPRESS_MS
  )
}

/**
 * 是否应调度主进程 Ctrl+V 触发的原生剪贴板图片兜底（决议 #207）。
 * 任一 input/textarea 有焦点时 paste 事件会走 onPaste（含其尾部显式兜底），
 * 再调度 IPC 兜底只会与 onPaste 竞态双发；仅「焦点不在可编辑输入」时需要 IPC。
 * 用 tagName 判断以便 vitest（无 DOM 原型）与浏览器行为一致。
 */
export function shouldScheduleIpcClipboardImageFallback(
  active: { tagName?: string } | null
): boolean {
  if (!active || typeof active.tagName !== 'string') return true
  const tag = active.tagName.toUpperCase()
  return tag !== 'INPUT' && tag !== 'TEXTAREA'
}

export function imageMimeFromExt(ext: string): string {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/png'
}

export function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * 纯文本侧口径：表格软件复制矩形区域时每行列数必然一致，
 * 而随手输入的制表符几乎不可能对齐，Tab 缩进的代码首列必然全空。
 */
function isTsvTableText(text: string): boolean {
  if (!text.includes('\t')) return false
  const rows = text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
  if (rows.length < 2) return false
  const colCount = rows[0].length
  if (colCount < 2) return false
  if (rows.some((row) => row.length !== colCount)) return false
  return rows.some((row) => row[0].trim().length > 0)
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= maxBytes) return { text, truncated: false }
  let out = ''
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).byteLength
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return { text: out, truncated: true }
}

/**
 * HTML 侧口径：片段里有且仅有一张 table、且表格之外没有实质文字时才算表格粘贴。
 * 返回 null 表示「不是纯表格片段」，调用方退回纯文本口径（DOMParser 不可用时同样退回）。
 */
function readHtmlTableText(html: string): string | null {
  if (!/<table[\s>]/i.test(html)) return null
  if (typeof DOMParser === 'undefined') return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const tables = Array.from(doc.querySelectorAll('table'))
  if (tables.length !== 1) return null
  const table = tables[0]
  const outsideLength =
    squeezeWhitespace(doc.body?.textContent ?? '').length -
    squeezeWhitespace(table.textContent ?? '').length
  if (outsideLength > 0) return null
  const text = tableRowsToText(table)
  return text.length > 0 ? text : null
}

function squeezeWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

function tableRowsToText(table: Element): string {
  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th,td'))
        .map((cell) => normalizeClipboardText(cell.textContent ?? '').trim())
        .join('\t')
    )
    .filter((row) => row.length > 0)
    .join('\n')
}
