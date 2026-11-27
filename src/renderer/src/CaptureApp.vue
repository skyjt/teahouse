<script setup lang="ts">
import { tr } from './utils/i18n'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CaptureInit } from '../../shared/ipc'
import { mapCaptureRectToImage } from './utils/capture-crop'
import {
  CAPTURE_TEXT_MAX_LENGTH,
  normalizeCaptureText,
  placeCaptureTextEditor,
  shouldCommitCaptureText
} from './utils/capture-text'
import { placeCaptureToolbar } from './utils/capture-toolbar'

// 截图框选窗（F-CAP-1）：屏幕图像做背景 → 拖拽框选 → 发送/复制/取消。
// Esc 取消，全局截图按 Enter 复制，聊天截图按 Enter 发送给发起会话。坐标按截图自然尺寸与实际视口分别映射（决议 #221）。

const PantryIcon = defineAsyncComponent(() => import('./components/PantryIcon.vue'))
const recipients = ref<CaptureInit['recipients']>([])
const pinnedConvId = ref<string | null>(null)
const selectedConvId = ref('')
const finishing = ref(false)
const actionError = ref('')
const selectedName = computed(() => recipients.value.find((r) => r.convId === selectedConvId.value)?.name)
const snapshotUrl = ref('')
const snapshotEl = ref<HTMLImageElement | null>(null)
const dragging = ref(false)
const startX = ref(0)
const startY = ref(0)
const rect = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const barEl = ref<HTMLElement | null>(null)
const toolbarSize = ref({ width: 560, height: 40 })
const viewportSize = ref({ width: window.innerWidth, height: window.innerHeight })
const toolbarPosition = computed(() => {
  const current = rect.value
  if (!current) return { left: 8, top: 8 }
  return placeCaptureToolbar(
    { x: current.x, y: current.y, width: current.w, height: current.h },
    toolbarSize.value,
    viewportSize.value
  )
})
const toolbarTooltipBelow = computed(() => toolbarPosition.value.top < 48)
type Tool = 'select' | 'rect' | 'arrow' | 'text' | 'mosaic'
interface Annotation {
  type: Exclude<Tool, 'select'>
  x: number
  y: number
  w: number
  h: number
  text?: string
}
const tool = ref<Tool>('select')
const annotations = ref<Annotation[]>([])
const drawingAnnotation = ref<number | null>(null)
interface PendingText {
  x: number
  y: number
  value: string
}
const textEditorEl = ref<HTMLInputElement | null>(null)
const pendingText = ref<PendingText | null>(null)
const textComposing = ref(false)
const textEditorStyle = computed(() => {
  const current = rect.value
  const pending = pendingText.value
  if (!current || !pending) return {}
  const width = Math.min(260, Math.max(1, viewportSize.value.width - 16))
  const height = 34
  const position = placeCaptureTextEditor(
    { x: current.x + pending.x, y: current.y + pending.y },
    { width, height },
    viewportSize.value
  )
  return {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${width}px`
  }
})

let unsubscribe: (() => void) | null = null
let objectUrl = ''
let snapshotGeneration = 0
let unmounted = false
let moveFrame: number | null = null
let pendingPoint: { x: number; y: number } | null = null

onMounted(() => {
  unsubscribe = window.pantry.onCaptureInit((init) => {
    recipients.value = init.recipients
    pinnedConvId.value = init.pinnedConvId
    selectedConvId.value = init.recipients.find((r) => r.convId === init.pinnedConvId)?.convId ?? ''
    void prepareSnapshot(init.pngBytes)
  })
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', refreshToolbarLayout)
})
onBeforeUnmount(() => {
  unmounted = true
  snapshotGeneration += 1
  unsubscribe?.()
  if (moveFrame !== null) cancelAnimationFrame(moveFrame)
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', refreshToolbarLayout)
})

async function prepareSnapshot(pngBytes: ArrayBuffer): Promise<void> {
  const generation = ++snapshotGeneration
  const nextUrl = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }))
  const image = new Image()
  image.src = nextUrl
  try {
    await image.decode()
  } catch {
    URL.revokeObjectURL(nextUrl)
    if (!unmounted && generation === snapshotGeneration) cancel()
    return
  }
  if (unmounted || generation !== snapshotGeneration) {
    URL.revokeObjectURL(nextUrl)
    return
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = nextUrl
  snapshotUrl.value = nextUrl
  rect.value = null
  annotations.value = []
  tool.value = 'select'
  pendingText.value = null
  textComposing.value = false
  await nextTick()
  await waitForPaint()
  if (!unmounted && generation === snapshotGeneration) await window.pantry.captureReady()
}

async function waitForPaint(): Promise<void> {
  await waitForFrame()
  await waitForFrame()
}

function waitForFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, 100)
    requestAnimationFrame(finish)
  })
}

function refreshToolbarLayout(): void {
  viewportSize.value = { width: window.innerWidth, height: window.innerHeight }
  const bar = barEl.value
  if (!bar) return
  const bounds = bar.getBoundingClientRect()
  if (bounds.width > 0 && bounds.height > 0) {
    toolbarSize.value = { width: bounds.width, height: bounds.height }
  }
}

function onKey(event: KeyboardEvent): void {
  if (pendingText.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelPendingText()
    } else if (shouldCommitCaptureText(event, textComposing.value)) {
      event.preventDefault()
      commitPendingText()
    }
    return
  }
  if (event.key === 'Escape') {
    cancel()
  } else if (event.key === 'Enter' && rect.value && !(event.target instanceof Element && event.target.closest('button, select'))) {
    event.preventDefault()
    void confirm(!!pinnedConvId.value && !!selectedConvId.value)
  }
}

function onMouseDown(event: MouseEvent): void {
  flushPendingPointerMove()
  if (rect.value && tool.value !== 'select' && inSelection(event.clientX, event.clientY)) {
    startAnnotation(event)
    return
  }
  cancelPendingText()
  dragging.value = true
  startX.value = event.clientX
  startY.value = event.clientY
  rect.value = { x: event.clientX, y: event.clientY, w: 0, h: 0 }
  annotations.value = []
}

function onMouseMove(event: MouseEvent): void {
  if (drawingAnnotation.value === null && !dragging.value) return
  pendingPoint = { x: event.clientX, y: event.clientY }
  if (moveFrame !== null) return
  moveFrame = requestAnimationFrame(() => {
    moveFrame = null
    applyPendingPointerMove()
  })
}

function applyPendingPointerMove(): void {
  const point = pendingPoint
  pendingPoint = null
  if (!point) return
  if (drawingAnnotation.value !== null && rect.value) {
    const ann = annotations.value[drawingAnnotation.value]
    ann.w = point.x - rect.value.x - ann.x
    ann.h = point.y - rect.value.y - ann.y
    return
  }
  if (!dragging.value) return
  rect.value = {
    x: Math.min(startX.value, point.x),
    y: Math.min(startY.value, point.y),
    w: Math.abs(point.x - startX.value),
    h: Math.abs(point.y - startY.value)
  }
}

function flushPendingPointerMove(): void {
  if (moveFrame !== null) {
    cancelAnimationFrame(moveFrame)
    moveFrame = null
  }
  applyPendingPointerMove()
}

async function onMouseUp(event: MouseEvent): Promise<void> {
  pendingPoint = { x: event.clientX, y: event.clientY }
  flushPendingPointerMove()
  if (drawingAnnotation.value !== null) {
    const ann = annotations.value[drawingAnnotation.value]
    if (ann && ann.type !== 'text' && Math.abs(ann.w) < 4 && Math.abs(ann.h) < 4) {
      annotations.value.splice(drawingAnnotation.value, 1)
    }
    drawingAnnotation.value = null
    return
  }
  dragging.value = false
  if (rect.value && (rect.value.w < 4 || rect.value.h < 4)) rect.value = null
  if (rect.value) {
    await nextTick()
    refreshToolbarLayout()
  }
}

function cancel(): void {
  if (!finishing.value) void window.pantry.captureDone(new ArrayBuffer(0))
}

async function confirm(send: boolean): Promise<void> {
  if (finishing.value || (send && !selectedConvId.value)) return
  const target = send ? selectedConvId.value : undefined
  commitPendingText()
  const r = rect.value
  const img = snapshotEl.value
  if (!r || !img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return
  const crop = mapCaptureRectToImage(
    r,
    { width: window.innerWidth, height: window.innerHeight },
    { width: img.naturalWidth, height: img.naturalHeight }
  )
  if (!crop) return
  const canvas = document.createElement('canvas')
  canvas.width = crop.width
  canvas.height = crop.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  )
  drawAnnotations(ctx, crop.scaleX, crop.scaleY)
  finishing.value = true
  actionError.value = ''
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob && await window.pantry.captureDone(await blob.arrayBuffer(), target)) return
  } catch {
    // 窗口仍在，用户可以重试或复制。
  } finally {
    finishing.value = false
  }
  actionError.value = target ? tr('未能发送截图，可以复制后重试。') : tr('复制失败，请重试。')
}

function inSelection(x: number, y: number): boolean {
  const r = rect.value
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

function setTool(nextTool: Tool): void {
  commitPendingText()
  tool.value = nextTool
}

function startAnnotation(event: MouseEvent): void {
  const r = rect.value
  if (!r) return
  const activeTool = tool.value
  if (activeTool === 'select') return
  const x = event.clientX - r.x
  const y = event.clientY - r.y
  if (activeTool === 'text') {
    void beginTextAnnotation(x, y)
    return
  }
  const ann: Annotation = { type: activeTool, x, y, w: 0, h: 0 }
  annotations.value.push(ann)
  drawingAnnotation.value = annotations.value.length - 1
}

async function beginTextAnnotation(x: number, y: number): Promise<void> {
  commitPendingText()
  pendingText.value = { x, y, value: '' }
  textComposing.value = false
  await nextTick()
  textEditorEl.value?.focus({ preventScroll: true })
}

function onTextInput(event: Event): void {
  const pending = pendingText.value
  if (!pending) return
  pending.value = (event.target as HTMLInputElement).value.slice(0, CAPTURE_TEXT_MAX_LENGTH)
}

function onTextEditorKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelPendingText()
    return
  }
  if (!shouldCommitCaptureText(event, textComposing.value)) return
  event.preventDefault()
  commitPendingText()
}

function onTextCompositionStart(): void {
  textComposing.value = true
}

function onTextCompositionEnd(): void {
  textComposing.value = false
}

function commitPendingText(): void {
  const pending = pendingText.value
  if (!pending) return
  const text = normalizeCaptureText(pending.value)
  pendingText.value = null
  textComposing.value = false
  if (text) annotations.value.push({ type: 'text', x: pending.x, y: pending.y, w: 0, h: 0, text })
}

function cancelPendingText(): void {
  pendingText.value = null
  textComposing.value = false
}

function norm(ann: Annotation): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(ann.x, ann.x + ann.w),
    y: Math.min(ann.y, ann.y + ann.h),
    w: Math.abs(ann.w),
    h: Math.abs(ann.h)
  }
}

function annStyle(ann: Annotation): Record<string, string> {
  if (ann.type === 'arrow') return arrowStyle(ann)
  const n = norm(ann)
  return { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` }
}

function arrowStyle(ann: Annotation): Record<string, string> {
  const len = Math.hypot(ann.w, ann.h)
  const deg = (Math.atan2(ann.h, ann.w) * 180) / Math.PI
  return {
    left: `${ann.x}px`,
    top: `${ann.y}px`,
    width: `${len}px`,
    transform: `rotate(${deg}deg)`
  }
}

/**
 * 标注色取自 tokens.css 的茶青主色（决议 #281），读一次即缓存。
 * 截图窗不调 `applyAppearance`，`--primary` 恒为浅色档的值，
 * 导出的 PNG 因此和屏幕上的预览描边始终同色，也不随应用主题漂移。
 */
let annotationColor = ''
function accent(): string {
  if (!annotationColor) {
    annotationColor =
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#4e79af'
  }
  return annotationColor
}

function drawAnnotations(ctx: CanvasRenderingContext2D, scaleX: number, scaleY: number): void {
  const strokeScale = (scaleX + scaleY) / 2
  ctx.save()
  ctx.lineWidth = Math.max(2, 3 * strokeScale)
  ctx.strokeStyle = accent()
  ctx.fillStyle = accent()
  ctx.textBaseline = 'top'
  for (const ann of annotations.value) {
    if (ann.type === 'rect') {
      const n = norm(ann)
      ctx.strokeRect(n.x * scaleX, n.y * scaleY, n.w * scaleX, n.h * scaleY)
    } else if (ann.type === 'arrow') {
      drawArrow(
        ctx,
        ann.x * scaleX,
        ann.y * scaleY,
        (ann.x + ann.w) * scaleX,
        (ann.y + ann.h) * scaleY,
        strokeScale
      )
    } else if (ann.type === 'text' && ann.text) {
      ctx.font = `700 ${Math.round(18 * scaleY)}px sans-serif`
      ctx.fillText(ann.text, ann.x * scaleX, ann.y * scaleY)
    } else if (ann.type === 'mosaic') {
      drawMosaic(ctx, norm(ann), scaleX, scaleY)
    }
  }
  ctx.restore()
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  scale: number
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = 12 * scale
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

function drawMosaic(
  ctx: CanvasRenderingContext2D,
  rect_: { x: number; y: number; w: number; h: number },
  scaleX: number,
  scaleY: number
): void {
  const x = Math.max(0, Math.round(rect_.x * scaleX))
  const y = Math.max(0, Math.round(rect_.y * scaleY))
  const right = Math.min(ctx.canvas.width, Math.round((rect_.x + rect_.w) * scaleX))
  const bottom = Math.min(ctx.canvas.height, Math.round((rect_.y + rect_.h) * scaleY))
  const w = right - x
  const h = bottom - y
  if (w <= 0 || h <= 0) return
  const block = Math.max(6, Math.round(10 * ((scaleX + scaleY) / 2)))
  const data = ctx.getImageData(x, y, w, h)
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      const idx = ((Math.min(by, h - 1) * w + Math.min(bx, w - 1)) * 4)
      ctx.fillStyle = `rgb(${data.data[idx]}, ${data.data[idx + 1]}, ${data.data[idx + 2]})`
      ctx.fillRect(x + bx, y + by, Math.min(block, w - bx), Math.min(block, h - by))
    }
  }
}
</script>

<template>
  <div
    class="stage"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
  >
    <img v-if="snapshotUrl" ref="snapshotEl" class="desktop" :src="snapshotUrl" alt="" />
    <div v-if="!rect" class="dim dim-full"></div>
    <template v-if="rect">
      <div class="dim dim-top" :style="{ height: `${rect.y}px` }"></div>
      <div
        class="dim dim-right"
        :style="{
          left: `${rect.x + rect.w}px`,
          top: `${rect.y}px`,
          height: `${rect.h}px`
        }"
      ></div>
      <div class="dim dim-bottom" :style="{ top: `${rect.y + rect.h}px` }"></div>
      <div
        class="dim dim-left"
        :style="{
          top: `${rect.y}px`,
          width: `${rect.x}px`,
          height: `${rect.h}px`
        }"
      ></div>
      <div
        class="sel"
        :class="{ annotating: tool !== 'select' }"
        :style="{
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.w}px`,
          height: `${rect.h}px`
        }"
      >
        <div
          v-for="(ann, idx) in annotations"
          :key="idx"
          class="ann"
          :class="ann.type"
          :style="annStyle(ann)"
        >
          <span v-if="ann.type === 'text'">{{ ann.text }}</span>
        </div>
      </div>
      <input
        v-if="pendingText"
        ref="textEditorEl"
        class="text-editor"
        type="text"
        :aria-label="tr('输入标注文字')"
        autocomplete="off"
        :maxlength="CAPTURE_TEXT_MAX_LENGTH"
        :style="textEditorStyle"
        :value="pendingText.value"
        @input="onTextInput"
        @keydown.stop="onTextEditorKeydown"
        @compositionstart="onTextCompositionStart"
        @compositionend="onTextCompositionEnd"
        @mousedown.stop
        @mousemove.stop
        @mouseup.stop
        @click.stop
      />
      <div
        v-if="!dragging"
        ref="barEl"
        class="bar"
        :class="{ 'tooltip-below': toolbarTooltipBelow }"
        :style="{
          left: `${toolbarPosition.left}px`,
          top: `${toolbarPosition.top}px`
        }"
        @mousedown.stop
      >
        <span class="size">{{ Math.round(rect.w) }} × {{ Math.round(rect.h) }}</span>
        <button
          type="button"
          class="btn tool"
          :class="{ on: tool === 'select' }"
          :data-tooltip="tr('重新框选')"
          :aria-label="tr('重新框选')"
          :aria-pressed="tool === 'select'"
          @click="setTool('select')"
        >
          <PantryIcon name="capture-select" size="compact" />
        </button>
        <button
          type="button"
          class="btn tool"
          :class="{ on: tool === 'rect' }"
          :data-tooltip="tr('矩形')"
          :aria-label="tr('矩形')"
          :aria-pressed="tool === 'rect'"
          @click="setTool('rect')"
        >
          <PantryIcon name="capture-rect" size="compact" />
        </button>
        <button
          type="button"
          class="btn tool"
          :class="{ on: tool === 'arrow' }"
          :data-tooltip="tr('箭头')"
          :aria-label="tr('箭头')"
          :aria-pressed="tool === 'arrow'"
          @click="setTool('arrow')"
        >
          <PantryIcon name="capture-arrow" size="compact" />
        </button>
        <button
          type="button"
          class="btn tool"
          :class="{ on: tool === 'text' }"
          :data-tooltip="tr('文字')"
          :aria-label="tr('文字')"
          :aria-pressed="tool === 'text'"
          @click="setTool('text')"
        >
          <PantryIcon name="text-select" size="compact" />
        </button>
        <button
          type="button"
          class="btn tool"
          :class="{ on: tool === 'mosaic' }"
          :data-tooltip="tr('马赛克')"
          :aria-label="tr('马赛克')"
          :aria-pressed="tool === 'mosaic'"
          @click="setTool('mosaic')"
        >
          <PantryIcon name="capture-mosaic" size="compact" />
        </button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <select v-if="!pinnedConvId && recipients.length" v-model="selectedConvId"
          class="recipient" :aria-label="tr('选择收件人')" @change="nextTick(refreshToolbarLayout)">
          <option value="">{{ tr('选择收件人') }}</option>
          <option v-for="r in recipients" :key="r.convId" :value="r.convId">{{ r.name }}</option>
        </select>
        <button
          v-if="selectedName"
          type="button"
          class="btn named" :class="{ primary: pinnedConvId }"
          :disabled="finishing"
          :data-tooltip="tr('发送给 {0}', { 0: selectedName })"
          :aria-label="tr('发送给 {0}', { 0: selectedName })"
          @click="confirm(true)"
        >
          <span>{{ tr('发送给 {0}', { 0: selectedName }) }}</span>
        </button>
        <button
          type="button"
          class="btn named" :class="{ primary: !pinnedConvId || !selectedName }" :disabled="finishing"
          :data-tooltip="tr('复制')"
          :aria-label="tr('复制')"
          @click="confirm(false)"
        >
          {{ tr('复制') }}
        </button>
        <button
          type="button"
          class="btn cancel-btn"
          :data-tooltip="tr('取消')"
          :aria-label="tr('取消')"
          @click="cancel"
        >
          <PantryIcon name="x" size="compact" />
        </button>
      </div>
    </template>
    <div v-else class="hint">{{ tr('拖拽框选区域 · Esc 取消') }}</div>
    <div v-if="actionError" class="hint" role="alert">{{ actionError }}</div>
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  background-color: #000;
  cursor: crosshair;
  user-select: none;
  overflow: hidden;
}
.desktop {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
}
.dim {
  position: absolute;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.dim-full,
.dim-top,
.dim-bottom {
  left: 0;
  right: 0;
}
.dim-full {
  top: 0;
  bottom: 0;
}
.dim-top {
  top: 0;
}
.dim-bottom {
  bottom: 0;
}
.dim-left {
  left: 0;
}
.dim-right {
  right: 0;
}
.sel {
  position: absolute;
  border: 2px solid var(--primary);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
  pointer-events: none;
  overflow: hidden;
}
.ann {
  position: absolute;
  pointer-events: none;
}
.ann.rect {
  border: 3px solid var(--primary);
}
.ann.mosaic {
  background:
    linear-gradient(45deg, rgba(var(--primary-rgb), 0.35) 25%, transparent 25%) 0 0 / 12px 12px,
    linear-gradient(45deg, transparent 75%, rgba(var(--primary-rgb), 0.35) 75%) 0 0 / 12px 12px,
    rgba(255, 255, 255, 0.2);
}
.ann.arrow {
  height: 3px;
  background: var(--primary);
  transform-origin: 0 50%;
}
.ann.arrow::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -5px;
  border-left: 12px solid var(--primary);
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}
.ann.text {
  color: var(--primary);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.2;
  white-space: pre;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.85);
}
.text-editor {
  position: absolute;
  z-index: 2;
  box-sizing: border-box;
  height: 34px;
  border: 2px solid var(--primary);
  border-radius: 5px;
  outline: none;
  padding: 4px 8px;
  color: var(--text-1);
  background: var(--material-strong);
  box-shadow: var(--shadow-soft);
  font: 700 18px/1.2 sans-serif;
  caret-color: var(--primary);
  cursor: text;
  user-select: text;
}
.text-editor:focus {
  box-shadow: 0 0 0 2px var(--primary-weak), var(--shadow-soft);
}
.bar {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--media-toolbar);
  border-radius: calc(var(--radius-control) + 5px);
  padding: 5px 7px;
  box-shadow: var(--media-shadow);
}
.size {
  color: var(--media-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  margin: 0 3px 0 1px;
}
.btn {
  position: relative;
  display: grid;
  place-items: center;
  width: var(--control-square);
  height: var(--control-square);
  border: none;
  border-radius: var(--radius-control);
  background: rgba(255, 255, 255, 0.14);
  color: var(--media-ink);
  padding: 0;
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;
}
.recipient { max-width: 145px; height: var(--control-square); border-radius: var(--radius-control); }
.btn.named { width: auto; max-width: 190px; padding: 0 9px; white-space: nowrap; }
.btn.named span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.btn::before,
.btn::after {
  position: absolute;
  left: 50%;
  z-index: 5;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition:
    opacity 120ms ease,
    transform 120ms ease,
    visibility 0s linear 120ms;
}
.btn::before {
  content: '';
  bottom: calc(100% + 3px);
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid rgba(15, 18, 17, 0.96);
}
.btn::after {
  content: attr(data-tooltip);
  bottom: calc(100% + 8px);
  padding: 5px 7px;
  border-radius: 4px;
  color: #fff;
  background: rgba(15, 18, 17, 0.96);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28);
  font: 12px/1 sans-serif;
  white-space: nowrap;
}
.btn:hover,
.btn:focus-visible {
  z-index: 4;
}
.btn:hover::before,
.btn:hover::after,
.btn:focus-visible::before,
.btn:focus-visible::after {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
  transition-delay: 250ms;
}
.btn:focus-visible::before,
.btn:focus-visible::after {
  transition-delay: 0ms;
}
.bar.tooltip-below .btn::before {
  top: calc(100% + 3px);
  bottom: auto;
  border-top: 0;
  border-bottom: 5px solid rgba(15, 18, 17, 0.96);
  transform: translate(-50%, -4px);
}
.bar.tooltip-below .btn::after {
  top: calc(100% + 8px);
  bottom: auto;
  transform: translate(-50%, -4px);
}
.bar.tooltip-below .btn:hover::before,
.bar.tooltip-below .btn:hover::after,
.bar.tooltip-below .btn:focus-visible::before,
.bar.tooltip-below .btn:focus-visible::after {
  transform: translate(-50%, 0);
}
.btn:hover {
  background: rgba(255, 255, 255, 0.23);
}
.btn:focus-visible {
  outline: 2px solid var(--media-focus);
  outline-offset: 2px;
}
.btn.primary {
  background: var(--primary);
  color: var(--on-primary);
}
.btn.primary:hover {
  /* 主色的按下态沿用项目里 ConvList / App 的做法，不再另写一个茶青字面量 */
  filter: brightness(0.9);
}
.btn.tool.on {
  /* 主色 85% 作选中底，tokens 里没有等价档位（--primary-weak 仅 12%），保留字面量 */
  background: rgba(var(--primary-rgb), 0.85);
  color: #fff;
}
.btn.cancel-btn:hover {
  background: rgba(213, 76, 76, 0.42);
}
.toolbar-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: rgba(255, 255, 255, 0.2);
}
.hint {
  position: absolute;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.5);
  font-size: 13px;
  padding: 6px 14px;
  border-radius: var(--radius-panel);
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .btn, .btn::before, .btn::after { transition: none; }
}
</style>
