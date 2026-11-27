<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ConversationMessageHit, ConversationSearchKind, ConversationSearchOptions } from '../../../shared/ipc'
import { searchTerms } from '../../../shared/search-terms'
import { vCachedImage } from '../directives/cached-image'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import { usePeersStore } from '../stores/peers'
import { splitEmojiText } from '../utils/compat-emoji'
import { isImeCompositionKey } from '../utils/ime'
import { language, tr } from '../utils/i18n'
import CompatEmoji from './CompatEmoji.vue'
import PantryIcon from './PantryIcon.vue'

const props = defineProps<{
  convId: string | null
  query: string
  kind: ConversationSearchKind
  originConvId: string | null
}>()
const emit = defineEmits<{ close: []; located: [] }>()
const chat = useChatStore()
const groups = useGroupsStore()
const peers = usePeersStore()
const scope = ref(props.convId)
const query = ref(props.query)
const kind = ref(props.kind)
const sender = ref<string | true | null>(null)
const senderIds = ref<string[]>([])
const period = ref('any')
const from = ref('')
const to = ref('')
const filtersOpen = ref(false)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const hits = ref<ConversationMessageHit[]>([])
const selected = ref('')
const locating = ref('')
const locationError = ref(false)
const previewError = ref(false)
const brokenImages = ref(new Set<string>())
const loading = ref(false)
const failed = ref(false)
const more = ref(false)
const retry = ref(0)
const composing = ref(false)
let searchRun = 0
let locationRun = 0
const pageSize = 30

const kinds = computed(() => [
  { value: 'all', label: tr('全部') }, { value: 'message', label: tr('文字') },
  { value: 'file', label: tr('文件') }, { value: 'image', label: tr('图片') }
] as const)
const periods = computed(() => [
  { value: 'any', label: tr('全部日期') }, { value: 'today', label: tr('今天') },
  { value: 'week', label: tr('近 7 天') }, { value: 'month', label: tr('近 30 天') },
  { value: 'custom', label: tr('自定义日期') }
])

function nameOf(convId: string): string {
  return convId.startsWith('group:') ? groups.nameOf(convId.slice(6)) : senderName(convId.slice(7))
}
const scopeChoices = computed(() => {
  const ids = [scope.value, props.convId, props.originConvId, chat.activeConvId, ...chat.convs.map(c => c.id)]
  return [...new Set(ids.filter((id): id is string => !!id))]
})
function senderName(id: string): string {
  const peer = peers.byId(id)
  return peer?.remark || peer?.nick || tr('未知节点') + ' · ' + id.slice(0, 8)
}
watch([scope, filtersOpen], async ([id, open], _, cleanup) => {
  if (!open) return
  let active = true
  cleanup(() => { active = false })
  senderIds.value = []
  const ids = await window.pantry.searchSenders(id).catch(() => [])
  if (active) senderIds.value = ids
})
const senders = computed(() => {
  const known = new Set([...senderIds.value, ...hits.value.filter(h => !h.isMine).map(h => h.senderId)])
  if (typeof sender.value === 'string') known.add(sender.value)
  return [...known].map(id => ({ id, name: senderName(id) })).sort((a, b) => a.name.localeCompare(b.name))
})
const activeFilters = computed(() => Number(!!sender.value) + Number(period.value !== 'any'))
const filterSummary = computed(() => {
  const who = sender.value ? (sender.value === true ? tr('我') : senderName(sender.value)) : ''
  const when = period.value === 'any' ? '' : period.value === 'custom' && (from.value || to.value)
    ? [from.value || '…', to.value || '…'].join(' – ') : periods.value.find(p => p.value === period.value)?.label
  return [who, when].filter(Boolean).join(' · ')
})
const invalidDates = computed(() => period.value === 'custom' && !!from.value && !!to.value && from.value > to.value)
function dateBoundary(value: string, end = false): number | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d + (end ? 1 : 0)).getTime() - (end ? 1 : 0)
}
const options = computed<ConversationSearchOptions>(() => {
  const opt: ConversationSearchOptions = {
    convId: scope.value, query: query.value.trim(), kind: kind.value, limit: pageSize + 1
  }
  if (sender.value === true) opt.fromMe = true
  else if (sender.value) opt.senderId = sender.value
  if (period.value === 'custom') {
    opt.fromTs = dateBoundary(from.value)
    opt.toTs = dateBoundary(to.value, true)
  } else if (period.value !== 'any') {
    const today = new Date()
    const days = period.value === 'month' ? 30 : period.value === 'week' ? 7 : 1
    opt.fromTs = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1).getTime()
    opt.toTs = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime() - 1
  }
  return opt
})

async function fetchPage(opt: ConversationSearchOptions, run: number, append = false): Promise<void> {
  loading.value = true
  failed.value = false
  try {
    const rows = await window.pantry.searchMessages(opt)
    if (run !== searchRun) return
    more.value = rows.length > pageSize
    hits.value = (append ? hits.value : []).concat(rows.slice(0, pageSize))
  } catch {
    if (run === searchRun) failed.value = true
  } finally {
    if (run === searchRun) loading.value = false
  }
}
watch([options, retry], ([opt], _, cleanup) => {
  const run = ++searchRun
  locationRun++
  hits.value = []
  selected.value = ''
  locating.value = ''
  previewError.value = false
  locationError.value = false
  failed.value = false
  more.value = false
  brokenImages.value = new Set()
  if (list.value) list.value.scrollTop = 0
  loading.value = !invalidDates.value
  if (invalidDates.value) return
  const timer = setTimeout(() => { void fetchPage(opt, run) }, opt.query ? 160 : 0)
  cleanup(() => clearTimeout(timer))
}, { immediate: true, flush: 'sync' })

function loadMore(): void {
  const last = hits.value[hits.value.length - 1]
  if (!last || !more.value || loading.value) return
  const before = { ts: last.ts, seq: last.seq, msgId: last.msgId }
  void fetchPage({ ...options.value, before }, searchRun, true)
}
function clearFilters(): void {
  sender.value = null
  period.value = 'any'
  from.value = to.value = ''
}
function focusQuery(): void { input.value?.focus() }
function findInConversation(convId: string | null): void {
  scope.value = convId
  focusQuery()
}
defineExpose({ focusQuery, findInConversation })
onMounted(focusQuery)
onUnmounted(() => { searchRun++; locationRun++ })

async function locate(hit: ConversationMessageHit): Promise<void> {
  const run = ++locationRun
  locationError.value = false
  locating.value = hit.msgId
  try {
    const found = await chat.jumpToMessage(hit.convId, hit.seq, hit.msgId)
    if (run !== locationRun) return
    if (found) {
      selected.value = hit.msgId
      emit('located')
    } else locationError.value = true
  } catch {
    if (run === locationRun) locationError.value = true
  } finally {
    if (run === locationRun) locating.value = ''
  }
}

const dateFormat = computed(() => new Intl.DateTimeFormat(language.value, { year: 'numeric', month: 'short', day: 'numeric' }))
const timeFormat = computed(() => new Intl.DateTimeFormat(language.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
const resultDays = computed(() => {
  const days: { label: string; items: ConversationMessageHit[] }[] = []
  for (const hit of hits.value) {
    const label = dateFormat.value.format(hit.ts)
    const last = days[days.length - 1]
    if (last?.label === label) last.items.push(hit)
    else days.push({ label, items: [hit] })
  }
  return days
})
const matcher = computed(() => {
  const terms = searchTerms(query.value).sort((a, b) => b.length - a.length)
  const patterns = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return patterns.length ? new RegExp('(' + patterns.join('|') + ')', 'gi') : null
})
function parts(hit: ConversationMessageHit): string[] {
  const label = hit.snippet
  return matcher.value ? label.split(matcher.value) : [label]
}
function imageId(hit: ConversationMessageHit): string {
  return hit.kind === 'image' && !brokenImages.value.has(hit.msgId) ? hit.fileRef?.transferId || '' : ''
}
async function previewImage(hit: ConversationMessageHit): Promise<void> {
  const run = searchRun
  const opened = await window.pantry.openImageViewer(imageId(hit)).catch(() => false)
  if (run === searchRun) previewError.value = !opened
}
function imageFailed(hit: ConversationMessageHit, e: Event): void {
  const img = e.currentTarget as HTMLImageElement
  if (img.src.startsWith('pantry-thumb:') && !img.dataset.original) {
    img.dataset.original = '1'
    img.src = 'pantry-img://' + imageId(hit)
  } else brokenImages.value.add(hit.msgId)
}
function stepResult(event: KeyboardEvent): void {
  if (isImeCompositionKey(event, composing.value) || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  const buttons = Array.from(list.value?.querySelectorAll<HTMLButtonElement>('.result-hit') ?? [])
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  const next = event.key === 'ArrowUp' ? index - 1 : index + 1
  const target = next < 0 ? input.value : buttons[next] || list.value?.querySelector<HTMLButtonElement>('.load-more')
  if (target) {
    event.preventDefault()
    target.focus()
  }
}
function clearQuery(): void {
  query.value = ''
  void nextTick(focusQuery)
}
</script>

<template>
  <section class="history" :aria-label="tr('聊天记录')"
    @compositionstart="composing = true" @compositionend="composing = false">
    <header class="history-head">
      <button type="button" class="icon-control compact-icon" :aria-label="tr('返回列表')" :title="tr('返回列表')" @click="emit('close')">
        <PantryIcon name="chevron-left" size="compact" />
      </button>
      <h2>{{ tr('聊天记录') }}</h2>
    </header>
    <div class="criteria">
      <label class="scope-line">
        <span>{{ tr('搜索范围') }}</span>
        <select v-model="scope">
          <option :value="null">{{ tr('全部聊天') }}</option>
          <option v-for="id in scopeChoices" :key="id" :value="id">{{ nameOf(id) }}</option>
        </select>
      </label>
      <div class="query-box">
        <PantryIcon name="search" size="compact" />
        <input ref="input" v-model="query" maxlength="128" @keydown.down="stepResult" :aria-label="tr('搜索消息或文件名')" :placeholder="tr('搜索消息或文件名')" />
        <button v-if="query" type="button" class="icon-control compact-icon" :aria-label="tr('清除关键词')" @click="clearQuery"><PantryIcon name="x" size="inline" /></button>
      </div>
      <div class="controls">
        <div class="kinds" role="group" :aria-label="tr('消息类型')">
          <button v-for="item in kinds" :key="item.value" type="button" :aria-pressed="kind === item.value" @click="kind = item.value">{{ item.label }}</button>
        </div>
        <button type="button" class="filter-toggle" :class="{ applied: activeFilters }"
          :aria-expanded="filtersOpen" aria-controls="history-filters" @click="filtersOpen = !filtersOpen">
          {{ tr('筛选') }}<span v-if="activeFilters && !filtersOpen"> · {{ activeFilters }}</span><PantryIcon :name="filtersOpen ? 'chevron-up' : 'chevron-down'" :size="12" />
        </button>
      </div>
      <button v-if="activeFilters && !filtersOpen" type="button" class="filter-summary" @click="filtersOpen = true">{{ filterSummary }}</button>
    </div>
    <div ref="list" class="history-scroll">
      <div v-if="filtersOpen" id="history-filters" class="filter-fields">
        <label>
          {{ tr('发送人') }}
          <select v-model="sender">
            <option :value="null">{{ tr('所有人') }}</option>
            <option :value="true">{{ tr('我') }}</option>
            <option v-for="person in senders" :key="person.id" :value="person.id">{{ person.name }}</option>
          </select>
        </label>
        <label>
          {{ tr('日期') }}
          <select v-model="period">
            <option v-for="p in periods" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </label>
        <template v-if="period === 'custom'">
          <label>{{ tr('开始日期') }}<input v-model="from" type="date" /></label>
          <label>{{ tr('结束日期') }}<input v-model="to" type="date" :aria-invalid="invalidDates || undefined" :aria-describedby="invalidDates ? 'history-date-error' : undefined" /></label>
        </template>
        <button v-if="activeFilters" type="button" class="text-button" @click="clearFilters">{{ tr('清除筛选') }}</button>
      </div>
      <div v-if="invalidDates" id="history-date-error" class="feedback date-error" role="status">{{ tr('结束日期须在开始日期当天或之后') }}</div>
      <template v-else>
        <div v-if="!hits.length && loading" class="feedback" role="status">{{ tr('正在搜索…') }}</div>
        <div v-else-if="!hits.length && !failed" class="feedback" role="status">
          <strong>{{ tr('没有找到相关记录') }}</strong>
          <button v-if="activeFilters || kind !== 'all'" type="button" class="text-button" @click="clearFilters(); kind = 'all'">{{ tr('清除筛选') }}</button>
          <button v-if="scope" type="button" class="text-button" @click="scope = null">{{ tr('在全部聊天中查找') }}</button>
        </div>
        <div v-if="hits.length" class="result-info" role="status">
          <span>{{ more ? tr('已显示 {0} 条', { 0: hits.length }) : tr('{0} 条结果', { 0: hits.length }) }}</span><span>{{ tr('从新到旧') }}</span>
        </div>
        <div v-if="previewError" class="feedback" role="status">{{ tr('原图不可用，可点记录查看聊天原文。') }}</div>
        <div v-if="locationError" class="feedback" role="status">{{ tr('无法定位这条记录，请刷新结果后再试。') }}<button type="button" class="text-button" @click="retry++">{{ tr('刷新结果') }}</button></div>
        <section v-for="day in resultDays" :key="day.label" class="result-day">
          <h3>{{ day.label }}</h3>
          <div v-for="hit in day.items" :key="hit.msgId" class="result-row" :class="{ selected: selected === hit.msgId }">
            <button
              type="button" class="result-hit"
              :aria-current="selected === hit.msgId ? 'true' : undefined"
              :aria-busy="locating === hit.msgId"
              :title="hit.kind === 'file' || hit.kind === 'image' ? hit.title + ' · ' + tr('定位到聊天原文') : tr('定位到聊天原文')"
              @keydown.down="stepResult" @keydown.up="stepResult"
              @click="locate(hit)"
            >
              <span class="hit-meta">
                <b>{{ hit.isMine ? tr('我') : senderName(hit.senderId) }}</b>
                <time>{{ timeFormat.format(hit.ts) }}</time>
              </span>
              <span class="hit-summary">
                <PantryIcon v-if="hit.kind !== 'text'" :name="hit.kind" :size="15" />
                <component v-for="(part, i) in parts(hit)" :is="i % 2 ? 'mark' : 'span'" :key="i">
                  <template v-for="(seg, j) in splitEmojiText(part)" :key="j">
                    <CompatEmoji v-if="seg.emoji" :emoji="seg.text" />
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </component>
              </span>
              <span v-if="!scope && (hit.isMine || hit.convId.startsWith('group:'))" class="hit-origin">
                <PantryIcon :name="hit.convId.startsWith('group:') ? 'users' : 'chat'" :size="12" />
                {{ nameOf(hit.convId) }}
              </span>
            </button>
            <button v-if="imageId(hit)" type="button" class="image-preview" :aria-label="tr('预览图片')" :title="tr('预览图片')" @click="previewImage(hit)">
              <img v-cached-image="{ transferId: imageId(hit) }" loading="lazy" decoding="async" alt="" @error="imageFailed(hit, $event)" />
            </button>
          </div>
        </section>
        <div v-if="failed" class="feedback" role="status">{{ tr('聊天记录读取失败') }}
          <button type="button" class="text-button" @click="hits.length ? loadMore() : retry++">{{ tr('重试') }}</button>
        </div>
        <button v-else-if="more" type="button" class="load-more text-button" :disabled="loading" @click="loadMore">{{ loading ? tr('正在搜索…') : tr('加载更早的记录') }}</button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.history {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  color: var(--text-1);
  background: var(--material-strong);
}
.history-head {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  padding: 32px 12px 0;
  height: 84px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
}
h2, h3 { margin: 0; }
h2 { font-size: 16px; font-weight: 650; }
:where(.history) button:where(:not(.icon-control)), :where(.history) input, :where(.history) select { font: inherit; color: inherit; }
:where(.history) button:where(:not(.icon-control)) { border: 0; cursor: pointer; background: transparent; }
.history button:focus-visible, .history select:focus-visible, .filter-fields input:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
@media (hover: hover) {
  .filter-toggle:hover { background: var(--surface-hover); }
  .kinds button:hover { background: var(--material-strong); }
  .result-row:hover { background: var(--surface-hover); }
  .text-button:hover:enabled { text-decoration: underline; }
}
.criteria { display: grid; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
.scope-line { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.scope-line span, .result-info, .hit-origin, .filter-fields label, .hit-meta time, .feedback { color: var(--text-2); }
.scope-line select {
  min-width: 0;
  max-width: 72%;
  padding: 3px 5px;
  font-weight: 600;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-input);
}
.query-box {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--primary-border);
  border-radius: var(--radius-control);
  padding: 0 7px;
  background: var(--bg-input);
  color: var(--text-2);
}
.query-box:focus-within { outline: 2px solid var(--primary); outline-offset: -1px; }
.query-box input {
  min-width: 0;
  width: 100%;
  height: 34px;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-1);
  font-size: 13px;
}
.controls, .kinds, .filter-toggle, .hit-meta, .result-info { display: flex; align-items: center; }
.controls, .hit-meta, .result-info { justify-content: space-between; gap: 5px; }
.controls { flex-wrap: wrap; }
.kinds { gap: 2px; border-radius: var(--radius-panel); background: var(--surface-hover); padding: 2px; }
.kinds button, .filter-toggle { font-size: var(--font-xs); border-radius: var(--radius-control); min-height: var(--control-square-sm); padding: 3px 7px; }
.kinds button[aria-pressed="true"] {
  background: var(--material-strong);
  color: var(--primary-hover);
  box-shadow: var(--shadow-soft);
  font-weight: 600;
}
.history .filter-toggle { gap: 3px; padding-inline: 3px; font-size: 12px; }
.filter-toggle[aria-expanded="true"] { background: var(--surface-selected); }
.history .applied, .history .text-button, .history .filter-summary { color: var(--primary-hover); }
.filter-summary { text-align: left; font-size: 12px; padding: 0; }
.history-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; flex: 1; scrollbar-gutter: stable; }
.filter-fields {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg-list);
  border-bottom: 1px solid var(--line);
}
.filter-fields label {
  display: grid;
  grid-template-columns: minmax(65px, auto) 1fr;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.filter-fields select, .filter-fields input {
  min-width: 0;
  width: 100%;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-input);
}
.filter-fields .text-button { justify-self: end; }
.result-info { padding: 10px 14px 4px; font-size: 11px; }
.result-day h3 { padding: 9px 14px 5px; font-size: 12px; font-weight: 600; color: var(--text-2); }
.result-row { display: flex; align-items: center; border-left: 3px solid transparent; }

.result-row.selected { border-color: var(--primary); background: var(--surface-selected); }
.result-row:active { background: var(--surface-pressed); }
.result-hit { flex: 1; min-width: 0; display: grid; gap: 4px; text-align: left; padding: 9px 14px 9px 11px; }
.hit-meta b, .hit-origin { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.hit-meta { font-size: 12px; }
.hit-meta time { flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; }
.hit-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
}
.hit-summary svg { display: inline-block; margin-right: 4px; vertical-align: -2px; color: var(--primary); }
mark { background: transparent; color: var(--primary-hover); font-weight: 700; }
.hit-origin { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.history .image-preview {
  width: 44px;
  height: 44px;
  margin-right: 12px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
  cursor: zoom-in;
  background: var(--bg-list);
}
.image-preview img { width: 100%; height: 100%; object-fit: cover; }
.feedback { padding: 20px 14px; display: grid; gap: 8px; justify-items: start; font-size: 13px; }
.text-button { min-height: 24px; padding: 4px 0; font-size: 12px; }
.date-error { color: var(--danger); }
.history .load-more:disabled { color: var(--text-2); cursor: default; }
@media (forced-colors: active) {
  .kinds button[aria-pressed="true"] { outline: 1px solid Highlight; outline-offset: -1px; }
}
.load-more { display: block; margin: 8px auto 14px; }
</style>
