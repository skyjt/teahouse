<script setup lang="ts">
import { tr } from '../utils/i18n'
import { messageText } from '../utils/message-text'
import { computed, ref, watch } from 'vue'
import type { ConversationSearchKind, PeerView } from '../../../shared/ipc'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import { listTime } from '../utils/time'
import { useGlobalSearch } from '../utils/global-search'
import AvatarMark from './AvatarMark.vue'
import PantryIcon from './PantryIcon.vue'

// 全局搜索结果面板（ui-design §6）：联系人 / 聊天记录（按会话聚合）/ 文件，
// 聚合结果展开该会话的全部命中，文件结果可直接查看原文。

const props = defineProps<{ query: string }>()
const emit = defineEmits<{
  navigate: []
  located: []
  history: [request: { convId: string; query: string; kind: ConversationSearchKind }]
}>()
const selectedFile = ref('')
const locateFailed = ref(false)
let locateRun = 0
watch(() => props.query, () => { locateRun++; selectedFile.value = ''; locateFailed.value = false })

const peersStore = usePeersStore()
const chatStore = useChatStore()
const { result, searching, failed, retry } = useGlobalSearch(() => props.query)

const groupsStore = useGroupsStore()
const matchingGroups = computed(() => {
  const query = props.query.trim().toLocaleLowerCase()
  return Object.values(groupsStore.byId).filter((g) => g.amMember && g.name.toLocaleLowerCase().includes(query))
})
const empty = computed(
  () =>
    !searching.value &&
    result.value.peers.length === 0 && matchingGroups.value.length === 0 &&
    result.value.messageGroups.length === 0 &&
    result.value.files.length === 0
)

const nickOf = computed(() => peersStore.nameOf) // 备注优先（F-DISC-9）

function peerName(peer: PeerView): string {
  return peer.remark || peer.nick
}

/** 会话显示名：群会话用群名，单聊用联系人名 */
function convName(convId: string, peerId: string): string {
  return convId.startsWith('group:') ? groupsStore.nameOf(convId.slice(6)) : nickOf.value(peerId)
}

async function openPeer(nodeId: string): Promise<void> {
  await chatStore.openPeer(nodeId)
  emit('navigate')
}

async function openGroup(groupId: string): Promise<void> {
  const id = 'group:' + groupId
  if (chatStore.pendingRemoval?.convId === id) chatStore.undoRemoveConversation()
  if (!chatStore.convs.some((conv) => conv.id === id)) {
    const restored = await window.pantry.openConversation(groupId, 'group')
    if (!restored) return
    chatStore.upsertConversation(restored)
  }
  await chatStore.openConv(id)
  emit('navigate')
}

async function openHit(convId: string, seq: number, msgId: string): Promise<void> {
  const run = ++locateRun
  locateFailed.value = false
  try {
    const found = await chatStore.jumpToMessage(convId, seq, msgId)
    if (run !== locateRun) return
    if (found) {
      selectedFile.value = msgId
      emit('located')
    } else locateFailed.value = true
  } catch {
    if (run === locateRun) locateFailed.value = true
  }
}
</script>

<template>
  <div class="pane">
    <div v-if="locateFailed" class="placeholder" role="status">{{ tr('无法定位这条记录，请刷新结果后再试。') }}
      <button type="button" class="retry" @click="locateFailed = false; retry()">{{ tr('刷新结果') }}</button>
    </div>
    <div v-if="searching" class="placeholder" role="status">{{ tr('正在搜索…') }}</div>
    <div v-else-if="failed" class="placeholder" role="status">{{ tr('聊天记录读取失败') }} <button type="button" class="retry" @click="retry">{{ tr('重试') }}</button></div>
    <div v-else-if="empty" class="placeholder">{{ tr('没有找到「{0}」相关的内容', { 0: props.query }) }}</div>
    <div v-else class="results">
      <template v-if="result.peers.length > 0">
        <div class="sec">{{ tr('联系人') }}</div>
        <button
          type="button"
          v-for="p in result.peers"
          :key="p.nodeId"
          class="item peer-item"
          @click="openPeer(p.nodeId)"
        >
          <AvatarMark
            class="search-avatar"
            :avatar="p.avatar"
            :avatar-hash="p.avatarHash"
            :name="peerName(p)"
            :offline="!p.online"
          />
          <span class="peer-text">
            <span class="t"
              >{{ peerName(p) }}<em v-if="!p.online" class="off">{{ tr('· 离线') }}</em></span
            >
            <span class="s">{{ [p.company, p.dept, p.team].filter(Boolean).join(' / ') || p.ip }}</span>
          </span>
        </button>
      </template>

      <template v-if="matchingGroups.length">
        <div class="sec">{{ tr('讨论组') }}</div>
        <button v-for="g in matchingGroups" :key="g.groupId" type="button" class="item peer-item" @click="openGroup(g.groupId)">
          <PantryIcon name="users" :size="22" />
          <span class="t">{{ g.name }}</span>
        </button>
      </template>

      <template v-if="result.messageGroups.length > 0">
        <div class="sec">{{ tr('聊天记录') }}</div>
        <button
          type="button"
          v-for="g in result.messageGroups"
          :key="g.convId"
          class="item"
          @click="emit('history', { convId: g.convId, query: props.query, kind: 'message' })"
        >
          <span class="t">{{ tr('与 {0} 的聊天 · {1} 条相关', { 0: convName(g.convId, g.peerId), 1: g.count }) }}</span>
          <span class="s">{{ g.previewMessage ? messageText(g.previewMessage) : g.snippet }} <i class="time">{{ listTime(g.ts) }}</i></span>
        </button>
      </template>

      <template v-if="result.files.length > 0">
        <div class="sec">{{ tr('文件') }}</div>
        <button
          type="button"
          v-for="f in result.files"
          :key="f.msgId"
          class="item"
          :aria-current="selectedFile === f.msgId ? 'true' : undefined"
          @click="openHit(f.convId, f.seq, f.msgId)"
        >
          <span class="t file-title">
            <PantryIcon name="file" :size="14" /><span class="t">{{ f.name }}</span>
          </span>
          <span class="s"
            >{{ tr('来自与 {0} 的聊天', { 0: convName(f.convId, f.peerId) }) }}<i class="time">{{ listTime(f.ts) }}</i></span
          >
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.placeholder {
  color: var(--text-2);
  font-size: 13px;
  text-align: center;
  margin-top: 24px;
}
.retry { color: var(--primary-hover); background: transparent; border: 0; cursor: pointer; font: inherit; }
.sec {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.3px;
  padding: 14px var(--pane-inset) 6px;
}
/* 分类标题不再贴下划线，改用组间分隔线 + 间距节奏区隔（决议 #122）；首个分类不加顶线 */
.sec:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid var(--line);
}
.item {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 8px var(--pane-inset);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
}
.item:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
@media (hover: hover) {
  .item:hover { background: var(--surface-hover); }
}
.item[aria-current="true"] { background: var(--surface-selected); }
.item[aria-current="true"] .file-title { font-weight: 600; }
.item:active { background: var(--surface-pressed); }
.peer-item {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.search-avatar {
  width: var(--avatar-list);
  height: var(--avatar-list);
  flex: none;
  background: var(--primary);
  color: var(--on-primary);
  font-size: 13px;
}
.peer-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.t {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-title {
  display: flex;
  align-items: center;
  gap: 5px;
}
.off {
  font-style: normal;
  font-size: 11px;
  color: var(--text-2);
}
.s {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.time {
  font-style: normal;
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
  margin-inline-start: 4px;
}
</style>
