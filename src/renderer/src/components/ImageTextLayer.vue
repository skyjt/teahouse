<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { OcrLine } from '../utils/ocr'
import {
  getImageTextLineBoxes,
  IMAGE_TEXT_MEASURE_SIZE,
  layoutImageTextLines,
  type ImageTextLineLayout,
  type ImageTextMetrics
} from '../utils/image-text-layer'

const props = defineProps<{ lines: OcrLine[]; width: number; height: number; zoom: number }>()
const emit = defineEmits<{
  'selection-change': [selected: boolean]
  'selecting-change': [selecting: boolean]
}>()
const layerEl = ref<HTMLElement | null>(null)
const layouts = shallowRef<ImageTextLineLayout[]>([])
const layerStyle = computed(() => ({
  width: `${props.width}px`,
  height: `${props.height}px`,
  transform: `scale(${props.zoom})`
}))

let selectionActive = false
let selecting = false
let buildVersion = 0
let measurementRoot: HTMLElement | null = null

function cancelMeasurement(): void {
  buildVersion += 1
  measurementRoot?.remove()
  measurementRoot = null
}

async function buildLayouts(): Promise<void> {
  cancelMeasurement()
  layouts.value = []
  const root = layerEl.value
  if (!root) return
  const version = buildVersion
  const lines = getImageTextLineBoxes(props.lines, props.width, props.height)
  if (!lines.length) return
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, {
    position: 'absolute', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none',
    width: '0', height: '0', contain: 'strict', overflow: 'hidden',
    fontFamily: getComputedStyle(root).fontFamily
  })
  document.body.append(container)
  measurementRoot = container
  const metrics = new Map<number, ImageTextMetrics>()
  try {
    for (let offset = 0; offset < lines.length; offset += 128) {
      if (version !== buildVersion) return
      const batch = lines.slice(offset, offset + 128)
      const fragment = document.createDocumentFragment()
      const spans = batch.map((line) => {
        const span = document.createElement('span')
        span.textContent = line.text
        Object.assign(span.style, {
          position: 'absolute', display: 'block', left: '0', top: '0', whiteSpace: 'pre',
          fontSize: `${IMAGE_TEXT_MEASURE_SIZE}px`, lineHeight: `${IMAGE_TEXT_MEASURE_SIZE}px`,
          height: `${IMAGE_TEXT_MEASURE_SIZE}px`, fontWeight: '400', fontStyle: 'normal', letterSpacing: '0'
        })
        fragment.append(span)
        return span
      })
      // 一批只写入一次，再集中读取真实 Range；测量容器避开图片的缩放与旋转。
      container.replaceChildren(fragment)
      spans.forEach((span, index) => {
        const element = span.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(span)
        const text = range.getBoundingClientRect()
        metrics.set(batch[index].key, {
          width: text.width, height: text.height,
          offsetX: text.left - element.left, offsetY: text.top - element.top
        })
      })
      if (offset + 128 < lines.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    }
    if (version === buildVersion) layouts.value = layoutImageTextLines(lines, (line) => metrics.get(line.key))
  } finally {
    container.remove()
    if (measurementRoot === container) measurementRoot = null
  }
}

function setSelecting(value: boolean): void {
  if (selecting === value) return
  selecting = value
  emit('selecting-change', value)
}

function onTextPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  if (!event.shiftKey) clearSelection()
  setSelecting(true)
}

function finishSelecting(): void {
  setSelecting(false)
}

function ownedSelection(): Selection | null {
  const root = layerEl.value
  const selection = window.getSelection()
  return root && selection && !selection.isCollapsed && selection.rangeCount > 0 &&
    root.contains(selection.anchorNode) && root.contains(selection.focusNode) ? selection : null
}

function onSelectionChange(): void {
  // 鼠标移动只检查选区端点归属；复制时才逐行提取内容。
  const selected = ownedSelection() !== null
  if (selectionActive === selected) return
  selectionActive = selected
  emit('selection-change', selected)
}

function selectedText(): string {
  const selection = ownedSelection()
  const root = layerEl.value
  if (!selection || !root) return ''
  const selectedRange = selection.getRangeAt(0)
  const lines: string[] = []
  for (const line of root.querySelectorAll('.image-text-line')) {
    if (!selectedRange.intersectsNode(line)) continue
    const part = document.createRange()
    part.selectNodeContents(line)
    if (selectedRange.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
      part.setStart(selectedRange.startContainer, selectedRange.startOffset)
    }
    if (selectedRange.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
      part.setEnd(selectedRange.endContainer, selectedRange.endOffset)
    }
    const text = part.toString()
    if (text.length > 0) lines.push(text)
  }
  return lines.join('\n')
}

async function copySelection(): Promise<void> {
  const text = selectedText()
  if (text) await navigator.clipboard.writeText(text)
}

function clearSelection(): void {
  finishSelecting()
  ownedSelection()?.removeAllRanges()
  onSelectionChange()
}

function onCopy(event: ClipboardEvent): void {
  if (event.defaultPrevented || !event.clipboardData) return
  const text = selectedText()
  if (!text) return
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
}

watch([() => props.lines, () => props.width, () => props.height], () => {
  clearSelection()
  void buildLayouts()
})

onMounted(() => {
  void buildLayouts()
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('copy', onCopy)
  document.addEventListener('pointerup', finishSelecting, true)
  document.addEventListener('pointercancel', finishSelecting, true)
  window.addEventListener('blur', finishSelecting)
})

onBeforeUnmount(() => {
  cancelMeasurement()
  clearSelection()
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('copy', onCopy)
  document.removeEventListener('pointerup', finishSelecting, true)
  document.removeEventListener('pointercancel', finishSelecting, true)
  window.removeEventListener('blur', finishSelecting)
})

defineExpose({ copySelection, clearSelection })
</script>

<template>
  <div
    ref="layerEl"
    class="image-text-layer"
    :style="layerStyle"
    role="document"
    aria-label="图片识别文字"
    @pointerdown.stop="onTextPointerDown"
    @dblclick.stop
  >
    <div v-memo="[layouts]">
      <span v-for="line in layouts" :key="line.key" class="image-text-line" :style="line.style">{{ line.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.image-text-layer {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  pointer-events: none;
  user-select: text;
}
.image-text-line {
  position: absolute;
  display: block;
  transform-origin: top left;
  white-space: pre;
  color: transparent;
  font-weight: 400;
  font-style: normal;
  letter-spacing: 0;
  cursor: text;
  pointer-events: auto;
  user-select: text;
}
.image-text-line::selection {
  color: transparent;
  background: var(--surface-pressed);
}
</style>
