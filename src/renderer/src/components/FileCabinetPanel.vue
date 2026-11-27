<script setup lang="ts">
import { tr } from '../utils/i18n'
import { onUnmounted, ref, watch } from 'vue'
import { SHARE_DIR_MAX_ENTRIES } from '../../../shared/protocol'
import { useShareBrowser } from '../utils/share-browser'
import { formatBytes } from '../utils/format'
import PantryIcon from './PantryIcon.vue'
import FileTypeIcon from './FileTypeIcon.vue'

// 聊天侧栏保留自己的浏览状态；与主窗文件柜只共享行为。
const props = defineProps<{ peerId: string; peerName: string }>()
const emit = defineEmits<{ close: [] }>()
const browser = useShareBrowser(() => props.peerId)
const {
  entries, path, perm, total, truncated, loading, loadingMore, failReason, moreFailReason,
  picked, downloading, uploading, note: downloadNote, transfer, canUpload, crumbs,
  failText, moreFailText, pickedCount, allLoadedPicked: allPagePicked,
  pickAllLabel, progressPercent, load, loadMore, goUp, openRow: onRowOpen,
  toggleAll, togglePick, download, upload, cancelTransfer: cancelDownload
} = browser
const dragActive = ref(false)

function onScroll(event: Event): void {
  // 翻页失败后暂停自动续拉，保留已加载条目供用户重试。
  if (moreFailReason.value) return
  const el = event.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadMore()
}

function onRowClick(index: number, event: MouseEvent): void {
  browser.clickRow(index, { shift: event.shiftKey, mod: event.ctrlKey || event.metaKey })
}

async function onDrop(event: DragEvent): Promise<void> {
  dragActive.value = false
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((f) => (f as File & { path?: string }).path ?? '')
    .filter((p) => p.length > 0)
  await browser.uploadDropped(paths)
}

function onDragOver(event: DragEvent): void {
  if (!canUpload.value) return
  event.preventDefault()
  dragActive.value = true
}

// 面板内部子元素之间的拖动不取消高亮。
function onDragLeave(event: DragEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && (event.currentTarget as HTMLElement).contains(next)) return
  dragActive.value = false
}

function openInCabinet(): void {
  void window.pantry.openCabinet(props.peerId)
  emit('close')
}

const stopTransfer = window.pantry.onTransferUpdated(browser.updateTransfer)

function revealDone(): void {
  if (transfer.value?.status === 'done') browser.revealTransfer()
}

watch(
  () => props.peerId,
  () => {
    browser.resetBrowse()
    void load('')
  },
  { immediate: true }
)

onUnmounted(stopTransfer)
</script>

<template>
  <aside
    class="panel side-panel"
    :class="{ 'drag-active': dragActive }"
    :aria-label="tr('对方的文件柜')"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <header class="panel-head">
      <span class="panel-title" :title="tr('{0} 的文件柜', { 0: peerName })">{{ tr('{0}的文件柜', { 0: peerName }) }}</span>
      <span v-if="!loading && !failReason" class="perm" :class="perm">{{ canUpload ? tr('可下载和上传') : tr('可下载') }}</span>
      <button class="icon-control compact-icon icon-btn" :title="tr('在文件柜里打开')" @click="openInCabinet">
        <PantryIcon name="external" size="compact" />
      </button>
      <button class="icon-control compact-icon icon-btn" :title="tr('关闭')" @click="emit('close')">
        <PantryIcon name="x" size="compact" />
      </button>
    </header>

    <div class="crumbs">
      <button class="icon-control compact-icon icon-btn" :title="tr('返回上级')" :disabled="crumbs.length < 2 || loading" @click="goUp">
        <PantryIcon name="chevron-left" size="compact" />
      </button>
      <div class="crumb-track">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="crumb-sep">/</span>
          <button
            class="crumb"
            :class="{ current: i === crumbs.length - 1 }"
            :disabled="i === crumbs.length - 1"
            @click="load(c.path)"
          >
            {{ c.name }}
          </button>
        </template>
      </div>
      <button class="icon-control compact-icon icon-btn" :title="tr('刷新')" :disabled="loading" @click="load(path)">
        <PantryIcon name="refresh" size="compact" />
      </button>
    </div>

    <div v-if="canUpload" class="actions upload-actions" :title="tr('上传的文件会按你的名字归入对方文件柜。')">
      <button class="ghost" :disabled="uploading" @click="upload(true)">{{ tr('上传文件夹') }}</button>
      <button class="ghost" :disabled="uploading" @click="upload(false)">{{ tr('上传文件') }}</button>
    </div>

    <div v-if="loading" class="hint">{{ tr('正在读取…') }}</div>
    <div v-else-if="failReason" class="hint error">
      <span>{{ failText }}</span>
      <button class="retry" @click="load(path)">{{ tr('重试') }}</button>
    </div>
    <div v-else-if="entries.length === 0" class="hint">{{ tr('这个文件夹是空的') }}</div>
    <template v-else>
      <div class="list-head">
        <label class="pick-all">
          <input type="checkbox" :checked="allPagePicked" @change="toggleAll" />
          <span>{{ pickAllLabel }}</span>
        </label>
        <span class="count">{{ tr('{0} 项', { 0: total }) }}</span>
      </div>
      <div class="list" @scroll="onScroll">
        <div
          v-for="(entry, index) in entries"
          :key="entry.name"
          class="row"
          :class="{ picked: picked.has(entry.name) }"
          @click="onRowClick(index, $event)"
          @dblclick="onRowOpen(index)"
        >
          <input
            class="row-pick"
            type="checkbox"
            :checked="picked.has(entry.name)"
            :aria-label="tr('勾选 {0}', { 0: entry.name })"
            @click.stop
            @change="togglePick(entry.name)"
          />
          <FileTypeIcon class="row-icon" :name="entry.name" :dir="entry.isDir" :size="20" />
          <span class="row-name" :title="entry.name">{{ entry.name }}</span>
          <span class="row-size">{{ entry.isDir ? '' : formatBytes(entry.size) }}</span>
        </div>
        <div v-if="loadingMore" class="hint small">{{ tr('正在加载更多…') }}</div>
        <div v-else-if="moreFailReason" class="hint small error inline">
          <span>{{ moreFailText }}</span>
          <button class="retry" @click="loadMore">{{ tr('重试') }}</button>
        </div>
        <div v-else-if="truncated" class="hint small">{{ tr('目录内容过多，仅显示前 {0} 项', { 0: SHARE_DIR_MAX_ENTRIES }) }}</div>
      </div>
    </template>

    <div v-if="transfer || downloadNote" class="progress-row">
      <div v-if="transfer && (transfer.status === 'accepted' || transfer.status === 'offering')" class="bar">
        <span class="bar-fill" :style="{ width: `${progressPercent}%` }"></span>
      </div>
      <span class="progress-text">{{ downloadNote || `${progressPercent}%` }}</span>
      <button
        v-if="transfer && (transfer.status === 'accepted' || transfer.status === 'offering')"
        class="link"
        @click="cancelDownload"
      >{{ tr('取消') }}</button>
      <button
        v-else-if="transfer?.status === 'done' && transfer.direction === 'in'"
        class="link"
        @click="revealDone"
      >{{ tr('打开位置') }}</button>
    </div>

    <footer v-if="!loading && !failReason" class="panel-foot">
      <div class="foot-row">
        <span class="foot-sum">
          <template v-if="pickedCount > 0">{{ tr('已选') }}<b>{{ pickedCount }}</b>{{ tr('项') }}</template>
          <template v-else-if="!failReason">{{ tr('双击进文件夹') }}</template>
        </span>
        <div v-if="pickedCount" class="actions">
          <button class="ghost" :disabled="downloading" @click="download(true)">{{ tr('另存为') }}</button>
          <button class="primary" :disabled="downloading" @click="download(false)">{{ tr('下载（{0}）', { 0: pickedCount }) }}</button>
        </div>
      </div>
      <p v-if="canUpload" class="foot-note">{{ tr('上传的文件会按你的名字归入对方文件柜。') }}</p>
    </footer>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 320px;
  border-left: 1px solid var(--line);
  background: var(--bg-window);
  box-shadow: var(--shadow-float);
  z-index: 26;
  display: flex;
  flex-direction: column;
  /* 顶部 40px 让出沉浸式拖拽带（同群信息面板，决议 #67） */
  padding: 40px 0 0;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 8px 12px;
}

.panel-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 权限徽标从底栏上移到头部（决议 #283），底栏让位给选中摘要与按钮 */
.perm {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--line);
  color: var(--text-2);
}

.perm.write {
  background: var(--primary-weak);
  color: var(--primary);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px 8px;
  border-bottom: 1px solid var(--line);
}

.crumb-track {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  white-space: nowrap;
}

.crumb {
  flex-shrink: 0;
  border: none;
  background: transparent;
  padding: 2px 4px;
  font-size: 12px;
  color: var(--primary);
  cursor: pointer;
}

.crumb.current {
  color: var(--text-1);
  cursor: default;
}

.crumb-sep {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 12px;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-3);
}

.pick-all {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 2px 6px;
}

/* 行高 36px（决议 #283）：与窗口版共用一套语义，面板窄一档更紧凑 */
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 6px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--surface-hover);
}

.row.picked {
  background: var(--surface-selected);
}

/* 未勾选时复选框只在 hover / 选中 / 聚焦时露出，平时让位给文件名 */
.row-pick {
  flex-shrink: 0;
  opacity: 0;
}

.row:hover .row-pick,
.row.picked .row-pick,
.row-pick:focus-visible {
  opacity: 1;
}

.row-icon {
  flex-shrink: 0;
}

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size {
  flex-shrink: 0;
  min-width: 58px;
  text-align: right;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.hint {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}

.hint.small {
  padding: 10px 12px;
}

.hint.error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  color: var(--text-2);
}

/* 翻页失败贴在列表末尾，横排更省纵向空间，也和上方条目区分开 */
.hint.inline {
  flex-direction: row;
  justify-content: center;
  gap: 8px;
}

.retry,
.link {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--text-2);
}

.bar {
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  background: var(--primary);
  transition: width 160ms linear;
}

.progress-text {
  flex-shrink: 0;
}

.panel.drag-active {
  outline: 2px dashed var(--primary);
  outline-offset: -6px;
}

.panel-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}

.foot-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.foot-sum {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
}

.foot-sum b {
  color: var(--text-1);
}

.foot-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
}

.upload-actions { padding: 4px 8px; }

.actions {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.primary,
.ghost {
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid transparent;
}

.primary {
  background: var(--primary);
  color: var(--on-primary);
}

.ghost {
  background: transparent;
  border-color: var(--line);
  color: var(--text-2);
}

.primary:disabled,
.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill {
    transition: none;
  }
}
</style>
