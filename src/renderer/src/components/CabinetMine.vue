<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { NButton, NSelect } from 'naive-ui'
import type { OwnShareListing } from '../../../shared/ipc'
import { isShareMode, SHARE_DIR_MAX_ENTRIES, SHARE_LIST_PAGE, type ShareEntry, type ShareMode } from '../../../shared/protocol'
import { SHARE_MODE_OPTIONS, useCabinetStore } from '../stores/cabinet'
import { formatBytes, formatCabinetTime } from '../utils/format'
import { tr } from '../utils/i18n'
import AvatarMark from './AvatarMark.vue'
import FileTypeIcon from './FileTypeIcon.vue'
import PantryIcon from './PantryIcon.vue'

const cabinet = useCabinetStore()
const path = ref('')
const revision = ref(0)
const listing = shallowRef<OwnShareListing | null>(null)
const loading = ref(false)
const limit = ref(SHARE_LIST_PAGE)
const grantId = ref<string | null>(null)
const grantMode = ref<ShareMode>('read')
const savingGrant = ref(false)
const picking = ref(false)
const rootName = computed(() => cabinet.shareRoot.split(/[/\\]/).filter(Boolean).pop() || tr('共享目录'))
const page = computed(() => !cabinet.shareRoot && cabinet.minePage === 'access' ? 'files' : cabinet.minePage)
const crumbs = computed(() => {
  const segments = path.value ? path.value.split('/') : []
  return [{ name: rootName.value, path: '' }, ...segments.map((name, index) => ({
    name, path: segments.slice(0, index + 1).join('/')
  }))]
})
const visibleEntries = computed(() => listing.value?.entries.slice(0, limit.value) ?? [])

watch(() => cabinet.shareRoot, () => { path.value = '' })
watch([path, () => cabinet.shareRoot], () => { limit.value = SHARE_LIST_PAGE })
watch([() => cabinet.shareRoot, page, path, revision, () => cabinet.recentUploads[0]?.transferId],
  async ([root, active, rel], _previous, onCleanup) => {
    let current = true
    onCleanup(() => { current = false })
    if (!root || active !== 'files') {
      listing.value = null
      loading.value = false
      return
    }
    loading.value = true
    try {
      const result = await window.pantry.listOwnShareFolder(rel)
      if (current) listing.value = result
    } catch {
      if (current) listing.value = null
    } finally {
      if (current) loading.value = false
    }
  }, { immediate: true })

function refresh(): void {
  if (page.value === 'files' && cabinet.shareRoot) revision.value++
}
onMounted(() => window.addEventListener('focus', refresh))
onUnmounted(() => window.removeEventListener('focus', refresh))

function openEntry(entry: ShareEntry): void {
  const rel = path.value ? `${path.value}/${entry.name}` : entry.name
  if (entry.isDir) path.value = rel
  else void cabinet.revealShareRoot(rel)
}

async function chooseFolder(): Promise<void> {
  if (picking.value) return
  picking.value = true
  try { await cabinet.pickShareRoot() } finally { picking.value = false }
}

async function addPerson(): Promise<void> {
  if (!grantId.value || savingGrant.value) return
  savingGrant.value = true
  try {
    await cabinet.changeGrant(grantId.value, grantMode.value)
    grantId.value = null
    grantMode.value = 'read'
  } finally { savingGrant.value = false }
}

function setMode(event: Event, nodeId?: string): void {
  const value = (event.target as HTMLSelectElement).value
  if (!isShareMode(value)) return
  if (nodeId) void cabinet.changeGrant(nodeId, value)
  else void cabinet.changeShareMode(value)
}
</script>

<template>
  <nav v-if="cabinet.shareRoot || cabinet.recentUploads.length" class="sections" :aria-label="tr('我的文件柜')">
    <button type="button" :aria-current="page === 'files' ? 'page' : undefined" @click="cabinet.minePage = 'files'">{{ tr('柜内文件') }}</button>
    <button v-if="cabinet.shareRoot" type="button" :aria-current="page === 'access' ? 'page' : undefined" @click="cabinet.minePage = 'access'">{{ tr('谁能访问') }}</button>
    <button type="button" :aria-current="page === 'received' ? 'page' : undefined" @click="cabinet.minePage = 'received'">{{ tr('最近收到') }}</button>
  </nav>

  <div v-if="!cabinet.settings" class="pane-empty" role="status">{{ tr('正在读取…') }}</div>
  <template v-else-if="page === 'received'">
    <div v-if="!cabinet.recentUploads.length" class="pane-empty">
      <PantryIcon name="download" :size="30" />
      <strong>{{ tr('还没有收到同事上传的文件') }}</strong>
      <p>{{ tr('给同事上传权限后，就能在这里找到他们放进来的文件。') }}</p>
    </div>
    <div v-else class="scroll">
      <p class="caption">{{ tr('最多显示最近 10 次上传，点击可查看保存位置。') }}</p>
      <button v-for="item in cabinet.recentUploads" :key="item.transferId" type="button" class="entry" @click="cabinet.revealUpload(item.transferId)">
        <AvatarMark class="avatar" :avatar="item.avatar" :avatar-hash="item.avatarHash" :name="item.name" />
        <span class="received-file">
          <span class="filename" :title="item.fileName">{{ item.fileName || tr('上传的文件') }}</span>
          <small>{{ item.fileCount ? tr('{0} 上传了 {1} 个文件', { 0: item.name, 1: item.fileCount }) : tr('来自 {0}', { 0: item.name }) }}</small>
        </span>
        <small class="size">{{ formatBytes(item.totalSize) }}</small><small class="time">{{ formatCabinetTime(item.ts) }}</small>
        <PantryIcon name="external" :size="14" />
      </button>
    </div>
  </template>
  <div v-else-if="!cabinet.shareRoot" class="pane-empty">
    <span class="pane-empty-icon"><PantryIcon name="folder" :size="32" /></span>
    <strong>{{ tr('选择一个本机文件夹') }}</strong>
    <p>{{ tr('你在线时，有权限的同事可以来取里面的文件。你也可以从左侧直接访问同事的文件柜。') }}</p>
    <NButton type="primary" :disabled="picking" @click="chooseFolder">{{ tr('选择文件夹') }}</NButton>
    <small v-if="cabinet.shareRootError" class="error" role="alert">{{ cabinet.shareRootError }}</small>
  </div>

  <template v-else-if="page === 'files'">
    <div class="tools">
      <nav class="trail" :aria-label="tr('当前位置')">
        <template v-for="(crumb, i) in crumbs" :key="crumb.path">
          <span v-if="i" aria-hidden="true">/</span>
          <button type="button" :disabled="i === crumbs.length - 1" @click="path = crumb.path">{{ crumb.name }}</button>
        </template>
      </nav>
      <button type="button" class="icon-control compact-icon" :aria-label="tr('刷新')" :title="tr('刷新')" :disabled="loading" @click="refresh">
        <PantryIcon name="refresh" size="compact" />
      </button>
      <NButton size="small" secondary @click="cabinet.revealShareRoot(path)">{{ tr('打开本机文件夹') }}</NButton>
    </div>
    <div v-if="loading" class="pane-empty" role="status">{{ tr('正在读取…') }}</div>
    <div v-else-if="!listing" class="pane-empty" role="status">
      <strong>{{ tr('找不到这个文件夹，或没有读取权限。') }}</strong>
      <NButton v-if="path" size="small" @click="path = ''">{{ tr('返回共享目录') }}</NButton>
      <NButton v-else size="small" @click="cabinet.minePage = 'access'">{{ tr('更换文件夹') }}</NButton>
    </div>
    <div v-else-if="!visibleEntries.length" class="pane-empty">
      <PantryIcon name="folder" :size="30" /><strong>{{ tr('这个文件夹是空的') }}</strong>
      <p>{{ tr('打开本机文件夹，把要分享的文件放进去。') }}</p>
    </div>
    <div v-else class="scroll files">
      <div class="entry columns"><span class="filename">{{ tr('名称') }}</span><small class="size">{{ tr('大小') }}</small><small class="time">{{ tr('修改时间') }}</small></div>
      <button
        v-for="entry in visibleEntries" :key="entry.name" type="button" class="entry"
        :title="entry.isDir ? entry.name : tr('在本机定位 {0}', { 0: entry.name })" @click="openEntry(entry)"
      >
        <FileTypeIcon :name="entry.name" :dir="entry.isDir" :size="24" />
        <span class="filename">{{ entry.name }}</span>
        <small class="size">{{ entry.isDir ? '—' : formatBytes(entry.size) }}</small>
        <small class="time">{{ formatCabinetTime(entry.mtime) }}</small>
        <PantryIcon :name="entry.isDir ? 'chevron-right' : 'external'" size="inline" />
      </button>
      <NButton v-if="limit < listing.entries.length" size="small" quaternary @click="limit += SHARE_LIST_PAGE">{{ tr('显示更多') }}</NButton>
      <p v-else-if="listing.truncated" class="caption">{{ tr('目录内容过多，仅显示前 {0} 项', { 0: SHARE_DIR_MAX_ENTRIES }) }}</p>
    </div>
  </template>

  <div v-else class="scroll access">
    <section>
      <h3>{{ tr('指定同事的权限') }}</h3>
      <p>{{ tr('这里的设置优先于默认权限。允许上传的同事也只能添加新文件。') }}</p>
      <div v-for="g in cabinet.grants" :key="g.nodeId" class="person">
        <AvatarMark class="avatar" :name="g.name" :avatar="g.avatar" :avatar-hash="g.avatarHash" />
        <span class="filename" :title="g.name">{{ g.name }}</span>
        <select :aria-label="tr('{0} 的访问权限', { 0: g.name })" :value="g.mode" @change="setMode($event, g.nodeId)">
          <option v-for="o in SHARE_MODE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <NButton size="small" quaternary @click="cabinet.removeGrant(g.nodeId)">{{ tr('跟随默认') }}</NButton>
      </div>
      <div v-if="cabinet.grantCandidates.length" class="add-person">
        <NSelect v-model:value="grantId" filterable clearable size="small" :options="cabinet.grantCandidates" :placeholder="tr('选择同事')" />
        <select v-model="grantMode" :aria-label="tr('所选同事的权限')">
          <option v-for="o in SHARE_MODE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <NButton type="primary" size="small" :disabled="!grantId || savingGrant" @click="addPerson">{{ tr('添加') }}</NButton>
      </div>
      <p v-else-if="!cabinet.grants.length">{{ tr('发现同事后，可以在这里为他们设置权限。') }}</p>
    </section>
    <section>
      <h3><label for="cab-default">{{ tr('其他同事的默认权限') }}</label></h3>
      <p>{{ tr('没有单独设置权限的同事，都按此设置访问。') }}</p>
      <select id="cab-default" :value="cabinet.shareMode" @change="setMode($event)">
        <option v-for="o in SHARE_MODE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </section>
    <section>
      <h3>{{ tr('共享的本机文件夹') }}</h3>
      <p class="local-path">{{ cabinet.shareRoot }}</p>
      <div class="folder-actions">
        <NButton size="small" secondary :disabled="picking" @click="chooseFolder">{{ tr('更换文件夹') }}</NButton>
        <NButton size="small" quaternary @click="cabinet.clearShareRoot()">{{ tr('停止共享') }}</NButton>
      </div>
      <small v-if="cabinet.shareRootError" class="error" role="alert">{{ cabinet.shareRootError }}</small>
    </section>
  </div>
</template>

<style scoped>
.sections, .tools, .trail, .person, .add-person, .folder-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sections, .tools { flex: none; padding: 0 var(--pane-inset); border-bottom: 1px solid var(--line); }
.sections { gap: 16px; overflow-x: auto; }
.sections button { flex: none; }
.sections button, .trail button {
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--text-2);
  cursor: pointer;
}
.sections button { padding: 10px 4px 8px; border-bottom: 2px solid transparent; }
.sections [aria-current] { color: var(--primary); border-color: currentColor; font-weight: 600; }
.tools { min-height: 46px; }
.trail { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; }
.trail button { color: var(--primary); padding: 3px 0; }
.trail button:disabled { color: var(--text-1); cursor: default; }
.scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; container-type: inline-size; padding: 0 var(--pane-inset) var(--pane-inset); }
.entry {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 76px 104px 16px;
  grid-template-areas: "icon name size time action";
  align-items: center;
  column-gap: 8px;
  width: 100%;
  min-height: 42px;
  padding: 4px 6px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  button.entry:hover, .sections button:hover { background: var(--surface-hover); }
  .trail button:enabled:hover { text-decoration: underline; }
}
button.entry:active { background: var(--surface-pressed); }
.entry:focus-visible, .sections button:focus-visible, .trail button:focus-visible { outline-offset: -2px; }
.entry > :first-child:not(.filename) { grid-area: icon; justify-self: center; }
.entry > .filename, .received-file { grid-area: name; }
.entry > .size { grid-area: size; }
.entry > .time { grid-area: time; }
.entry > svg:last-child { grid-area: action; color: var(--text-2); }

.columns { min-height: 30px; font-weight: 600; color: var(--text-2); font-size: 12px; cursor: default; }
.filename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.received-file { flex: 1; min-width: 0; display: grid; }
.entry > small { text-align: right; font-variant-numeric: tabular-nums; }
.received-file small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caption { padding-block: 10px; }
@container (max-width: 420px) {
  .entry {
    grid-template-columns: 28px auto minmax(0, 1fr) 16px;
    grid-template-areas: "icon name name action" "icon size time action";
    row-gap: 2px;
    padding-block: 8px;
  }
  .entry > small { text-align: left; }
  .columns { display: none; }
}
small, .caption, .access p { color: var(--text-2); font-size: 12px; line-height: 1.6; }
.access { padding-inline: var(--pane-inset); }
.access section { max-width: 680px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.access section:last-child { border: 0; }
.access h3 { margin: 0; font-size: 14px; }
.access p { margin: 4px 0 10px; }
.local-path { overflow-wrap: anywhere; }
select { max-width: 100%; min-height: 30px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--bg-input); color: var(--text-1); font: inherit; }
.person, .add-person { padding: 5px 0; }
.add-person { flex-wrap: wrap; }
.add-person :deep(.n-select) { flex: 1 1 135px; min-width: 0; }
@container (max-width: 460px) {
  .add-person :deep(.n-select) { flex-basis: 100%; }
  .add-person select { flex: 1; }
}
.avatar { flex: none; width: 28px; height: 28px; }
.error { color: var(--danger); }
</style>
