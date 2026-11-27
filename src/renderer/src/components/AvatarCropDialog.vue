<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AvatarSourcePick } from '../../../shared/ipc'
import {
  avatarMaxZoom,
  clampAvatarOffset,
  renderAvatarWebp,
  type AvatarCropState
} from '../utils/avatar-crop'
import PantryIcon from './PantryIcon.vue'

const VIEWPORT = 240
// 等比步进：缩放感知按倍率而非增量，大上限（大图可达数十倍）下每步幅度稳定（决议 #249）
const ZOOM_STEP = 1.12
const props = defineProps<{
  source: Extract<AvatarSourcePick, { ok: true }>
  title?: string
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ close: []; apply: [bytes: ArrayBuffer] }>()

const dialog = ref<HTMLElement | null>(null)
const imageLoaded = ref(false)
const imageUrl = ref('')
const zoom = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const localError = ref('')
const dragging = ref(false)
let dragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

const cropState = computed<AvatarCropState>(() => ({
  imageWidth: props.source.width,
  imageHeight: props.source.height,
  viewportSize: VIEWPORT,
  zoom: zoom.value,
  offsetX: offsetX.value,
  offsetY: offsetY.value
}))
const scale = computed(
  () =>
    Math.max(VIEWPORT / cropState.value.imageWidth, VIEWPORT / cropState.value.imageHeight) *
    zoom.value
)
// 最大缩放随源图短边放宽，允许裁到 192px 输出分辨率对应的最小区域（决议 #249）
const maxZoom = computed(() => avatarMaxZoom(props.source.width, props.source.height))
const imageStyle = computed(() => ({
  width: `${cropState.value.imageWidth * scale.value}px`,
  height: `${cropState.value.imageHeight * scale.value}px`,
  transform: `translate(calc(-50% + ${offsetX.value}px), calc(-50% + ${offsetY.value}px))`
}))
const visibleError = computed(() => localError.value || props.error || '')

function clampOffsets(): void {
  const next = clampAvatarOffset(cropState.value)
  offsetX.value = next.x
  offsetY.value = next.y
}

function reset(): void {
  zoom.value = 1
  offsetX.value = 0
  offsetY.value = 0
  localError.value = ''
}

function imageReady(): void {
  imageLoaded.value = true
  localError.value = ''
  clampOffsets()
}

function imageFailed(): void {
  imageLoaded.value = false
  localError.value = tr('无法解码这张图片')
}

function setZoom(next: number, event?: WheelEvent): void {
  if (props.busy) return
  const previous = zoom.value
  zoom.value = Math.max(1, Math.min(maxZoom.value, next))
  if (event && previous !== zoom.value) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const pointX = event.clientX - rect.left - VIEWPORT / 2
    const pointY = event.clientY - rect.top - VIEWPORT / 2
    const ratio = zoom.value / previous
    offsetX.value = pointX - (pointX - offsetX.value) * ratio
    offsetY.value = pointY - (pointY - offsetY.value) * ratio
  }
  clampOffsets()
}

function startDrag(event: MouseEvent): void {
  if (props.busy || !imageLoaded.value || event.button !== 0 || dragStart) return
  event.preventDefault()
  dragging.value = true
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    offsetX: offsetX.value,
    offsetY: offsetY.value
  }
}

function moveDrag(event: MouseEvent): void {
  if (!dragStart) return
  event.preventDefault()
  offsetX.value = dragStart.offsetX + event.clientX - dragStart.x
  offsetY.value = dragStart.offsetY + event.clientY - dragStart.y
  clampOffsets()
}

function endDrag(): void {
  dragging.value = false
  dragStart = null
}

function requestClose(): void {
  if (!props.busy) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') requestClose()
}

async function apply(): Promise<void> {
  if (!imageLoaded.value || props.busy) return
  localError.value = ''
  try {
    emit(
      'apply',
      await renderAvatarWebp(props.source.bytes, props.source.mime, cropState.value)
    )
  } catch (error) {
    localError.value = error instanceof Error ? error.message : tr('处理图片失败')
  }
}

watch(zoom, clampOffsets)

onMounted(async () => {
  imageUrl.value = URL.createObjectURL(new Blob([props.source.bytes], { type: props.source.mime }))
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('mousemove', moveDrag)
  window.addEventListener('mouseup', endDrag)
  window.addEventListener('blur', endDrag)
  await nextTick()
  dialog.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousemove', moveDrag)
  window.removeEventListener('mouseup', endDrag)
  window.removeEventListener('blur', endDrag)
  endDrag()
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
  returnFocus?.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="crop-mask" role="presentation" @mousedown.self="requestClose">
      <section
        ref="dialog"
        class="crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-crop-title"
        tabindex="-1"
      >
        <header>
          <div>
            <h2 id="avatar-crop-title">{{ title || tr('调整头像') }}</h2>
            <p>{{ tr('拖动图片并缩放，让头像落在圆形区域内。') }}</p>
          </div>
          <button class="icon-control compact-icon" :title="tr('关闭')" :disabled="busy" @click="requestClose">
            <PantryIcon name="x" size="compact" />
          </button>
        </header>

        <div
          class="crop-stage"
          :class="{ dragging }"
          @mousedown="startDrag"
          @wheel.prevent="setZoom(zoom * ($event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), $event)"
        >
          <img
            :src="imageUrl"
            :style="imageStyle"
            :alt="tr('待裁剪头像')"
            draggable="false"
            @load="imageReady"
            @error="imageFailed"
          />
          <div class="crop-shade" aria-hidden="true"></div>
          <div class="crop-circle" aria-hidden="true"></div>
        </div>

        <div class="zoom-row">
          <button class="icon-control compact-icon" :title="tr('缩小')" :disabled="busy || zoom <= 1" @click="setZoom(zoom / ZOOM_STEP)">
            <PantryIcon name="minus" size="compact" />
          </button>
          <input
            :value="Math.round(zoom * 100)"
            type="range"
            min="100"
            :max="Math.round(maxZoom * 100)"
            step="1"
            :aria-label="tr('头像缩放')"
            :disabled="busy || maxZoom <= 1"
            @input="setZoom(Number(($event.target as HTMLInputElement).value) / 100)"
          />
          <button class="icon-control compact-icon" :title="tr('放大')" :disabled="busy || zoom >= maxZoom" @click="setZoom(zoom * ZOOM_STEP)">
            <PantryIcon name="plus" size="compact" />
          </button>
          <button class="reset" :disabled="busy" @click="reset">{{ tr('重置') }}</button>
        </div>

        <p v-if="visibleError" class="crop-error" role="alert">{{ visibleError }}</p>
        <footer>
          <button class="secondary" :disabled="busy" @click="requestClose">{{ tr('取消') }}</button>
          <button class="primary" :disabled="busy || !imageLoaded" @click="apply">
            {{ busy ? tr('正在保存…') : tr('应用头像') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.crop-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--scrim);
}
.crop-dialog {
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--bg-window);
  color: var(--text-1);
  box-shadow: var(--shadow-float);
  padding: 16px;
  outline: none;
}
header,
footer,
.zoom-row {
  display: flex;
  align-items: center;
}
header {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
h2,
p {
  margin: 0;
}
h2 {
  font-size: 16px;
}
header p {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 12px;
}
.crop-stage {
  position: relative;
  width: 240px;
  height: 240px;
  margin: 0 auto;
  overflow: hidden;
  border-radius: var(--radius-panel);
  background: var(--bg-list);
  cursor: grab;
  touch-action: none;
}
.crop-stage.dragging {
  cursor: grabbing;
}
.crop-stage img {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  user-select: none;
  pointer-events: none;
}
.crop-shade,
.crop-circle {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
}
.crop-shade {
  box-shadow: 0 0 0 9999px rgba(10, 18, 24, 0.56);
}
.crop-circle {
  border: 2px solid rgba(255, 255, 255, 0.92);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.16);
}
.zoom-row {
  gap: 8px;
  margin-top: 12px;
}
.zoom-row .reset {
  height: var(--control-square-sm);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-window);
  color: var(--text-2);
  cursor: pointer;
  padding: 0 8px;
  font-size: 12px;
}
.zoom-row input {
  min-width: 0;
  flex: 1;
  accent-color: var(--primary);
}
button:disabled {
  cursor: default;
  opacity: 0.52;
}
.crop-error {
  min-height: 18px;
  margin-top: 8px;
  color: var(--danger);
  font-size: 12px;
}
footer {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
footer button {
  height: 32px;
  border-radius: var(--radius-panel);
  padding: 0 12px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
footer .secondary {
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-2);
}
footer .primary {
  border: 1px solid var(--primary);
  background: var(--primary);
  color: var(--on-primary);
}
</style>
