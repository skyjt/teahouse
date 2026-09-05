<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { MessageView } from '../../../shared/ipc'
import { RECALL_WINDOW_MS } from '../../../shared/protocol'
import { imageMimeFromExt } from '../utils/clipboard'
import {
  canRecallAt,
  formatRecallMenuMeta,
  isRecallMenuUrgent,
  recallRemainingMs
} from '../utils/recall'
import { useTransfersStore } from '../stores/transfers'
import { useStickersStore } from '../stores/stickers'
import { vCachedImage } from '../directives/cached-image'
import PantryIcon from './PantryIcon.vue'

// 图片/表情消息气泡（ui-design §5）：图片 ≤280px 可看大图；表情固定 120px。
// 右键「添加到表情」（F-MSG-7）。图源走 pantry-img:// 自定义协议。

const emit = defineEmits<{ forward: []; recall: [] }>()
const props = withDefaults(
  defineProps<{
    msg: MessageView
    recallVisible?: boolean
    recallDisabledReason?: string
  }>(),
  {
    recallVisible: false,
    recallDisabledReason: ''
  }
)
const transfers = useTransfersStore()
const stickersStore = useStickersStore()
const broken = ref(false)
const menuAt = ref<{ x: number; y: number } | null>(null)
const addTip = ref('')
const addTipKind = ref<'ok' | 'fail'>('ok')
const MENU_WIDTH = 128
const MENU_ITEM_HEIGHT = 32
const MENU_PADDING = 10
const MENU_MARGIN = 8
let addTipTimer: number | undefined
let recallCountdownTimer: number | undefined

const isSticker = computed(() => props.msg.kind === 'sticker')
const tableViewMode = ref<'image' | 'text'>('image')
const hasTableText = computed(
  () => !isSticker.value && typeof props.msg.fileRef?.tableText === 'string' && props.msg.fileRef.tableText.length > 0
)
const showTableText = computed(() => hasTableText.value && tableViewMode.value === 'text')
const menuHeight = computed(
  () => MENU_PADDING + MENU_ITEM_HEIGHT * (props.recallVisible ? 4 : 3)
)
const recallNowTs = ref(Date.now())
const recallRemaining = computed(() =>
  recallRemainingMs(recallNowTs.value, props.msg.ts, RECALL_WINDOW_MS)
)
const recallMeta = computed(() =>
  formatRecallMenuMeta(recallRemaining.value, props.recallDisabledReason)
)
const recallUrgent = computed(() =>
  isRecallMenuUrgent(recallRemaining.value, props.recallDisabledReason)
)
const recallDisabled = computed(() =>
  !canRecallAt(recallNowTs.value, props.msg.ts, RECALL_WINDOW_MS, props.recallDisabledReason)
)

function startRecallCountdownTimer(): void {
  if (recallCountdownTimer !== undefined) return
  recallNowTs.value = Date.now()
  recallCountdownTimer = window.setInterval(() => (recallNowTs.value = Date.now()), 500)
}

function stopRecallCountdownTimer(): void {
  if (recallCountdownTimer === undefined) return
  window.clearInterval(recallCountdownTimer)
  recallCountdownTimer = undefined
}

function onContextMenu(event: MouseEvent): void {
  event.stopPropagation()
  const maxX = Math.max(MENU_MARGIN, window.innerWidth - MENU_WIDTH - MENU_MARGIN)
  const maxY = Math.max(MENU_MARGIN, window.innerHeight - menuHeight.value - MENU_MARGIN)
  menuAt.value = {
    x: Math.max(MENU_MARGIN, Math.min(event.clientX, maxX)),
    y: Math.max(MENU_MARGIN, Math.min(event.clientY, maxY))
  }
}

watch(menuAt, (next) => {
  if (next) startRecallCountdownTimer()
  else stopRecallCountdownTimer()
})

async function addToStickers(): Promise<void> {
  menuAt.value = null
  const ok = await stickersStore.addFromTransfer(transferId.value)
  showTip(ok ? '已添加到表情' : '添加失败', ok ? 'ok' : 'fail')
}

async function sourceToPngBlob(bytes: ArrayBuffer, ext: string): Promise<Blob | null> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: imageMimeFromExt(ext) }))
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return null
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

async function copyImage(): Promise<void> {
  menuAt.value = null
  try {
    if (!transferId.value) throw new Error('missing transfer id')
    const source = await window.pantry.fetchStickerSource(transferId.value)
    if (!source) throw new Error('source unavailable')
    const png = await sourceToPngBlob(source.bytes, source.ext)
    if (!png) throw new Error('png unavailable')
    const ok = await window.pantry.writeImageToClipboard(await png.arrayBuffer())
    if (!ok) throw new Error('clipboard write failed')
    showTip('已复制', 'ok')
  } catch {
    showTip('复制失败', 'fail')
  }
}

function showTip(text: string, kind: 'ok' | 'fail'): void {
  addTipKind.value = kind
  addTip.value = text
  clearAddTipTimer()
  addTipTimer = window.setTimeout(() => {
    addTip.value = ''
    addTipTimer = undefined
  }, 1500)
}

function forwardImage(): void {
  menuAt.value = null
  emit('forward')
}

function recallImage(): void {
  menuAt.value = null
  emit('recall')
}

function openImageViewer(): void {
  if (isSticker.value || showTableText.value || !transferId.value) return
  void window.pantry.openImageViewer(transferId.value)
}

function onPreviewError(event: Event): void {
  const image = event.currentTarget as HTMLImageElement | null
  if (
    image?.src.startsWith('pantry-thumb:') &&
    image.dataset.previewOriginalFallback !== 'true'
  ) {
    image.dataset.previewOriginalFallback = 'true'
    image.src = `pantry-img://${transferId.value}`
    return
  }
  broken.value = true
}

function clearAddTipTimer(): void {
  if (addTipTimer !== undefined) {
    window.clearTimeout(addTipTimer)
    addTipTimer = undefined
  }
}

const transferId = computed(() => props.msg.fileRef?.transferId ?? '')
const transfer = computed(() => transfers.byId[transferId.value])
const ready = computed(
  () => transfer.value?.status === 'done' || (props.msg.isMine && !!transfer.value?.savedPath)
)
const failed = computed(() => {
  if (broken.value) return true
  // 发送方：以消息状态为准——数据送达即 sent、迟到的 offer 判负不算失败（issue #3，与终态保护一致）；
  // 接收方：看传输结果（下载失败 / 被取消 / 被拒）。
  if (props.msg.isMine) return props.msg.status === 'failed'
  const s = transfer.value?.status
  return s === 'failed' || s === 'canceled' || s === 'declined'
})

watch(transferId, (id, _previous, onCleanup) => {
  if (id) onCleanup(transfers.retain(id))
}, { immediate: true })

onUnmounted(() => {
  clearAddTipTimer()
  stopRecallCountdownTimer()
})
</script>

<template>
  <div class="img-bubble" :class="{ mine: props.msg.isMine, peer: !props.msg.isMine }" @mouseleave="menuAt = null">
    <div
      v-if="hasTableText"
      class="table-switch"
      :class="{ text: showTableText }"
      role="group"
      aria-label="表格消息视图"
      @contextmenu.stop
    >
      <button
        type="button"
        :class="{ selected: tableViewMode === 'image' }"
        @click.stop="tableViewMode = 'image'"
      >
        图片
      </button>
      <button
        type="button"
        :class="{ selected: tableViewMode === 'text' }"
        @click.stop="tableViewMode = 'text'"
      >
        文字
      </button>
    </div>
    <div v-if="showTableText" class="table-text-shell" @contextmenu.stop>
      <div v-if="props.msg.fileRef?.tableTextTruncated" class="table-text-note">
        文字视图已截断，图片完整
      </div>
      <pre class="table-text">{{ props.msg.fileRef?.tableText }}</pre>
    </div>
    <template v-else>
      <img
        v-if="ready && !failed"
        v-cached-image="{ transferId, cache: !isSticker }"
        class="thumb"
        :class="{ sticker: isSticker }"
        alt="[图片]"
        loading="lazy"
        decoding="async"
        @click="openImageViewer"
        @error="onPreviewError"
        @contextmenu.prevent.stop="onContextMenu"
      />
      <div v-else-if="failed" class="ph fail">{{ isSticker ? '表情' : '图片' }}传输失败</div>
      <div v-else class="ph" :class="{ sticker: isSticker }">
        {{ isSticker ? '表情' : '图片' }}接收中…
      </div>
    </template>
    <div
      v-if="menuAt"
      class="ctx"
      :style="{ left: `${menuAt.x}px`, top: `${menuAt.y}px` }"
      @click.stop
    >
      <button type="button" @click="copyImage">复制</button>
      <button type="button" @click="forwardImage">转发</button>
      <button type="button" @click="addToStickers">添加到表情</button>
      <button
        v-if="props.recallVisible"
        type="button"
        class="danger recall-action"
        :disabled="recallDisabled"
        @click="recallImage"
      >
        <span>撤回</span>
        <span class="recall-action-meta" :class="{ 'is-urgent': recallUrgent }">
          {{ recallMeta }}
        </span>
      </button>
    </div>
    <span
      v-if="addTip"
      class="tip"
      :class="addTipKind"
      role="status"
      aria-live="polite"
    >
      <PantryIcon v-if="addTipKind === 'ok'" name="check" :size="12" class="tip-icon" />
      <span v-else class="tip-mark">!</span>
      <span>{{ addTip }}</span>
    </span>
  </div>
</template>

<style scoped>
.img-bubble {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
}
.img-bubble.mine {
  align-items: flex-end;
}
.table-switch {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 96px;
  height: 24px;
  margin-bottom: 4px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-list);
  overflow: hidden;
}
.table-switch::before {
  content: "";
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc(50% - 2px);
  border-radius: 999px;
  background: var(--primary);
  transition:
    transform 150ms ease,
    opacity 150ms ease;
}
.table-switch.text::before {
  transform: translateX(100%);
}
.table-switch button {
  position: relative;
  z-index: 1;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.table-switch button.selected {
  color: #fff;
}
.table-text-shell {
  width: 320px;
  max-width: 70vw;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-window);
}
.table-text-note {
  position: sticky;
  top: 0;
  padding: 6px 10px 0;
  background: var(--bg-window);
  color: var(--text-3);
  font-size: 12px;
  line-height: 18px;
}
.table-text {
  margin: 0;
  padding: 8px 10px 10px;
  color: var(--text-1);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
  user-select: text;
}
.thumb {
  max-width: 280px;
  max-height: 280px;
  border-radius: 8px;
  cursor: zoom-in;
  display: block;
  border: 1px solid var(--line);
}
.thumb[data-preview-loading='true'] {
  width: 180px;
  height: 120px;
  cursor: default;
  background: var(--bg-list);
}
.thumb.sticker {
  max-width: 120px;
  max-height: 120px;
  cursor: default;
  border: none;
}
.thumb.sticker[data-preview-loading='true'] {
  width: 120px;
  height: 120px;
}
.ph.sticker {
  width: 120px;
  height: 120px;
}
.ctx {
  position: fixed;
  min-width: 128px;
  box-sizing: border-box;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 6;
}
.ctx button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  width: 100%;
  min-height: 32px;
  box-sizing: border-box;
  border: none;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}
.ctx button:hover {
  background: var(--line);
}
.ctx button.danger {
  color: var(--danger);
}
.ctx button:active:not(:disabled) {
  transform: scale(0.98);
}
.recall-action-meta {
  min-width: 38px;
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  text-align: right;
}
.recall-action-meta.is-urgent {
  color: var(--danger);
}
.ctx button:disabled {
  color: var(--text-3);
  cursor: default;
}
.ctx button:disabled:hover {
  background: transparent;
}
.tip {
  position: absolute;
  top: 50%;
  left: calc(100% + 8px);
  --tip-enter-x: -4px;
  transform: translate(0, -50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 4px 8px 4px 7px;
  border: 1px solid rgba(61, 139, 107, 0.22);
  border-radius: 999px;
  background: var(--bg-window);
  box-shadow: 0 6px 18px rgba(34, 49, 42, 0.14);
  color: var(--primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  pointer-events: none;
  white-space: nowrap;
  z-index: 5;
}
.img-bubble.mine .tip {
  left: auto;
  right: calc(100% + 8px);
  --tip-enter-x: 4px;
}
.tip.fail {
  border-color: rgba(229, 72, 77, 0.24);
  color: var(--danger);
}
.tip-icon,
.tip-mark {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}
.tip-mark {
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(229, 72, 77, 0.1);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.ph {
  width: 180px;
  height: 120px;
  border-radius: 8px;
  background: var(--line);
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--text-3);
}
.ph.fail {
  color: var(--danger);
}
@media (prefers-reduced-motion: no-preference) {
  .tip {
    animation: tip-pop 150ms cubic-bezier(0.16, 1, 0.3, 1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .table-switch::before {
    transition: none;
  }
  .ctx button:active:not(:disabled) {
    transform: none;
  }
}
@keyframes tip-pop {
  from {
    opacity: 0;
    transform: translate(var(--tip-enter-x), -50%) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translate(0, -50%) scale(1);
  }
}
</style>
