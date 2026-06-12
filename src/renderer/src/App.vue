<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppInfo, SettingsView } from '../../shared/ipc'
import { usePeersStore } from './stores/peers'
import { useChatStore } from './stores/chat'
import PeerList from './components/PeerList.vue'
import ConvList from './components/ConvList.vue'
import ChatPane from './components/ChatPane.vue'
import SetupWizard from './components/SetupWizard.vue'
import SearchPanel from './components/SearchPanel.vue'
import ProfileCard from './components/ProfileCard.vue'
import GroupCreator from './components/GroupCreator.vue'
import MassSender from './components/MassSender.vue'
import PantryIcon from './components/PantryIcon.vue'
import { useGroupsStore } from './stores/groups'
import type { PeerView } from '../../shared/ipc'
import { applyAppearance } from './utils/appearance'
import { avatarStyle, avatarText } from './utils/avatar'

type Tab = 'chat' | 'contacts'

const tab = ref<Tab>('chat')
const searchQuery = ref('')
const selectedPeerId = ref<string | null>(null)
const showGroupCreator = ref(false)
const showMassSender = ref(false)
const groupsStore = useGroupsStore()

const selectedPeer = computed<PeerView | null>(() =>
  selectedPeerId.value ? (peersStore.byId(selectedPeerId.value) ?? null) : null
)

function onSelectPeer(peer: PeerView): void {
  selectedPeerId.value = peer.nodeId
}

async function chatWith(nodeId: string): Promise<void> {
  await chatStore.openPeer(nodeId)
  selectedPeerId.value = null
  tab.value = 'chat'
}

function openSettings(): void {
  void window.pantry.openSettings()
}
const info = ref<AppInfo | null>(null)
const settings = ref<SettingsView | null>(null)
const showWizard = ref(false)
const peersStore = usePeersStore()
const chatStore = useChatStore()
let stopSettings: (() => void) | null = null

function applyWindowTitle(next: SettingsView | null): void {
  const nick = next?.setupDone ? next.nick.trim() : ''
  document.title = nick ? `${nick}-🍵Pantry` : '茶话间'
}

onMounted(async () => {
  void peersStore.init()
  void chatStore.init()
  void groupsStore.init()
  info.value = await window.pantry.getAppInfo()
  settings.value = await window.pantry.getSettings()
  applyAppearance(settings.value)
  applyWindowTitle(settings.value)
  showWizard.value = settings.value !== null && !settings.value.setupDone
  stopSettings = window.pantry.onSettingsUpdated((next) => {
    settings.value = next
    applyAppearance(next)
    applyWindowTitle(next)
  })
})

onUnmounted(() => {
  stopSettings?.()
})
</script>

<template>
  <SetupWizard v-if="showWizard && settings" :settings="settings" @done="showWizard = false" />
  <div class="shell">
    <nav class="rail">
      <div class="rail-panel">
        <div
          class="avatar"
          :style="avatarStyle(settings?.avatar ?? -1, settings?.nick ?? '茶')"
        >
          {{ avatarText(settings?.avatar ?? -1, settings?.nick ?? '茶') }}
        </div>
        <button
          class="rail-btn"
          :class="{ active: tab === 'chat' }"
          title="聊天"
          @click="tab = 'chat'"
        >
          <PantryIcon name="chat" :size="23" />
          <span v-if="chatStore.totalUnread > 0" class="rail-badge">{{
            chatStore.totalUnread > 99 ? '99+' : chatStore.totalUnread
          }}</span>
        </button>
        <button
          class="rail-btn"
          :class="{ active: tab === 'contacts' }"
          title="通讯录"
          @click="tab = 'contacts'"
        >
          <PantryIcon name="contacts" :size="23" />
        </button>
        <div class="spacer"></div>
        <button class="rail-btn" title="设置" @click="openSettings">
          <PantryIcon name="settings" :size="21" />
        </button>
      </div>
    </nav>

    <aside class="list">
      <div class="search-box">
        <div class="search-field">
          <PantryIcon class="search-mark" name="search" :size="15" />
          <input v-model="searchQuery" class="search" placeholder="搜索" />
          <button v-if="searchQuery" class="clear" title="清空" @click="searchQuery = ''">
            <PantryIcon name="x" :size="13" />
          </button>
        </div>
        <button class="new-group" title="群发消息" @click="showMassSender = true">
          <PantryIcon name="send-many" :size="16" />
        </button>
        <button class="new-group" title="发起讨论组" @click="showGroupCreator = true">
          <PantryIcon name="plus" :size="17" />
        </button>
      </div>
      <GroupCreator v-if="showGroupCreator" @close="showGroupCreator = false" />
      <MassSender v-if="showMassSender" @close="showMassSender = false" />
      <SearchPanel
        v-if="searchQuery.trim()"
        :query="searchQuery.trim()"
        @navigate="((searchQuery = ''), (tab = 'chat'))"
      />
      <ConvList v-else-if="tab === 'chat'" />
      <PeerList v-else @select="onSelectPeer" />
    </aside>

    <main class="content">
      <ProfileCard
        v-if="tab === 'contacts' && selectedPeer"
        :peer="selectedPeer"
        @chat="chatWith"
      />
      <ChatPane v-else-if="chatStore.activeConv" />
      <div v-else class="empty">
        <div class="logo">茶话间</div>
        <p v-if="info" class="meta">
          v{{ info.version }} · Electron {{ info.electron }} · Chromium {{ info.chrome }} · Node
          {{ info.node }}
        </p>
        <p class="hint">在「通讯录」里选个人，开始第一句话</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  min-height: 0;
}

/* 栏① 导航 */
.rail {
  width: 64px;
  background: var(--rail-outer);
  display: flex;
  justify-content: center;
  padding: 12px 6px;
}
.rail-panel {
  width: 52px;
  height: 100%;
  border-radius: 28px;
  background: var(--rail-panel);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 0;
  gap: 10px;
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%; /* 决议：圆形头像 */
  display: grid;
  place-items: center;
  font-weight: 600;
  font-size: 17px;
  margin-bottom: 10px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}
.rail-btn {
  position: relative;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 21px;
  background: transparent;
  color: var(--rail-icon);
  cursor: pointer;
  opacity: 1;
  display: grid;
  place-items: center;
  transition:
    background-color 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}
.rail-btn:hover {
  background: rgba(61, 139, 107, 0.1);
  color: var(--primary);
}
.rail-btn.active {
  color: var(--primary);
}
.rail-btn:active {
  transform: scale(0.96);
}
.rail-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  background: var(--badge);
  color: #fff;
  font-size: 10px;
  display: grid;
  place-items: center;
  padding: 0 4px;
}
.spacer {
  flex: 1;
}

/* 栏② 列表 */
.list {
  width: 250px;
  background: var(--bg-list);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}
.search-box {
  padding: 12px 12px 8px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.search-field {
  flex: 1;
  min-width: 0;
  position: relative;
}
.search-mark {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
.search-field .search {
  flex: 1;
}
.new-group {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: var(--line);
  color: var(--text-2);
  cursor: pointer;
  flex-shrink: 0;
  display: grid;
  place-items: center;
}
.new-group:hover {
  background: var(--primary);
  color: #fff;
}
.clear {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  width: 18px;
  height: 18px;
  padding: 0;
  display: grid;
  place-items: center;
}
.search {
  width: 100%;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: var(--line);
  padding: 0 26px 0 28px;
  font-size: 13px;
  outline: none;
}

/* 栏③ 内容 */
.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-chat);
  display: grid;
}
.empty {
  place-self: center;
  text-align: center;
  color: var(--text-3);
}
.logo {
  font-size: 28px;
  font-weight: 600;
  color: var(--primary);
  margin-bottom: 12px;
}
.meta {
  font-size: 13px;
  margin-bottom: 4px;
}
.hint {
  font-size: 12px;
}
</style>
