<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import { tr } from './utils/i18n'
import PantryIcon from './components/PantryIcon.vue'
import { isPlainEscape } from './utils/escape'
import { applyPerformanceProfile } from './utils/performance-profile'
import { SCREEN_MAX_FRAME_BYTES, SCREEN_MAX_PIXELS } from '../../shared/protocol'
import { isScreenMode, type ScreenImage, type ScreenSample, type ScreenSource, type ScreenState } from '../../shared/remote-view'

const state = ref<ScreenState | null>(null)
const sources = ref<ScreenSource[]>([])
const selected = ref('')
const selecting = ref(false)
const preparing = ref(false)
const fit = ref(true)
const received = ref(false)
const stale = ref(false)
const picture = ref<HTMLElement | null>(null)
const viewport = ref<HTMLElement | null>(null)
const error = ref('')
const sourceName = ref('')
const subscriptions: Array<() => void> = []
let stream: MediaStream | null = null
let video: HTMLVideoElement | null = null
let encoder: HTMLCanvasElement | null = null
let sampling = false
let displayCanvas: HTMLCanvasElement | null = null
let lastSampleAt = 0
let captureFps = 10
let slowerSamples = 0
let slowerFps = 10
let adjustingCapture = false
let canAdjustCapture = true
let displaying = false
let disposed = false
let generation = 0
let staleTimer: ReturnType<typeof setTimeout> | undefined
let pan: { x: number; y: number; left: number; top: number } | null = null
const sharer = computed(() => state.value?.role === 'sharer')
const compact = computed(() => sharer.value && state.value?.phase !== 'awaiting-consent')
const title = computed(() => sharer.value
  ? tr('{0} 正在查看你的屏幕', { 0: state.value?.peerName ?? '' })
  : tr('查看 {0} 的屏幕', { 0: state.value?.peerName ?? '' }))
watchEffect(() => { document.title = tr('屏幕协助') })

function live(id: string, run: number): boolean {
  return !disposed && run === generation && state.value?.sessionId === id && state.value.phase !== 'ended'
}
function acceptState(next: ScreenState | null): void {
  if (!next || disposed || (state.value && next.revision < state.value.revision)) return
  state.value = next
  if (next.phase === 'ended') cleanup()
}
function cleanup(): void {
  generation += 1
  clearTimeout(staleTimer)
  stale.value = false
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  if (video) { video.pause(); video.srcObject = null; video.remove(); video = null }
  if (encoder) { encoder.width = encoder.height = 0; encoder = null }
  if (displayCanvas) displayCanvas.width = displayCanvas.height = 0
  displayCanvas = null
  picture.value?.replaceChildren()
  sources.value = []
  received.value = false
}
function stop(): void {
  const id = state.value?.sessionId
  cleanup()
  if (id) void window.pantry.stopScreen(id)
}
function decline(): void {
  if (state.value) void window.pantry.respondScreen(state.value.sessionId, false)
}
function fail(id: string, reason: 'permission-denied' | 'capture-failed' = 'capture-failed'): void {
  cleanup()
  void window.pantry.failScreen(id, reason)
}
async function choose(): Promise<void> {
  if (!state.value || selecting.value) return
  selecting.value = true
  error.value = ''
  const id = state.value.sessionId
  const run = generation
  try {
    const result = await window.pantry.getScreenSources(id)
    if (live(id, run)) sources.value = result
  } catch { if (live(id, run)) error.value = tr('无法获取屏幕，请重试') }
  finally { selecting.value = false }
}
async function share(): Promise<void> {
  if (!state.value || !selected.value || preparing.value) return
  const id = state.value.sessionId
  const run = generation
  sourceName.value = sources.value.find(source => source.id === selected.value)?.name ?? ''
  preparing.value = true
  try {
    if (!await window.pantry.respondScreen(id, true, selected.value) || !live(id, run)) return
    sources.value = []
    const media = await navigator.mediaDevices.getDisplayMedia({ audio: false,
      video: { frameRate: { ideal: 10, max: 10 }, width: { ideal: 1600, max: 1600 }, height: { ideal: 1600, max: 1600 } } })
    if (!live(id, run)) { media.getTracks().forEach(track => track.stop()); return }
    stream = media
    media.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (live(id, run)) fail(id)
    }, { once: true }))
    video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = media
    await video.play()
    if (!live(id, run)) return
    if (!video.videoWidth || !video.videoHeight) throw new Error('屏幕帧不可用')
    encoder = document.createElement('canvas')
    if (!await window.pantry.screenReady(id)) cleanup()
  } catch (cause) {
    if (live(id, run)) fail(id, cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'permission-denied' : 'capture-failed')
  } finally { preparing.value = false }
}
function adjustCaptureRate(): void {
  const now = performance.now()
  const interval = lastSampleAt ? now - lastSampleAt : 100
  lastSampleAt = now
  // ponytail: 用本机请求节奏近似采集需求；目标机出现抖动时再校准阈值。
  const fps = interval >= 280 ? 3 : interval >= 160 ? 5 : 10
  slowerSamples = fps < captureFps ? (fps === slowerFps ? slowerSamples + 1 : 1) : 0
  slowerFps = fps
  const track = stream?.getVideoTracks()[0]
  if (!track || !canAdjustCapture || adjustingCapture || fps === captureFps || (fps < captureFps && slowerSamples < 3)) return
  adjustingCapture = true
  void track.applyConstraints({ width: { ideal: 1600, max: 1600 }, height: { ideal: 1600, max: 1600 },
    frameRate: { ideal: fps, max: fps } }).then(() => { captureFps = fps }, () => {
    // 不支持动态约束的桌面保留当前可用采集，取帧/编码仍受单帧背压限制。
    canAdjustCapture = false
  }).finally(() => { adjustingCapture = false })
}
async function sample(request: ScreenSample): Promise<void> {
  const run = generation
  if (!live(request.sessionId, run) || !stream || !video || !encoder || sampling) return
  sampling = true
  adjustCaptureRate()
  try {
    for (const [edge, quality] of [[1600, 0.60], [1600, 0.50], [1280, 0.50]]) {
      const ratio = Math.min(1, edge / Math.max(video.videoWidth, video.videoHeight), Math.sqrt(SCREEN_MAX_PIXELS / (video.videoWidth * video.videoHeight)))
      const width = Math.max(1, Math.floor(video.videoWidth * ratio))
      const height = Math.max(1, Math.floor(video.videoHeight * ratio))
      if (encoder.width !== width) encoder.width = width
      if (encoder.height !== height) encoder.height = height
      const context = encoder.getContext('2d', { alpha: false })
      if (!context) throw new Error('画布不可用')
      context.drawImage(video, 0, 0, width, height)
      const blob = await new Promise<Blob | null>(resolve => encoder!.toBlob(resolve, 'image/jpeg', quality))
      if (!live(request.sessionId, run)) return
      if (!blob) throw new Error('编码失败')
      if (blob.size > SCREEN_MAX_FRAME_BYTES) continue
      const bytes = await blob.arrayBuffer()
      if (!live(request.sessionId, run)) return
      await window.pantry.sendScreenFrame(request.sessionId, request.seq, bytes)
      return
    }
    fail(request.sessionId)
  } catch { if (live(request.sessionId, run)) fail(request.sessionId) }
  finally { sampling = false }
}
async function display(image: ScreenImage): Promise<void> {
  const run = generation
  if (!live(image.sessionId, run) || !picture.value || displaying) return
  displaying = true
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(new Blob([image.bytes], { type: 'image/jpeg' }))
    if (!live(image.sessionId, run) || !picture.value) return
    if (bitmap.width !== image.width || bitmap.height !== image.height) throw new Error('画面尺寸不符')
    const target = displayCanvas ??= document.createElement('canvas')
    if (target.width !== image.width) target.width = image.width
    if (target.height !== image.height) target.height = image.height
    const direct = target.getContext('bitmaprenderer')
    if (direct) direct.transferFromImageBitmap(bitmap)
    else {
      const context = target.getContext('2d', { alpha: false })
      if (!context) throw new Error('画布不可用')
      context.drawImage(bitmap, 0, 0)
    }
    target.setAttribute('role', 'img')
    target.setAttribute('aria-label', title.value)
    if (!target.parentNode) picture.value.appendChild(target)
    received.value = true
    stale.value = false
    clearTimeout(staleTimer)
    staleTimer = setTimeout(() => { if (live(image.sessionId, run)) stale.value = true }, 2000)
    // 解码图替换后消费；最小化时不等待可能暂停的 requestAnimationFrame。
    await window.pantry.consumeScreenFrame(image.sessionId, image.seq)
  } catch { if (live(image.sessionId, run)) fail(image.sessionId) }
  finally {
    bitmap?.close()
    displaying = false
  }
}
function changeMode(event: Event): void {
  const mode = (event.target as HTMLSelectElement).value
  if (state.value && isScreenMode(mode)) void window.pantry.setScreenMode(state.value.sessionId, mode)
}
function keydown(event: KeyboardEvent): void {
  if (!isPlainEscape(event)) return
  if (event.target instanceof HTMLSelectElement) return
  event.preventDefault()
  stop()
}
function startPan(event: PointerEvent): void {
  if (fit.value || event.button !== 0 || !viewport.value) return
  pan = { x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop }
  viewport.value.setPointerCapture(event.pointerId)
}
function movePan(event: PointerEvent): void {
  if (!pan || !viewport.value) return
  viewport.value.scrollLeft = pan.left + pan.x - event.clientX
  viewport.value.scrollTop = pan.top + pan.y - event.clientY
}

onMounted(async () => {
  subscriptions.push(window.pantry.onScreenState(acceptState), window.pantry.onScreenSample(request => { void sample(request) }),
    window.pantry.onScreenImage(image => { void display(image) }), window.pantry.onSettingsUpdated(settings => {
      document.documentElement.dataset.theme = settings.theme
    }))
  document.addEventListener('keydown', keydown)
  acceptState(await window.pantry.getScreenState())
  if (state.value?.role === 'viewer') await window.pantry.screenReady(state.value.sessionId)
  const [settings, info] = await Promise.all([window.pantry.getSettings(), window.pantry.getAppInfo()])
  if (disposed) return
  document.documentElement.dataset.theme = settings.theme
  applyPerformanceProfile(info)
})
onUnmounted(() => { disposed = true; cleanup(); subscriptions.forEach(stop => stop()); document.removeEventListener('keydown', keydown) })
window.addEventListener('beforeunload', cleanup, { once: true })
</script>

<template>
  <main v-if="state" class="remote" :class="{ sharing: sharer, compact }">
    <header class="toolbar">
      <span class="screen-icon" aria-hidden="true"><PantryIcon name="screen" :size="20" /></span>
      <div class="identity" :title="`${state.peerName} · ${state.peerIp}${sourceName ? ' · ' + sourceName : ''}`"><strong>{{ compact ? (state.phase === 'active' ? tr('正在共享屏幕') : tr('正在准备屏幕连接…')) : tr('屏幕协助') }}</strong><span>{{ state.peerName }}<template v-if="!compact"> · {{ state.peerIp }}</template></span></div>
      <button v-if="state.phase !== 'awaiting-consent'" class="stop" @click="stop">{{ state.phase === 'requesting' || state.phase === 'preparing' ? tr('取消') : sharer ? tr('停止共享') : tr('结束查看') }}</button>
    </header>
    <section v-if="sharer && state.phase === 'awaiting-consent'" class="consent" aria-live="polite">
      <div class="selection-body">
        <h1>{{ tr('{0} 想查看你的屏幕', { 0: state.peerName }) }}</h1>
        <p>{{ tr('仅查看本次选择的屏幕，你可以随时停止。') }}</p>
        <div v-if="sources.length" class="sources" role="radiogroup" :aria-label="tr('选择屏幕')">
          <label v-for="source in sources" :key="source.id" :class="{ selected: selected === source.id }">
            <input v-model="selected" type="radio" name="source" :value="source.id" />
            <img :src="source.thumbnail" alt="" />
            <span>{{ source.name }}</span>
          </label>
        </div>
        <p v-if="error" role="alert">{{ error }}</p>
      </div>
      <div class="actions">
        <button @click="decline">{{ tr('拒绝') }}</button>
        <button v-if="!sources.length" class="primary" :disabled="selecting" @click="choose">{{ selecting ? tr('正在获取屏幕…') : tr('选择屏幕') }}</button>
        <button v-else class="primary" :disabled="!selected || preparing" @click="share">{{ tr('开始共享') }}</button>
      </div>
    </section>
    <template v-else-if="!sharer">
      <div class="controls">
        <label>{{ tr('流畅度') }}
          <select :value="state.mode" @change="changeMode">
            <option value="auto">{{ tr('自动') }}</option>
            <option value="economy">{{ tr('节省资源（3 帧/秒）') }}</option>
            <option value="standard">{{ tr('标准（5 帧/秒）') }}</option>
            <option value="smooth">{{ tr('流畅（10 帧/秒）') }}</option>
          </select>
        </label>
        <span class="target">{{ tr('目标 {0} 帧/秒', { 0: state.targetFps }) }}</span>
        <div class="zoom" role="group" :aria-label="tr('画面大小')">
          <button :aria-pressed="fit" @click="fit = true">{{ tr('适应窗口') }}</button>
          <button :aria-pressed="!fit" @click="fit = false">100%</button>
        </div>
      </div>
      <div class="screen-area">
        <div ref="viewport" class="viewport" :class="{ fit }" tabindex="0" :aria-label="title"
          @pointerdown="startPan" @pointermove="movePan" @pointerup="pan = null" @lostpointercapture="pan = null" @contextmenu.prevent>
          <div ref="picture" class="picture"></div>
          <p v-if="!received" class="waiting" role="status"><PantryIcon name="screen" :size="32" /><span>{{ state.phase === 'requesting' ? tr('等待对方同意…') : tr('正在连接屏幕…') }}</span></p>
        </div>
        <p v-if="stale" class="stale" role="status">{{ tr('画面暂未更新') }}</p>
      </div>
      <footer>{{ tr('仅查看画面，可通过聊天指导对方操作') }}</footer>
    </template>
  </main>
</template>

<style scoped>
.remote { height: 100vh; display: flex; flex-direction: column; background: var(--bg-window); color: var(--text-1); font-size: var(--font-md); }
.toolbar { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.screen-icon { flex-shrink: 0; display: grid; place-items: center; width: 32px; height: 32px; color: var(--primary); background: var(--primary-weak); border-radius: var(--radius-control); }
.identity { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.identity span { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-xs); }
button, select { min-height: 32px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--bg-window); color: var(--text-1); font: inherit; padding: 5px 10px; cursor: pointer; }
@media (hover: hover) {
  button:enabled:hover { background: var(--surface-hover); }
}
button:focus-visible, select:focus-visible, .viewport:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
button:disabled { opacity: .5; cursor: default; }
button.primary { color: var(--on-primary); background: var(--primary); border-color: var(--primary); font-weight: 600; }
button.stop { flex-shrink: 0; color: var(--danger); border-color: var(--danger); }
button[aria-pressed='true'] { background: var(--primary-weak); border-color: var(--primary); }
.consent { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.selection-body { flex: 1; min-height: 0; padding: 20px; overflow: auto; overscroll-behavior: contain; }
h1 { margin: 0 0 4px; font-size: var(--font-lg); line-height: 1.5; overflow-wrap: anywhere; }
p { margin: 0; color: var(--text-2); line-height: 1.6; }
.actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); }
.sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 12px; margin-top: 16px; }
.sources label { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 2px solid var(--line); border-radius: var(--radius-control); cursor: pointer; }
.sources label.selected, .sources label:focus-within { border-color: var(--primary); background: var(--primary-weak); }
.sources input { position: absolute; top: 12px; left: 12px; accent-color: var(--primary); }
.sources img { width: 100%; aspect-ratio: 8 / 5; object-fit: contain; background: var(--bg-chat); }
.sources span { overflow-wrap: anywhere; font-size: var(--font-sm); }
.controls { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 16px; border-bottom: 1px solid var(--line); font-size: var(--font-sm); }
.controls label { display: flex; align-items: center; gap: 8px; }
.controls select { width: 180px; }
.target { color: var(--text-2); font-size: var(--font-xs); }
.zoom { display: flex; margin-left: auto; }
.zoom button { border-radius: 0; font-variant-numeric: tabular-nums; }
.zoom button + button { margin-inline-start: -1px; }
.zoom button[aria-pressed="true"] { position: relative; z-index: 1; font-weight: 600; }
.zoom button:first-child { border-radius: var(--radius-control) 0 0 var(--radius-control); }
.zoom button:last-child { border-radius: 0 var(--radius-control) var(--radius-control) 0; }
.stale { position: absolute; top: 8px; left: 12px; padding: 6px 12px; background: var(--bg-window); color: var(--text-1); border: 1px solid var(--danger); border-radius: var(--radius-control); font-size: var(--font-sm); }
.screen-area { position: relative; flex: 1; min-height: 0; display: flex; }
.viewport { min-width: 0; position: relative; flex: 1; min-height: 0; overflow: auto; background: var(--bg-chat); touch-action: none; }
.picture { display: grid; place-items: center; min-width: 100%; min-height: 100%; width: max-content; }
.picture :deep(canvas) { display: block; max-width: none; cursor: grab; user-select: none; }
.fit { overflow: hidden; }
.fit .picture { width: 100%; height: 100%; }
.fit .picture :deep(canvas) { width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: contain; cursor: default; }
.waiting { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; pointer-events: none; color: var(--text-2); }
footer { font-variant-numeric: tabular-nums; flex-shrink: 0; padding: 6px 16px; color: var(--text-2); font-size: var(--font-xs); border-top: 1px solid var(--line); }
.sharing { border: 1px solid var(--line); box-sizing: border-box; }
.sharing .toolbar { -webkit-app-region: drag; }
.sharing button { -webkit-app-region: no-drag; }
.compact .toolbar { flex: 1; min-height: 0; padding: 6px 8px; gap: 8px; border: 0; }
.compact .identity strong { font-size: var(--font-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.compact .screen-icon { width: 28px; height: 28px; }
.compact .stop { font-size: var(--font-xs); }
@media (max-width: 560px) { .target { flex: 1; } .zoom { margin-left: 0; } }
</style>
