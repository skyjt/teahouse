<script setup lang="ts">
// 大图查看器：纯渲染层缩放/旋转/平移，图片源仍走 pantry-img://，另存为走既有 IPC。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  OCR_AUTO_MAX_PIXELS,
  getCachedOcrResult,
  getOcrResultText,
  isAutoOcrCandidate,
  recognizeImageText,
  type OcrResult
} from '../utils/ocr'
import {
  offsetForAnchoredZoom,
  pointFromImageRect,
  type ImagePoint
} from '../utils/image-viewer-geometry'
import PantryIcon from './PantryIcon.vue'

const props = defineProps<{ src: string; transferId: string }>()
const emit = defineEmits<{ close: [] }>()

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
const ocrTextAreaEl = ref<HTMLTextAreaElement | null>(null)
const loading = ref(true)
const broken = ref(false)
const saving = ref(false)
const isDragging = ref(false)
const viewMode = ref<'fit' | 'free'>('fit')
const ocrStatus = ref<OcrStatus>('idle')
const ocrProgress = ref(0)
const ocrMessage = ref('')
const ocrText = ref('')
const ocrTextPanelOpen = ref(false)
const ocrTextCopied = ref(false)

let dragStart: DragStart | null = null
let ocrAutoStarted = false
let ocrCopyTimer: ReturnType<typeof setTimeout> | null = null
let loadToken = 0
let ocrToken = 0

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
    return ocrTextPanelOpen.value ? '结果已打开' : '已识别文字'
  }
  if (ocrStatus.value === 'error') return ocrMessage.value || '识别失败'
  return '识别文字'
})
const ocrButtonTitle = computed(() => {
  if (isOcrBusy.value) return ocrLabel.value
  if (ocrStatus.value === 'ready' && ocrText.value.trim()) return '查看识别结果'
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

async function startOcr(mode: 'auto' | 'manual' = 'manual'): Promise<void> {
  if (!canStartOcr.value) return
  const openResult = mode === 'manual'
  const token = ++ocrToken
  clearOcrCopyFeedback()
  if (openResult) closeOcrTextPanel()
  const cached = await readCachedOcrResult()
  if (token !== ocrToken) return
  if (cached) {
    applyOcrResult(cached)
    if (openResult) openOcrTextPanel()
    return
  }
  ocrStatus.value = 'loading-source'
  ocrProgress.value = 0
  ocrMessage.value = ''
  ocrText.value = ''
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
      cacheKey: imageOcrCacheKey.value,
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
    await saveCachedOcrResult(result)
    if (token !== ocrToken) return
    applyOcrResult(result)
    if (openResult) openOcrTextPanel()
  } catch (err) {
    console.warn('[image-ocr] 识别失败：', err instanceof Error ? err.message : String(err))
    if (token !== ocrToken) return
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
  if (!cacheKey) return
  try {
    await window.pantry.saveImageOcrResult(props.transferId, cacheKey, result)
  } catch {
    // OCR 缓存失败不影响当前窗口查看文字。
  }
}

function applyOcrResult(result: OcrResult): void {
  ocrText.value = getOcrResultText(result)
  ocrStatus.value = 'ready'
  ocrProgress.value = 1
  ocrMessage.value = ocrText.value.trim() ? '' : '未识别到文字'
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

function clearOcrCopyFeedback(): void {
  if (ocrCopyTimer) {
    clearTimeout(ocrCopyTimer)
    ocrCopyTimer = null
  }
  ocrTextCopied.value = false
}

function resetOcrState(): void {
  ocrToken += 1
  ocrStatus.value = 'idle'
  ocrProgress.value = 0
  ocrMessage.value = ''
  ocrText.value = ''
  ocrTextPanelOpen.value = false
  ocrAutoStarted = false
  clearOcrCopyFeedback()
}

function openOcrTextPanel(): void {
  if (!ocrText.value.trim()) return
  ocrTextPanelOpen.value = true
  clearOcrCopyFeedback()
  window.setTimeout(() => {
    ocrTextAreaEl.value?.focus()
  }, 0)
}

function closeOcrTextPanel(): void {
  ocrTextPanelOpen.value = false
  clearOcrCopyFeedback()
}

function onOcrButtonClick(): void {
  if (ocrStatus.value === 'ready' && ocrText.value.trim()) {
    openOcrTextPanel()
    return
  }
  void startOcr('manual')
}

async function copyAllOcr(): Promise<void> {
  if (!canCopyAllOcr.value) return
  try {
    await navigator.clipboard.writeText(ocrText.value)
    ocrTextCopied.value = true
    ocrMessage.value = '已复制全部'
    if (ocrCopyTimer) clearTimeout(ocrCopyTimer)
    ocrCopyTimer = setTimeout(() => {
      ocrTextCopied.value = false
      if (ocrMessage.value === '已复制全部') ocrMessage.value = ''
    }, 1400)
  } catch {
    ocrMessage.value = '复制失败'
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
    const initialZoom = await window.pantry.fitImageViewerWindow(
      natural.value.width,
      natural.value.height
    )
    if (token !== loadToken) return
    zoom.value = clamp(initialZoom, MIN_ZOOM, MAX_ZOOM)
    centerImage()
    viewMode.value = zoom.value < 0.999 ? 'fit' : 'free'
    const cachedOcr = await readCachedOcrResult()
    if (token !== loadToken) return
    if (cachedOcr) {
      ocrAutoStarted = true
      applyOcrResult(cachedOcr)
    } else {
      maybeStartAutoOcr()
    }
  } catch {
    if (token === loadToken) {
      applyFit()
      const cachedOcr = await readCachedOcrResult()
      if (token !== loadToken) return
      if (cachedOcr) {
        ocrAutoStarted = true
        applyOcrResult(cachedOcr)
      } else {
        maybeStartAutoOcr()
      }
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
    if (ocrTextPanelOpen.value) {
      closeOcrTextPanel()
      return
    }
    emit('close')
    return
  }
  if (isEditableTarget(event.target)) return
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
          :src="src"
          class="full"
          alt="[图片]"
          draggable="false"
          @load="onImageLoad"
          @error="onImageError"
        />
      </div>
    </main>

    <section
      v-if="ocrTextPanelOpen"
      class="ocr-panel"
      role="dialog"
      aria-label="识别结果"
      @pointerdown.stop
      @pointermove.stop
      @pointerup.stop
      @wheel.stop
      @dblclick.stop
    >
      <header class="ocr-panel-head">
        <div class="ocr-panel-title">
          <strong>识别结果</strong>
          <span>{{ ocrText.length }} 字</span>
        </div>
        <button class="panel-close" type="button" title="关闭" @click="closeOcrTextPanel">
          <PantryIcon name="x" :size="16" />
        </button>
      </header>
      <textarea
        ref="ocrTextAreaEl"
        class="ocr-textarea"
        :value="ocrText"
        readonly
        spellcheck="false"
      ></textarea>
      <footer class="ocr-panel-actions">
        <span class="ocr-copy-state">{{ ocrTextCopied ? '已复制' : '' }}</span>
        <button class="ocr-panel-copy" type="button" @click="copyAllOcr">
          <PantryIcon name="copy" :size="15" />
          复制全部
        </button>
      </footer>
    </section>

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
        @click="onOcrButtonClick"
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
.ocr-panel {
  position: fixed;
  top: 14px;
  right: 14px;
  bottom: 70px;
  width: min(420px, calc(100vw - 28px));
  min-height: 220px;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(24, 28, 26, 0.82);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.36);
  backdrop-filter: blur(18px);
  overflow: hidden;
  z-index: 3;
}
.ocr-panel-head {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.11);
}
.ocr-panel-title {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ocr-panel-title strong {
  color: #ffffff;
  font-size: 14px;
  font-weight: 700;
}
.ocr-panel-title span {
  color: rgba(245, 247, 246, 0.56);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.panel-close {
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(245, 247, 246, 0.72);
  background: transparent;
  cursor: pointer;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    border-color 0.16s ease;
}
.panel-close:hover {
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.1);
}
.ocr-textarea {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 0;
  outline: none;
  resize: none;
  padding: 12px 14px;
  color: rgba(245, 247, 246, 0.92);
  background: rgba(8, 10, 9, 0.26);
  font: 13px/1.62 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  letter-spacing: 0;
  white-space: pre-wrap;
  cursor: text;
  user-select: text;
}
.ocr-textarea::selection {
  color: #ffffff;
  background: rgba(61, 139, 107, 0.72);
}
.ocr-panel-actions {
  min-height: 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px 8px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.11);
}
.ocr-copy-state {
  min-width: 42px;
  color: rgba(91, 191, 145, 0.9);
  font-size: 12px;
  white-space: nowrap;
}
.ocr-panel-copy {
  height: 30px;
  border: 1px solid rgba(91, 191, 145, 0.32);
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  color: #ffffff;
  background: rgba(61, 139, 107, 0.78);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  transition:
    background 0.16s ease,
    border-color 0.16s ease,
    transform 0.16s ease;
}
.ocr-panel-copy:hover {
  border-color: rgba(91, 191, 145, 0.5);
  background: rgba(61, 139, 107, 0.92);
}
.ocr-panel-copy:active {
  transform: translateY(1px);
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
  .viewer-menu,
  .ocr-panel {
    background: #1c201e;
  }
}

@media (max-width: 720px) {
  .viewer-menu {
    bottom: 10px;
    max-width: calc(100vw - 16px);
  }
  .ocr-panel {
    top: 10px;
    right: 10px;
    bottom: 64px;
    left: 10px;
    width: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool,
  .image-plane,
  .panel-close,
  .ocr-panel-copy {
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
