<script setup lang="ts">
// 大图查看器：纯渲染层缩放/旋转/平移，图片源仍走 pantry-img://，另存为走既有 IPC。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  OCR_AUTO_MAX_PIXELS,
  getSelectedOcrText,
  isAutoOcrCandidate,
  recognizeImageText,
  type OcrToken
} from '../utils/ocr'
import PantryIcon from './PantryIcon.vue'

const props = defineProps<{ src: string; transferId: string }>()
const emit = defineEmits<{ close: [] }>()

const MIN_ZOOM = 0.005
const MAX_ZOOM = 6
const ZOOM_STEP = 1.2
const PAN_STEP = 48

type Point = { x: number; y: number }
type DragStart = Point & { offsetX: number; offsetY: number }
type OcrStatus = 'idle' | 'loading-source' | 'recognizing' | 'ready' | 'error'
type SelectionRect = { x: number; y: number; width: number; height: number }
type CopyTip = { x: number; y: number; text: string }

const zoom = ref(1)
const rotation = ref(0)
const offset = ref<Point>({ x: 0, y: 0 })
const natural = ref({ width: 0, height: 0 })
const ocrLayerEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const broken = ref(false)
const saving = ref(false)
const isDragging = ref(false)
const viewMode = ref<'fit' | 'free'>('fit')
const ocrStatus = ref<OcrStatus>('idle')
const ocrProgress = ref(0)
const ocrMessage = ref('')
const ocrTokens = ref<OcrToken[]>([])
const selectedOcrIds = ref<Set<string>>(new Set())
const ocrSelectRect = ref<SelectionRect | null>(null)
const copyTip = ref<CopyTip | null>(null)
const isSelectingOcr = ref(false)

let dragStart: DragStart | null = null
let ocrSelectionStart: Point | null = null
let ocrAutoStarted = false
let copyTipTimer: ReturnType<typeof setTimeout> | null = null
let loadToken = 0
let ocrToken = 0

const canUseImage = computed(() => !loading.value && !broken.value)
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`)
const isOcrBusy = computed(() => ocrStatus.value === 'loading-source' || ocrStatus.value === 'recognizing')
const canStartOcr = computed(() => canUseImage.value && !isOcrBusy.value)
const canSelectOcr = computed(
  () => ocrStatus.value === 'ready' && rotation.value === 0 && ocrTokens.value.length > 0
)
const selectedOcrText = computed(() => getSelectedOcrText(ocrTokens.value, selectedOcrIds.value))
const canCopySelectedOcr = computed(() => selectedOcrText.value.length > 0)
const canCopyAllOcr = computed(() => ocrStatus.value === 'ready' && ocrTokens.value.length > 0)
const ocrLabel = computed(() => {
  if (ocrStatus.value === 'loading-source') return '准备识别'
  if (ocrStatus.value === 'recognizing') return `识别中 ${Math.round(ocrProgress.value * 100)}%`
  if (ocrStatus.value === 'ready') {
    if (ocrMessage.value) return ocrMessage.value
    return ocrTokens.value.length > 0 ? '可拖选文字' : '未识别到文字'
  }
  if (ocrStatus.value === 'error') return ocrMessage.value || '识别失败'
  return '识别文字'
})
const ocrButtonTitle = computed(() => {
  if (isOcrBusy.value) return ocrLabel.value
  if (ocrStatus.value === 'ready') return '重新识别文字'
  if (ocrStatus.value === 'error') return '重试识别文字'
  return '识别文字'
})
const imageStyle = computed(() => {
  const width = Math.max(1, Math.round(natural.value.width * zoom.value))
  const height = Math.max(1, Math.round(natural.value.height * zoom.value))
  return {
    width: `${width}px`,
    height: `${height}px`,
    transform: `translate3d(${offset.value.x}px, ${offset.value.y}px, 0) rotate(${rotation.value}deg)`
  }
})
const selectionStyle = computed(() => {
  const rect = ocrSelectRect.value
  if (!rect) return {}
  return {
    left: `${rect.x * zoom.value}px`,
    top: `${rect.y * zoom.value}px`,
    width: `${rect.width * zoom.value}px`,
    height: `${rect.height * zoom.value}px`
  }
})
const copyTipStyle = computed(() => {
  const tip = copyTip.value
  if (!tip) return {}
  return {
    left: `${tip.x}px`,
    top: `${tip.y}px`
  }
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isQuarterTurn(): boolean {
  return Math.abs(rotation.value % 180) === 90
}

function fitScale(): number {
  if (!natural.value.width || !natural.value.height) return 1
  const imageWidth = isQuarterTurn() ? natural.value.height : natural.value.width
  const imageHeight = isQuarterTurn() ? natural.value.width : natural.value.height
  const maxWidth = Math.max(1, window.innerWidth)
  const maxHeight = Math.max(1, window.innerHeight)
  return clamp(Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1), MIN_ZOOM, MAX_ZOOM)
}

function centerImage(): void {
  offset.value = { x: 0, y: 0 }
}

function applyFit(): void {
  zoom.value = fitScale()
  centerImage()
  viewMode.value = 'fit'
}

function applyActualSize(): void {
  zoom.value = 1
  centerImage()
  viewMode.value = 'free'
}

function setZoom(nextZoom: number): void {
  zoom.value = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
  viewMode.value = 'free'
}

function zoomIn(): void {
  setZoom(zoom.value * ZOOM_STEP)
}

function zoomOut(): void {
  setZoom(zoom.value / ZOOM_STEP)
}

function toggleActualSize(): void {
  if (viewMode.value === 'fit' || Math.abs(zoom.value - fitScale()) < 0.01) {
    applyActualSize()
  } else {
    applyFit()
  }
}

function rotateImage(delta: number): void {
  rotation.value = (rotation.value + delta + 360) % 360
  clearOcrSelection()
  if (viewMode.value === 'fit') applyFit()
}

async function saveAs(): Promise<void> {
  if (saving.value || broken.value || loading.value) return
  saving.value = true
  try {
    await window.pantry.saveImageAs(props.transferId)
  } finally {
    saving.value = false
  }
}

async function startOcr(mode: 'auto' | 'manual' = 'manual'): Promise<void> {
  if (!canStartOcr.value) return
  const token = ++ocrToken
  clearOcrSelection()
  ocrStatus.value = 'loading-source'
  ocrProgress.value = 0
  ocrMessage.value = ''
  ocrTokens.value = []
  try {
    const source = await window.pantry.getImageOcrSource(props.transferId)
    if (token !== ocrToken) return
    if (!source) {
      ocrStatus.value = 'error'
      ocrMessage.value = '无法读取图片'
      return
    }
    if (mode === 'auto' && !isAutoOcrCandidate(natural.value.width, natural.value.height, source.size)) {
      ocrStatus.value = 'idle'
      ocrProgress.value = 0
      return
    }
    ocrStatus.value = 'recognizing'
    const result = await recognizeImageText({
      cacheKey: `${props.transferId}:${source.size}:${natural.value.width}x${natural.value.height}`,
      source,
      naturalWidth: natural.value.width,
      naturalHeight: natural.value.height,
      onProgress: (progress, status) => {
        if (token !== ocrToken) return
        ocrProgress.value = progress
        ocrMessage.value = ocrStatusText(status)
      }
    })
    if (token !== ocrToken) return
    ocrTokens.value = result.tokens
    ocrStatus.value = 'ready'
    ocrProgress.value = 1
    ocrMessage.value = result.tokens.length > 0 ? '' : '未识别到文字'
  } catch (err) {
    console.warn('[image-ocr] 识别失败：', err instanceof Error ? err.message : String(err))
    if (token !== ocrToken) return
    ocrStatus.value = 'error'
    ocrProgress.value = 0
    ocrMessage.value = '识别失败'
  }
}

function maybeStartAutoOcr(): void {
  if (ocrAutoStarted || !canUseImage.value) return
  if (natural.value.width * natural.value.height > OCR_AUTO_MAX_PIXELS) return
  ocrAutoStarted = true
  void startOcr('auto')
}

function ocrStatusText(status: string): string {
  if (status.includes('loading language')) return '加载语言'
  if (status.includes('initializing')) return '初始化'
  if (status.includes('recognizing')) return '识别文字'
  if (status.includes('cached')) return '已缓存'
  return '准备识别'
}

function clearCopyTip(): void {
  if (copyTipTimer) {
    clearTimeout(copyTipTimer)
    copyTipTimer = null
  }
  copyTip.value = null
}

function clearOcrSelection(): void {
  selectedOcrIds.value = new Set()
  ocrSelectRect.value = null
  isSelectingOcr.value = false
  ocrSelectionStart = null
  clearCopyTip()
}

function resetOcrState(): void {
  ocrToken += 1
  ocrStatus.value = 'idle'
  ocrProgress.value = 0
  ocrMessage.value = ''
  ocrTokens.value = []
  selectedOcrIds.value = new Set()
  ocrSelectRect.value = null
  copyTip.value = null
  isSelectingOcr.value = false
  ocrSelectionStart = null
  ocrAutoStarted = false
  if (copyTipTimer) {
    clearTimeout(copyTipTimer)
    copyTipTimer = null
  }
}

function pointFromOcrEvent(event: PointerEvent): Point | null {
  const layer = ocrLayerEl.value
  if (!layer || zoom.value <= 0) return null
  const rect = layer.getBoundingClientRect()
  return {
    x: clamp((event.clientX - rect.left) / zoom.value, 0, natural.value.width),
    y: clamp((event.clientY - rect.top) / zoom.value, 0, natural.value.height)
  }
}

function rectFromPoints(a: Point, b: Point): SelectionRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

function selectOcrTokens(rect: SelectionRect): void {
  const selection = rect.width < 2 && rect.height < 2
    ? { x: rect.x - 2, y: rect.y - 2, width: 4, height: 4 }
    : rect
  const ids = ocrTokens.value
    .filter((token) => intersects(selection, token.bbox))
    .map((token) => token.id)
  selectedOcrIds.value = new Set(ids)
}

function intersects(rect: SelectionRect, box: { x0: number; y0: number; x1: number; y1: number }): boolean {
  return (
    box.x1 >= rect.x &&
    box.x0 <= rect.x + rect.width &&
    box.y1 >= rect.y &&
    box.y0 <= rect.y + rect.height
  )
}

function ocrTokenStyle(token: OcrToken): Record<string, string> {
  return {
    left: `${token.bbox.x0 * zoom.value}px`,
    top: `${token.bbox.y0 * zoom.value}px`,
    width: `${Math.max(1, (token.bbox.x1 - token.bbox.x0) * zoom.value)}px`,
    height: `${Math.max(1, (token.bbox.y1 - token.bbox.y0) * zoom.value)}px`
  }
}

function onOcrPointerDown(event: PointerEvent): void {
  if (!canSelectOcr.value || event.button !== 0) return
  const point = pointFromOcrEvent(event)
  if (!point) return
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  clearOcrSelection()
  isSelectingOcr.value = true
  ocrSelectionStart = point
  ocrSelectRect.value = { x: point.x, y: point.y, width: 0, height: 0 }
}

function onOcrPointerMove(event: PointerEvent): void {
  if (!isSelectingOcr.value || !ocrSelectionStart) return
  const point = pointFromOcrEvent(event)
  if (!point) return
  const rect = rectFromPoints(ocrSelectionStart, point)
  ocrSelectRect.value = rect
  selectOcrTokens(rect)
}

function finishOcrSelection(event: PointerEvent): void {
  if (!isSelectingOcr.value) return
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  isSelectingOcr.value = false
  ocrSelectionStart = null
  const rect = ocrSelectRect.value
  if (!rect || !canCopySelectedOcr.value) {
    clearCopyTip()
    return
  }
  copyTip.value = {
    x: clamp((rect.x + rect.width / 2) * zoom.value, 8, natural.value.width * zoom.value - 58),
    y: clamp((rect.y + rect.height) * zoom.value + 8, 8, natural.value.height * zoom.value - 34),
    text: '复制'
  }
}

async function copySelectedOcr(): Promise<void> {
  const text = selectedOcrText.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    if (copyTip.value) copyTip.value = { ...copyTip.value, text: '已复制' }
    ocrMessage.value = '已复制'
    if (copyTipTimer) clearTimeout(copyTipTimer)
    copyTipTimer = setTimeout(() => {
      clearCopyTip()
      if (ocrMessage.value.startsWith('已复制')) ocrMessage.value = ''
    }, 1400)
  } catch {
    ocrMessage.value = '复制失败'
  }
}

async function copyAllOcr(): Promise<void> {
  if (!canCopyAllOcr.value) return
  selectedOcrIds.value = new Set(ocrTokens.value.map((token) => token.id))
  await copySelectedOcr()
  if (ocrMessage.value === '已复制') ocrMessage.value = '已复制全部'
}

async function onImageLoad(event: Event): Promise<void> {
  const token = ++loadToken
  const image = event.currentTarget as HTMLImageElement
  natural.value = {
    width: image.naturalWidth || 1,
    height: image.naturalHeight || 1
  }
  loading.value = false
  broken.value = false
  try {
    const initialZoom = await window.pantry.fitImageViewerWindow(
      natural.value.width,
      natural.value.height
    )
    if (token !== loadToken) return
    zoom.value = clamp(initialZoom, MIN_ZOOM, MAX_ZOOM)
    centerImage()
    viewMode.value = zoom.value < 0.999 ? 'fit' : 'free'
    maybeStartAutoOcr()
  } catch {
    if (token === loadToken) {
      applyFit()
      maybeStartAutoOcr()
    }
  }
}

function onImageError(): void {
  loading.value = false
  broken.value = true
}

function onWheel(event: WheelEvent): void {
  if (!canUseImage.value) return
  if (event.deltaY < 0) zoomIn()
  else zoomOut()
}

function onPointerDown(event: PointerEvent): void {
  if (!canUseImage.value || event.button !== 0) return
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  isDragging.value = true
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    offsetX: offset.value.x,
    offsetY: offset.value.y
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!isDragging.value || !dragStart) return
  const dx = event.clientX - dragStart.x
  const dy = event.clientY - dragStart.y
  offset.value = {
    x: dragStart.offsetX + dx,
    y: dragStart.offsetY + dy
  }
  viewMode.value = 'free'
}

function finishDrag(event: PointerEvent): void {
  if (!isDragging.value) return
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  isDragging.value = false
  dragStart = null
}

function panBy(dx: number, dy: number): void {
  if (!canUseImage.value) return
  offset.value = { x: offset.value.x + dx, y: offset.value.y + dy }
  viewMode.value = 'free'
}

function onKey(event: KeyboardEvent): void {
  const key = event.key
  const saveShortcut = (event.metaKey || event.ctrlKey) && key.toLowerCase() === 's'
  const copyShortcut = (event.metaKey || event.ctrlKey) && key.toLowerCase() === 'c'
  if (key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (copyShortcut && canCopySelectedOcr.value) {
    event.preventDefault()
    void copySelectedOcr()
    return
  }
  if (!canUseImage.value && !saveShortcut) return
  if (key === '+' || key === '=') {
    event.preventDefault()
    zoomIn()
  } else if (key === '-' || key === '_') {
    event.preventDefault()
    zoomOut()
  } else if (key === '0') {
    event.preventDefault()
    applyActualSize()
  } else if (key.toLowerCase() === 'f') {
    event.preventDefault()
    applyFit()
  } else if (key.toLowerCase() === 'r') {
    event.preventDefault()
    rotateImage(event.shiftKey ? -90 : 90)
  } else if (saveShortcut) {
    event.preventDefault()
    void saveAs()
  } else if (key === 'ArrowLeft') {
    event.preventDefault()
    panBy(PAN_STEP, 0)
  } else if (key === 'ArrowRight') {
    event.preventDefault()
    panBy(-PAN_STEP, 0)
  } else if (key === 'ArrowUp') {
    event.preventDefault()
    panBy(0, PAN_STEP)
  } else if (key === 'ArrowDown') {
    event.preventDefault()
    panBy(0, -PAN_STEP)
  }
}

function onResize(): void {
  if (viewMode.value === 'fit' && canUseImage.value) applyFit()
}

function resetState(): void {
  loadToken += 1
  zoom.value = 1
  rotation.value = 0
  offset.value = { x: 0, y: 0 }
  natural.value = { width: 0, height: 0 }
  loading.value = true
  broken.value = false
  saving.value = false
  isDragging.value = false
  viewMode.value = 'fit'
  dragStart = null
  resetOcrState()
}

watch(() => props.src, resetState)

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div class="viewer" aria-label="图片查看器">
    <main
      class="viewer-stage"
      :class="{ grabbing: isDragging }"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="finishDrag"
      @pointercancel="finishDrag"
      @dblclick.stop="toggleActualSize"
    >
      <div v-if="loading" class="viewer-state">图片加载中…</div>
      <div v-else-if="broken" class="viewer-state error">图片不可用</div>
      <div
        class="image-plane"
        :class="{ pending: loading || broken }"
        :style="imageStyle"
      >
        <img
          :src="src"
          class="full"
          alt="[图片]"
          draggable="false"
          @load="onImageLoad"
          @error="onImageError"
        />
        <div
          v-if="ocrTokens.length > 0 || ocrStatus === 'ready'"
          ref="ocrLayerEl"
          class="ocr-layer"
          :class="{ selectable: canSelectOcr, paused: ocrStatus === 'ready' && rotation !== 0 }"
          title="拖选图片文字"
          @pointerdown.stop.prevent="onOcrPointerDown"
          @pointermove.stop.prevent="onOcrPointerMove"
          @pointerup.stop.prevent="finishOcrSelection"
          @pointercancel.stop.prevent="finishOcrSelection"
        >
          <span
            v-for="token in ocrTokens"
            :key="token.id"
            class="ocr-token"
            :class="{ selected: selectedOcrIds.has(token.id) }"
            :style="ocrTokenStyle(token)"
            aria-hidden="true"
          ></span>
          <span v-if="ocrSelectRect" class="ocr-selection" :style="selectionStyle"></span>
          <button
            v-if="copyTip"
            class="ocr-copy"
            type="button"
            :style="copyTipStyle"
            @pointerdown.stop
            @click.stop="copySelectedOcr"
          >
            {{ copyTip.text }}
          </button>
        </div>
      </div>
    </main>

    <footer class="viewer-menu" role="toolbar" aria-label="图片查看工具" @click.stop>
      <span class="zoom-readout">{{ broken ? '不可用' : loading ? '加载中' : zoomLabel }}</span>
      <button class="tool" type="button" title="缩小" :disabled="!canUseImage" @click="zoomOut">
        <PantryIcon name="zoom-out" :size="17" />
      </button>
      <button class="tool" type="button" title="放大" :disabled="!canUseImage" @click="zoomIn">
        <PantryIcon name="zoom-in" :size="17" />
      </button>
      <button
        class="tool"
        :class="{ active: viewMode === 'fit' }"
        type="button"
        title="适应窗口"
        :disabled="!canUseImage"
        :aria-pressed="viewMode === 'fit'"
        @click="applyFit"
      >
        <PantryIcon name="fit-screen" :size="17" />
      </button>
      <button class="tool" type="button" title="原始大小" :disabled="!canUseImage" @click="applyActualSize">
        <PantryIcon name="actual-size" :size="17" />
      </button>
      <span class="tool-divider" aria-hidden="true"></span>
      <button class="tool" type="button" title="向左旋转" :disabled="!canUseImage" @click="rotateImage(-90)">
        <PantryIcon name="rotate-left" :size="17" />
      </button>
      <button class="tool" type="button" title="向右旋转" :disabled="!canUseImage" @click="rotateImage(90)">
        <PantryIcon name="rotate-right" :size="17" />
      </button>
      <span class="tool-divider" aria-hidden="true"></span>
      <button
        class="tool"
        :class="{ active: ocrStatus === 'ready', busy: isOcrBusy }"
        type="button"
        :title="ocrButtonTitle"
        :disabled="!canStartOcr"
        @click="startOcr('manual')"
      >
        <PantryIcon :name="isOcrBusy ? 'loader' : 'text-select'" :size="17" />
      </button>
      <span v-if="ocrStatus !== 'idle'" class="ocr-readout">{{ ocrLabel }}</span>
      <button class="tool" type="button" title="复制全部文字" :disabled="!canCopyAllOcr" @click="copyAllOcr">
        <PantryIcon name="copy" :size="17" />
      </button>
      <span class="tool-divider" aria-hidden="true"></span>
      <button class="tool" type="button" title="另存为" :disabled="saving || !canUseImage" @click="saveAs">
        <PantryIcon :name="saving ? 'loader' : 'save'" :size="17" />
      </button>
    </footer>
  </div>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  color: #f5f7f6;
  background: #111412;
  overflow: hidden;
}
.viewer-menu {
  position: fixed;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  max-width: calc(100vw - 20px);
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 7px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 8px;
  background: rgba(28, 32, 30, 0.68);
  box-shadow:
    0 16px 40px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(18px);
  overflow-x: auto;
  z-index: 2;
}

.zoom-readout {
  min-width: 50px;
  padding: 0 7px 0 5px;
  color: rgba(245, 247, 246, 0.82);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: nowrap;
}
.tool {
  width: 32px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(245, 247, 246, 0.86);
  background: transparent;
  cursor: pointer;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    border-color 0.16s ease,
    transform 0.16s ease;
}
.tool:hover:not(:disabled),
.tool.active {
  color: #ffffff;
  border-color: rgba(91, 191, 145, 0.36);
  background: rgba(91, 191, 145, 0.2);
}
.tool:active:not(:disabled) {
  transform: translateY(1px);
}
.tool:disabled {
  color: rgba(245, 247, 246, 0.28);
  cursor: default;
}
.tool.busy :deep(.pantry-icon) {
  animation: viewer-spin 1s linear infinite;
}
.tool-divider {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: rgba(255, 255, 255, 0.14);
}
.ocr-readout {
  max-width: 116px;
  padding: 0 6px;
  color: rgba(245, 247, 246, 0.72);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.viewer-stage {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 0;
  cursor: default;
  touch-action: none;
}
.viewer-stage.grabbing,
.viewer-stage.grabbing .image-plane {
  cursor: grabbing;
}
.image-plane {
  position: relative;
  max-width: none;
  max-height: none;
  user-select: none;
  transform-origin: center center;
  cursor: grab;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: 0 22px 66px rgba(0, 0, 0, 0.38);
  will-change: transform;
  transition: transform 0.14s cubic-bezier(0.2, 0, 0.2, 1);
}
.image-plane.pending {
  opacity: 0;
  pointer-events: none;
}
.full {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
  border-radius: inherit;
}
.ocr-layer {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  overflow: hidden;
}
.ocr-layer.selectable {
  cursor: default;
  pointer-events: auto;
}
.ocr-layer.paused {
  cursor: not-allowed;
}
.ocr-token {
  position: absolute;
  border-radius: 2px;
  background: rgba(91, 191, 145, 0.08);
  box-shadow: inset 0 0 0 1px rgba(91, 191, 145, 0.24);
  opacity: 0.42;
  pointer-events: none;
}
.ocr-layer.selectable .ocr-token {
  cursor: text;
  pointer-events: auto;
}
.ocr-token.selected {
  background: rgba(91, 191, 145, 0.28);
  box-shadow:
    inset 0 0 0 1px rgba(121, 225, 176, 0.72),
    0 0 0 1px rgba(15, 18, 16, 0.32);
  opacity: 1;
}
.ocr-selection {
  position: absolute;
  border: 1px solid rgba(126, 230, 184, 0.88);
  border-radius: 4px;
  background: rgba(91, 191, 145, 0.16);
  pointer-events: none;
  box-shadow: 0 0 0 1px rgba(12, 16, 14, 0.28);
}
.ocr-copy {
  position: absolute;
  min-width: 48px;
  height: 28px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  padding: 0 10px;
  color: #ffffff;
  background: rgba(34, 39, 36, 0.86);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(14px);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transform: translateX(-50%);
}
.ocr-copy:hover {
  background: rgba(61, 139, 107, 0.92);
}
.viewer-state {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  min-width: 132px;
  padding: 10px 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(28, 32, 30, 0.82);
  color: rgba(245, 247, 246, 0.76);
  font-size: 13px;
  text-align: center;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
}
.viewer-state.error {
  color: #ffb1b5;
  border-color: rgba(255, 107, 114, 0.26);
  background: rgba(54, 24, 27, 0.82);
}

@supports not (backdrop-filter: blur(18px)) {
  .viewer-menu {
    background: #1c201e;
  }
}

@media (max-width: 720px) {
  .viewer-menu {
    bottom: 10px;
    max-width: calc(100vw - 16px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool,
  .image-plane {
    transition: none;
  }
  .tool.busy :deep(.pantry-icon) {
    animation: none;
  }
}

@keyframes viewer-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
