<script setup lang="ts">
// 大图查看器：纯渲染层缩放/旋转/平移，图片源仍走 pantry-img://，另存为走既有 IPC。
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  cancelImageTextRecognition,
  disposeImageTextRecognition,
  getCachedOcrResult,
  getOcrResultText,
  recognizeImageText,
  type OcrResult,
  type OcrLine
} from '../utils/ocr'
import {
  offsetForAnchoredZoom,
  pointFromImageRect,
  type ImagePoint
} from '../utils/image-viewer-geometry'
import PantryIcon from './PantryIcon.vue'
import ImageTextLayer from './ImageTextLayer.vue'

const props = defineProps<{
  src: string
  transferId: string
  hasPrevious: boolean
  hasNext: boolean
  navigating: boolean
  navigationError: string
}>()
const emit = defineEmits<{
  close: []
  navigate: [direction: 'previous' | 'next']
  retryNavigation: []
}>()

const MIN_ZOOM = 0.005
const MAX_ZOOM = 6
const ZOOM_STEP = 1.2
const PAN_STEP = 48

type Point = ImagePoint
type DragStart = Point & { offsetX: number; offsetY: number }
type OcrStatus = 'idle' | 'loading-source' | 'recognizing' | 'ready' | 'error'

const zoom = ref(1)
const rotation = ref(0)
const offset = ref<Point>({ x: 0, y: 0 })
const natural = ref({ width: 0, height: 0 })
const imagePlaneEl = ref<HTMLElement | null>(null)
const textLayerEl = ref<InstanceType<typeof ImageTextLayer> | null>(null)
const loading = ref(true)
const broken = ref(false)
const saving = ref(false)
const isDragging = ref(false)
const viewMode = ref<'fit' | 'free'>('fit')
const ocrStatus = ref<OcrStatus>('idle')
const ocrProgress = ref(0)
const ocrMessage = ref('')
const ocrText = ref('')
const ocrLines = shallowRef<OcrLine[]>([])
const textLayerVisible = ref(false)
const hasTextSelection = ref(false)

let dragStart: DragStart | null = null
let ocrCopyTimer: ReturnType<typeof setTimeout> | null = null
let loadToken = 0
let ocrToken = 0
let windowFitted = false

const canUseImage = computed(() => !loading.value && !broken.value)
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`)
const isOcrBusy = computed(() => ocrStatus.value === 'loading-source' || ocrStatus.value === 'recognizing')
const canStartOcr = computed(() => canUseImage.value && !isOcrBusy.value)
const canCopyAllOcr = computed(() => ocrStatus.value === 'ready' && ocrText.value.trim().length > 0)
const imageOcrCacheKey = computed(() => {
  if (!props.transferId || natural.value.width <= 0 || natural.value.height <= 0) return ''
  return `${props.transferId}:${natural.value.width}x${natural.value.height}`
})
const ocrLabel = computed(() => {
  if (ocrStatus.value === 'loading-source') return '准备识别'
  if (ocrStatus.value === 'recognizing') return `识别中 ${Math.round(ocrProgress.value * 100)}%`
  if (ocrStatus.value === 'ready') {
    if (ocrMessage.value) return ocrMessage.value
    if (!ocrText.value.trim()) return '未识别到文字'
    return textLayerVisible.value ? '可在图上选字' : '文字选择已隐藏'
  }
  if (ocrStatus.value === 'error') return ocrMessage.value || '识别失败'
  return '识别文字'
})
const ocrButtonTitle = computed(() => {
  if (isOcrBusy.value) return '取消识别'
  if (ocrStatus.value === 'ready' && ocrLines.value.length) {
    return textLayerVisible.value ? '隐藏文字选择层' : '显示文字选择层'
  }
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
    left: `calc(50% + ${offset.value.x}px)`,
    top: `calc(50% + ${offset.value.y}px)`,
    transform: `translate3d(-50%, -50%, 0) rotate(${rotation.value}deg)`
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

function pointFromImageClient(clientX: number, clientY: number): Point | null {
  const plane = imagePlaneEl.value
  if (!plane || zoom.value <= 0 || rotation.value !== 0) return null
  const rect = plane.getBoundingClientRect()
  return pointFromImageRect({
    clientX,
    clientY,
    rect,
    zoom: zoom.value,
    naturalWidth: natural.value.width,
    naturalHeight: natural.value.height
  })
}

function applyZoomAroundPoint(nextZoom: number, imagePoint: Point, clientPoint: Point): void {
  const next = offsetForAnchoredZoom({
    clientPoint,
    imagePoint,
    naturalWidth: natural.value.width,
    naturalHeight: natural.value.height,
    nextZoom,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM
  })
  zoom.value = next.zoom
  offset.value = next.offset
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

function toggleActualSize(event?: MouseEvent): void {
  if (viewMode.value === 'fit' || Math.abs(zoom.value - fitScale()) < 0.01) {
    if (event) {
      const imagePoint = pointFromImageClient(event.clientX, event.clientY)
      if (imagePoint) {
        applyZoomAroundPoint(1, imagePoint, { x: event.clientX, y: event.clientY })
        return
      }
    }
    applyActualSize()
  } else {
    applyFit()
  }
}

function rotateImage(delta: number): void {
  rotation.value = (rotation.value + delta + 360) % 360
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

async function startOcr(): Promise<void> {
  if (!canStartOcr.value) return
  const token = ++ocrToken
  clearOcrCopyFeedback()
  ocrStatus.value = 'loading-source'
  ocrProgress.value = 0
  ocrMessage.value = ''
  try {
    const cached = await readCachedOcrResult()
    if (token !== ocrToken) return
    if (cached && getOcrResultText(cached)) {
      applyOcrResult(cached)
      return
    }
    const source = await window.pantry.getImageOcrSource(props.transferId)
    if (token !== ocrToken) return
    if (!source) {
      ocrStatus.value = 'error'
      ocrMessage.value = '无法读取图片'
      return
    }
    ocrStatus.value = 'recognizing'
    const result = await recognizeImageText({
      cacheKey: imageOcrCacheKey.value,
      source,
      naturalWidth: natural.value.width,
      naturalHeight: natural.value.height,
      onProgress: (progress) => {
        if (token === ocrToken) ocrProgress.value = progress
      }
    })
    if (token !== ocrToken) return
    await saveCachedOcrResult(result)
    if (token === ocrToken) applyOcrResult(result)
  } catch (err) {
    if (token !== ocrToken) return
    console.warn('[image-ocr] 识别失败：', err instanceof Error ? err.message : String(err))
    ocrStatus.value = 'error'
    ocrProgress.value = 0
    ocrMessage.value = '识别失败'
  }
}

function cachedOcrResult(): OcrResult | null {
  const cacheKey = imageOcrCacheKey.value
  return cacheKey ? getCachedOcrResult(cacheKey) : null
}

async function readCachedOcrResult(): Promise<OcrResult | null> {
  const local = cachedOcrResult()
  if (local) return local
  const cacheKey = imageOcrCacheKey.value
  if (!cacheKey) return null
  try {
    return await window.pantry.getImageOcrResult(props.transferId, cacheKey)
  } catch {
    return null
  }
}

async function saveCachedOcrResult(result: OcrResult): Promise<void> {
  const cacheKey = imageOcrCacheKey.value
  if (!cacheKey || !getOcrResultText(result)) return
  try {
    await window.pantry.saveImageOcrResult(props.transferId, cacheKey, result)
  } catch {
    // OCR 缓存失败不影响当前窗口查看文字。
  }
}

function applyOcrResult(result: OcrResult): void {
  ocrText.value = getOcrResultText(result)
  ocrLines.value = result.lines
  textLayerVisible.value = result.lines.length > 0
  ocrStatus.value = 'ready'
  ocrProgress.value = 1
  ocrMessage.value = ocrText.value.trim() ? '' : '未识别到文字'
}

function clearOcrCopyFeedback(): void {
  if (ocrCopyTimer) {
    clearTimeout(ocrCopyTimer)
    ocrCopyTimer = null
  }
}

function resetOcrState(): void {
  ocrToken += 1
  cancelImageTextRecognition()
  textLayerEl.value?.clearSelection()
  ocrStatus.value = 'idle'
  ocrProgress.value = 0
  ocrMessage.value = ''
  ocrText.value = ''
  ocrLines.value = []
  textLayerVisible.value = false
  hasTextSelection.value = false
  clearOcrCopyFeedback()
}

function onOcrButtonClick(): void {
  if (isOcrBusy.value) {
    resetOcrState()
  } else if (ocrStatus.value === 'ready' && ocrLines.value.length) {
    textLayerEl.value?.clearSelection()
    hasTextSelection.value = false
    textLayerVisible.value = !textLayerVisible.value
  } else {
    void startOcr()
  }
}

async function copyOcr(selected: boolean): Promise<void> {
  if (selected ? !hasTextSelection.value : !canCopyAllOcr.value) return
  const token = ocrToken
  try {
    if (selected) await textLayerEl.value?.copySelection()
    else await navigator.clipboard.writeText(ocrText.value)
    if (token !== ocrToken) return
    ocrMessage.value = selected ? '已复制所选文字' : '已复制全部'
    clearOcrCopyFeedback()
    ocrCopyTimer = setTimeout(() => { ocrMessage.value = '' }, 1400)
  } catch {
    if (token === ocrToken) ocrMessage.value = '复制失败'
  }
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
    const initialZoom = windowFitted
      ? fitScale()
      : await window.pantry.fitImageViewerWindow(natural.value.width, natural.value.height)
    if (token !== loadToken) return
    windowFitted = true
    zoom.value = clamp(initialZoom, MIN_ZOOM, MAX_ZOOM)
    centerImage()
    viewMode.value = zoom.value < 0.999 ? 'fit' : 'free'
    const cachedOcr = await readCachedOcrResult()
    if (token !== loadToken) return
    if (cachedOcr) applyOcrResult(cachedOcr)
  } catch {
    if (token === loadToken) {
      applyFit()
      const cachedOcr = await readCachedOcrResult()
      if (token !== loadToken) return
      if (cachedOcr) applyOcrResult(cachedOcr)
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
  textLayerEl.value?.clearSelection()
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

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable
}

function onKey(event: KeyboardEvent): void {
  const key = event.key
  const saveShortcut = (event.metaKey || event.ctrlKey) && key.toLowerCase() === 's'
  if (key === 'Escape') {
    event.preventDefault()
    if (hasTextSelection.value) {
      textLayerEl.value?.clearSelection()
      return
    }
    emit('close')
    return
  }
  if (isEditableTarget(event.target)) return
  if (hasTextSelection.value && event.key.startsWith('Arrow')) return
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
  loadToken += 1
  resetOcrState()
  disposeImageTextRecognition()
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
      @dblclick.stop="toggleActualSize($event)"
    >
      <div v-if="loading" class="viewer-state">图片加载中…</div>
      <div v-else-if="broken" class="viewer-state error">图片不可用</div>
      <div
        ref="imagePlaneEl"
        class="image-plane"
        :class="{ pending: loading || broken }"
        :style="imageStyle"
      >
        <img
          :key="src"
          :src="src"
          class="full"
          alt="[图片]"
          draggable="false"
          @load="onImageLoad"
          @error="onImageError"
        />
        <ImageTextLayer
          v-if="textLayerVisible && canUseImage"
          :key="src"
          ref="textLayerEl"
          :lines="ocrLines"
          :width="natural.width"
          :height="natural.height"
          :zoom="zoom"
          @selection-change="hasTextSelection = $event"
        />
      </div>
    </main>

    <nav class="viewer-navigation" aria-label="聊天图片切换" :aria-busy="navigating">
      <button
        class="navigate previous"
        type="button"
        title="上一张"
        aria-label="上一张"
        :disabled="!hasPrevious || navigating"
        @click="emit('navigate', 'previous')"
      >
        <PantryIcon name="chevron-left" :size="24" />
      </button>
      <button
        class="navigate next"
        type="button"
        title="下一张"
        aria-label="下一张"
        :disabled="!hasNext || navigating"
        @click="emit('navigate', 'next')"
      >
        <PantryIcon name="chevron-right" :size="24" />
      </button>
    </nav>
    <div v-if="navigationError" class="navigation-error" role="status">
      {{ navigationError }}
      <button type="button" :disabled="navigating" @click="emit('retryNavigation')">重试</button>
    </div>

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
        :class="{ active: textLayerVisible, busy: isOcrBusy }"
        type="button"
        :title="ocrButtonTitle"
        :disabled="!canUseImage"
        :aria-label="ocrButtonTitle"
        :aria-pressed="textLayerVisible"
        @click="onOcrButtonClick"
      >
        <PantryIcon :name="isOcrBusy ? 'loader' : 'text-select'" :size="17" />
      </button>
      <span v-if="ocrStatus !== 'idle'" class="ocr-readout">{{ ocrLabel }}</span>
      <button
        v-if="hasTextSelection"
        class="tool copy-selection"
        type="button"
        title="复制所选文字"
        @pointerdown.prevent
        @click="copyOcr(true)"
      >复制所选</button>
      <button class="tool" type="button" title="复制全部文字" :disabled="!canCopyAllOcr" @pointerdown.prevent @click="copyOcr(false)">
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
.navigate {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: inherit;
  background: var(--scrim);
  border: 1px solid var(--offline);
  border-radius: var(--radius-pill);
  cursor: pointer;
  z-index: 2;
}
.navigate.previous { left: 14px; }
.navigate.next { right: 14px; }
.navigate:hover:not(:disabled) { background: var(--primary); }
.navigate:focus-visible,
.navigation-error button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 3px;
}
.navigate:disabled {
  opacity: 0.3;
  cursor: default;
}
.navigation-error {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 12px;
  background: var(--scrim);
  border-radius: var(--radius-control);
  font-size: var(--font-sm);
  z-index: 2;
}
.navigation-error button {
  margin-left: 8px;
  color: inherit;
  background: transparent;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
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
.copy-selection {
  width: auto;
  flex-shrink: 0;
  padding: 0 8px;
  font-size: var(--font-xs);
  white-space: nowrap;
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
  position: absolute;
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
