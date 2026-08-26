<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { darkTheme, dateZhCN, NButton, NConfigProvider, NInput, zhCN } from 'naive-ui'
import type {
  AppInfo,
  CaptureFailureNotice,
  ScanProgressView,
  SettingsView
} from '../../shared/ipc'
import { usePeersStore } from './stores/peers'
import { useChatStore } from './stores/chat'
import { useUpdateStore } from './stores/update'
import PeerList from './components/PeerList.vue'
import ConvList from './components/ConvList.vue'
import ChatPane from './components/ChatPane.vue'
import SetupWizard from './components/SetupWizard.vue'
import SearchPanel from './components/SearchPanel.vue'
import ProfileCard from './components/ProfileCard.vue'
import GroupCreator from './components/GroupCreator.vue'
// 群发功能已停用（决议 #62）：建讨论组即可满足同样诉求，群发无实际意义；保留代码留痕。
// import MassSender from './components/MassSender.vue'
import PantryIcon from './components/PantryIcon.vue'
import PantryBrandLogo from './components/PantryBrandLogo.vue'
import WindowControls from './components/WindowControls.vue'
import WindowDragStrip from './components/WindowDragStrip.vue'
import { useGroupsStore } from './stores/groups'
import type { PeerView } from '../../shared/ipc'
import { applyAppearance } from './utils/appearance'
import { applyPerformanceProfile } from './utils/performance-profile'
import AvatarMark from './components/AvatarMark.vue'
import CabinetList from './components/CabinetList.vue'
import CabinetPane from './components/CabinetPane.vue'
import { useCabinetStore } from './stores/cabinet'
import { randomQuote } from './utils/quotes'
import {
  teahouseDarkThemeOverrides,
  teahouseLightThemeOverrides
} from './ui/naive-theme'

type Tab = 'chat' | 'contacts' | 'cabinet'

const tab = ref<Tab>('chat')
const searchQuery = ref('')
const selectedPeerId = ref<string | null>(null)
const showGroupCreator = ref(false)
// const showMassSender = ref(false) // 群发已停用（决议 #62）
const groupsStore = useGroupsStore()
const cabinetStore = useCabinetStore()

/** 设置窗「打开文件柜」与私聊面板「在文件柜里打开」都走这里（决议 #284） */
function showCabinet(peerId: string): void {
  tab.value = 'cabinet'
  if (peerId) cabinetStore.selectPeer(peerId)
}

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

function openSettings(event?: Event): void {
  releaseRailFocus(event)
  void window.pantry.openSettings()
}

// 文件柜（决议 #283，形态改为主窗页签见 #284）：底部工具组最上一格，切到文件柜页签；
// 未设共享目录也可点——进去就是引导设置的空态
function openCabinet(event?: Event): void {
  hideRailHint()
  releaseRailFocus(event)
  tab.value = 'cabinet'
}

// 局域网自更新提示（决议 #166/#172）：发现同平台更高版本的在线源时，导航栏出现升级入口；机制说明收进问号提示。
const updateStore = useUpdateStore()
const showUpdatePanel = ref(false)
const updateRequesting = ref(false)
const updateRequestMsg = ref('')
const updateHelpText = '将从内网同平台节点请求安装包，不访问外网；同步更新只发起索包，不会静默安装。'
const updateHintLabel = computed(() =>
  updateStore.available
    ? `内网有新版 v${updateStore.available.version}（来自 ${updateStore.available.fromName}）`
    : ''
)
function toggleUpdatePanel(event?: Event): void {
  releaseRailFocus(event)
  showUpdatePanel.value = !showUpdatePanel.value
}
async function requestUpdatePackage(): Promise<void> {
  if (updateRequesting.value) return
  updateRequesting.value = true
  updateRequestMsg.value = ''
  try {
    const ok = await window.pantry.requestUpdate()
    updateRequestMsg.value = ok ? '请求已发出。' : '请求未送达，请稍后重试。'
  } catch {
    updateRequestMsg.value = '请求更新失败，请稍后重试。'
  } finally {
    updateRequesting.value = false
  }
}
const info = ref<AppInfo | null>(null)
// 主界面空态随机名言（决议 #82）：组件创建（每次打开软件）时随机一条，纯本地内置
const quote = ref(randomQuote())
const settings = ref<SettingsView | null>(null)
const naiveTheme = computed(() => (settings.value?.theme === 'dark' ? darkTheme : null))
const naiveThemeOverrides = computed(() =>
  settings.value?.theme === 'dark' ? teahouseDarkThemeOverrides : teahouseLightThemeOverrides
)
const showWizard = ref(false)
const settingsWindowOpen = ref(false)
const peersStore = usePeersStore()
const chatStore = useChatStore()
let stopSettings: (() => void) | null = null
let stopSettingsWindowState: (() => void) | null = null
let stopCabinetOpen: (() => void) | null = null
let stopScanProgress: (() => void) | null = null
let stopCaptureFailed: (() => void) | null = null
let scanProgressHideTimer: ReturnType<typeof setTimeout> | null = null
let captureNoticeTimer: ReturnType<typeof setTimeout> | null = null
let railHintTimer: ReturnType<typeof setTimeout> | null = null
let railFocusReleaseTimer: ReturnType<typeof setTimeout> | null = null
let pendingRailHint: string | null = null

const scanProgress = ref<ScanProgressView>({
  scanId: 0,
  status: 'idle',
  running: false,
  done: 0,
  total: 0,
  rangeCount: 0,
  startedAt: 0,
  finishedAt: 0
})
const scanProgressVisible = ref(false)
const captureNotice = ref<CaptureFailureNotice | null>(null)
// 环形进度显示值：刷新前归零（环隐藏时瞬间）、扫描中随 scanPercent 平滑增长（决议 #163）
const scanRingPct = ref(0)
const hasScanRanges = computed(() => (settings.value?.scanRanges.length ?? 0) > 0)
const canScanAllRanges = computed(() => hasScanRanges.value && !scanProgress.value.running)
const scanPercent = computed(() => {
  const total = scanProgress.value.total
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((scanProgress.value.done / total) * 100)))
})
const scanButtonTitle = computed(() => {
  if (scanProgress.value.running) {
    return `扫描中 ${scanProgress.value.done}/${scanProgress.value.total}`
  }
  if (!hasScanRanges.value) return '没有已保存扫描网段'
  return '刷新全局用户'
})
const scanProgressTitle = computed(() => `扫描进度 ${scanPercent.value}%`)

// 全量刷新二次确认（决议 #197）：只展示 CIDR 摘要，最多 4 条，超出折叠；不堆说明文案
const SCAN_CONFIRM_PREVIEW_LIMIT = 4
const showScanConfirm = ref(false)

const scanConfirmCidrs = computed(() => {
  const items = settings.value?.scanRangeItems
  if (items && items.length > 0) return items.map((item) => item.cidr)
  return settings.value?.scanRanges ?? []
})
const scanConfirmTotal = computed(() => scanConfirmCidrs.value.length)
const scanConfirmPreview = computed(() =>
  scanConfirmCidrs.value.slice(0, SCAN_CONFIRM_PREVIEW_LIMIT)
)
const scanConfirmExtra = computed(() =>
  Math.max(0, scanConfirmTotal.value - SCAN_CONFIRM_PREVIEW_LIMIT)
)
const scanConfirmSub = computed(() => {
  const n = scanConfirmTotal.value
  if (n <= 0) return ''
  return n === 1 ? '将探测 1 个网段' : `将探测 ${n} 个网段`
})
const selfName = computed(() => settings.value?.nick.trim() || '未设置昵称')
const selfOrgPath = computed(() => {
  const parts = [settings.value?.company, settings.value?.dept, settings.value?.team]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
  return parts.length > 0 ? parts.join(' / ') : '未设置组织信息'
})
const selfIpText = computed(() => info.value?.localIp || '正在获取')
const selfHostText = computed(() => settings.value?.host.trim() || '主机名未加载')
const selfNodeShort = computed(() => info.value?.nodeId.slice(0, 8) ?? '加载中')
const activeRailHint = ref<string | null>(null)

function applyWindowTitle(next: SettingsView | null): void {
  const nick = next?.setupDone ? next.nick.trim() : ''
  document.title = nick ? `${nick}-🍵Teahouse` : '茶话间'
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') chatStore.forgetConversationScrolls()
}

function clearScanProgressHideTimer(): void {
  if (scanProgressHideTimer) clearTimeout(scanProgressHideTimer)
  scanProgressHideTimer = null
}

function showCaptureFailure(notice: CaptureFailureNotice): void {
  captureNotice.value = notice
  if (captureNoticeTimer) clearTimeout(captureNoticeTimer)
  captureNoticeTimer = setTimeout(() => {
    captureNotice.value = null
    captureNoticeTimer = null
  }, 7000)
}

function dismissCaptureFailure(): void {
  captureNotice.value = null
  if (captureNoticeTimer) clearTimeout(captureNoticeTimer)
  captureNoticeTimer = null
}

function clearRailHintTimer(): void {
  if (railHintTimer) clearTimeout(railHintTimer)
  railHintTimer = null
  pendingRailHint = null
}

function scheduleRailHint(key: string): void {
  if (activeRailHint.value === key || pendingRailHint === key) return
  clearRailHintTimer()
  pendingRailHint = key
  railHintTimer = setTimeout(() => {
    activeRailHint.value = key
    clearRailHintTimer()
  }, 520)
}

function hideRailHint(key?: string): void {
  clearRailHintTimer()
  if (!key || activeRailHint.value === key) activeRailHint.value = null
}

function clearRailFocusReleaseTimer(): void {
  if (railFocusReleaseTimer) clearTimeout(railFocusReleaseTimer)
  railFocusReleaseTimer = null
}

function releaseRailFocus(event?: Event): void {
  const eventTarget = event?.currentTarget
  if (eventTarget instanceof HTMLElement) eventTarget.blur()

  const active = document.activeElement
  if (active instanceof HTMLElement && active.classList.contains('rail-btn')) active.blur()
}

function releaseInitialRailFocus(): void {
  clearRailFocusReleaseTimer()
  void nextTick(() => {
    requestAnimationFrame(() => {
      releaseRailFocus()
      railFocusReleaseTimer = setTimeout(() => {
        releaseRailFocus()
        railFocusReleaseTimer = null
      }, 0)
    })
  })
}

function applyScanProgress(next: ScanProgressView): void {
  scanProgress.value = next
  scanRingPct.value = scanPercent.value
  clearScanProgressHideTimer()
  if (next.running) {
    scanProgressVisible.value = true
    return
  }
  if (next.status === 'done' && next.total > 0) {
    scanProgressVisible.value = true
    scanProgressHideTimer = setTimeout(() => {
      scanProgressVisible.value = false
      scanProgressHideTimer = null
    }, 2200)
    return
  }
  scanProgressVisible.value = false
}

function activateTab(next: Tab, event: Event): void {
  tab.value = next
  hideRailHint()
  releaseRailFocus(event)
}

/** 点击刷新：先弹二次确认（决议 #197），确认后才扫 */
function askRefreshAllUsers(event?: Event): void {
  releaseRailFocus(event)
  hideRailHint()
  if (!canScanAllRanges.value) return
  showScanConfirm.value = true
}

function cancelScanConfirm(): void {
  showScanConfirm.value = false
}

async function confirmRefreshAllUsers(): Promise<void> {
  if (!canScanAllRanges.value) {
    showScanConfirm.value = false
    return
  }
  showScanConfirm.value = false
  scanRingPct.value = 0 // 新扫描前归零（此刻环隐藏、无过渡），避免从上次满环倒退
  applyScanProgress(await window.pantry.scanAllRanges())
}

function onScanConfirmKeydown(event: KeyboardEvent): void {
  if (!showScanConfirm.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelScanConfirm()
  }
}

onMounted(async () => {
  // 先订阅再等待初始化 IPC，避免用户启动后立即点设置时错过遮罩状态。
  stopSettingsWindowState = window.pantry.onSettingsWindowState((open) => {
    settingsWindowOpen.value = open
  })
  stopCabinetOpen = window.pantry.onCabinetFocusPeer((peerId) => showCabinet(peerId))
  void peersStore.init()
  void chatStore.init()
  void groupsStore.init()
  void updateStore.init()
  document.addEventListener('visibilitychange', onVisibilityChange)
  info.value = await window.pantry.getAppInfo()
  applyPerformanceProfile(info.value)
  settings.value = await window.pantry.getSettings()
  applyAppearance(settings.value)
  applyWindowTitle(settings.value)
  showWizard.value = settings.value !== null && !settings.value.setupDone
  stopSettings = window.pantry.onSettingsUpdated((next) => {
    settings.value = next
    applyAppearance(next)
    applyWindowTitle(next)
  })
  stopScanProgress = window.pantry.onScanProgress(applyScanProgress)
  stopCaptureFailed = window.pantry.onCaptureFailed(showCaptureFailure)
  document.addEventListener('keydown', onScanConfirmKeydown)
  releaseInitialRailFocus()
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  document.removeEventListener('keydown', onScanConfirmKeydown)
  stopSettings?.()
  stopSettingsWindowState?.()
  stopCabinetOpen?.()
  stopScanProgress?.()
  stopCaptureFailed?.()
  dismissCaptureFailure()
  clearScanProgressHideTimer()
  hideRailHint()
  clearRailFocusReleaseTimer()
})
</script>

<template>
  <NConfigProvider
    abstract
    :theme="naiveTheme"
    :theme-overrides="naiveThemeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
  <SetupWizard v-if="showWizard && settings" :settings="settings" @done="showWizard = false" />
  <!-- 沉浸式无标题栏（决议 #49/#52）：顶部 32px 隐形拖拽带 + Win/Linux 自绘窗口控制按钮 -->
  <WindowDragStrip />
  <WindowControls />
  <Transition name="settings-scrim">
    <div v-if="settingsWindowOpen" class="settings-scrim" aria-hidden="true"></div>
  </Transition>
  <div class="shell">
    <nav class="rail">
      <div class="avatar-wrap" aria-label="我的信息">
        <AvatarMark
          class="avatar"
          :avatar="settings?.avatar ?? -1"
          :avatar-hash="settings?.avatarHash"
          :name="settings?.nick ?? '茶'"
        />
        <div class="self-card" aria-hidden="true">
          <div class="self-card-head">
            <AvatarMark
              class="self-card-avatar"
              :avatar="settings?.avatar ?? -1"
              :avatar-hash="settings?.avatarHash"
              :name="settings?.nick ?? '茶'"
            />
            <div class="self-card-title">
              <div class="self-card-name">{{ selfName }}</div>
              <div class="self-card-subtitle">本机账户</div>
            </div>
          </div>
          <div class="self-card-body">
            <div class="self-card-network">
              <span class="self-card-network-label">本机 IP</span>
              <span class="self-card-ip">{{ selfIpText }}</span>
            </div>
            <dl class="self-card-details">
              <div class="self-card-detail">
                <dt>组织</dt>
                <dd>{{ selfOrgPath }}</dd>
              </div>
              <div class="self-card-detail">
                <dt>设备</dt>
                <dd>{{ selfHostText }}</dd>
              </div>
            </dl>
            <div class="self-card-node">
              <span>节点 ID</span>
              <strong>{{ selfNodeShort }}</strong>
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        class="rail-btn rail-hint"
        :class="{ active: tab === 'chat', 'show-hint': activeRailHint === 'chat' }"
        data-label="聊天"
        aria-label="聊天"
        @pointermove="scheduleRailHint('chat')"
        @pointerleave="hideRailHint('chat')"
        @click="activateTab('chat', $event)"
      >
        <PantryIcon name="chat" :size="25" />
        <span v-if="chatStore.totalUnread > 0" class="rail-badge">{{
          chatStore.totalUnread > 99 ? '99+' : chatStore.totalUnread
        }}</span>
      </button>
      <button
        type="button"
        class="rail-btn rail-hint"
        :class="{ active: tab === 'contacts', 'show-hint': activeRailHint === 'contacts' }"
        data-label="通讯录"
        aria-label="通讯录"
        @pointermove="scheduleRailHint('contacts')"
        @pointerleave="hideRailHint('contacts')"
        @click="activateTab('contacts', $event)"
      >
        <PantryIcon name="contacts" :size="25" />
      </button>
      <div class="spacer"></div>
      <button
        v-if="updateStore.available"
        type="button"
        class="rail-btn rail-update"
        :class="{ active: showUpdatePanel }"
        :title="updateHintLabel"
        :aria-label="updateHintLabel"
        @click="toggleUpdatePanel($event)"
      >
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 19V7M7 12l5-5 5 5"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="rail-dot" aria-hidden="true"></span>
      </button>
      <button
        type="button"
        class="rail-btn rail-hint"
        :class="{ active: tab === 'cabinet', 'show-hint': activeRailHint === 'cabinet' }"
        data-label="文件柜"
        aria-label="文件柜"
        @pointermove="scheduleRailHint('cabinet')"
        @pointerleave="hideRailHint('cabinet')"
        @click="openCabinet($event)"
      >
        <PantryIcon name="cabinet" :size="21" />
      </button>
      <button
        type="button"
        class="rail-btn rail-hint"
        :class="{
          scanning: scanProgress.running,
          'is-disabled': !canScanAllRanges,
          'show-hint': activeRailHint === 'scan'
        }"
        :aria-disabled="!canScanAllRanges"
        :data-label="scanButtonTitle"
        :aria-label="scanProgress.running ? scanProgressTitle : scanButtonTitle"
        @pointermove="scheduleRailHint('scan')"
        @pointerleave="hideRailHint('scan')"
        @click="askRefreshAllUsers($event)"
      >
        <span
          class="scan-ring"
          :class="{ visible: scanProgressVisible }"
          :style="{ '--scan-p': scanRingPct }"
          aria-hidden="true"
        ></span>
        <PantryIcon name="refresh" :size="21" />
      </button>
      <button
        type="button"
        class="rail-btn rail-hint"
        :class="{ 'show-hint': activeRailHint === 'settings' }"
        data-label="设置"
        aria-label="设置"
        @pointermove="scheduleRailHint('settings')"
        @pointerleave="hideRailHint('settings')"
        @click="openSettings($event)"
      >
        <PantryIcon name="settings" :size="21" />
      </button>
    </nav>

    <div v-if="showUpdatePanel && updateStore.available" class="update-pop" role="dialog">
      <div class="update-pop-head">
        <span>内网有新版</span>
        <span class="update-pop-help">
          <button type="button" class="update-help-trigger" aria-label="内网更新说明" aria-describedby="main-update-help">
            ?
          </button>
          <span id="main-update-help" class="update-help-pop" role="tooltip">
            {{ updateHelpText }}
          </span>
        </span>
      </div>
      <div class="update-pop-ver">v{{ updateStore.available.version }}</div>
      <div class="update-pop-from">来自 {{ updateStore.available.fromName }}</div>
      <div class="update-pop-cur">当前版本 v{{ updateStore.available.currentVersion }}</div>
      <p v-if="updateRequestMsg" class="update-pop-hint">{{ updateRequestMsg }}</p>
      <NButton
        type="primary"
        size="small"
        :loading="updateRequesting"
        class="update-pop-ok"
        :disabled="updateRequesting"
        :aria-busy="updateRequesting"
        @click="requestUpdatePackage"
      >
        {{ updateRequesting ? '请求中' : '同步更新' }}
      </NButton>
    </div>

    <aside class="list">
      <div v-if="tab !== 'cabinet'" class="search-box">
        <NInput
          v-model:value="searchQuery"
          class="search"
          size="small"
          clearable
          aria-label="搜索联系人、讨论组和聊天记录"
          placeholder="搜索"
        >
          <template #prefix><PantryIcon name="search" :size="15" /></template>
        </NInput>
        <!-- 群发入口已停用（决议 #62）：直接建讨论组即可，群发无意义；保留留痕
        <button class="new-group" title="群发消息" @click="showMassSender = true">
          <PantryIcon name="send-many" :size="16" />
        </button>
        -->
        <NButton
          class="new-group"
          size="small"
          quaternary
          circle
          title="发起讨论组"
          aria-label="发起讨论组"
          @click="showGroupCreator = true"
        >
          <PantryIcon name="plus" :size="17" />
        </NButton>
      </div>
      <GroupCreator v-if="showGroupCreator" @close="showGroupCreator = false" />
      <!-- <MassSender v-if="showMassSender" @close="showMassSender = false" /> 群发已停用（决议 #62） -->
      <SearchPanel
        v-if="searchQuery.trim() && tab !== 'cabinet'"
        :query="searchQuery.trim()"
        @navigate="((searchQuery = ''), (tab = 'chat'))"
      />
      <CabinetList v-else-if="tab === 'cabinet'" />
      <ConvList v-else-if="tab === 'chat'" />
      <PeerList v-else @select="onSelectPeer" @chat="chatWith" />
    </aside>

    <main class="content">
      <CabinetPane v-if="tab === 'cabinet'" />
      <ProfileCard
        v-else-if="tab === 'contacts' && selectedPeer"
        :peer="selectedPeer"
        @chat="chatWith"
      />
      <ChatPane
        v-else-if="chatStore.activeConv"
        :win7-ime-compat="info?.windows7 === true"
      />
      <div v-else class="empty">
        <PantryBrandLogo variant="color" :size="92" class="empty-logo" />
        <div class="brand-title">茶话间</div>
        <p class="quote">{{ quote.text }}</p>
        <p class="quote-author">{{ quote.author }}</p>
        <p class="hint">在「通讯录」里选个人，开始第一句话</p>
      </div>
    </main>
  </div>

  <!-- 全量刷新二次确认（决议 #197）：标题 + 一句摘要 + CIDR 列表，确认后才扫 -->
  <div
    v-if="showScanConfirm"
    class="scan-confirm-mask"
    @click.self="cancelScanConfirm"
  >
    <div
      class="scan-confirm-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-confirm-title"
      aria-describedby="scan-confirm-sub"
    >
      <div class="scan-confirm-mark" aria-hidden="true">
        <PantryIcon name="warning" :size="22" />
      </div>
      <h3 id="scan-confirm-title">刷新全局用户</h3>
      <p id="scan-confirm-sub" class="scan-confirm-sub">{{ scanConfirmSub }}</p>
      <ul class="scan-confirm-list" aria-label="将扫描的网段">
        <li v-for="cidr in scanConfirmPreview" :key="cidr">
          <code>{{ cidr }}</code>
        </li>
        <li v-if="scanConfirmExtra > 0" class="scan-confirm-more">另 {{ scanConfirmExtra }} 个</li>
      </ul>
      <div class="scan-confirm-actions">
        <NButton size="small" secondary @click="cancelScanConfirm">取消</NButton>
        <NButton type="primary" size="small" @click="confirmRefreshAllUsers">
          开始扫描
        </NButton>
      </div>
    </div>
  </div>

  <!-- 移除聊天后的 10 秒撤回提示（决议 #125）：倒计时结束才真正删除聊天记录 -->
  <div v-if="chatStore.pendingRemoval" class="undo-toast" role="status">
    <span class="undo-text">已删除与「{{ chatStore.pendingRemoval.name }}」的聊天记录</span>
    <button type="button" class="undo-btn" @click="chatStore.undoRemoveConversation()">
      撤回 {{ chatStore.pendingRemoval.secondsLeft }}s
    </button>
  </div>
  <Transition name="capture-toast">
    <div
      v-if="captureNotice"
      class="capture-toast"
      role="status"
      aria-live="assertive"
    >
      <PantryIcon name="warning" :size="18" />
      <span>{{ captureNotice.message }}</span>
      <button type="button" aria-label="关闭截图提示" @click="dismissCaptureFailure">×</button>
    </div>
  </Transition>
  </NConfigProvider>
</template>

<style scoped>
.settings-scrim {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(18, 31, 25, 0.24);
  pointer-events: auto;
  opacity: 1;
  transition: opacity 140ms ease-out;
}

:global(html[data-theme='dark']) .settings-scrim {
  background: rgba(0, 0, 0, 0.38);
}

.settings-scrim-enter-from,
.settings-scrim-leave-to {
  opacity: 0;
}

.shell {
  display: flex;
  height: 100%;
  min-height: 0;
  isolation: isolate;
  background: var(--bg-chat);
}

/* 栏① 导航 */
.rail {
  /* 68px 容纳标准 mac 红绿灯（决议 #68）；浅灰底（决议 #70，微信式）让红绿灯落在浅色上自然 */
  width: 68px;
  background: var(--rail-bg);
  border-right: 1px solid var(--line);
  box-shadow: var(--highlight-edge);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 38px 0 12px; /* 顶部让出拖拽带与 mac 红绿灯 */
  gap: 7px;
  position: relative;
  z-index: 3;
}
.avatar-wrap {
  position: relative;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  margin-bottom: 11px;
  outline: none;
}
.avatar-wrap::after {
  /* 只在头像已悬停后接通到资料卡的 12px 间隙，避免横向移动时提前收起（决议 #238）。 */
  content: '';
  position: absolute;
  top: -8px;
  left: 38px;
  width: 18px;
  height: 56px;
  pointer-events: none;
}
.avatar-wrap:hover::after {
  pointer-events: auto;
}
.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%; /* 决议：圆形头像 */
  display: grid;
  place-items: center;
  font-weight: 600;
  font-size: 18px;
}
.self-card {
  position: absolute;
  left: 52px;
  top: -8px;
  z-index: 30;
  width: 304px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--material-strong);
  color: var(--text-1);
  box-shadow: var(--highlight-edge), var(--shadow-float);
  backdrop-filter: blur(24px) saturate(145%);
  -webkit-backdrop-filter: blur(24px) saturate(145%);
  display: flex;
  flex-direction: column;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transform: translateX(-6px) scale(0.985);
  transform-origin: left 28px;
  transition:
    opacity 160ms ease,
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s linear 180ms;
}
.avatar-wrap:hover .self-card {
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
  transform: translateX(0) scale(1);
  transition-delay: 120ms, 120ms, 0s;
}
.self-card-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 16px 16px 14px;
  border-bottom: 1px solid var(--line);
}
.self-card-avatar {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
}
.self-card-title {
  min-width: 0;
  flex: 1;
}
.self-card-name {
  color: var(--text-1);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.self-card-subtitle {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.3;
}
.self-card-body {
  display: grid;
  gap: 12px;
  padding: 12px 16px 14px;
}
.self-card-network {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--primary-weak);
}
.self-card-network-label {
  color: var(--text-3);
  font-size: 11px;
  line-height: 1;
}
.self-card-ip {
  min-width: 0;
  overflow: hidden;
  color: var(--primary);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.self-card-details {
  display: grid;
  gap: 9px;
}
.self-card-detail {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  min-width: 0;
}
.self-card-detail dt {
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.35;
}
.self-card-detail dd {
  min-width: 0;
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.self-card-node {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.2;
}
.self-card-node strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-2);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-btn {
  position: relative;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 12px;
  appearance: none;
  -webkit-appearance: none;
  outline: none;
  background: transparent;
  color: var(--text-2); /* 浅灰底上用深灰图标（决议 #70） */
  cursor: pointer;
  display: grid;
  place-items: center;
  transition:
    color 150ms ease,
    background 150ms ease,
    box-shadow 150ms ease,
    transform 90ms ease-out;
}
.rail-btn:focus {
  outline: none;
}
.rail-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(61, 139, 107, 0.2);
}
.rail-hint::after {
  content: attr(data-label);
  position: absolute;
  top: 50%;
  left: calc(100% + 10px);
  z-index: 25;
  min-width: max-content;
  max-width: 160px;
  padding: 6px 9px;
  border-radius: 8px;
  background: rgba(36, 42, 38, 0.96);
  color: #fff;
  font-size: 12px;
  line-height: 1.2;
  letter-spacing: 0;
  white-space: nowrap;
  box-shadow: var(--shadow-soft);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-50%);
  transition:
    opacity 90ms ease,
    visibility 0s linear 90ms;
}
.rail-hint.show-hint::after {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
.rail-btn:hover {
  background: var(--surface-hover);
  color: var(--text-1);
}
.rail-btn.active,
.rail-btn.active:hover {
  background: var(--surface-selected);
  color: var(--primary);
  box-shadow: var(--highlight-edge);
}
.rail-btn:active:not(.is-disabled) {
  transform: scale(0.96);
  background: var(--surface-pressed);
}
.rail-btn.is-disabled:not(.scanning) {
  cursor: default;
  opacity: 0.45;
}
.rail-btn.is-disabled:not(.scanning):hover {
  background: transparent;
  color: var(--text-2);
}
.rail-btn.scanning,
.rail-btn.scanning:hover {
  /* 扫描态不再用方块底/图标旋转，进度改由图标外圈环形表达（决议 #162） */
  background: transparent;
  color: var(--primary);
  opacity: 1;
}
/* 局域网自更新提示入口（决议 #166 第一步） */
.rail-update {
  color: var(--primary);
}
.rail-update.active,
.rail-update:hover {
  background: var(--primary-weak);
}
.rail-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
  border: 1.5px solid var(--rail-bg);
}
.update-pop {
  position: fixed;
  left: 76px;
  bottom: 16px;
  z-index: 60;
  width: 192px;
  padding: 16px;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--highlight-edge), var(--shadow-float);
  backdrop-filter: blur(22px) saturate(140%);
  -webkit-backdrop-filter: blur(22px) saturate(140%);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.update-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.update-pop-help {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
}
.update-help-trigger {
  width: 17px;
  height: 17px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--bg-list);
  color: var(--text-3);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: help;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease;
}
.update-help-trigger:hover,
.update-help-trigger:focus-visible {
  border-color: rgba(61, 139, 107, 0.42);
  background: var(--primary-weak);
  color: var(--primary);
  outline: none;
  box-shadow: 0 0 0 2px rgba(61, 139, 107, 0.1);
}
.update-help-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 70;
  width: 238px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--text-1);
  color: var(--bg-window);
  box-shadow: 0 8px 24px rgba(34, 49, 42, 0.22);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(3px);
  transition:
    opacity 0.14s ease,
    transform 0.14s ease,
    visibility 0.14s ease;
}
.update-pop-help:hover .update-help-pop,
.update-pop-help:focus-within .update-help-pop {
  opacity: 1;
  visibility: visible;
  transform: none;
}
.update-pop-ver {
  font-size: 20px;
  font-weight: 600;
  color: var(--primary);
  line-height: 1.2;
}
.update-pop-from {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-1);
}
.update-pop-cur {
  font-size: 12px;
  color: var(--text-3);
}
.update-pop-hint {
  margin: 8px 0 10px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
.update-pop-ok {
  width: 100%;
  margin-top: 8px;
}

/* 进度数值注册为可过渡的 typed 属性，让环形进度平滑增长而非跳变（决议 #163） */
@property --scan-p {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}
.scan-ring {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background: conic-gradient(var(--primary) calc(var(--scan-p, 0) * 1%), var(--line) 0);
  -webkit-mask: radial-gradient(closest-side, transparent 72%, #000 76%);
  mask: radial-gradient(closest-side, transparent 72%, #000 76%);
  opacity: 0;
  transition: opacity 180ms ease; /* 非扫描态：进度值瞬间归零、不倒退 */
  pointer-events: none;
}
.scan-ring.visible {
  opacity: 1;
  transition:
    opacity 180ms ease,
    --scan-p 0.4s linear; /* 扫描中：进度平滑增长 */
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
@media (prefers-reduced-motion: reduce) {
  .settings-scrim {
    transition: none;
  }
  .rail-hint::after,
  .rail-btn,
  .self-card,
  .scan-ring,
  .scan-ring.visible,
  .new-group {
    transition: none;
  }
  .rail-btn:active:not(.is-disabled) {
    transform: none;
  }
}

.capture-toast {
  position: fixed;
  top: 46px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(620px, calc(100% - 48px));
  padding: 11px 12px 11px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--material-strong);
  color: var(--text-1);
  box-shadow: var(--highlight-edge), var(--shadow-float);
  backdrop-filter: blur(20px) saturate(135%);
  -webkit-backdrop-filter: blur(20px) saturate(135%);
  font-size: 13px;
  line-height: 1.45;
}
.capture-toast > svg {
  flex: 0 0 auto;
  color: var(--danger);
}
.capture-toast > span {
  min-width: 0;
  flex: 1;
}
.capture-toast > button {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.capture-toast > button:hover {
  background: var(--surface-hover);
  color: var(--text-1);
}
.capture-toast-enter-active,
.capture-toast-leave-active {
  transition: opacity 160ms ease, transform 180ms ease;
}
.capture-toast-enter-from,
.capture-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}
@media (prefers-reduced-motion: reduce) {
  .capture-toast-enter-active,
  .capture-toast-leave-active {
    transition: none;
  }
}

/* 栏② 列表 */
.list {
  width: 272px;
  background: var(--material-panel);
  border-right: 1px solid var(--line);
  box-shadow: 8px 0 26px rgba(26, 48, 38, 0.035), var(--highlight-edge);
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 2;
}
.search-box {
  /* 与聊天头部 .head 等高（84px），两栏顶栏分隔线连成一条（决议 #127）；
     padding-top 32px 让出拖拽带与 mac 红绿灯，与 .head 一致 */
  height: 84px;
  flex: 0 0 84px;
  box-sizing: border-box;
  padding: 36px 12px 10px;
  display: flex;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--line);
}
.search {
  flex: 1;
  min-width: 0;
}
.new-group {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  color: var(--text-2);
}
.new-group:hover {
  color: var(--primary);
}

/* 栏③ 内容 */
.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-chat);
  display: grid;
  position: relative;
  z-index: 1;
}
.empty {
  place-self: center;
  text-align: center;
  color: var(--text-3);
  max-width: 420px;
  padding: 32px;
}
.empty-logo {
  margin: 0 auto 18px;
  filter: drop-shadow(0 10px 22px rgba(48, 104, 80, 0.13));
}
.brand-title {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--primary);
  margin-bottom: 16px;
}
.quote {
  font-size: 14px;
  color: var(--text-2);
  line-height: 1.75;
  max-width: 360px;
  margin: 0 auto 8px;
}
.quote-author {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 18px;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
}

/* 全量刷新二次确认（决议 #197）：暖色警示标 + 精简文案（非删除红，提醒「留意代价」） */
.scan-confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(20, 28, 24, 0.26);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: scan-confirm-fade 0.14s ease;
}
.scan-confirm-card {
  width: min(300px, 100%);
  padding: 20px 18px 14px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-float);
  text-align: center;
  animation: scan-confirm-rise 0.16s cubic-bezier(0.16, 1, 0.3, 1);
}
.scan-confirm-mark {
  width: 48px;
  height: 48px;
  margin: 0 auto 12px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #c48a12;
  background:
    radial-gradient(circle at 50% 42%, rgba(255, 214, 120, 0.35), transparent 62%),
    rgba(196, 138, 18, 0.12);
  box-shadow: inset 0 0 0 1px rgba(196, 138, 18, 0.18);
}
.scan-confirm-card h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.3;
}
.scan-confirm-sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-2);
}
.scan-confirm-list {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 132px;
  overflow-y: auto;
  text-align: left;
}
.scan-confirm-list li {
  display: flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 9px;
  background: var(--bg-list);
}
.scan-confirm-list code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-1);
  letter-spacing: 0.01em;
  background: transparent;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-confirm-more {
  justify-content: center;
  background: transparent !important;
  color: var(--text-3);
  font-size: 12px;
  min-height: 22px !important;
  padding: 0 !important;
}
.scan-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.scan-confirm-actions button {
  height: 32px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: 13px;
  cursor: pointer;
  transition:
    background 0.12s ease,
    border-color 0.12s ease,
    color 0.12s ease,
    filter 0.12s ease,
    transform 0.1s ease;
}
.scan-confirm-cancel {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
}
.scan-confirm-cancel:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.scan-confirm-cancel:active,
.scan-confirm-go:active {
  transform: scale(0.98);
}
.scan-confirm-go {
  border: none;
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
.scan-confirm-go:hover {
  filter: brightness(0.96);
}
@keyframes scan-confirm-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes scan-confirm-rise {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .scan-confirm-mask,
  .scan-confirm-card {
    animation: none;
  }
  .scan-confirm-actions button {
    transition: none;
  }
  .scan-confirm-cancel:active,
  .scan-confirm-go:active {
    transform: none;
  }
}

/* 移除聊天撤回提示（决议 #125）：底部居中浮条，茶青撤回按钮，尊重 reduced-motion */
.undo-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: calc(100% - 48px);
  padding: 10px 12px 10px 16px;
  border-radius: 14px;
  background: var(--material-strong);
  border: 1px solid var(--line);
  box-shadow: var(--highlight-edge), var(--shadow-float);
  backdrop-filter: blur(20px) saturate(135%);
  -webkit-backdrop-filter: blur(20px) saturate(135%);
  animation: undo-rise 0.18s ease;
}
.undo-text {
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.undo-btn {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    color 150ms ease,
    background 150ms ease,
    transform 90ms ease-out;
}
.undo-btn:hover {
  background: var(--primary);
  color: #fff;
}
.undo-btn:active {
  transform: scale(0.97);
}
@keyframes undo-rise {
  from {
    opacity: 0;
    transform: translate(-50%, 8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .undo-toast {
    animation: none;
  }
  .undo-btn {
    transition: none;
  }
  .undo-btn:active {
    transform: none;
  }
}
</style>
