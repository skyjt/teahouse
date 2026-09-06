<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { OcrLine } from '../utils/ocr'
import { layoutImageTextLines, type ImageTextLineLayout } from '../utils/image-text-layer'

const props = defineProps<{ lines: OcrLine[]; width: number; height: number; zoom: number }>()
const emit = defineEmits<{ 'selection-change': [selected: boolean] }>()
const layerEl = ref<HTMLElement | null>(null)
const layouts = shallowRef<ImageTextLineLayout[]>([])
const layerStyle = computed(() => ({
  width: `${props.width}px`,
  height: `${props.height}px`,
  transform: `scale(${props.zoom})`
}))

let measureContext: CanvasRenderingContext2D | null = null
let fontFamily = ''
let selectionActive = false

function buildLayouts(): void {
  const context = measureContext
  if (!context) return
  layouts.value = layoutImageTextLines(props.lines, props.width, props.height, (text, fontSize) => {
    context.font = `${fontSize}px ${fontFamily}`
    return context.measureText(text).width
  })
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
  buildLayouts()
})

onMounted(() => {
  measureContext = document.createElement('canvas').getContext('2d')
  fontFamily = getComputedStyle(layerEl.value!).fontFamily
  buildLayouts()
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('copy', onCopy)
})

onBeforeUnmount(() => {
  clearSelection()
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('copy', onCopy)
  measureContext = null
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
    @pointerdown.stop
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
