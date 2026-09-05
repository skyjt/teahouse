<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NSelect } from 'naive-ui'
import { SHARE_DIR_MAX_ENTRIES, type ShareMode } from '../../../shared/protocol'
import { cabinetPeerName, SHARE_MODE_OPTIONS, useCabinetStore } from '../stores/cabinet'
import { formatBytes } from '../utils/format'
import { isPlainEscape } from '../utils/escape'
import AvatarMark from './AvatarMark.vue'
import FileTypeIcon from './FileTypeIcon.vue'
import PantryIcon from './PantryIcon.vue'

// 文件柜内容区（ui-design §8.2 / 决议 #283，形态改为主窗页签见 #284）：
// 左边选谁，这里就是谁的文件浏览器；选「我的文件柜」则是共享目录 / 权限 / 例外的管理页。
// 浏览手感对齐系统文件管理器：单击选中、双击进目录、Ctrl/Shift 多选、键盘与右键菜单。

const cabinet = useCabinetStore()

const dragActive = ref(false)
const newGrantId = ref<string | null>(null)
const menu = ref<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })
const listEl = ref<HTMLElement | null>(null)

const peerTitle = computed(() =>
  cabinet.activePeer ? `${cabinetPeerName(cabinet.activePeer)}的文件柜` : '文件柜'
)

const peerSubtitle = computed(() => {
  const p = cabinet.activePeer
  if (!p) return ''
  if (!p.online) return '离线'
  return [p.dept, p.ip].filter((s) => (s ?? '').length > 0).join(' · ') || '在线'
})

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${mm}-${dd}`
  const sameDay = d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? `今天 ${hh}:${mi}` : `${mm}-${dd} ${hh}:${mi}`
}

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
  } else if (event.key === 'ArrowUp') {
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

function openMenu(index: number, event: MouseEvent): void {
  const entry = cabinet.entries[index]
  if (!entry) return
  if (!cabinet.picked.has(entry.name)) {
    cabinet.picked = new Set([entry.name])
    cabinet.cursor = index
  }
  menu.value = { open: true, x: event.clientX, y: event.clientY }
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
    cabinet.flashToast('文件名已复制')
  } catch {
    cabinet.flashToast('复制失败')
  }
}

function onDragOver(event: DragEvent): void {
  if (cabinet.target.kind !== 'peer') return
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

async function addGrant(): Promise<void> {
  if (!newGrantId.value) return
  await cabinet.addGrant(newGrantId.value)
  newGrantId.value = null
}

function changeGrant(nodeId: string, mode: string | number | null): void {
  if (mode !== 'off' && mode !== 'read' && mode !== 'write') return
  void cabinet.changeGrant(nodeId, mode as ShareMode)
}

function closeMenu(): void {
  if (menu.value.open) menu.value.open = false
}

function onMenuEscape(event: KeyboardEvent): void {
  if (!menu.value.open || !isPlainEscape(event)) return
  event.preventDefault()
  closeMenu()
}

onMounted(() => {
  void cabinet.init()
  window.addEventListener('click', closeMenu)
  document.addEventListener('keydown', onMenuEscape)
})

onUnmounted(() => {
  window.removeEventListener('click', closeMenu)
  document.removeEventListener('keydown', onMenuEscape)
})
</script>

<template>
  <!-- ——— 我的文件柜管理页 ——— -->
  <section v-if="cabinet.target.kind === 'mine'" class="cabinet-pane">
    <header class="head">
      <span class="head-icon"><PantryIcon name="cabinet" :size="18" /></span>
      <span class="head-txt">
        <span class="head-title">我的文件柜</span>
        <span class="head-sub">
          {{ cabinet.shareRoot ? '正在共享 · 同事按下面的权限访问' : '还没有开启，同事看不到任何内容' }}
        </span>
      </span>
      <NButton v-if="cabinet.shareRoot" quaternary size="small" @click="cabinet.clearShareRoot()">
        停止共享
      </NButton>
    </header>

    <div v-if="!cabinet.shareRoot" class="guide">
      <span class="guide-icon"><PantryIcon name="cabinet" :size="24" /></span>
      <strong>你还没有开文件柜</strong>
      <p>选一个目录，同事就能自己来取里面的文件，不用你一个个发。</p>
      <p v-if="cabinet.shareRootError" class="guide-error">{{ cabinet.shareRootError }}</p>
      <NButton type="primary" @click="cabinet.pickShareRoot()">选择共享目录</NButton>
    </div>

    <div v-else class="page">
      <section class="card">
        <h3>共享目录</h3>
        <div class="path-row">
          <span class="path-icon"><PantryIcon name="folder" :size="15" /></span>
          <span class="path" :title="cabinet.shareRoot">{{ cabinet.shareRoot }}</span>
          <NButton size="tiny" secondary @click="cabinet.revealShareRoot()">打开</NButton>
          <NButton size="tiny" secondary @click="cabinet.pickShareRoot()">更改…</NButton>
        </div>
        <p v-if="cabinet.shareRootError" class="card-error">{{ cabinet.shareRootError }}</p>
        <p class="card-hint">同事只能看到这个目录里面的内容，看不到它在你磁盘上的位置。</p>
      </section>

      <section class="card">
        <h3>默认权限</h3>
        <div class="segment" role="radiogroup" aria-label="文件柜默认权限">
          <button
            v-for="opt in SHARE_MODE_OPTIONS"
            :key="opt.value"
            type="button"
            role="radio"
            :class="{ on: cabinet.shareMode === opt.value }"
            :aria-checked="cabinet.shareMode === opt.value"
            @click="cabinet.changeShareMode(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <p class="card-hint">{{ cabinet.shareModeHint }}</p>
      </section>

      <section class="card">
        <h3>
          单独设过的同事
          <em v-if="cabinet.grants.length">{{ cabinet.grants.length }} 人</em>
        </h3>
        <div v-if="cabinet.grants.length === 0" class="card-empty">所有同事都按默认权限</div>
        <div v-else class="grant-table">
          <div class="grant-row grant-head"><span>同事</span><span>权限</span><span></span></div>
          <div v-for="g in cabinet.grants" :key="g.nodeId" class="grant-row">
            <span class="grant-peer">
              <AvatarMark
                class="grant-avatar"
                :avatar="g.avatar"
                :avatar-hash="g.avatarHash"
                :name="g.name"
                :offline="!g.online"
              />
              <span :class="{ offline: !g.online }">
                {{ g.name }}{{ g.online ? '' : '（离线）' }}
              </span>
            </span>
            <NSelect
              :value="g.mode"
              :options="SHARE_MODE_OPTIONS"
              size="small"
              @update:value="(v: string | number | null) => changeGrant(g.nodeId, v)"
            />
            <button
              type="button"
              class="icon-btn danger"
              title="移除例外（恢复跟随默认权限）"
              @click="cabinet.removeGrant(g.nodeId)"
            >
              <PantryIcon name="x" :size="13" />
            </button>
          </div>
        </div>
        <div class="grant-add">
          <NSelect
            v-model:value="newGrantId"
            :options="cabinet.grantCandidates"
            filterable
            clearable
            size="small"
            placeholder="搜索同事，为 TA 单独设置权限"
          />
          <NButton size="small" :disabled="!newGrantId" @click="addGrant">添加</NButton>
        </div>
      </section>

      <section class="card">
        <h3>最近有人放进来</h3>
        <div v-if="cabinet.recentUploads.length === 0" class="card-empty">
          还没有人往你的文件柜放东西
        </div>
        <div v-else class="feed">
          <button
            v-for="item in cabinet.recentUploads"
            :key="item.transferId"
            type="button"
            class="feed-row"
            @click="cabinet.revealUpload(item.transferId)"
          >
            <AvatarMark
              class="feed-avatar"
              :avatar="item.avatar"
              :avatar-hash="item.avatarHash"
              :name="item.name"
            />
            <span class="feed-txt">
              <b>{{ item.name }}</b> 放进来 {{ item.fileCount }} 个文件 ·
              {{ formatBytes(item.totalSize) }}
            </span>
            <time>{{ formatTime(item.ts) }}</time>
          </button>
        </div>
        <p class="card-hint">点任意一条打开本机对应目录。别人只是浏览、下载不会出现在这里。</p>
      </section>
    </div>

    <Transition name="cab-toast">
      <div v-if="cabinet.toast" class="toast" role="status" aria-live="polite">
        <PantryIcon name="check" :size="15" />
        <span>{{ cabinet.toast }}</span>
      </div>
    </Transition>
  </section>

  <!-- ——— 对方的文件柜浏览器 ——— -->
  <section
    v-else
    class="cabinet-pane"
    :class="{ 'drag-active': dragActive && cabinet.canUpload, 'drag-deny': dragActive && !cabinet.canUpload }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
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
          <template v-if="!cabinet.failReason && cabinet.total > 0">
            · 共 {{ cabinet.total }} 项
          </template>
        </span>
      </span>
      <span v-if="!cabinet.failReason" class="perm" :class="cabinet.perm">
        {{ cabinet.canUpload ? '可上传' : '只读' }}
      </span>
      <span class="seg-view" role="group" aria-label="视图">
        <button
          type="button"
          :class="{ on: cabinet.viewMode === 'list' }"
          title="详情列表"
          aria-label="详情列表"
          @click="cabinet.setViewMode('list')"
        >
          <PantryIcon name="list" :size="15" />
        </button>
        <button
          type="button"
          :class="{ on: cabinet.viewMode === 'grid' }"
          title="网格"
          aria-label="网格"
          @click="cabinet.setViewMode('grid')"
        >
          <PantryIcon name="grid" :size="15" />
        </button>
      </span>
      <button
        type="button"
        class="icon-btn quiet"
        title="刷新"
        :disabled="cabinet.loading"
        @click="cabinet.load(cabinet.path)"
      >
        <PantryIcon name="refresh" :size="16" />
      </button>
    </header>

    <div class="crumbs">
      <button
        type="button"
        class="icon-btn"
        title="返回上级"
        :disabled="cabinet.crumbs.length < 2 || cabinet.loading"
        @click="cabinet.goUp()"
      >
        <PantryIcon name="chevron-left" :size="16" />
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
    </div>

    <div v-if="cabinet.loading" class="state">正在读取…</div>
    <div v-else-if="cabinet.failReason" class="state error">
      <span class="state-icon"><PantryIcon name="info" :size="21" /></span>
      <strong>{{ cabinet.failText }}</strong>
      <NButton size="small" @click="cabinet.load(cabinet.path)">重试</NButton>
    </div>
    <div v-else-if="cabinet.entries.length === 0" class="state">
      <span class="state-icon"><PantryIcon name="folder" :size="21" /></span>
      <strong>这个文件夹是空的</strong>
      <small v-if="cabinet.canUpload">
        可以把文件拖进来，会放到 TA 柜子里以你命名的文件夹。
      </small>
    </div>
    <template v-else>
      <div v-if="cabinet.viewMode === 'list'" class="cols">
        <label class="pick-all">
          <input type="checkbox" :checked="cabinet.allLoadedPicked" @change="cabinet.toggleAll()" />
          <span>{{ cabinet.pickAllLabel }}</span>
        </label>
        <span class="c-name">名称</span>
        <span class="c-size">大小</span>
        <span class="c-time">修改时间</span>
      </div>
      <div
        v-if="cabinet.viewMode === 'list'"
        ref="listEl"
        class="rows"
        tabindex="0"
        role="listbox"
        aria-label="文件列表"
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
            :aria-label="`勾选 ${entry.name}`"
            @click.stop
            @change="cabinet.togglePick(entry.name)"
          />
          <FileTypeIcon class="row-icon" :name="entry.name" :dir="entry.isDir" :size="22" />
          <span class="row-name" :title="entry.name">{{ entry.name }}</span>
          <span class="row-size">{{ entry.isDir ? '—' : formatBytes(entry.size) }}</span>
          <span class="row-time">{{ formatTime(entry.mtime) }}</span>
        </div>
        <div v-if="cabinet.loadingMore" class="tail">正在加载更多…</div>
        <div v-else-if="cabinet.moreFailReason" class="tail fail">
          <span>{{ cabinet.moreFailText }}</span>
          <button type="button" class="link" @click="cabinet.loadMore()">重试</button>
        </div>
        <div v-else-if="cabinet.truncated" class="tail">
          目录内容过多，仅显示前 {{ SHARE_DIR_MAX_ENTRIES }} 项
        </div>
      </div>

      <div
        v-else
        class="grid"
        tabindex="0"
        role="listbox"
        aria-label="文件网格"
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
        <div v-if="cabinet.loadingMore" class="tail grid-tail">正在加载更多…</div>
        <div v-else-if="cabinet.moreFailReason" class="tail fail grid-tail">
          <span>{{ cabinet.moreFailText }}</span>
          <button type="button" class="link" @click="cabinet.loadMore()">重试</button>
        </div>
        <div v-else-if="cabinet.truncated" class="tail grid-tail">
          目录内容过多，仅显示前 {{ SHARE_DIR_MAX_ENTRIES }} 项
        </div>
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
        <button v-if="cabinet.transferActive" type="button" class="link" @click="cabinet.cancelTransfer()">
          取消
        </button>
        <button
          v-else-if="cabinet.transfer?.status === 'done' && cabinet.transfer.direction === 'in'"
          type="button"
          class="link"
          @click="cabinet.revealTransfer()"
        >
          打开位置
        </button>
      </div>
      <div v-if="cabinet.transferActive" class="bar">
        <span class="bar-fill" :style="{ width: `${cabinet.progressPercent}%` }"></span>
      </div>
    </div>

    <footer class="foot">
      <div class="foot-row">
        <span class="foot-sum">
          <template v-if="cabinet.pickedCount > 0">
            已选 <b>{{ cabinet.pickedCount }}</b> 项<template v-if="cabinet.pickedSize > 0">
              · {{ formatBytes(cabinet.pickedSize) }}</template>
          </template>
          <template v-else-if="!cabinet.failReason">单击选中，双击进文件夹</template>
        </span>
        <span class="foot-actions">
          <template v-if="cabinet.pickedCount > 0">
            <NButton size="small" secondary :disabled="cabinet.downloading" @click="cabinet.download(true)">
              另存为…
            </NButton>
            <NButton
              size="small"
              type="primary"
              :disabled="cabinet.downloading"
              @click="cabinet.download(false)"
            >
              下载 {{ cabinet.pickedCount }} 项
            </NButton>
          </template>
          <template v-else-if="cabinet.canUpload">
            <NButton size="small" secondary :disabled="cabinet.uploading" @click="cabinet.upload(true)">
              上传文件夹
            </NButton>
            <NButton
              size="small"
              type="primary"
              :disabled="cabinet.uploading"
              @click="cabinet.upload(false)"
            >
              上传到 TA 的柜子
            </NButton>
          </template>
        </span>
      </div>
      <p class="foot-hint">
        <template v-if="cabinet.canUpload">
          上传的内容会放进 TA 柜子里的「{{ cabinet.selfName }}」文件夹，不影响 TA 已有的文件；下载默认落到「文件保存位置」下的「文件柜-对方名称」。
        </template>
        <template v-else>
          下载默认落到「文件保存位置」下的「文件柜-对方名称」，也可以「另存为」自选目录。
        </template>
      </p>
    </footer>

    <!-- 右键菜单：只有取，没有删改（决议 #272/#283） -->
    <div
      v-if="menu.open"
      class="ctx-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      role="menu"
    >
      <button type="button" role="menuitem" @click="menuDownload(false)">下载</button>
      <button type="button" role="menuitem" @click="menuDownload(true)">另存为…</button>
      <button type="button" role="menuitem" @click="copyName">复制文件名</button>
    </div>

    <Transition name="cab-toast">
      <div v-if="cabinet.toast" class="toast" role="status" aria-live="polite">
        <PantryIcon name="check" :size="15" />
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
  content: '松手就放进 TA 的柜子';
  position: absolute;
  inset: 8px;
  z-index: 5;
  display: grid;
  place-items: center;
  border: 2px dashed var(--primary);
  border-radius: 14px;
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
}

.cabinet-pane.drag-deny::after {
  content: '对方没有开放上传';
  border-color: var(--text-3);
  background: var(--surface-hover);
  color: var(--text-2);
}

.head {
  flex: none;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 0 16px;
  margin-top: 32px; /* 沉浸式拖拽带（决议 #49） */
  border-bottom: 1px solid var(--line);
}

.head-avatar {
  flex: none;
  width: 32px;
  height: 32px;
}

.head-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
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
  font-size: 15px;
  font-weight: 600;
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
  border-radius: 9px;
  background: var(--surface-hover);
}

.seg-view button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}

.seg-view button.on {
  background: var(--material-strong);
  color: var(--primary);
  box-shadow: var(--shadow-soft);
}

.icon-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.icon-btn.quiet {
  background: var(--surface-hover);
}

.icon-btn:hover:not(:disabled) {
  color: var(--primary);
  background: var(--surface-hover);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.icon-btn.danger:hover {
  color: var(--danger);
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
  padding: 4px 6px;
}

.rows:focus-visible,
.grid:focus-visible {
  outline: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px;
  border-radius: 9px;
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
  border-radius: 10px;
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
  border-radius: 9px;
  background: var(--surface-hover);
  color: var(--text-3);
}

.state.error .state-icon {
  color: var(--danger);
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

.foot-actions {
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

/* ——— 我的文件柜页 ——— */
.page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--bg-list);
}

.card {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--material-strong);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.card h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.card h3 em {
  font-style: normal;
  font-size: 11px;
  font-weight: 500;
  color: var(--primary);
  background: var(--primary-weak);
  padding: 2px 7px;
  border-radius: 999px;
}

.card-hint,
.card-empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}

.card-error,
.guide-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

.path-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 9px;
  background: var(--bg-list);
}

.path-icon {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--text-2);
}

.path {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.segment {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg-list);
}

.segment button {
  flex: 1;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
}

.segment button.on {
  background: var(--primary);
  color: #fff;
  font-weight: 500;
}

.grant-table {
  display: flex;
  flex-direction: column;
}

.grant-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px 28px;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
}

.grant-row:last-child {
  border-bottom: none;
}

.grant-head {
  font-size: 11.5px;
  color: var(--text-3);
}

.grant-peer {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.grant-peer > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grant-avatar,
.feed-avatar {
  flex: none;
  width: 24px;
  height: 24px;
}

.offline {
  color: var(--text-3);
}

.grant-add {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grant-add :deep(.n-select) {
  flex: 1;
  min-width: 0;
}

.feed {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.feed-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.feed-row:hover {
  background: var(--surface-hover);
}

.feed-txt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feed-txt b {
  color: var(--text-1);
  font-weight: 500;
}

.feed-row time {
  flex: none;
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.guide {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  text-align: center;
}

.guide strong {
  font-size: 15px;
}

.guide p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
  max-width: 40ch;
  line-height: 1.6;
}

.guide-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--primary-weak);
  color: var(--primary);
}

/* ——— 右键菜单与 toast ——— */
.ctx-menu {
  position: fixed;
  z-index: 80;
  min-width: 140px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 10px;
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

.cab-toast-enter-active {
  transition: opacity 0.24s ease, transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}

.cab-toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.cab-toast-enter-from,
.cab-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill {
    transition: none;
  }

  .cab-toast-enter-active,
  .cab-toast-leave-active {
    transition: opacity 0.16s ease;
  }

  .cab-toast-enter-from,
  .cab-toast-leave-to {
    transform: translateX(-50%);
  }
}
</style>
