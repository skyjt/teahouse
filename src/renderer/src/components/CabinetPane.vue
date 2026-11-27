<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { SHARE_DIR_MAX_ENTRIES } from '../../../shared/protocol'
import { cabinetPeerName, useCabinetStore } from '../stores/cabinet'
import { formatBytes, formatCabinetTime } from '../utils/format'
import { clampMenuPosition } from '../utils/menu-position'
import { isPlainEscape } from '../utils/escape'
import AvatarMark from './AvatarMark.vue'
import CabinetMine from './CabinetMine.vue'
import FileTypeIcon from './FileTypeIcon.vue'
import PantryIcon from './PantryIcon.vue'

const cabinet = useCabinetStore()

const dragActive = ref(false)
const emit = defineEmits<{ chat: [peerId: string] }>()
const menu = ref<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })
const menuEl = ref<HTMLElement | null>(null)
const available = computed(() => !!cabinet.snapshotId && !cabinet.loading && !cabinet.failReason)

const peerTitle = computed(() =>
  cabinet.activePeer ? tr('{0}的文件柜', { 0: cabinetPeerName(cabinet.activePeer) }) : tr('文件柜')
)

const peerSubtitle = computed(() => {
  const p = cabinet.activePeer
  if (!p) return ''
  if (!p.online) return tr('离线')
  return [tr('在线'), p.dept].filter(Boolean).join(' · ')
})

function onRowClick(index: number, event: MouseEvent): void {
  cabinet.clickRow(index, { shift: event.shiftKey, mod: event.ctrlKey || event.metaKey })
}

function onScroll(event: Event): void {
  // 上一页刚失败（多半撞了对方 10 秒 5 次的限流）就停下等用户点重试
  if (cabinet.moreFailReason) return
  const el = event.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) void cabinet.loadMore()
}

function onKeydown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    cabinet.moveCursor(1, event.shiftKey)
  } else if (event.key === 'ArrowUp' && !mod) {
    event.preventDefault()
    cabinet.moveCursor(-1, event.shiftKey)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (cabinet.cursor >= 0) cabinet.openRow(cabinet.cursor)
  } else if (event.key === ' ') {
    event.preventDefault()
    if (cabinet.cursor >= 0) cabinet.togglePick(cabinet.entries[cabinet.cursor].name)
  } else if (event.key === 'Backspace' || (mod && event.key === 'ArrowUp')) {
    event.preventDefault()
    cabinet.goUp()
  } else if (mod && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    cabinet.picked = new Set(cabinet.entries.map((e) => e.name))
  } else if (event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) {
    event.preventDefault()
    void cabinet.load(cabinet.path)
  } else if (isPlainEscape(event) && (menu.value.open || cabinet.picked.size > 0)) {
    event.preventDefault()
    if (menu.value.open) menu.value.open = false
    else cabinet.picked = new Set()
  }
}

async function openMenu(index: number, event: MouseEvent): Promise<void> {
  const entry = cabinet.entries[index]
  if (!entry) return
  if (!cabinet.picked.has(entry.name)) {
    cabinet.picked = new Set([entry.name])
  }
  cabinet.cursor = index
  menu.value = { open: true, x: event.clientX, y: event.clientY }
  await nextTick()
  if (menuEl.value) {
    const { width, height } = menuEl.value.getBoundingClientRect()
    Object.assign(menu.value, clampMenuPosition(event.clientX, event.clientY, width, height, window.innerWidth, window.innerHeight))
  }
}

function menuDownload(saveAs: boolean): void {
  menu.value.open = false
  void cabinet.download(saveAs)
}

async function copyName(): Promise<void> {
  menu.value.open = false
  const name = cabinet.cursor >= 0 ? (cabinet.entries[cabinet.cursor]?.name ?? '') : ''
  if (!name) return
  try {
    await navigator.clipboard.writeText(name)
    cabinet.flashToast(tr('文件名已复制'))
  } catch {
    cabinet.flashToast(tr('复制失败'))
  }
}

function onDragOver(event: DragEvent): void {
  if (cabinet.target.kind !== 'peer' || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dragActive.value = true
}

// 拖过内部子元素时根节点也会收到 dragleave，只有真正离开边界才熄灭（决议 #281）
function onDragLeave(event: DragEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && (event.currentTarget as HTMLElement).contains(next)) return
  dragActive.value = false
}

async function onDrop(event: DragEvent): Promise<void> {
  dragActive.value = false
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((f) => (f as File & { path?: string }).path ?? '')
    .filter((p) => p.length > 0)
  await cabinet.uploadDropped(paths)
}

function closeMenu(): void {
  if (menu.value.open) menu.value.open = false
}

function onMenuEscape(event: KeyboardEvent): void {
  if (!menu.value.open || !isPlainEscape(event)) return
  event.preventDefault()
  closeMenu()
}

watch(() => cabinet.target, () => {
  closeMenu()
  dragActive.value = false
})

watch([() => cabinet.activePeer?.nodeId, () => cabinet.activePeer?.online], ([id, online], [previousId, previousOnline]) => {
  if (id && id === previousId && online !== previousOnline) void cabinet.load(cabinet.path)
})

onMounted(() => {
  void cabinet.init()
  if (cabinet.target.kind === 'peer' && !cabinet.loading) void cabinet.load(cabinet.path)
  window.addEventListener('click', closeMenu)
  document.addEventListener('keydown', onMenuEscape)
})

onUnmounted(() => {
  window.removeEventListener('click', closeMenu)
  document.removeEventListener('keydown', onMenuEscape)
})
</script>

<template>
  <section
    class="cabinet-pane"
    :class="{ 'drag-active': dragActive && cabinet.canUpload, 'drag-deny': dragActive && !cabinet.canUpload }"
    :data-drop-hint="cabinet.canUpload ? tr('松开以上传文件') : tr('对方没有开放上传')"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <template v-if="cabinet.target.kind === 'mine'">
      <header class="head">
        <span class="head-icon"><PantryIcon name="cabinet" size="action" /></span>
        <span class="head-txt">
          <span class="head-title">{{ tr('我的文件柜') }}</span>
          <span v-if="cabinet.settings" class="head-sub">{{ cabinet.shareAudience }}</span>
        </span>
      </header>
      <CabinetMine />
    </template>
    <template v-else>
      <header class="head">
        <AvatarMark
          v-if="cabinet.activePeer"
          class="head-avatar"
          :avatar="cabinet.activePeer.avatar"
          :avatar-hash="cabinet.activePeer.avatarHash"
          :name="cabinetPeerName(cabinet.activePeer)"
          :presence="cabinet.activePeer.online ? 'online' : 'offline'"
        />
        <span class="head-txt">
          <span class="head-title">{{ peerTitle }}</span>
          <span class="head-sub">
            {{ peerSubtitle }}
            <template v-if="available">{{ tr('· 共 {0} 项', { 0: cabinet.total }) }}</template>
          </span>
        </span>
        <span v-if="available" class="perm" :class="cabinet.perm">
          {{ cabinet.canUpload ? tr('可下载和上传') : tr('可下载') }}
        </span>
        <span v-if="available" class="seg-view" role="group" :aria-label="tr('视图')">
          <button
            type="button"
            class="icon-control compact-icon"
            :aria-pressed="cabinet.viewMode === 'list'"
            :title="tr('详情列表')"
            :aria-label="tr('详情列表')"
            @click="cabinet.setViewMode('list')"
          >
            <PantryIcon name="list" size="compact" />
          </button>
          <button
            type="button"
            class="icon-control compact-icon"
            :aria-pressed="cabinet.viewMode === 'grid'"
            :title="tr('网格')"
            :aria-label="tr('网格')"
            @click="cabinet.setViewMode('grid')"
          >
            <PantryIcon name="grid" size="compact" />
          </button>
        </span>
        <button
          type="button"
          class="icon-control icon-btn"
          :title="tr('刷新')"
          :disabled="cabinet.loading"
          @click="cabinet.load(cabinet.path)"
        >
          <PantryIcon name="refresh" size="compact" />
        </button>
      </header>

      <div v-if="available || cabinet.path" class="crumbs">
        <button
          type="button"
          class="icon-control compact-icon icon-btn"
          :title="tr('返回上级')"
          :disabled="cabinet.crumbs.length < 2 || cabinet.loading"
          @click="cabinet.goUp()"
        >
          <PantryIcon name="chevron-left" size="compact" />
        </button>
        <div class="crumb-track">
          <template v-for="(c, i) in cabinet.crumbs" :key="c.path">
            <span v-if="i > 0" class="crumb-sep">/</span>
            <button
              type="button"
              class="crumb"
              :class="{ current: i === cabinet.crumbs.length - 1 }"
              :disabled="i === cabinet.crumbs.length - 1"
              @click="cabinet.load(c.path)"
            >
              {{ c.name }}
            </button>
          </template>
        </div>
        <div v-if="cabinet.canUpload" class="actions" :title="tr('上传的文件会按你的名字归入对方文件柜。')">
          <NButton size="small" quaternary :disabled="cabinet.uploading" @click="cabinet.upload(true)">{{ tr('上传文件夹') }}</NButton>
          <NButton size="small" secondary :disabled="cabinet.uploading" @click="cabinet.upload(false)">{{ tr('上传文件') }}</NButton>
        </div>
      </div>

      <div v-if="cabinet.loading" class="state">{{ tr('正在读取…') }}</div>
      <div v-else-if="cabinet.failReason" class="state">
        <span class="state-icon"><PantryIcon name="info" :size="21" /></span>
        <strong>{{ cabinet.failText }}</strong>
        <small v-if="cabinet.failReason === 'off' || cabinet.failReason === 'no-perm'">{{ tr('请对方在「谁能访问」中给你下载权限，然后刷新。') }}</small>
        <NButton v-if="cabinet.activePeer && ['off', 'no-perm', 'offline'].includes(cabinet.failReason)" size="small" @click="emit('chat', cabinet.activePeer.nodeId)">{{ tr('联系对方') }}</NButton>
        <button type="button" class="link" @click="cabinet.load(cabinet.path)">{{ tr('重试') }}</button>
      </div>
      <div v-else-if="cabinet.entries.length === 0" class="state">
        <span class="state-icon"><PantryIcon name="folder" :size="21" /></span>
        <strong>{{ tr('这个文件夹是空的') }}</strong>
        <small v-if="cabinet.canUpload">{{ tr('可以把文件拖进来，会放到 TA 柜子里以你命名的文件夹。') }}</small>
      </div>
      <template v-else>
        <div v-if="cabinet.viewMode === 'list'" class="cols">
          <label class="pick-all">
            <input type="checkbox" :checked="cabinet.allLoadedPicked" @change="cabinet.toggleAll()" />
            <span>{{ cabinet.pickAllLabel }}</span>
          </label>
          <span class="c-name">{{ tr('名称') }}</span>
          <span class="c-size">{{ tr('大小') }}</span>
          <span class="c-time">{{ tr('修改时间') }}</span>
        </div>
        <div
          v-if="cabinet.viewMode === 'list'"
          class="rows"
          tabindex="0"
          role="listbox"
          aria-multiselectable="true"
          :aria-label="tr('文件列表')"
          @scroll="onScroll"
          @keydown="onKeydown"
        >
          <div
            v-for="(entry, index) in cabinet.entries"
            :key="entry.name"
            class="row"
            :class="{ picked: cabinet.picked.has(entry.name), cursor: cabinet.cursor === index }"
            role="option"
            :aria-selected="cabinet.picked.has(entry.name)"
            @click="onRowClick(index, $event)"
            @dblclick="cabinet.openRow(index)"
            @contextmenu.prevent="openMenu(index, $event)"
          >
            <input
              class="row-pick"
              type="checkbox"
              :checked="cabinet.picked.has(entry.name)"
              :aria-label="tr('勾选 {0}', { 0: entry.name })"
              @click.stop
              @change="cabinet.togglePick(entry.name)"
            />
            <FileTypeIcon class="row-icon" :name="entry.name" :dir="entry.isDir" :size="24" />
            <span class="row-name" :title="entry.name">{{ entry.name }}</span>
            <span class="row-size">{{ entry.isDir ? '—' : formatBytes(entry.size) }}</span>
            <span class="row-time">{{ formatCabinetTime(entry.mtime) }}</span>
          </div>
          <div v-if="cabinet.loadingMore" class="tail">{{ tr('正在加载更多…') }}</div>
          <div v-else-if="cabinet.moreFailReason" class="tail fail">
            <span>{{ cabinet.moreFailText }}</span>
            <button type="button" class="link" @click="cabinet.loadMore()">{{ tr('重试') }}</button>
          </div>
          <div v-else-if="cabinet.truncated" class="tail">{{ tr('目录内容过多，仅显示前 {0} 项', { 0: SHARE_DIR_MAX_ENTRIES }) }}</div>
        </div>

        <div
          v-else
          class="grid"
          tabindex="0"
          role="listbox"
          aria-multiselectable="true"
          :aria-label="tr('文件网格')"
          @scroll="onScroll"
          @keydown="onKeydown"
        >
          <div
            v-for="(entry, index) in cabinet.entries"
            :key="entry.name"
            class="card-item"
            :class="{ picked: cabinet.picked.has(entry.name) }"
            role="option"
            :aria-selected="cabinet.picked.has(entry.name)"
            :title="entry.name"
            @click="onRowClick(index, $event)"
            @dblclick="cabinet.openRow(index)"
            @contextmenu.prevent="openMenu(index, $event)"
          >
            <FileTypeIcon class="card-icon" :name="entry.name" :dir="entry.isDir" :size="42" />
            <span class="card-name">{{ entry.name }}</span>
          </div>
          <div v-if="cabinet.loadingMore" class="tail grid-tail">{{ tr('正在加载更多…') }}</div>
          <div v-else-if="cabinet.moreFailReason" class="tail fail grid-tail">
            <span>{{ cabinet.moreFailText }}</span>
            <button type="button" class="link" @click="cabinet.loadMore()">{{ tr('重试') }}</button>
          </div>
          <div v-else-if="cabinet.truncated" class="tail grid-tail">{{ tr('目录内容过多，仅显示前 {0} 项', { 0: SHARE_DIR_MAX_ENTRIES }) }}</div>
        </div>
      </template>

      <div v-if="cabinet.transfer || cabinet.note" class="progress">
        <div class="progress-top">
          <PantryIcon
            :name="cabinet.transfer?.direction === 'out' ? 'upload' : 'download'"
            :size="15"
            class="progress-icon"
          />
          <span class="progress-text">{{ cabinet.note || cabinet.transfer?.name }}</span>
          <span v-if="cabinet.transferActive" class="progress-num">
            {{ cabinet.progressPercent }}%
          </span>
          <button v-if="cabinet.transferActive" type="button" class="link" @click="cabinet.cancelTransfer()">{{ tr('取消') }}</button>
          <button
            v-else-if="cabinet.transfer?.status === 'done' && cabinet.transfer.direction === 'in'"
            type="button"
            class="link"
            @click="cabinet.revealTransfer()"
          >{{ tr('打开位置') }}</button>
        </div>
        <div v-if="cabinet.transferActive" class="bar">
          <span class="bar-fill" :style="{ width: `${cabinet.progressPercent}%` }"></span>
        </div>
      </div>

      <footer v-if="available" class="foot">
        <div class="foot-row">
          <span class="foot-sum">
            <template v-if="cabinet.pickedCount > 0">{{ tr('已选') }}<b>{{ cabinet.pickedCount }}</b>{{ tr('项') }}<template v-if="cabinet.pickedSize > 0">
                · {{ formatBytes(cabinet.pickedSize) }}</template>
            </template>
            <template v-else-if="!cabinet.failReason">{{ tr('单击选中，双击进文件夹') }}</template>
          </span>
          <span v-if="cabinet.pickedCount" class="actions">
            <NButton size="small" secondary :disabled="cabinet.downloading" @click="cabinet.download(true)">{{ tr('另存为…') }}</NButton>
            <NButton size="small" type="primary" :disabled="cabinet.downloading" @click="cabinet.download(false)">{{ tr('下载 {0} 项', { 0: cabinet.pickedCount }) }}</NButton>
          </span>
        </div>
        <p v-if="cabinet.canUpload || cabinet.pickedCount" class="foot-hint">
          <template v-if="cabinet.canUpload && !cabinet.pickedCount">{{ tr('上传的文件会按你的名字归入对方文件柜。') }}</template>
          <template v-else>{{ tr('下载默认落到「文件保存位置」下的「文件柜-对方名称」，也可以「另存为」自选目录。') }}</template>
        </p>
      </footer>

      <!-- 右键菜单：只有取，没有删改（决议 #272/#283） -->
      <div
        v-if="menu.open"
        ref="menuEl"
        class="ctx-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        role="menu"
      >
        <button type="button" role="menuitem" @click="menuDownload(false)">{{ tr('下载') }}</button>
        <button type="button" role="menuitem" @click="menuDownload(true)">{{ tr('另存为…') }}</button>
        <button type="button" role="menuitem" @click="copyName">{{ tr('复制文件名') }}</button>
      </div>

    </template>
    <Transition name="notice">
      <div v-if="cabinet.toast" class="toast" role="status" aria-live="polite">
        <span>{{ cabinet.toast }}</span>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.cabinet-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--bg-window);
}

.cabinet-pane.drag-active::after,
.cabinet-pane.drag-deny::after {
  content: attr(data-drop-hint);
  position: absolute;
  inset: 8px;
  z-index: 5;
  display: grid;
  place-items: center;
  border: 2px dashed var(--primary);
  border-radius: var(--radius-panel);
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
}

.cabinet-pane.drag-deny::after {
  border-color: var(--text-3);
  background: var(--surface-hover);
  color: var(--text-2);
}

.head {
  flex: none;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 var(--pane-inset);
  margin-top: 32px; /* 沉浸式拖拽带（决议 #49） */
  border-bottom: 1px solid var(--line);
}

.head-avatar {
  flex: none;
  width: var(--avatar-heading);
  height: var(--avatar-heading);
}

.head-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--avatar-heading);
  height: var(--avatar-heading);
  border-radius: var(--radius-panel);
  background: var(--primary-weak);
  color: var(--primary);
}

.head-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.head-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-lg);
  font-weight: 650;
}

.head-sub {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.perm {
  flex: none;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
  background: var(--surface-hover);
  color: var(--text-2);
}

.perm.write {
  background: var(--primary-weak);
  color: var(--primary);
}

.seg-view {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-panel);
  background: var(--surface-hover);
}

.seg-view button[aria-pressed="true"] {
  background: var(--material-strong);
  color: var(--primary);
  box-shadow: var(--shadow-soft);
}

.crumbs {
  flex: none;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 12px;
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
  flex: none;
  border: none;
  background: transparent;
  padding: 2px 4px;
  font-size: 13px;
  color: var(--primary);
  cursor: pointer;
}

.crumb.current {
  color: var(--text-1);
  font-weight: 500;
  cursor: default;
}

.crumb-sep {
  flex: none;
  color: var(--text-3);
  font-size: 13px;
}

.cols {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--text-3);
}

.pick-all {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.c-name {
  flex: 1;
}

.c-size {
  width: 76px;
  text-align: right;
}

.c-time {
  width: 104px;
  text-align: right;
}

.rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 6px;
}

.rows:focus-visible,
.grid:focus-visible {
  outline: 1px solid var(--primary);
  outline-offset: -2px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--radius-panel);
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--surface-hover);
}

.row.picked {
  background: var(--surface-selected);
}

.row.cursor {
  box-shadow: inset 0 0 0 1px var(--primary);
}

/* 未勾选时复选框只在 hover / 选中 / 聚焦时露出，平时让位给文件名 */
.row-pick {
  flex: none;
  opacity: 0;
}

.row:hover .row-pick,
.row.picked .row-pick,
.row-pick:focus-visible {
  opacity: 1;
}

.row-icon,
.card-icon {
  flex: none;
}

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size,
.row-time {
  flex: none;
  font-size: 12px;
  color: var(--text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.row-size {
  width: 76px;
}

.row-time {
  width: 104px;
}

.grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px;
  display: grid;
  /* 卡片固定 112px 不随窗口拉宽（1fr 会把列摊得很宽，图标孤零零留在中间） */
  grid-template-columns: repeat(auto-fill, 112px);
  gap: 8px;
  align-content: start;
  justify-content: start;
}

.card-item {
  height: 108px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 6px;
  border: 1.5px solid transparent;
  border-radius: var(--radius-panel);
  cursor: pointer;
  user-select: none;
}

.card-item:hover {
  background: var(--surface-hover);
}

.card-item.picked {
  background: var(--surface-selected);
  border-color: var(--primary);
}

.card-name {
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.grid-tail {
  grid-column: 1 / -1;
}

.state {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 16px;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}

.state strong {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-1);
}

.state small {
  font-size: 12px;
  color: var(--text-3);
  max-width: 34ch;
  line-height: 1.6;
}

.state-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: var(--radius-panel);
  background: var(--surface-hover);
  color: var(--text-3);
}

/* 翻页失败只贴在列表末尾，已加载条目一律保留（决议 #278） */
.tail {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}

.tail.fail {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.link {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
}

.progress {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 16px 10px;
  border-top: 1px solid var(--line);
  background: var(--bg-list);
}

.progress-top {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-2);
}

.progress-icon {
  color: var(--primary);
}

.progress-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-1);
}

.progress-num {
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.bar {
  height: 4px;
  border-radius: 999px;
  background: var(--surface-hover);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--primary);
  transition: width 160ms linear;
}

.foot {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 11px 16px;
  border-top: 1px solid var(--line);
}

.foot-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.foot-sum {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-2);
}

.foot-sum b {
  color: var(--text-1);
}

.actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.foot-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}

/* ——— 右键菜单与 toast ——— */
.ctx-menu {
  position: fixed;
  z-index: 80;
  min-width: 140px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--material-strong);
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
}

.ctx-menu button {
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  text-align: left;
  padding: 7px 10px;
  cursor: pointer;
}

.ctx-menu button:hover {
  background: var(--surface-hover);
  color: var(--primary);
}

/* 「设置已保存」胶囊（决议 #151）：底部居中淡入上移，1.8s 后淡出 */
.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-radius: 999px;
  background: var(--text-1);
  color: var(--bg-window);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  box-shadow: var(--shadow-float);
  z-index: 90;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill { transition: none; }
}
</style>
