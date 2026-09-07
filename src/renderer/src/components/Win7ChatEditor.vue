<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { splitEmojiText } from '../utils/compat-emoji'
import { emojiToTwemojiCode, twemojiUrl } from '../utils/twemoji-assets'

const props = defineProps<{
  modelValue: string
  disabled: boolean
  placeholder: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  keydown: [event: KeyboardEvent]
  paste: [event: ClipboardEvent]
  scroll: []
  compositionstart: []
  compositionend: []
}>()

const root = ref<HTMLDivElement | null>(null)
let composing = false

function emojiOf(node: Node): string {
  return node instanceof HTMLImageElement ? (node.dataset['editorEmoji'] ?? '') : ''
}

function logicalLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  const emoji = emojiOf(node)
  if (emoji) return emoji.length
  if (node instanceof HTMLBRElement) return 1
  let total = 0
  for (const child of Array.from(node.childNodes)) total += logicalLength(child)
  return total
}

function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ')
  const emoji = emojiOf(node)
  if (emoji) return emoji
  if (node instanceof HTMLBRElement) return '\n'
  let text = ''
  for (const child of Array.from(node.childNodes)) text += textOf(child)
  return text
}

function editorText(): string {
  const el = root.value
  if (!el) return props.modelValue
  // Chromium 会在清空 contenteditable 后留下占位 <br>；它不属于真实草稿。
  if (!el.textContent && !el.querySelector('img[data-editor-emoji]')) return ''
  return textOf(el)
}

function offsetInside(node: Node, target: Node, targetOffset: number): number | null {
  if (node === target) {
    if (node.nodeType === Node.TEXT_NODE) {
      return Math.max(0, Math.min(targetOffset, node.textContent?.length ?? 0))
    }
    const children = Array.from(node.childNodes)
    let total = 0
    for (let index = 0; index < Math.min(targetOffset, children.length); index += 1) {
      total += logicalLength(children[index])
    }
    return total
  }
  if (emojiOf(node) || node instanceof HTMLBRElement) return null
  let consumed = 0
  for (const child of Array.from(node.childNodes)) {
    const nested = offsetInside(child, target, targetOffset)
    if (nested !== null) return consumed + nested
    consumed += logicalLength(child)
  }
  return null
}

function selectionRange(): { start: number; end: number } {
  const el = root.value
  const selection = window.getSelection()
  if (!el || !selection?.anchorNode || !selection.focusNode) {
    const end = props.modelValue.length
    return { start: end, end }
  }
  const anchor = offsetInside(el, selection.anchorNode, selection.anchorOffset)
  const focus = offsetInside(el, selection.focusNode, selection.focusOffset)
  if (anchor === null || focus === null) {
    const end = props.modelValue.length
    return { start: end, end }
  }
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
}

interface DomPoint {
  node: Node
  offset: number
}

function pointAt(node: Node, targetOffset: number): DomPoint {
  if (node.nodeType === Node.TEXT_NODE) {
    return {
      node,
      offset: Math.max(0, Math.min(targetOffset, node.textContent?.length ?? 0))
    }
  }
  const children = Array.from(node.childNodes)
  let remaining = Math.max(0, targetOffset)
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    const length = logicalLength(child)
    const emoji = emojiOf(child)
    if (emoji || child instanceof HTMLBRElement) {
      if (remaining === 0) return { node, offset: index }
      if (remaining <= length) return { node, offset: index + 1 }
      remaining -= length
      continue
    }
    if (remaining <= length) return pointAt(child, remaining)
    remaining -= length
  }
  return { node, offset: children.length }
}

function setSelectionRange(start: number, end: number): void {
  const el = root.value
  const selection = window.getSelection()
  if (!el || !selection) return
  const max = logicalLength(el)
  const safeStart = Math.max(0, Math.min(start, max))
  const safeEnd = Math.max(safeStart, Math.min(end, max))
  const from = pointAt(el, safeStart)
  const to = pointAt(el, safeEnd)
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  selection.removeAllRanges()
  selection.addRange(range)
}

function appendEmoji(fragment: DocumentFragment, emoji: string): void {
  const image = document.createElement('img')
  image.className = 'win7-editor-emoji'
  image.dataset['editorEmoji'] = emoji
  image.src = twemojiUrl(emojiToTwemojiCode(emoji))
  image.alt = emoji
  image.draggable = false
  image.contentEditable = 'false'
  fragment.appendChild(image)
}

function renderValue(value: string, range?: { start: number; end: number }): void {
  const el = root.value
  if (!el) return
  const active = document.activeElement === el
  const scrollTop = el.scrollTop
  const fragment = document.createDocumentFragment()
  for (const part of splitEmojiText(value)) {
    if (part.emoji) appendEmoji(fragment, part.text)
    else if (part.text) fragment.appendChild(document.createTextNode(part.text))
  }
  el.replaceChildren(fragment)
  el.scrollTop = scrollTop
  if (active || range) {
    el.focus({ preventScroll: true })
    const next = range ?? { start: value.length, end: value.length }
    setSelectionRange(next.start, next.end)
  }
}

function hasRawEmojiText(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return splitEmojiText(node.textContent ?? '').some((part) => part.emoji)
  }
  for (const child of Array.from(node.childNodes)) {
    if (hasRawEmojiText(child)) return true
  }
  return false
}

function syncFromDom(): void {
  const el = root.value
  if (!el) return
  const value = editorText()
  const range = selectionRange()
  emit('update:modelValue', value)
  if (!value && el.childNodes.length > 0) {
    renderValue('', { start: 0, end: 0 })
    return
  }
  if (!composing && hasRawEmojiText(el)) renderValue(value, range)
}

function replaceSelection(text: string): void {
  const value = editorText()
  const range = selectionRange()
  const normalized = text.replace(/\r\n?/g, '\n')
  const next = value.slice(0, range.start) + normalized + value.slice(range.end)
  const caret = range.start + normalized.length
  emit('update:modelValue', next)
  renderValue(next, { start: caret, end: caret })
}

function onCompositionStart(): void {
  composing = true
  emit('compositionstart')
}

function onCompositionEnd(): void {
  composing = false
  syncFromDom()
  emit('compositionend')
}

function onPaste(event: ClipboardEvent): void {
  emit('paste', event)
  if (event.defaultPrevented) return
  const text = event.clipboardData?.getData('text/plain')
  if (text === undefined || text === '') {
    // 图片 / 文件由父层异步读取；contenteditable 必须同步拦截浏览器默认嵌入。
    event.preventDefault()
    return
  }
  event.preventDefault()
  replaceSelection(text)
}

function onCopy(event: ClipboardEvent): boolean {
  if (event.defaultPrevented || !event.clipboardData) return false
  const range = selectionRange()
  if (range.start === range.end) return false
  event.clipboardData.setData('text/plain', editorText().slice(range.start, range.end))
  event.preventDefault()
  return true
}

function onCut(event: ClipboardEvent): void {
  if (props.disabled || composing) return
  // 原子图片没有原生纯文本；先复制逻辑草稿，再用原生删除保留撤销和 input 事件。
  if (onCopy(event)) document.execCommand('delete')
}

function focus(): void {
  root.value?.focus({ preventScroll: true })
}

function scrollTop(): number {
  return root.value?.scrollTop ?? 0
}

defineExpose({ focus, selectionRange, setSelectionRange, scrollTop })

watch(
  () => props.modelValue,
  (value) => {
    if (composing || editorText() === value) return
    const range = document.activeElement === root.value ? selectionRange() : undefined
    renderValue(value, range)
  }
)

onMounted(() => renderValue(props.modelValue))
</script>

<template>
  <div
    ref="root"
    class="win7-chat-editor"
    :class="{ disabled }"
    :contenteditable="disabled ? 'false' : 'true'"
    :data-placeholder="placeholder"
    role="textbox"
    aria-multiline="true"
    :aria-disabled="disabled"
    spellcheck="false"
    @input="syncFromDom"
    @keydown="emit('keydown', $event)"
    @paste="onPaste"
    @copy="onCopy"
    @cut="onCut"
    @scroll="emit('scroll')"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
  ></div>
</template>

<style scoped>
.win7-chat-editor {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  border: none;
  outline: none;
  padding: 6px 8px;
  font-family: 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-1);
  background: var(--material-strong);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  user-select: text;
  cursor: text;
}
.win7-chat-editor:empty::before {
  content: attr(data-placeholder);
  color: var(--text-3);
  pointer-events: none;
}
.win7-chat-editor.disabled {
  cursor: default;
  opacity: 0.6;
}
.win7-chat-editor :deep(.win7-editor-emoji) {
  display: inline-block;
  width: 1.3em;
  height: 1.3em;
  vertical-align: -0.2em;
  object-fit: contain;
  user-select: all;
}
</style>
