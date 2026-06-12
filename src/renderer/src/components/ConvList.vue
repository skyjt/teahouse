<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ConversationView } from '../../../shared/ipc'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import { listTime } from '../utils/time'
import { avatarStyle, avatarText as renderAvatarText } from '../utils/avatar'
import PantryIcon from './PantryIcon.vue'

const peersStore = usePeersStore()
const chatStore = useChatStore()
const groupsStore = useGroupsStore()
const menu = ref<{ x: number; y: number; conv: ConversationView } | null>(null)

const nickOf = computed(() => peersStore.nameOf) // 备注优先（F-DISC-9）

function convName(conv: ConversationView): string {
  return conv.type === 'group' ? groupsStore.nameOf(conv.peerId) : nickOf.value(conv.peerId)
}

function convAvatarText(conv: ConversationView): string {
  const peer = peersStore.byId(conv.peerId)
  return renderAvatarText(peer?.avatar ?? -1, nickOf.value(conv.peerId))
}

function convAvatarStyle(conv: ConversationView): { backgroundColor: string; color: string } | undefined {
  if (conv.type === 'group') return undefined
  const peer = peersStore.byId(conv.peerId)
  return avatarStyle(peer?.avatar ?? -1, nickOf.value(conv.peerId))
}

function openMenu(event: MouseEvent, conv: ConversationView): void {
  menu.value = { x: event.clientX, y: event.clientY, conv }
}

async function togglePin(): Promise<void> {
  const conv = menu.value?.conv
  menu.value = null
  if (conv) await chatStore.pinConversation(conv.id, !conv.pinned)
}

async function toggleMute(): Promise<void> {
  const conv = menu.value?.conv
  menu.value = null
  if (conv) await chatStore.muteConversation(conv.id, !conv.muted)
}

async function removeConv(): Promise<void> {
  const conv = menu.value?.conv
  menu.value = null
  if (conv) await chatStore.removeConversation(conv.id)
}
</script>

<template>
  <div class="pane" @click="menu = null">
    <div v-if="chatStore.convs.length === 0" class="placeholder">
      还没有会话<br />去「通讯录」找个人开聊
    </div>
    <ul v-else class="conv-list">
      <li
        v-for="conv in chatStore.convs"
        :key="conv.id"
        class="conv"
        :class="{ active: conv.id === chatStore.activeConvId }"
        @click="chatStore.openConv(conv.id)"
        @contextmenu.prevent.stop="openMenu($event, conv)"
      >
        <span
          class="conv-avatar"
          :class="{ grp: conv.type === 'group' }"
          :style="convAvatarStyle(conv)"
        >
          <PantryIcon v-if="conv.type === 'group'" name="users" :size="18" />
          <template v-else>{{ convAvatarText(conv) }}</template>
        </span>
        <span class="conv-main">
          <span class="row1">
            <span class="conv-name">
              <em v-if="conv.pinned" class="flag">置顶</em>
              <em v-if="conv.muted" class="flag muted">静音</em>
              {{ convName(conv) }}
            </span>
            <span class="conv-time">{{ listTime(conv.lastTs) }}</span>
          </span>
          <span class="row2">
            <span v-if="conv.mentioned" class="mention">[有人@我]</span>
            <span class="conv-preview">{{ conv.preview }}</span>
            <span v-if="conv.unread > 0" class="badge">{{
              conv.unread > 99 ? '99+' : conv.unread
            }}</span>
          </span>
        </span>
      </li>
    </ul>
    <div
      v-if="menu"
      class="conv-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <button @click="togglePin">{{ menu.conv.pinned ? '取消置顶' : '置顶' }}</button>
      <button @click="toggleMute">{{ menu.conv.muted ? '取消免打扰' : '免打扰' }}</button>
      <button class="danger" @click="removeConv">移除会话</button>
    </div>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}
.placeholder {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  margin-top: 24px;
  line-height: 1.8;
}
.conv-list {
  list-style: none;
  overflow-y: auto;
  flex: 1;
}
.conv {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
}
.conv:hover {
  background: var(--line);
}
.conv.active {
  background: rgba(61, 139, 107, 0.12);
}
.conv-avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 15px;
  flex-shrink: 0;
}
.conv-avatar.grp {
  background: #6b8e9e; /* 群会话用区分色 */
}
.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row1,
.row2 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.conv-name {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.flag {
  font-style: normal;
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 3px;
  font-size: 10px;
  padding: 0 3px;
  margin-right: 3px;
}
.flag.muted {
  color: var(--text-3);
  border-color: var(--text-3);
}
.conv-time {
  font-size: 11px;
  color: var(--text-3);
  flex-shrink: 0;
}
.conv-preview {
  flex: 1;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--badge);
}
.badge {
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--badge);
  color: #fff;
  font-size: 11px;
  display: grid;
  place-items: center;
  padding: 0 5px;
  flex-shrink: 0;
}
.conv-menu {
  position: fixed;
  min-width: 110px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 20;
}
.conv-menu button {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.conv-menu button:hover {
  background: var(--line);
}
.conv-menu button.danger {
  color: var(--danger);
}
</style>
