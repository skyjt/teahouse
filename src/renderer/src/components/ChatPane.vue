<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import { useTransfersStore } from '../stores/transfers'
import { splitEmojiText } from '../utils/compat-emoji'
import {
  hasClipboardText,
  normalizeClipboardText,
  readClipboardTableText,
  shouldScheduleIpcClipboardImageFallback,
  shouldSuppressNativeImageFallback,
  type ClipboardTableText
} from '../utils/clipboard'
import { emojiAdvanceWidth, fontOfStyle, setTextMeasurer } from '../utils/emoji-metrics'
import { emojiToTwemojiCode, twemojiUrl } from '../utils/twemoji-assets'
import { isImeCompositionKey } from '../utils/ime'
import { isPlainEscape } from '../utils/escape'
import {
  TABLE_PASTE_HINT_MS,
  draftWithoutTablePaste,
  tablePasteHintIntact,
  tablePasteHintText,
  type TablePasteHint
} from '../utils/table-paste'
import { listTime } from '../utils/time'
import {
  canRecallAt,
  formatRecallMenuMeta,
  isRecallMenuUrgent,
  recallRemainingMs
} from '../utils/recall'
import AvatarMark from './AvatarMark.vue'
import CompatEmoji from './CompatEmoji.vue'
import MessageRow from './MessageRow.vue'
import EmojiPanel from './EmojiPanel.vue'
import GroupPanel from './GroupPanel.vue'
import FileCabinetPanel from './FileCabinetPanel.vue'
import GroupAvatar from './GroupAvatar.vue'
import ForwardDialog from './ForwardDialog.vue'
import PantryIcon from './PantryIcon.vue'
import Win7ChatEditor from './Win7ChatEditor.vue'
import type {
  ConversationMessageHit,
  ConversationSearchKind,
  MessageView,
  PeerView,
  SettingsView,
  TransferView
} from '../../../shared/ipc'
import { IMAGE_FILE_EXTENSIONS } from '../../../shared/media'
import { vCachedImage } from '../directives/cached-image'
import type { PkGame } from '../../../shared/pk'
import {
  CAPS,
  NUDGE_MIN_INTERVAL_MS,
  RECALL_WINDOW_MS,
  TEXT_TCP_LIMIT,
  TEXT_UDP_LIMIT
} from '../../../shared/protocol'

const props = withDefaults(defineProps<{ win7ImeCompat?: boolean }>(), {
  win7ImeCompat: false
})

const peersStore = usePeersStore()
const chatStore = useChatStore()
const groupsStore = useGroupsStore()
const transfersStore = useTransfersStore()
transfersStore.init()

const draft = ref('')
const dragging = ref(false)

// 可拖拽调节的输入框高度（决议 #127）：拖输入区顶部手柄上下改 .input-shell 高度，
// clamp 到 [48, 320]，用 localStorage 记忆，纯渲染层、不新增 IPC/存储。
const INPUT_MIN_H = 48
const INPUT_MAX_H = 320
const INPUT_DEFAULT_H = 72
function readStoredInputHeight(): number {
  try {
    const v = Number(localStorage.getItem('chat-input-height'))
    if (Number.isFinite(v) && v >= INPUT_MIN_H && v <= INPUT_MAX_H) return v
  } catch {
    /* localStorage 不可用时退默认值 */
  }
  return INPUT_DEFAULT_H
}
const inputShellHeight = ref(readStoredInputHeight())
let inputResizeMove: ((e: PointerEvent) => void) | null = null
let inputResizeUp: (() => void) | null = null

function stopInputResize(): void {
  if (inputResizeMove) window.removeEventListener('pointermove', inputResizeMove)
  if (inputResizeUp) window.removeEventListener('pointerup', inputResizeUp)
  inputResizeMove = null
  inputResizeUp = null
}

function startInputResize(e: PointerEvent): void {
  e.preventDefault()
  stopInputResize()
  const startY = e.clientY
  const startH = inputShellHeight.value
  inputResizeMove = (ev: PointerEvent): void => {
    // 向上拖（clientY 变小）增高，向下拖减小
    const next = startH - (ev.clientY - startY)
    inputShellHeight.value = Math.max(INPUT_MIN_H, Math.min(INPUT_MAX_H, Math.round(next)))
  }
  inputResizeUp = (): void => {
    stopInputResize()
    try {
      localStorage.setItem('chat-input-height', String(inputShellHeight.value))
    } catch {
      /* 忽略写入失败，仅本次会话生效 */
    }
  }
  window.addEventListener('pointermove', inputResizeMove)
  window.addEventListener('pointerup', inputResizeUp)
}

onUnmounted(stopInputResize)
const showEmoji = ref(false)
const showHistorySearch = ref(false)
const showMembers = ref(false)
const showCabinet = ref(false)
const showMentionPicker = ref(false)
const mentionIds = ref<string[]>([])
const pendingMentionAt = ref<number | null>(null)
const loadingEarlier = ref(false)
const scrollArea = ref<HTMLElement | null>(null)
const msgsContent = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const win7EditorEl = ref<InstanceType<typeof Win7ChatEditor> | null>(null)
const inputComposing = ref(false)
const emojiScope = ref<HTMLElement | null>(null)
const pkScope = ref<HTMLElement | null>(null)
const peerProfileScope = ref<HTMLElement | null>(null)
const historySearchInput = ref<HTMLInputElement | null>(null)
const inputScrollTop = ref(0)
const msgMenu = ref<{ x: number; y: number; msg: MessageView } | null>(null)
const forwardMsg = ref<MessageView | null>(null)
const replyToId = ref<string | null>(null)
const replyToMeta = ref({id: '', senderName: '', text: ''})

watch(replyToId,
    async (newId) => {
      if (!newId) {
        replyToMeta.value = {id: '', senderName: '', text: ''}
        return
      }
      /** 用 ID 解析引用展示元数据；查不到时降级为"原消息不可用" */
      const msg = await chatStore.getMessageById(newId)
      if (!msg) {
        replyToMeta.value = {id: newId, senderName: '原消息不可用', text: ''}
        return
      }
      // 直接读取源消息自身的发送者 ID 和文本；原消息是普通消息时 replyTo 字段为空
      const senderName = peersStore.nameOf(msg.senderId) || '未知成员'
      replyToMeta.value = {id: newId, senderName, text: String(msg.text ?? '')}
    },
    {immediate: true}
)

const settings = ref<SettingsView | null>(null)
let stopSettings: (() => void) | null = null
let stopClipboardPaste: (() => void) | null = null
let clipboardImagePasteBusy = false
let clipboardImageFallbackTimer: ReturnType<typeof setTimeout> | null = null
let lastClipboardPasteHandledAt = 0
/** 粘贴代次：mark 时递增；兜底在 await 后若代次变化则放弃发送（决议 #207） */
let clipboardPasteEpoch = 0
let historySearchTimer: ReturnType<typeof setTimeout> | null = null
// 历史搜索结果点图片：单击放大 / 双击定位的延时区分（决议 #74）
let hitClickTimer: ReturnType<typeof setTimeout> | null = null
let peerProfileSavedTimer: ReturnType<typeof setTimeout> | null = null
let historySearchRun = 0
const MSG_MENU_WIDTH = 128
const MSG_MENU_ITEM_HEIGHT = 32
const MSG_MENU_PADDING = 10
const MENU_MARGIN = 8
const ACTIVE_MESSAGE_TRIM_THRESHOLD = 400
const ACTIVE_MESSAGE_TRIM_KEEP = 300
interface HistoryCalendarDay {
  key: string
  label: number
  inMonth: boolean
  isToday: boolean
  isStart: boolean
  isEnd: boolean
  inRange: boolean
}

const historyQuery = ref('')
const historyKind = ref<ConversationSearchKind>('all')
const historyFrom = ref('')
const historyTo = ref('')
const historyCalendarMonth = ref(monthKey(new Date()))
const historyHits = ref<ConversationMessageHit[]>([])
const historySearching = ref(false)
const historyBrokenImages = ref<Record<string, boolean>>({})
const showPeerProfile = ref(false)
const showPk = ref(false)
const peerProfileRemark = ref('')
const peerProfileSaving = ref(false)
const peerProfileSaved = ref(false)
const nudgeSending = ref(false)
const nudgeRetryUntil = ref(0)
const nudgeNow = ref(Date.now())
const nudgeFeedback = ref<{ text: string; kind: 'ok' | 'warn' } | null>(null)
let nudgeFeedbackTimer: ReturnType<typeof setTimeout> | null = null
let nudgeRetryTimer: ReturnType<typeof setInterval> | null = null
// 表格粘贴提示条（决议 #270）：粘贴只插入文本，发不发图片由用户决定
const tablePasteHint = ref<TablePasteHint | null>(null)
let tablePasteHintTimer: ReturnType<typeof setTimeout> | null = null
/** 提示条待发的表格素材；含 ArrayBuffer，不进 store、不经 IPC */
let tablePastePayload: {
  rawText: string
  meta: ClipboardTableText
  imageBytes: ArrayBuffer | null
  imageExt: string
} | null = null
const tablePasteHintLabel = computed(() =>
  tablePasteHintText(tablePasteHint.value?.oversize ?? false)
)
let applyingConversationScroll = false
const SCROLL_BOTTOM_THRESHOLD = 24
const CLIPBOARD_NATIVE_FALLBACK_DELAY_MS = 80
const TABLE_RENDER_MAX_COL_WIDTH = 220
const TABLE_RENDER_MIN_COL_WIDTH = 56
const TABLE_RENDER_PAD_X = 10
const TABLE_RENDER_ROW_HEIGHT = 28
// 贴底意图（决议 #133）：用户处于"看最新"状态时，图片 / 文件卡片等异步撑高后继续贴底
let stickBottom = false
let bottomKeeper: ResizeObserver | null = null
// 距底超过约两屏（决议 #134）：驱动消息区右下角"回到最新"悬浮按钮的显示
const farFromBottom = ref(false)

const isGroup = computed(() => chatStore.activeConv?.type === 'group')

// 文件柜入口（决议 #273）：只在私聊出现；拿不到就明确说明原因，不给"点了没反应"的按钮
const cabinetDisabledReason = computed(() => {
  const p = peer.value
  if (!p) return '对方资料还没同步到'
  if (!p.online) return '对方离线'
  if (!(p.caps ?? []).includes(CAPS.fileCabinet)) return '对方版本不支持文件柜'
  return ''
})
const cabinetTitle = computed(() => cabinetDisabledReason.value || '文件柜')

function toggleCabinet(): void {
  if (cabinetDisabledReason.value) return
  showCabinet.value = !showCabinet.value
  if (showCabinet.value) showMembers.value = false
}
const group = computed(() =>
  isGroup.value && chatStore.activeConv
    ? (groupsStore.byId[chatStore.activeConv.peerId] ?? null)
    : null
)
const peer = computed(() => {
  const conv = chatStore.activeConv
  if (!conv || conv.type === 'group') return null
  return peersStore.byId(conv.peerId) ?? null
})
const peerName = computed(() => {
  if (isGroup.value) return group.value?.name ?? '讨论组'
  return peer.value ? peer.value.remark || peer.value.nick : '未知节点'
})
const peerIp = computed(() => peer.value?.ip ?? '')
const peerOnline = computed(() => peer.value?.online ?? false)
/** 群：成员才可发；单聊：文本随时可发（离线走补发） */
const canSend = computed(() => (isGroup.value ? (group.value?.amMember ?? false) : true))
const onlineGroupRecipientCount = computed(() => {
  if (!group.value) return 0
  let count = 0
  for (const id of group.value.members) {
    if (id === chatStore.selfId) continue
    if (peersStore.byId(id)?.online) count += 1
  }
  return count
})
const canSendMedia = computed(() =>
  isGroup.value ? canSend.value && onlineGroupRecipientCount.value > 0 : peerOnline.value
)
const canSendPk = computed(() =>
  isGroup.value ? canSend.value && onlineGroupRecipientCount.value > 0 : peerOnline.value
)
const pkDisabledReason = computed(() => 'PK 只能和在线的人玩')
const pkToolTip = computed(() => (canSendPk.value ? 'PK' : pkDisabledReason.value))
const nudgeRetryRemainingMs = computed(() => Math.max(0, nudgeRetryUntil.value - nudgeNow.value))
const canSendNudge = computed(
  () => !isGroup.value && peerOnline.value && !nudgeSending.value && nudgeRetryRemainingMs.value <= 0
)
const nudgeToolTip = computed(() => {
  if (isGroup.value) return '窗口震动仅支持私聊'
  if (!peerOnline.value) return '对方离线，无法震动'
  if (nudgeRetryRemainingMs.value > 0) {
    return `${Math.ceil(nudgeRetryRemainingMs.value / 1000)} 秒后可再震动`
  }
  return '窗口震动'
})
const mentionMembers = computed(() =>
  group.value ? group.value.members.filter((id) => id !== chatStore.selfId) : []
)
const inputPlaceholder = computed(() => {
  if (!canSend.value) return '你已不在该讨论组，无法发言'
  return settings.value?.sendKey === 'ctrlEnter'
    ? '输入消息，Ctrl+Enter 发送，Enter 换行；可粘贴截图/文件'
    : '输入消息，Enter 发送，Ctrl+Enter 换行；可粘贴截图/文件'
})
const draftEmojiParts = computed(() => splitEmojiText(draft.value))
// Win7 由系统字体 contenteditable 直接承载 Twemoji 原子节点，不再启用 textarea 镜像（决议 #262）。
const draftUsesEmojiMirror = computed(() =>
  !props.win7ImeCompat && draftEmojiParts.value.some((part) => part.emoji)
)
/** textarea 的实际 font（measureText 用）；为空时镜像退化为原字符渲染，宽度天然一致 */
const inputFont = ref('')
/** PantryEmojiBlank 加载完成后 +1：清测量缓存并强制镜像重算（决议 #56） */
const fontEpoch = ref(0)
interface MirrorPart {
  text: string
  emoji: boolean
  width: number
  src: string
}
// 镜像层 emoji 的占位宽度 = textarea 字体下该字符的真实 advance 宽度（决议 #48 对齐修正；
// PantryEmojiBlank 生效后测量值恒为 1.3em，决议 #56）
const draftMirrorParts = computed<MirrorPart[]>(() => {
  void fontEpoch.value
  return draftEmojiParts.value.map((part) => {
    if (!part.emoji || !inputFont.value) return { ...part, width: 0, src: '' }
    return {
      ...part,
      width: emojiAdvanceWidth(part.text, inputFont.value),
      src: twemojiUrl(emojiToTwemojiCode(part.text))
    }
  })
})

function refreshInputFont(): void {
  const ta = inputEl.value
  inputFont.value = ta ? fontOfStyle(getComputedStyle(ta)) : ''
}
const historyResultMeta = computed(() => {
  if (historySearching.value) return '搜索中'
  return `${historyHits.value.length} 条结果`
})
const HISTORY_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const historyDateRangeLabel = computed(() => {
  if (historyFrom.value && historyTo.value) {
    return `${compactDateLabel(historyFrom.value)} 至 ${compactDateLabel(historyTo.value)}`
  }
  if (historyFrom.value) return `${compactDateLabel(historyFrom.value)} 起`
  return '全部日期'
})
const historyCalendarTitle = computed(() => {
  const base = monthDate(historyCalendarMonth.value)
  return `${base.getFullYear()}年${base.getMonth() + 1}月`
})
const historyCalendarDays = computed<HistoryCalendarDay[]>(() => {
  const base = monthDate(historyCalendarMonth.value)
  const first = new Date(base.getFullYear(), base.getMonth(), 1)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = new Date(first)
  start.setDate(first.getDate() - mondayOffset)
  const today = dateKey(new Date())
  const from = historyFrom.value
  const to = historyTo.value
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    const key = dateKey(day)
    const isStart = key === from
    const isEnd = key === to
    return {
      key,
      label: day.getDate(),
      inMonth: day.getMonth() === base.getMonth(),
      isToday: key === today,
      isStart,
      isEnd,
      inRange: Boolean(from && to && key > from && key < to)
    }
  })
})

function onDocumentPointerDown(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  if (showEmoji.value && !emojiScope.value?.contains(target)) showEmoji.value = false
  if (showPk.value && !pkScope.value?.contains(target)) showPk.value = false
  if (showPeerProfile.value && !peerProfileScope.value?.contains(target)) closePeerProfile()
}

function onEscape(event: KeyboardEvent): void {
  if (!isPlainEscape(event, inputComposing.value) || document.querySelector('[aria-modal="true"]')) return
  if (msgMenu.value) msgMenu.value = null
  else if (showMentionPicker.value) {
    showMentionPicker.value = false
    pendingMentionAt.value = null
  } else if (showEmoji.value) showEmoji.value = false
  else if (showPk.value) showPk.value = false
  else if (showPeerProfile.value) closePeerProfile()
  else return
  event.preventDefault()
}

onMounted(async () => {
  document.addEventListener('keydown', onEscape)
  document.addEventListener('mousedown', onDocumentPointerDown)
  refreshInputFont()
  // 空白字形字体就绪前测得的是系统字符宽——就绪后清缓存重测，镜像槽宽收敛到 1.3em
  void document.fonts
    ?.load('14px PantryEmojiBlank')
    .catch(() => undefined)
    .then(() => {
      setTextMeasurer(null)
      fontEpoch.value += 1
    })
  settings.value = await window.pantry.getSettings()
  stopSettings = window.pantry.onSettingsUpdated((next) => {
    settings.value = next
    void nextTick(refreshInputFont)
  })
  stopClipboardPaste = window.pantry.onClipboardPasteImage(() => {
    // 任一 input/textarea 有焦点时由 onPaste 独占（决议 #207）；IPC 兜底仅服务
    // 焦点不在可编辑输入时（如点在消息区按 Ctrl+V）。
    if (!shouldScheduleIpcClipboardImageFallback(document.activeElement)) return
    if (canSendMedia.value) scheduleClipboardImageFallback()
  })
  // 内容异步撑高（图片 / 文件卡片加载完成、消息渲染）后，若处于贴底意图则继续贴到最新（决议 #133）
  if (msgsContent.value && typeof ResizeObserver !== 'undefined') {
    bottomKeeper = new ResizeObserver(() => {
      const el = scrollArea.value
      if (el && stickBottom && !isNearBottom(el)) el.scrollTop = el.scrollHeight
    })
    bottomKeeper.observe(msgsContent.value)
  }
  applyConversationScroll()
})

onUnmounted(() => {
  rememberConversationScroll()
  document.removeEventListener('keydown', onEscape)
  bottomKeeper?.disconnect()
  bottomKeeper = null
  document.removeEventListener('mousedown', onDocumentPointerDown)
  if (historySearchTimer) clearTimeout(historySearchTimer)
  if (peerProfileSavedTimer) clearTimeout(peerProfileSavedTimer)
  if (nudgeFeedbackTimer) clearTimeout(nudgeFeedbackTimer)
  if (nudgeRetryTimer) clearInterval(nudgeRetryTimer)
  clearTablePasteHint()
  stopRecallCountdownTimer()
  if (clipboardImageFallbackTimer) clearTimeout(clipboardImageFallbackTimer)
  historySearchRun += 1
  stopSettings?.()
  stopClipboardPaste?.()
})

watch(
  () => chatStore.activeConv?.peerId,
  (id) => {
    showMembers.value = false
    // 文件柜面板跟着会话走：留着会直接挂到新对端身上，对方离线 / 不支持时
    // 顶部按钮已经灰掉、面板却还开着报错，状态自相矛盾（决议 #278）
    showCabinet.value = false
    showMentionPicker.value = false
    showHistorySearch.value = false
    closePeerProfile()
    mentionIds.value = []
    nudgeFeedback.value = null
    clearTablePasteHint()
    resetHistorySearch()
    replyToId.value = null
    if (isGroup.value && id) void groupsStore.ensure(id)
  },
  { immediate: true }
)

watch([historyQuery, historyKind, historyFrom, historyTo], () => scheduleHistorySearch())

watch(draft, () => {
  void nextTick(syncInputMirrorScroll)
  // 用户一改草稿，捕获的表格素材就与输入框对不上了，直接收起提示条（决议 #270）
  if (tablePasteHint.value && !tablePasteHintIntact(draft.value, tablePasteHint.value)) {
    clearTablePasteHint()
  }
})

watch(
  () => [peer.value?.nodeId ?? '', peer.value?.remark ?? ''] as const,
  () => {
    if (showPeerProfile.value) return
    peerProfileRemark.value = peer.value?.remark ?? ''
    peerProfileSaved.value = false
  }
)

function senderName(msg: MessageView): string {
  return peersStore.nameOf(msg.senderId)
}

function senderAvatar(msg: MessageView): number {
  return peersStore.byId(msg.senderId)?.avatar ?? -1
}

function senderAvatarHash(msg: MessageView): string {
  return peersStore.byId(msg.senderId)?.avatarHash ?? ''
}

const draftBytes = computed(() => new TextEncoder().encode(draft.value.trim()).length)
const overUdpLimit = computed(() => draftBytes.value > TEXT_UDP_LIMIT)
const overLimit = computed(() => draftBytes.value > TEXT_TCP_LIMIT)

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollArea.value
    if (el) {
      stickBottom = true
      applyScrollTop(el.scrollHeight)
    }
  })
}

// 点右下角悬浮按钮回到最新（决议 #134）：历史页需重载最新页，最新页直接滚到底
function jumpToLatest(): void {
  if (chatStore.viewingHistory) void chatStore.backToLatest()
  else scrollToBottom()
}

function isNearBottom(el = scrollArea.value): boolean {
  if (!el) return true
  return el.scrollHeight - el.clientHeight - el.scrollTop <= SCROLL_BOTTOM_THRESHOLD
}

function rememberConversationScroll(convId = chatStore.activeConvId): void {
  const el = scrollArea.value
  if (!el || !convId) return
  chatStore.rememberConversationScroll(convId, el.scrollTop, isNearBottom(el))
}

function applyScrollTop(top: number): void {
  const el = scrollArea.value
  if (!el) return
  applyingConversationScroll = true
  el.scrollTop = top
  window.requestAnimationFrame(() => {
    applyingConversationScroll = false
    rememberConversationScroll()
  })
}

function applyConversationScroll(): void {
  const convId = chatStore.activeConvId
  const mode = chatStore.openScrollMode
  if (!convId) return
  // 搜索跳转定位到指定历史消息（高亮居中），不属于贴底意图，避免内容撑高时被拉回底部
  if (mode === 'target') {
    stickBottom = false
    return
  }
  void nextTick(() => {
    if (chatStore.activeConvId !== convId) return
    const el = scrollArea.value
    if (!el) return
    const saved = chatStore.scrollPositions[convId]
    if (mode === 'latest' || !saved || saved.atBottom) {
      stickBottom = true
      applyScrollTop(el.scrollHeight)
      return
    }
    stickBottom = false
    applyScrollTop(Math.min(saved.top, Math.max(0, el.scrollHeight - el.clientHeight)))
  })
}

watch(
  () => chatStore.activeConvId,
  (_id, oldId) => {
    if (oldId) rememberConversationScroll(oldId)
  }
)

watch(() => chatStore.openScrollRun, applyConversationScroll)

// 只在"末尾追加"且用户本来在底部附近时贴底；自己发送的消息始终跟随到底部。
watch(
  () => {
    const list = chatStore.activeMessages
    const tail = list[list.length - 1]
    return {
      convId: chatStore.activeConvId ?? '',
      id: tail?.id ?? '',
      isMine: tail?.isMine ?? false
    }
  },
  (next, old) => {
    if (!old || !next.convId || next.convId !== old.convId || !next.id || next.id === old.id) {
      return
    }
    const shouldStickToBottom = isNearBottom() || next.isMine
    if (!shouldStickToBottom) return
    scrollToBottom()
    if (
      !chatStore.viewingHistory &&
      chatStore.openScrollMode !== 'target' &&
      chatStore.activeMessages.length > ACTIVE_MESSAGE_TRIM_THRESHOLD
    ) {
      chatStore.trimConversationHead(next.convId, ACTIVE_MESSAGE_TRIM_KEEP)
    }
  }
)
// 搜索跳转高亮：滚动到目标消息居中
watch(
  () => chatStore.highlightId,
  (id) => {
    if (!id) return
    void nextTick(() => {
      document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'center' })
    })
  },
  { immediate: true }
)

/** 滚到顶部附近 → 向上加载更早历史，并保持视口位置不跳（F-MSG-5） */
async function onScroll(): Promise<void> {
  const el = scrollArea.value
  if (!el) return
  rememberConversationScroll()
  // 跟随贴底意图随滚动更新：贴近底部则保持跟随，向上翻历史则停止（决议 #133）
  stickBottom = isNearBottom(el)
  // 距底超过约两屏才显示"回到最新"按钮，避免一上滑就冒出来打扰（决议 #134）
  farFromBottom.value = el.scrollHeight - el.clientHeight - el.scrollTop > el.clientHeight * 2
  if (applyingConversationScroll || el.scrollTop > 40 || loadingEarlier.value) return
  loadingEarlier.value = true
  const prevHeight = el.scrollHeight
  const loaded = await chatStore.loadEarlier()
  if (loaded > 0) {
    await nextTick()
    el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop
    rememberConversationScroll()
  }
  loadingEarlier.value = false
}

function resetHistorySearch(): void {
  if (historySearchTimer) {
    clearTimeout(historySearchTimer)
    historySearchTimer = null
  }
  historySearchRun += 1
  historyQuery.value = ''
  historyKind.value = 'all'
  historyFrom.value = ''
  historyTo.value = ''
  historyCalendarMonth.value = monthKey(new Date())
  historyHits.value = []
  historySearching.value = false
  historyBrokenImages.value = {}
}

function closePeerProfile(): void {
  showPeerProfile.value = false
  peerProfileSaving.value = false
  peerProfileSaved.value = false
  if (peerProfileSavedTimer) {
    clearTimeout(peerProfileSavedTimer)
    peerProfileSavedTimer = null
  }
}

function openPeerProfile(): void {
  const current = peer.value
  if (!current) return
  showEmoji.value = false
  closeHistorySearch()
  peerProfileRemark.value = current.remark
  peerProfileSaved.value = false
  showPeerProfile.value = true
}

function togglePeerProfile(): void {
  if (showPeerProfile.value) {
    closePeerProfile()
    return
  }
  openPeerProfile()
}

function closeHistorySearch(): void {
  showHistorySearch.value = false
  if (historySearchTimer) {
    clearTimeout(historySearchTimer)
    historySearchTimer = null
  }
  historySearching.value = false
  historySearchRun += 1
  historyBrokenImages.value = {}
}

function toggleHistorySearch(): void {
  closePeerProfile()
  showHistorySearch.value = !showHistorySearch.value
  if (!showHistorySearch.value) {
    closeHistorySearch()
    return
  }
  historyCalendarMonth.value = historyFrom.value
    ? historyFrom.value.slice(0, 7)
    : monthKey(new Date())
  scheduleHistorySearch()
  void nextTick(() => historySearchInput.value?.focus())
}

function clearHistorySearch(): void {
  resetHistorySearch()
  scheduleHistorySearch()
  void nextTick(() => historySearchInput.value?.focus())
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

function monthDate(key: string): Date {
  const matched = /^(\d{4})-(\d{2})$/.exec(key)
  if (!matched) return new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  return new Date(Number(matched[1]), Number(matched[2]) - 1, 1)
}

function compactDateLabel(value: string): string {
  return value.replace(/-/g, '.')
}

function moveHistoryMonth(offset: number): void {
  const base = monthDate(historyCalendarMonth.value)
  base.setMonth(base.getMonth() + offset)
  historyCalendarMonth.value = monthKey(base)
}

function pickHistoryDate(key: string): void {
  historyCalendarMonth.value = key.slice(0, 7)
  if (!historyFrom.value || historyTo.value) {
    historyFrom.value = key
    historyTo.value = ''
    return
  }
  if (key < historyFrom.value) {
    historyTo.value = historyFrom.value
    historyFrom.value = key
    return
  }
  historyTo.value = key
}

function clearHistoryDateRange(): void {
  historyFrom.value = ''
  historyTo.value = ''
  historyCalendarMonth.value = monthKey(new Date())
}

function peerOrgPath(p: PeerView): string {
  return [p.company, p.dept, p.team].filter(Boolean).join(' / ') || '未分组'
}

function peerPlatformLabel(platform: PeerView['platform']): string {
  if (platform === 'win') return 'Windows'
  if (platform === 'mac') return 'macOS'
  return 'Linux'
}

function peerLastSeenLabel(p: PeerView): string {
  if (p.online) return '当前在线'
  if (!p.lastSeen) return '离线'
  return listTime(p.lastSeen)
}

async function savePeerProfileRemark(): Promise<void> {
  const current = peer.value
  if (!current || peerProfileSaving.value) return
  const next = peerProfileRemark.value.trim()
  peerProfileSaving.value = true
  try {
    await window.pantry.setPeerRemark(current.nodeId, next)
    peerProfileRemark.value = next
    peerProfileSaved.value = true
    if (peerProfileSavedTimer) clearTimeout(peerProfileSavedTimer)
    peerProfileSavedTimer = setTimeout(() => {
      peerProfileSaved.value = false
      peerProfileSavedTimer = null
    }, 1500)
  } finally {
    peerProfileSaving.value = false
  }
}

function dayStart(value: string): number | undefined {
  if (!value) return undefined
  const ts = new Date(`${value}T00:00:00`).getTime()
  return Number.isFinite(ts) ? ts : undefined
}

function dayEnd(value: string): number | undefined {
  if (!value) return undefined
  const ts = new Date(`${value}T23:59:59.999`).getTime()
  return Number.isFinite(ts) ? ts : undefined
}

function scheduleHistorySearch(): void {
  if (historySearchTimer) clearTimeout(historySearchTimer)
  if (!showHistorySearch.value || !chatStore.activeConvId) {
    historyHits.value = []
    historySearching.value = false
    return
  }
  historySearching.value = true
  historySearchTimer = setTimeout(() => {
    historySearchTimer = null
    void runHistorySearch()
  }, 200)
}

async function runHistorySearch(): Promise<void> {
  const convId = chatStore.activeConvId
  if (!convId) {
    historyHits.value = []
    historySearching.value = false
    return
  }
  const run = ++historySearchRun
  const hits = await window.pantry.searchMessages({
    convId,
    query: historyQuery.value,
    kind: historyKind.value,
    fromTs: dayStart(historyFrom.value),
    toTs: dayEnd(historyTo.value),
    limit: 50
  })
  if (run !== historySearchRun) return
  historyHits.value = hits
  historyBrokenImages.value = {}
  historySearching.value = false
}

function historyIcon(hit: ConversationMessageHit): string {
  if (hit.kind === 'image') return 'image'
  if (hit.kind === 'file') return 'file'
  if (hit.kind === 'pk') return 'pk'
  return 'chat'
}

function openHistoryViewer(hit: ConversationMessageHit): void {
  const transferId = hit.fileRef?.transferId ?? ''
  if (!transferId || !historyImageTransferId(hit)) return
  void window.pantry.openImageViewer(transferId)
}

function historySecondary(hit: ConversationMessageHit): string {
  const who = hit.isMine ? '我' : peersStore.nameOf(hit.senderId)
  return `${who} · ${listTime(hit.ts)}`
}

function historyImageTransferId(hit: ConversationMessageHit): string {
  if (hit.kind !== 'image' || historyBrokenImages.value[hit.msgId]) return ''
  return hit.fileRef?.transferId ?? ''
}

function markHistoryImageBroken(hit: ConversationMessageHit, event: Event): void {
  const image = event.currentTarget as HTMLImageElement | null
  if (
    image?.src.startsWith('pantry-thumb:') &&
    image.dataset.previewOriginalFallback !== 'true'
  ) {
    image.dataset.previewOriginalFallback = 'true'
    image.src = `pantry-img://${hit.fileRef?.transferId ?? ''}`
    return
  }
  const msgId = hit.msgId
  historyBrokenImages.value = { ...historyBrokenImages.value, [msgId]: true }
}

async function openHistoryHit(hit: ConversationMessageHit): Promise<void> {
  closeHistorySearch()
  await chatStore.jumpToMessage(hit.convId, hit.seq, hit.msgId)
}

// 图片命中：单击放大看图（延时区分），双击跳转定位；其余命中单击即定位（决议 #74）
function onHistoryHitClick(hit: ConversationMessageHit): void {
  if (hit.kind !== 'image') {
    void openHistoryHit(hit)
    return
  }
  if (hitClickTimer) clearTimeout(hitClickTimer)
  hitClickTimer = setTimeout(() => {
    hitClickTimer = null
    openHistoryViewer(hit)
  }, 220)
}

function onHistoryHitDblClick(hit: ConversationMessageHit): void {
  if (hitClickTimer) {
    clearTimeout(hitClickTimer)
    hitClickTimer = null
  }
  void openHistoryHit(hit)
}

function window_startCapture(): void {
  void window.pantry.startCapture()
}

async function sendStickerById(stickerId: string): Promise<void> {
  showEmoji.value = false
  await chatStore.sendSticker(stickerId)
}

function inputSelectionRange(): { start: number; end: number } {
  if (props.win7ImeCompat) {
    return win7EditorEl.value?.selectionRange() ?? {
      start: draft.value.length,
      end: draft.value.length
    }
  }
  const textarea = inputEl.value
  const start = textarea?.selectionStart ?? draft.value.length
  return { start, end: textarea?.selectionEnd ?? start }
}

function focusInput(): void {
  if (props.win7ImeCompat) win7EditorEl.value?.focus()
  else inputEl.value?.focus()
}

function setInputSelection(start: number, end = start): void {
  if (props.win7ImeCompat) {
    win7EditorEl.value?.setSelectionRange(start, end)
    return
  }
  if (inputEl.value) {
    inputEl.value.selectionStart = start
    inputEl.value.selectionEnd = end
  }
}

function onWin7EditorValue(value: string): void {
  draft.value = value
}

function insertEmoji(emoji: string): void {
  const { start, end } = inputSelectionRange()
  draft.value = draft.value.slice(0, start) + emoji + draft.value.slice(end)
  void nextTick(() => {
    focusInput()
    setInputSelection(start + emoji.length)
  })
}

function syncInputMirrorScroll(): void {
  inputScrollTop.value = props.win7ImeCompat
    ? (win7EditorEl.value?.scrollTop() ?? 0)
    : (inputEl.value?.scrollTop ?? 0)
}

function insertNewline(): void {
  const { start, end } = inputSelectionRange()
  draft.value = draft.value.slice(0, start) + '\n' + draft.value.slice(end)
  void nextTick(() => {
    focusInput()
    setInputSelection(start + 1)
  })
}

/** 在光标处插入文本，返回插入起点（表格粘贴提示条要靠它把这段摘回来） */
function insertTextAtCursor(text: string): number {
  const { start, end } = inputSelectionRange()
  draft.value = draft.value.slice(0, start) + text + draft.value.slice(end)
  void nextTick(() => {
    focusInput()
    setInputSelection(start + text.length)
  })
  return start
}

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || overLimit.value || !canSend.value) return
  const mentions = isGroup.value
    ? [...new Set(mentionIds.value)].filter((id) => text.includes(`@${peersStore.nameOf(id)}`))
    : []
  const id = replyToId.value ? replyToId.value : undefined
  draft.value = ''
  mentionIds.value = []
  showMentionPicker.value = false
  replyToId.value = null
  await chatStore.send(text, mentions, id)
}

async function sendClipboardImageFallback(event?: Event): Promise<boolean> {
  if (clipboardImagePasteBusy) return false
  clipboardImagePasteBusy = true
  const epoch = clipboardPasteEpoch
  try {
    const bytes = await window.pantry.readImageFromClipboard()
    // await 期间若 onPaste 已 mark（代次前进），放弃发送，避免双通道各发一张
    if (epoch !== clipboardPasteEpoch) return false
    if (!bytes) return false
    event?.preventDefault()
    markClipboardPasteHandled()
    await chatStore.sendImageBytes('粘贴图片.png', bytes)
    return true
  } finally {
    clipboardImagePasteBusy = false
  }
}

function markClipboardPasteHandled(): void {
  clipboardPasteEpoch += 1
  lastClipboardPasteHandledAt = Date.now()
  if (clipboardImageFallbackTimer) {
    clearTimeout(clipboardImageFallbackTimer)
    clipboardImageFallbackTimer = null
  }
}

function scheduleClipboardImageFallback(): void {
  if (shouldSuppressNativeImageFallback(lastClipboardPasteHandledAt)) return
  if (clipboardImageFallbackTimer) clearTimeout(clipboardImageFallbackTimer)
  clipboardImageFallbackTimer = setTimeout(() => {
    clipboardImageFallbackTimer = null
    if (shouldSuppressNativeImageFallback(lastClipboardPasteHandledAt) || !canSendMedia.value) return
    void sendClipboardImageFallback()
  }, CLIPBOARD_NATIVE_FALLBACK_DELAY_MS)
}

function setNudgeFeedback(text: string, kind: 'ok' | 'warn' = 'ok'): void {
  nudgeFeedback.value = { text, kind }
  if (nudgeFeedbackTimer) clearTimeout(nudgeFeedbackTimer)
  nudgeFeedbackTimer = setTimeout(() => {
    nudgeFeedback.value = null
    nudgeFeedbackTimer = null
  }, 3000)
}

function startNudgeRetry(ms: number): void {
  nudgeRetryUntil.value = Date.now() + Math.max(0, ms)
  nudgeNow.value = Date.now()
  if (nudgeRetryTimer) clearInterval(nudgeRetryTimer)
  nudgeRetryTimer = setInterval(() => {
    nudgeNow.value = Date.now()
    if (nudgeRetryRemainingMs.value <= 0 && nudgeRetryTimer) {
      clearInterval(nudgeRetryTimer)
      nudgeRetryTimer = null
    }
  }, 250)
}

async function sendNudge(): Promise<void> {
  if (!canSendNudge.value) return
  nudgeSending.value = true
  try {
    const result = await chatStore.sendNudge()
    if (result.ok) {
      startNudgeRetry(NUDGE_MIN_INTERVAL_MS)
      return
    }
    if (result.reason === 'rate-limited') {
      const wait = result.retryAfterMs ?? NUDGE_MIN_INTERVAL_MS
      startNudgeRetry(wait)
      setNudgeFeedback(`太频繁，${Math.ceil(wait / 1000)} 秒后再试`, 'warn')
      return
    }
    if (result.reason === 'undelivered') {
      startNudgeRetry(NUDGE_MIN_INTERVAL_MS)
      setNudgeFeedback('对方暂时无响应', 'warn')
      return
    }
    setNudgeFeedback('当前会话无法震动', 'warn')
  } finally {
    nudgeSending.value = false
  }
}

async function sendPk(game: PkGame): Promise<void> {
  if (!canSendPk.value) return
  showPk.value = false
  await chatStore.sendPk(game)
}

function onKeydown(event: KeyboardEvent): void {
  if (isImeCompositionKey(event, inputComposing.value)) return
  if (event.key === '@' && isGroup.value && canSend.value && mentionMembers.value.length > 0) {
    pendingMentionAt.value = inputSelectionRange().start
    showMentionPicker.value = true
    return
  }
  if (event.key !== 'Enter') return
  const modified = event.ctrlKey || event.metaKey
  const mode = settings.value?.sendKey ?? 'enter'
  if ((mode === 'enter' && !modified) || (mode === 'ctrlEnter' && modified)) {
    event.preventDefault()
    void send()
    return
  }
  if (mode === 'enter' && modified) {
    event.preventDefault()
    insertNewline()
    return
  }
  if (mode === 'ctrlEnter' && !modified && props.win7ImeCompat) {
    event.preventDefault()
    insertNewline()
  }
}

function onInputCompositionStart(): void {
  inputComposing.value = true
}

function onInputCompositionEnd(): void {
  inputComposing.value = false
}

function insertMention(nodeId: string): void {
  const name = peersStore.nameOf(nodeId)
  const at = pendingMentionAt.value ?? draft.value.length
  const end = Math.max(at, inputSelectionRange().start)
  draft.value = `${draft.value.slice(0, at)}@${name} ${draft.value.slice(end)}`
  mentionIds.value = [...new Set([...mentionIds.value, nodeId])]
  showMentionPicker.value = false
  pendingMentionAt.value = null
  void nextTick(() => {
    const pos = at + name.length + 2
    focusInput()
    setInputSelection(pos)
  })
}

function canCopyMessage(msg: MessageView): boolean {
  return msg.kind === 'text' && msg.status !== 'recalled'
}

function isRecallableMediaKind(msg: MessageView): boolean {
  return msg.kind === 'image' || msg.kind === 'file'
}

function messageTransferIds(msg: MessageView): string[] {
  const ref = msg.fileRef
  if (!ref) return []
  return ref.transferIds && ref.transferIds.length > 0 ? ref.transferIds : [ref.transferId]
}

function messageTransfers(msg: MessageView): TransferView[] {
  return messageTransferIds(msg)
    .map((id) => transfersStore.byId[id])
    .filter((item): item is TransferView => !!item)
}

function peerSupportsMediaRecall(peerId: string): boolean {
  return (peersStore.byId(peerId)?.caps ?? []).includes(CAPS.mediaRecall)
}

function mediaPeersSupportRecall(msg: MessageView): boolean {
  const transfers = messageTransfers(msg)
  if (transfers.length > 0) {
    return transfers.every((transfer) => peerSupportsMediaRecall(transfer.peerId))
  }
  if (msg.convId.startsWith('single:')) return peerSupportsMediaRecall(msg.convId.slice(7))
  return false
}

function mediaRecallDisabledReason(msg: MessageView): string {
  if (!isRecallableMediaKind(msg)) return ''
  if (!mediaPeersSupportRecall(msg)) return '不可用'
  if (msg.kind !== 'file') return ''
  const transfers = messageTransfers(msg)
  if (transfers.length === 0) return '不可用'
  if (transfers.some((transfer) => transfer.status === 'done')) {
    return msg.convId.startsWith('group:') ? '部分已接收' : '已接收'
  }
  return ''
}

function canRecallMessageAt(msg: MessageView, nowTs: number): boolean {
  if (!isRecallableKind(msg)) return false
  return canRecallAt(nowTs, msg.ts, RECALL_WINDOW_MS, mediaRecallDisabledReason(msg))
}

function canRecallMessage(msg: MessageView): boolean {
  return canRecallMessageAt(msg, Date.now())
}

/** 撤回项是否出现在右键菜单（不含时间判断）：超时也显示，变灰提示"超时"（决议 #63） */
function isRecallableKind(msg: MessageView): boolean {
  return (
    msg.isMine &&
    (msg.kind === 'text' || msg.kind === 'pk' || isRecallableMediaKind(msg)) &&
    msg.status !== 'recalled'
  )
}

// 撤回倒计时时间源（决议 #63/#188/#251）：仅在通用菜单打开期间驱动右侧 mm:ss 实时递减
const recallMenuNowTs = ref(Date.now())
let recallCountdownTimer: ReturnType<typeof setInterval> | null = null

function startRecallCountdownTimer(): void {
  if (recallCountdownTimer) return
  recallMenuNowTs.value = Date.now()
  recallCountdownTimer = setInterval(() => (recallMenuNowTs.value = Date.now()), 500)
}

function stopRecallCountdownTimer(): void {
  if (!recallCountdownTimer) return
  clearInterval(recallCountdownTimer)
  recallCountdownTimer = null
}

function recallRemainingFor(msg: MessageView, nowTs = recallMenuNowTs.value): number {
  return recallRemainingMs(nowTs, msg.ts, RECALL_WINDOW_MS)
}

function recallButtonMetaFor(msg: MessageView, nowTs = recallMenuNowTs.value): string {
  return formatRecallMenuMeta(recallRemainingFor(msg, nowTs), mediaRecallDisabledReason(msg))
}
const recallButtonMeta = computed(() => {
  const msg = msgMenu.value?.msg
  return msg ? recallButtonMetaFor(msg) : ''
})
const recallButtonDisabled = computed(() => {
  const msg = msgMenu.value?.msg
  return !msg || !canRecallMessageAt(msg, recallMenuNowTs.value)
})
const recallButtonUrgent = computed(() => {
  const msg = msgMenu.value?.msg
  if (!msg) return false
  return isRecallMenuUrgent(recallRemainingFor(msg), mediaRecallDisabledReason(msg))
})

watch(msgMenu, (menu) => {
  if (menu) startRecallCountdownTimer()
  else stopRecallCountdownTimer()
})

function canForwardMessage(msg: MessageView): boolean {
  return msg.status !== 'recalled' && msg.kind !== 'system' && msg.kind !== 'pk'
}

function canQuoteMessage(msg: MessageView): boolean {
  return msg.kind === 'text' && msg.status !== 'recalled'
}

function quoteSelectedMessage(): void {
  const msg = msgMenu.value?.msg
  msgMenu.value = null
  if (!msg || !canQuoteMessage(msg)) return
  replyToId.value = String(msg.id)
}

function messageMenuItemCount(msg: MessageView): number {
  return (
    Number(canCopyMessage(msg)) +
    Number(canForwardMessage(msg)) +
    Number(isRecallableKind(msg)) +
    Number(canQuoteMessage(msg) && isGroup.value)
  )
}

function clampMenuPosition(
  event: MouseEvent,
  width: number,
  height: number
): { x: number; y: number } {
  const maxX = Math.max(MENU_MARGIN, window.innerWidth - width - MENU_MARGIN)
  const maxY = Math.max(MENU_MARGIN, window.innerHeight - height - MENU_MARGIN)
  return {
    x: Math.max(MENU_MARGIN, Math.min(event.clientX, maxX)),
    y: Math.max(MENU_MARGIN, Math.min(event.clientY, maxY))
  }
}

function openMessageMenu(event: MouseEvent, msg: MessageView): void {
  const itemCount = messageMenuItemCount(msg)
  if (itemCount === 0) return
  const pos = clampMenuPosition(
    event,
    MSG_MENU_WIDTH,
    itemCount * MSG_MENU_ITEM_HEIGHT + MSG_MENU_PADDING
  )
  msgMenu.value = { ...pos, msg }
}

async function copySelectedMessage(): Promise<void> {
  const msg = msgMenu.value?.msg
  msgMenu.value = null
  if (!msg || !canCopyMessage(msg)) return
  try {
    await navigator.clipboard.writeText(msg.text)
  } catch {
    // 浏览器剪贴板不可用时静默失败；不影响撤回等核心流程。
  }
}

async function recallSelectedMessage(): Promise<void> {
  const msg = msgMenu.value?.msg
  if (msg) await recallMessage(msg)
}

async function recallMessage(msg: MessageView): Promise<void> {
  msgMenu.value = null
  if (!canRecallMessage(msg)) return
  await chatStore.recall(msg.id)
}

function forwardSelectedMessage(): void {
  const msg = msgMenu.value?.msg
  msgMenu.value = null
  if (!msg || !canForwardMessage(msg)) return
  forwardMsg.value = msg
}

async function jumpToReplyTarget(msgId: string): Promise<void> {
  await chatStore.jumpToMessageById(msgId)
}

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase()
  return IMAGE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

async function grantLocalFilePaths(paths: string[]): Promise<string[]> {
  const unique = Array.from(new Set(paths.filter((p) => p.length > 0)))
  if (unique.length === 0) return []
  return window.pantry.grantFilePaths(unique)
}

async function sendFiles(directory: boolean): Promise<void> {
  if (!canSendMedia.value) return
  const paths = await window.pantry.pickFiles(directory)
  if (paths) await chatStore.sendFilePaths(paths)
}

async function sendImage(): Promise<void> {
  if (!canSendMedia.value) return
  const paths = await window.pantry.pickImages()
  if (!paths) return
  for (const path of paths) await chatStore.sendImagePath(path)
}

interface ClipboardImagePayload {
  bytes: ArrayBuffer
  ext: string
}

function imageExtFromMime(type: string): string {
  if (type === 'image/jpeg') return '.jpg'
  if (type === 'image/webp') return '.webp'
  if (type === 'image/gif') return '.gif'
  return '.png'
}

async function readClipboardImageItem(data: DataTransfer): Promise<ClipboardImagePayload | null> {
  for (const item of Array.from(data.items)) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    return { bytes: await file.arrayBuffer(), ext: imageExtFromMime(item.type) }
  }
  return null
}

function parseTableRows(text: string): string[][] {
  return normalizeClipboardText(text)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
}

async function renderTableTextImageBytes(text: string): Promise<ArrayBuffer | null> {
  const rows = parseTableRows(text)
  if (rows.length === 0) return null
  const colCount = Math.max(...rows.map((row) => row.length))
  if (colCount === 0) return null

  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')
  if (!measureCtx) return null
  measureCtx.font =
    '14px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
  const widths = Array.from({ length: colCount }, (_, col) => {
    const measured = rows.reduce((max, row) => {
      const text = row[col] ?? ''
      return Math.max(max, Math.ceil(measureCtx.measureText(text).width))
    }, 0)
    return Math.max(
      TABLE_RENDER_MIN_COL_WIDTH,
      Math.min(TABLE_RENDER_MAX_COL_WIDTH, measured + TABLE_RENDER_PAD_X * 2)
    )
  })
  const width = widths.reduce((sum, value) => sum + value, 0) + 1
  const height = rows.length * TABLE_RENDER_ROW_HEIGHT + 1
  if (width <= 1 || height <= 1 || width > 12000 || height > 12000) return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#D8DED9'
  ctx.lineWidth = 1
  ctx.font = measureCtx.font
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#1F2A24'

  let y = 0
  for (const row of rows) {
    let x = 0
    for (let col = 0; col < colCount; col++) {
      const cellWidth = widths[col]
      ctx.strokeRect(x + 0.5, y + 0.5, cellWidth, TABLE_RENDER_ROW_HEIGHT)
      const text = row[col] ?? ''
      ctx.save()
      ctx.beginPath()
      ctx.rect(x + TABLE_RENDER_PAD_X, y + 1, cellWidth - TABLE_RENDER_PAD_X * 2, TABLE_RENDER_ROW_HEIGHT - 2)
      ctx.clip()
      ctx.fillText(text, x + TABLE_RENDER_PAD_X, y + TABLE_RENDER_ROW_HEIGHT / 2 + 0.5)
      ctx.restore()
      x += cellWidth
    }
    y += TABLE_RENDER_ROW_HEIGHT
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null)
        return
      }
      blob.arrayBuffer().then(resolve, () => resolve(null))
    }, 'image/png')
  })
}

function clearTablePasteHint(): void {
  tablePasteHint.value = null
  tablePastePayload = null
  if (tablePasteHintTimer) {
    clearTimeout(tablePasteHintTimer)
    tablePasteHintTimer = null
  }
}

/**
 * 表格粘贴只插入原文并给出「发送为图片」入口（决议 #270）。
 * 旧行为是命中即直接发图片：没有预览也没有逃生口，一次误判等于误发消息（Issue #19）。
 */
async function prepareTablePaste(data: DataTransfer, meta: ClipboardTableText): Promise<void> {
  const plainText = normalizeClipboardText(data.getData('text/plain'))
  const rawText = plainText.includes('\t') ? plainText : meta.tableText
  // DataTransfer 出了本次事件即失效，剪贴板现成图片项必须此刻取走
  const imageItem = await readClipboardImageItem(data)
  const start = insertTextAtCursor(rawText)
  tablePastePayload = {
    rawText,
    meta,
    imageBytes: imageItem?.bytes ?? null,
    imageExt: imageItem?.ext ?? '.png'
  }
  tablePasteHint.value = { start, text: rawText, draft: draft.value, oversize: overLimit.value }
  if (tablePasteHintTimer) clearTimeout(tablePasteHintTimer)
  // 超限草稿本来就发不出去，提示条再自动消失就等于把唯一出路也关掉
  tablePasteHintTimer = overLimit.value
    ? null
    : setTimeout(() => {
        tablePasteHintTimer = null
        clearTablePasteHint()
      }, TABLE_PASTE_HINT_MS)
}

async function sendTablePasteImage(): Promise<void> {
  const hint = tablePasteHint.value
  const payload = tablePastePayload
  if (!hint || !payload || !canSendMedia.value) return
  const bytes = payload.imageBytes ?? (await renderTableTextImageBytes(payload.rawText))
  if (!bytes) {
    // 渲染失败就只收起提示条，文本仍留在草稿里，不丢内容
    clearTablePasteHint()
    return
  }
  draft.value = draftWithoutTablePaste(hint)
  clearTablePasteHint()
  void nextTick(focusInput)
  await chatStore.sendImageBytes(`粘贴表格${payload.imageExt}`, bytes, payload.meta)
}

/** Ctrl+V 粘贴：复制的文件按路径发（保留文件名/类型），截图位图按 bytes 发（F-MSG-3 / 决议 #76） */
async function onPaste(event: ClipboardEvent): Promise<void> {
  if (!canSendMedia.value) return
  const data = event.clipboardData
  // paste 已派发即由本链路独占（决议 #207）：必须在任何 await 之前同步 mark 并清 IPC 定时器，
  // 否则大截图 arrayBuffer 间隙里兜底会再发一张（UOS/Wayland 慢机双发根因）。
  markClipboardPasteHandled()
  // 1) 从文件管理器复制的真实文件：Electron 为剪贴板 File 注入 path（与拖拽同机制）
  const paths: string[] = []
  if (data) {
    for (const file of Array.from(data.files)) {
      const p = (file as File & { path?: string }).path
      if (p) paths.push(p)
    }
    if (paths.length > 0) {
      event.preventDefault()
      const granted = await grantLocalFilePaths(paths)
      if (granted.length === 1 && isImagePath(granted[0])) await chatStore.sendImagePath(granted[0])
      else if (granted.length > 0) await chatStore.sendFilePaths(granted)
      return
    }
    const tableText = readClipboardTableText(data)
    if (tableText) {
      event.preventDefault()
      await prepareTablePaste(data, tableText)
      return
    }
    // 复制网页 / 富文本 emoji 时，剪贴板常同时带 text/plain 和 image/png；文本交给 textarea 原生粘贴。
    if (hasClipboardText(data)) {
      return
    }
    // 2) 截图位图（无对应文件路径）：直接按图片 bytes 发送
    const imageItem = await readClipboardImageItem(data)
    if (imageItem) {
      event.preventDefault()
      await chatStore.sendImageBytes(`粘贴图片${imageItem.ext}`, imageItem.bytes)
      return
    }
  }
  // clipboardData 无图时显式走原生剪贴板（#138）；与 IPC 调度互斥，不双发
  await sendClipboardImageFallback(event)
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  if (canSendMedia.value) dragging.value = true
}

function onDragLeave(event: DragEvent): void {
  const current = event.currentTarget
  const related = event.relatedTarget
  if (current instanceof Node && related instanceof Node && current.contains(related)) return
  dragging.value = false
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragging.value = false
  if (!canSendMedia.value || !event.dataTransfer) return
  const paths: string[] = []
  for (const file of Array.from(event.dataTransfer.files)) {
    const p = (file as File & { path?: string }).path
    if (p) paths.push(p)
  }
  if (paths.length === 0) return
  const granted = await grantLocalFilePaths(paths)
  if (granted.length === 0) return
  // 单张图片拖入 → 按图片消息发；其余按文件
  if (granted.length === 1 && isImagePath(granted[0])) {
    await chatStore.sendImagePath(granted[0])
  } else {
    await chatStore.sendFilePaths(granted)
  }
}
</script>

<template>
  <div
    class="chat"
    @click="msgMenu = null"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <ForwardDialog v-if="forwardMsg" :msg="forwardMsg" @close="forwardMsg = null" />
    <div
      v-if="showHistorySearch"
      class="history-overlay"
      @mousedown.self="closeHistorySearch"
      @keydown.esc.stop="closeHistorySearch"
    >
      <section
        class="history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-search-title"
        @mousedown.stop
      >
        <header class="history-dialog-head">
          <span class="history-title-block">
            <span id="history-search-title" class="history-title">搜索聊天记录</span>
            <span class="history-subtitle">{{ peerName }}</span>
          </span>
          <button type="button" class="history-close" aria-label="关闭搜索" @click="closeHistorySearch">
            <PantryIcon name="x" :size="16" />
          </button>
        </header>
        <div class="history-dialog-body">
          <aside class="history-sidebar">
            <label class="history-field">
              <span>关键词</span>
              <input
                ref="historySearchInput"
                v-model="historyQuery"
                class="history-input"
                maxlength="128"
                placeholder="搜索当前会话"
              />
            </label>
            <div class="history-field">
              <span>类型</span>
              <div class="history-segments">
                <button
                  type="button"
                  :class="{ selected: historyKind === 'all' }"
                  @click="historyKind = 'all'"
                >
                  全部
                </button>
                <button
                  type="button"
                  :class="{ selected: historyKind === 'image' }"
                  @click="historyKind = 'image'"
                >
                  图片
                </button>
                <button
                  type="button"
                  :class="{ selected: historyKind === 'file' }"
                  @click="historyKind = 'file'"
                >
                  文件
                </button>
              </div>
            </div>
            <div class="history-field">
              <span class="history-field-head">
                <span>日期</span>
                <button
                  v-if="historyFrom || historyTo"
                  type="button"
                  class="history-date-clear"
                  @click="clearHistoryDateRange"
                >
                  清除
                </button>
              </span>
              <span class="history-range-label">{{ historyDateRangeLabel }}</span>
              <div class="history-calendar">
                <div class="history-calendar-head">
                  <button type="button" aria-label="上个月" @click="moveHistoryMonth(-1)">
                    <PantryIcon name="chevron-left" :size="14" />
                  </button>
                  <span>{{ historyCalendarTitle }}</span>
                  <button type="button" aria-label="下个月" @click="moveHistoryMonth(1)">
                    <PantryIcon name="chevron-right" :size="14" />
                  </button>
                </div>
                <div class="history-weekdays">
                  <span v-for="day in HISTORY_WEEKDAYS" :key="day">{{ day }}</span>
                </div>
                <div class="history-calendar-grid">
                  <button
                    v-for="day in historyCalendarDays"
                    :key="day.key"
                    type="button"
                    class="history-day"
                    :class="{
                      out: !day.inMonth,
                      today: day.isToday,
                      'in-range': day.inRange,
                      'range-edge': day.isStart || day.isEnd
                    }"
                    @click="pickHistoryDate(day.key)"
                  >
                    {{ day.label }}
                  </button>
                </div>
              </div>
            </div>
            <button type="button" class="history-clear" @click="clearHistorySearch">清空筛选</button>
          </aside>
          <main class="history-results-panel">
            <div class="history-results-head">
              <span>结果</span>
              <span>{{ historyResultMeta }}</span>
            </div>
            <div class="history-results">
              <div v-if="historySearching" class="history-empty">搜索中...</div>
              <div v-else-if="historyHits.length === 0" class="history-empty">没有找到相关记录</div>
              <template v-else>
                <button
                  v-for="hit in historyHits"
                  :key="hit.msgId"
                  type="button"
                  class="history-hit"
                  :class="`history-hit-${hit.kind}`"
                  @click="onHistoryHitClick(hit)"
                  @dblclick="onHistoryHitDblClick(hit)"
                >
                  <span v-if="hit.kind !== 'text'" class="history-hit-media">
                    <img
                      v-if="historyImageTransferId(hit)"
                      v-cached-image="{ transferId: historyImageTransferId(hit) }"
                      class="history-thumb"
                      alt="[图片]"
                      loading="lazy"
                      decoding="async"
                      @error="markHistoryImageBroken(hit, $event)"
                    />
                    <span v-else class="history-kind-icon">
                      <PantryIcon :name="historyIcon(hit)" :size="20" />
                    </span>
                  </span>
                  <span class="history-hit-copy">
                    <span v-if="hit.kind === 'file'" class="history-hit-title">{{ hit.title }}</span>
                    <span v-else-if="hit.kind === 'text'" class="history-hit-snippet">
                      <template
                        v-for="(seg, segIdx) in splitEmojiText(hit.snippet)"
                        :key="segIdx"
                      >
                        <CompatEmoji v-if="seg.emoji" :emoji="seg.text" />
                        <span v-else>{{ seg.text }}</span>
                      </template>
                    </span>
                    <span class="history-hit-meta">{{ historySecondary(hit) }}</span>
                  </span>
                </button>
              </template>
            </div>
          </main>
        </div>
      </section>
    </div>
    <div v-if="dragging" class="drop-mask">松手发送给 {{ peerName }}</div>
    <header class="head">
      <div v-if="!isGroup && peer" ref="peerProfileScope" class="peer-profile-scope">
        <button
          class="title-button"
          :class="{ active: showPeerProfile }"
          type="button"
          aria-label="查看对方资料"
          @click.stop="togglePeerProfile"
        >
          <AvatarMark
            class="head-avatar"
            :avatar="peer.avatar"
            :avatar-hash="peer.avatarHash"
            :name="peerName"
            :presence="peerOnline ? 'online' : 'offline'"
          />
          <span class="title-text">
            <span class="title">{{ peerName }}</span>
            <span class="subtitle">
              <span class="state-word" :class="{ on: peerOnline }">{{
                peerOnline ? '在线' : '离线'
              }}</span>
              <template v-if="peerIp"> · {{ peerIp }}</template>
            </span>
          </span>
        </button>
        <section
          v-if="showPeerProfile"
          class="peer-profile-popover"
          role="dialog"
          aria-label="对方详细信息"
          @click.stop
          @keydown.esc.stop="closePeerProfile"
        >
          <header class="peer-profile-head">
            <AvatarMark
              class="profile-avatar"
              :avatar="peer.avatar"
              :avatar-hash="peer.avatarHash"
              :name="peer.remark || peer.nick"
              :offline="!peer.online"
            />
            <span class="profile-title">
              <strong>{{ peer.remark || peer.nick }}</strong>
              <small v-if="peer.remark">昵称：{{ peer.nick }}</small>
              <span class="profile-status" :class="{ on: peer.online }">
                <span class="profile-status-dot"></span>
                {{ peer.online ? '在线' : '离线' }}
              </span>
            </span>
          </header>
          <div class="profile-rows">
            <div class="profile-row"><span>组织</span><strong>{{ peerOrgPath(peer) }}</strong></div>
            <div class="profile-row"><span>IP</span><strong>{{ peer.ip || '未知' }}</strong></div>
            <div class="profile-row"><span>主机</span><strong>{{ peer.host || '未知' }}</strong></div>
            <div class="profile-row">
              <span>平台</span><strong>{{ peerPlatformLabel(peer.platform) }}</strong>
            </div>
            <div class="profile-row">
              <span>最近</span><strong>{{ peerLastSeenLabel(peer) }}</strong>
            </div>
          </div>
          <label class="profile-remark">
            <span>备注</span>
            <input
              v-model="peerProfileRemark"
              maxlength="32"
              placeholder="仅自己可见"
              @keydown.enter="savePeerProfileRemark"
            />
          </label>
          <div class="profile-actions">
            <span class="profile-save-state">{{ peerProfileSaved ? '已保存' : '' }}</span>
            <button
              type="button"
              class="profile-save"
              :disabled="peerProfileSaving"
              @click="savePeerProfileRemark"
            >
              {{ peerProfileSaving ? '保存中' : '保存备注' }}
            </button>
          </div>
        </section>
      </div>
      <template v-else>
        <GroupAvatar
          class="group-head-avatar"
          :avatar-hash="group?.avatarHash"
          :icon-size="20"
        />
        <span class="title-block">
          <span class="title">{{ peerName }}</span>
        </span>
      </template>
      <span v-if="isGroup" class="state">{{ group?.members.length ?? 0 }} 人</span>
      <span class="head-spacer"></span>
      <button
        v-if="!isGroup"
        class="head-btn"
        :class="{ disabled: !!cabinetDisabledReason }"
        :title="cabinetTitle"
        :aria-disabled="!!cabinetDisabledReason"
        @click="toggleCabinet"
      >
        <PantryIcon name="folder" :size="17" />
      </button>
      <button v-if="isGroup" class="head-btn" title="成员" @click="showMembers = !showMembers">
        <PantryIcon name="users" :size="17" />
      </button>
    </header>

    <!-- 对方的文件柜（决议 #273）：与群信息面板同一形态，覆盖右侧一整列 -->
    <FileCabinetPanel
      v-if="!isGroup && showCabinet && peer"
      :peer-id="peer.nodeId"
      :peer-name="peerName"
      @close="showCabinet = false"
    />

    <!-- 群信息面板（决议 #67）：绝对定位覆盖右侧一整列，不挤压消息 -->
    <GroupPanel
      v-if="isGroup && showMembers && group"
      :group="group"
      :self-id="chatStore.selfId"
      @close="showMembers = false"
    />

    <div class="body-wrap">
      <div ref="scrollArea" class="msgs" @scroll="onScroll">
      <div ref="msgsContent" class="msgs-content">
      <div v-if="loadingEarlier" class="sep">加载更早的消息…</div>
      <MessageRow
        v-for="(msg, i) in chatStore.activeMessages"
        :key="msg.id"
        :msg="msg"
        :prev-ts="i === 0 ? null : chatStore.activeMessages[i - 1].ts"
        :is-group-conv="isGroup"
        :sender-name="senderName(msg)"
        :sender-avatar="senderAvatar(msg)"
        :sender-avatar-hash="senderAvatarHash(msg)"
        :highlighted="msg.id === chatStore.highlightId"
        :can-send-pk="canSendPk"
        :pk-disabled-reason="pkDisabledReason"
        :recall-visible="isRecallableKind(msg)"
        :recall-disabled-reason="mediaRecallDisabledReason(msg)"
        @contextmenu="openMessageMenu"
        @forward="forwardMsg = $event"
        @recall="recallMessage"
        @reply-to="jumpToReplyTarget"
        @participate-pk="sendPk"
        @resend="chatStore.resend"
      />
      </div>
      </div>
      <Transition name="jump-latest">
        <button
          v-if="chatStore.viewingHistory || farFromBottom"
          class="jump-latest"
          type="button"
          title="回到最新消息"
          @click="jumpToLatest"
        >
          <PantryIcon name="chevron-down" :size="20" />
        </button>
      </Transition>
    </div>

    <div
      v-if="msgMenu"
      class="msg-menu"
      :style="{ left: `${msgMenu.x}px`, top: `${msgMenu.y}px` }"
      @click.stop
    >
      <button v-if="canCopyMessage(msgMenu.msg)" @click="copySelectedMessage">复制</button>
      <button v-if="canForwardMessage(msgMenu.msg)" @click="forwardSelectedMessage">转发</button>
      <button v-if="canQuoteMessage(msgMenu.msg) && isGroup && !msgMenu.msg.isMine" @click="quoteSelectedMessage">引用回复</button>
      <button
        v-if="isRecallableKind(msgMenu.msg)"
        class="danger recall-action"
        :disabled="recallButtonDisabled"
        @click="recallSelectedMessage"
      >
        <span>撤回</span>
        <span class="recall-action-meta" :class="{ 'is-urgent': recallButtonUrgent }">
          {{ recallButtonMeta }}
        </span>
      </button>
    </div>

    <footer class="input-area">
      <!-- 输入框高度拖拽手柄（决议 #127）：压在消息/输入分隔线上，上下拖调高 -->
      <div
        class="input-resizer"
        role="separator"
        aria-label="拖动调整输入框高度"
        title="拖动调整输入框高度"
        @pointerdown="startInputResize"
      >
        <span class="input-resizer-grip"></span>
      </div>
      <div class="toolbar">
        <span ref="emojiScope" class="emoji-scope">
          <EmojiPanel
            v-if="showEmoji"
            :sticker-enabled="canSendMedia"
            @select="insertEmoji"
            @sticker="sendStickerById"
          />
          <span class="tool-wrap" data-tip="表情">
            <button
              class="tool"
              type="button"
              aria-label="表情"
              :disabled="!canSend"
              @click="showEmoji = !showEmoji"
            >
              <PantryIcon name="smile" :size="18" />
            </button>
          </span>
        </span>
        <span ref="pkScope" class="pk-scope">
          <div v-if="showPk" class="pk-popover">
            <button
              type="button"
              :disabled="!canSendPk"
              :title="canSendPk ? '猜拳' : pkDisabledReason"
              @click="sendPk('rps')"
            >
              <span class="pk-pop-window"><PantryIcon name="pk-rps" :size="22" /></span>
              <span>猜拳</span>
            </button>
            <button
              type="button"
              :disabled="!canSendPk"
              :title="canSendPk ? '骰子' : pkDisabledReason"
              @click="sendPk('dice')"
            >
              <span class="pk-pop-window"><PantryIcon name="pk-dice" :size="22" /></span>
              <span>骰子</span>
            </button>
          </div>
          <span class="tool-wrap" :data-tip="pkToolTip">
            <button
              class="tool"
              :class="{ active: showPk }"
              type="button"
              aria-label="PK"
              aria-haspopup="menu"
              :aria-expanded="showPk ? 'true' : 'false'"
              @click="showPk = !showPk"
            >
              <PantryIcon name="pk" :size="18" />
            </button>
          </span>
        </span>
        <span v-if="!isGroup" class="tool-wrap" :data-tip="nudgeToolTip">
          <button
            class="tool"
            type="button"
            aria-label="窗口震动"
            :disabled="!canSendNudge"
            @click="sendNudge"
          >
            <PantryIcon name="nudge" :size="18" />
          </button>
        </span>
        <span class="tool-wrap" data-tip="截图">
          <button
            class="tool"
            type="button"
            aria-label="截图（Ctrl/Cmd+Alt+A）"
            @click="window_startCapture"
          >
            <PantryIcon name="scissors" :size="18" />
          </button>
        </span>
        <span class="tool-wrap" data-tip="发送图片">
          <button
            class="tool"
            type="button"
            aria-label="发送图片"
            :disabled="!canSendMedia"
            @click="sendImage"
          >
            <PantryIcon name="image" :size="18" />
          </button>
        </span>
        <span class="tool-wrap" data-tip="发送文件">
          <button
            class="tool"
            type="button"
            aria-label="发送文件"
            :disabled="!canSendMedia"
            @click="sendFiles(false)"
          >
            <PantryIcon name="file" :size="18" />
          </button>
        </span>
        <span class="tool-wrap" data-tip="发送文件夹">
          <button
            class="tool"
            type="button"
            aria-label="发送文件夹"
            :disabled="!canSendMedia"
            @click="sendFiles(true)"
          >
            <PantryIcon name="folder" :size="18" />
          </button>
        </span>
        <span v-if="isGroup && canSend && onlineGroupRecipientCount === 0" class="tool-hint">
          群成员离线，无法发送图片/文件
        </span>
        <span v-else-if="isGroup" class="tool-hint">仅在线群成员可接收图片/文件</span>
        <span v-else-if="!peerOnline" class="tool-hint">对方离线，无法发送图片/文件</span>
        <span v-if="nudgeFeedback" class="nudge-feedback" :class="nudgeFeedback.kind">
          {{ nudgeFeedback.text }}
        </span>
        <span class="toolbar-spacer"></span>
        <span class="history-search-scope">
          <span class="tool-wrap" data-tip="历史搜索">
            <button
              class="tool"
              :class="{ active: showHistorySearch }"
              type="button"
              aria-label="历史搜索"
              @click="toggleHistorySearch"
            >
              <PantryIcon name="search" :size="18" />
            </button>
          </span>
        </span>
      </div>
      <div v-if="showMentionPicker" class="mention-picker">
        <button
          v-for="id in mentionMembers"
          :key="id"
          type="button"
          @mousedown.prevent="insertMention(id)"
        >
          {{ peersStore.nameOf(id) }}
        </button>
      </div>
      <div v-if="tablePasteHint" class="table-paste-hint" role="status" aria-live="polite">
        <PantryIcon name="table" :size="16" />
        <span class="table-paste-hint-text">{{ tablePasteHintLabel }}</span>
        <button
          class="table-paste-hint-action"
          type="button"
          :disabled="!canSendMedia"
          @click="sendTablePasteImage"
        >
          发送为图片
        </button>
        <button
          class="table-paste-hint-close"
          type="button"
          aria-label="忽略"
          @click="clearTablePasteHint"
        >
          <PantryIcon name="x" :size="14" />
        </button>
      </div>
      <div v-if="replyToId" class="reply-preview">
        <span class="reply-preview-label">引用回复</span>
        <span class="reply-preview-sender">{{ replyToMeta?.senderName ?? '原消息不可用' }}</span>
        <span class="reply-preview-text">{{ replyToMeta?.text ?? '' }}</span>
        <button
          class="reply-preview-close"
          type="button"
          aria-label="取消引用"
          @click="replyToId = null"
        >
          <PantryIcon name="x" :size="12" />
        </button>
      </div>
      <div
        class="input-shell"
        :class="{ 'has-mirror': draftUsesEmojiMirror }"
        :style="{ height: `${inputShellHeight}px` }"
      >
        <div
          v-if="draftUsesEmojiMirror"
          class="input-mirror"
          aria-hidden="true"
        >
          <div
            class="input-mirror-content"
            :style="{ transform: `translateY(-${inputScrollTop}px)` }"
          >
            <template v-for="(part, index) in draftMirrorParts" :key="index">
              <span
                v-if="part.emoji && part.width > 0 && part.src"
                class="mirror-emoji"
                :style="{ width: `${part.width}px` }"
              >
                <img :src="part.src" alt="" aria-hidden="true" draggable="false" />
              </span>
              <span v-else>{{ part.text }}</span>
            </template>
            <span v-if="draft.endsWith('\n')">&nbsp;</span>
          </div>
        </div>
        <Win7ChatEditor
          v-if="props.win7ImeCompat"
          ref="win7EditorEl"
          :model-value="draft"
          :disabled="!canSend"
          :placeholder="inputPlaceholder"
          @update:model-value="onWin7EditorValue"
          @keydown="onKeydown"
          @paste="onPaste"
          @scroll="syncInputMirrorScroll"
          @compositionstart="onInputCompositionStart"
          @compositionend="onInputCompositionEnd"
        />
        <textarea
          v-else
          ref="inputEl"
          v-model="draft"
          class="input"
          :class="{ 'mirror-active': draftUsesEmojiMirror }"
          :disabled="!canSend"
          :placeholder="inputPlaceholder"
          @keydown="onKeydown"
          @paste="onPaste"
          @scroll="syncInputMirrorScroll"
          @compositionstart="onInputCompositionStart"
          @compositionend="onInputCompositionEnd"
        ></textarea>
      </div>
      <div class="input-bar">
        <span v-if="draftBytes > 600" class="counter" :class="{ over: overLimit }">
          {{ draftBytes }} / {{ TEXT_TCP_LIMIT }} 字节{{
            overLimit ? '（文本过长）' : overUdpLimit ? '（将通过 TCP 发送）' : ''
          }}
        </span>
        <button class="send" :disabled="!draft.trim() || overLimit || !canSend" @click="send">
          发送
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-chat);
  position: relative;
  overflow: hidden;
  isolation: isolate;
}
.drop-mask {
  position: absolute;
  inset: 0;
  background: rgba(61, 139, 107, 0.12);
  border: 2px dashed var(--primary);
  display: grid;
  place-items: center;
  font-size: 15px;
  color: var(--primary);
  z-index: 5;
  pointer-events: none;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-bottom: 6px;
  position: relative;
}
.toolbar-spacer {
  flex: 1;
  min-width: 8px;
}
.emoji-scope {
  display: inline-grid;
  place-items: center;
}
.pk-scope {
  position: relative;
  display: inline-grid;
  place-items: center;
}
.pk-popover {
  position: absolute;
  /* 左对齐按钮向右展开：PK 按钮太靠近聊天面板左缘，居中弹出会让浮层左侧溢出 .chat 的 overflow:hidden 被裁切（决议 #144） */
  left: 0;
  bottom: calc(100% + 8px);
  display: grid;
  grid-template-columns: repeat(2, 74px);
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-float);
  backdrop-filter: blur(18px) saturate(135%);
  -webkit-backdrop-filter: blur(18px) saturate(135%);
  z-index: 28;
}
.pk-popover button {
  padding: 8px 6px 7px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text-1);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms ease, transform 100ms ease-out;
}
/* 玩法卡的图标小窗：与 PkBubble 开奖窗同底（--bg-chat）、同茶青语义，让浮层与气泡视觉呼应 */
.pk-pop-window {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--bg-chat);
  border: 1px solid var(--line);
  color: var(--primary);
  transition: border-color 140ms ease, background 140ms ease;
}
.pk-popover button:hover:not(:disabled) {
  background: var(--surface-hover);
}
.pk-popover button:hover:not(:disabled) .pk-pop-window {
  border-color: var(--primary);
  background: var(--bg-window);
}
.pk-popover button:active:not(:disabled) {
  transform: scale(0.97);
}
.pk-popover button:focus-visible {
  outline: 2px solid rgba(61, 139, 107, 0.35);
  outline-offset: 2px;
}
.pk-popover button:disabled {
  opacity: 0.4;
  cursor: default;
}
.history-search-scope {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
}
.mention-picker {
  position: absolute;
  left: 12px;
  bottom: 104px;
  width: 220px;
  max-height: 180px;
  overflow-y: auto;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--highlight-edge), var(--shadow-float);
  padding: 5px;
  z-index: 4;
}
.mention-picker button {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
}
.mention-picker button:hover {
  background: var(--surface-hover);
}
/* 表格粘贴提示条（决议 #270）：粘贴只插入文本，这条给出"改发图片"的入口，可随时忽略 */
.table-paste-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  margin: 0 0 6px;
  padding: 0 6px 0 10px;
  background: var(--bg-list);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text-2);
  animation: table-paste-hint-in 120ms ease-out;
}
.table-paste-hint-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.table-paste-hint-action {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.table-paste-hint-action:hover:not(:disabled) {
  background: var(--primary-weak);
}
.table-paste-hint-action:disabled {
  color: var(--text-3);
  cursor: default;
}
.table-paste-hint-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: 6px;
  cursor: pointer;
}
.table-paste-hint-close:hover {
  background: var(--surface-hover);
  color: var(--text-2);
}
@keyframes table-paste-hint-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .table-paste-hint {
    animation: none;
  }
}
.reply-preview {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin: 0 0 6px;
  padding: 0 6px 0 10px;
  background: rgba(61, 139, 107, 0.08);
  border: 1px solid rgba(61, 139, 107, 0.22);
  border-radius: 8px;
  color: var(--text-2);
  font-size: 12px;
  overflow: hidden;
}
.reply-preview-label {
  flex: 0 0 auto;
  color: var(--primary);
  font-weight: 600;
  font-size: 11px;
  white-space: nowrap;
}
.reply-preview-sender {
  flex: 0 0 auto;
  color: var(--primary);
  font-weight: 600;
  white-space: nowrap;
}
.reply-preview-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}
.reply-preview-close {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: 4px;
  display: grid;
  place-items: center;
  cursor: pointer;
  margin-left: 2px;
}
.reply-preview-close:hover {
  background: var(--line);
  color: var(--text-1);
}
/* "回到最新"悬浮圆按钮（决议 #134）：贴消息区右下角，白底 + 茶青箭头 + 柔和阴影 */
.jump-latest {
  position: absolute;
  right: 16px;
  bottom: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--material-strong);
  color: var(--primary);
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: var(--highlight-edge), var(--shadow-soft);
  z-index: 6;
  transition: box-shadow 140ms ease, border-color 140ms ease;
}
.jump-latest:active {
  background: var(--surface-pressed);
  transform: scale(0.96);
}
/* 进出场：淡入 + 自下方 8px 上移，缓动复用项目既有曲线 */
.jump-latest-enter-active,
.jump-latest-leave-active {
  transition: opacity 160ms ease, transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.jump-latest-enter-from,
.jump-latest-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
@media (prefers-reduced-motion: reduce) {
  .jump-latest-enter-active,
  .jump-latest-leave-active {
    transition: opacity 120ms ease;
  }
  .jump-latest-enter-from,
  .jump-latest-leave-to {
    transform: none;
  }
}
/* hover 只做高亮：茶青描边 + 阴影略增，保持白底，不加半透明、不浮动（决议 #135） */
.jump-latest:hover {
  background: var(--material-strong);
  border-color: var(--primary);
  box-shadow: var(--highlight-edge), 0 8px 24px rgba(24, 50, 37, 0.14);
  opacity: 1;
}
.tool {
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  width: 32px;
  height: 30px;
  padding: 0;
  border-radius: 9px;
  display: grid;
  place-items: center;
  position: relative;
  transition:
    color 150ms ease,
    background 150ms ease,
    transform 90ms ease-out;
}
.tool-wrap {
  position: relative;
  display: inline-grid;
  place-items: center;
}
.tool-wrap::before,
.tool-wrap::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 7px);
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
  z-index: 30;
}
.tool-wrap::before {
  content: '';
  bottom: calc(100% + 3px);
  border: 4px solid transparent;
  border-top-color: rgba(35, 35, 35, 0.94);
}
.tool-wrap::after {
  content: attr(data-tip);
  min-width: max-content;
  max-width: 120px;
  padding: 4px 7px;
  border-radius: 7px;
  background: rgba(35, 35, 35, 0.94);
  color: #fff;
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  box-shadow: var(--shadow-soft);
}
.tool-wrap:hover::before,
.tool-wrap:hover::after,
.tool-wrap:focus-within::before,
.tool-wrap:focus-within::after {
  opacity: 1;
  transform: translate(-50%, 0);
  transition-delay: 0.45s;
}
.tool:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-1);
}
.tool:active:not(:disabled) {
  transform: scale(0.96);
}
.tool:focus-visible {
  outline: 2px solid rgba(61, 139, 107, 0.35);
  outline-offset: 1px;
}
.tool.active {
  color: var(--primary);
  background: var(--surface-selected);
  box-shadow: var(--highlight-edge);
}
.tool:disabled {
  opacity: 0.35;
  cursor: default;
}
.tool-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-3);
}
.nudge-feedback {
  min-width: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--primary);
}
.nudge-feedback.warn {
  color: var(--danger);
}
.history-overlay {
  position: absolute;
  inset: 0;
  z-index: 18;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgba(0, 0, 0, 0.16);
}
.history-dialog {
  width: min(680px, 100%);
  height: min(500px, 100%);
  /* 不再用 min-height 兜底，矮窗（Win7 VM）下会撑破遮罩 padding 导致末行被裁（决议 #74） */
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.history-dialog-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--line);
}
.history-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.history-title {
  color: var(--text-1);
  font-size: 15px;
  font-weight: 600;
}
.history-subtitle {
  color: var(--text-3);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-close {
  flex: 0 0 auto;
  width: 30px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 4px;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.history-close:hover {
  background: var(--line);
}
.history-dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 218px minmax(0, 1fr);
}
.history-sidebar {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  background: var(--bg-list);
  border-right: 1px solid var(--line);
}
.history-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: var(--text-3);
  font-size: 12px;
}
.history-field-head {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.history-date-clear {
  border: none;
  background: transparent;
  color: var(--text-3);
  padding: 0 2px;
  font-size: 12px;
  cursor: pointer;
}
.history-date-clear:hover {
  color: var(--primary);
}
.history-input {
  width: 100%;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 4px;
  outline: none;
  padding: 0 10px;
  background: var(--bg-window);
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
}
.history-input:focus {
  border-color: rgba(61, 139, 107, 0.55);
  background: var(--bg-window);
}
.history-segments {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-window);
}
.history-segments button {
  height: 32px;
  border: none;
  border-right: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.history-segments button:last-child {
  border-right: none;
}
.history-segments button.selected {
  color: var(--primary);
  background: rgba(61, 139, 107, 0.1);
}
.history-clear {
  width: 100%;
  height: 32px;
  margin-top: auto;
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-2);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.history-clear:hover {
  color: var(--primary);
  border-color: rgba(61, 139, 107, 0.35);
}
.history-range-label {
  width: 100%;
  height: 28px;
  display: flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-window);
  color: var(--text-1);
  font-size: 12px;
  padding: 0 8px;
}
.history-calendar {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-window);
  padding: 7px;
}
.history-calendar-head {
  height: 26px;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) 26px;
  align-items: center;
  gap: 4px;
}
.history-calendar-head span {
  text-align: center;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
}
.history-calendar-head button {
  width: 26px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 4px;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.history-calendar-head button:hover {
  background: var(--line);
  color: var(--primary);
}
.history-weekdays,
.history-calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.history-weekdays {
  margin: 5px 0 3px;
}
.history-weekdays span {
  height: 18px;
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: 11px;
}
.history-calendar-grid {
  gap: 2px;
}
.history-day {
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.history-day.out {
  color: var(--text-3);
  opacity: 0.55;
}
.history-day.today:not(.range-edge) {
  box-shadow: inset 0 0 0 1px rgba(61, 139, 107, 0.38);
  color: var(--primary);
}
.history-day.in-range {
  background: rgba(61, 139, 107, 0.1);
  color: var(--primary);
}
.history-day.range-edge {
  background: var(--primary);
  color: #fff;
  opacity: 1;
}
.history-day:hover:not(.range-edge) {
  background: var(--line);
  color: var(--primary);
}
.history-results-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-window);
}
.history-results-head {
  flex: 0 0 auto;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
}
.history-results-head span:last-child {
  color: var(--text-3);
  font-size: 12px;
  font-weight: 400;
}
.history-results {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 末尾多留白：Win7/Chrome108 下 flex+overflow 容器最后一项易被裁（决议 #74） */
  padding: 8px 8px 16px;
}
.history-empty {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: 12px;
}
.history-hit {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-1);
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}
.history-hit-image {
  grid-template-columns: 72px minmax(0, 1fr);
  min-height: 88px;
}
/* 文本命中：去掉媒体列，摘要直接当主体（决议 #74） */
.history-hit-text {
  grid-template-columns: minmax(0, 1fr);
}
.history-hit + .history-hit {
  margin-top: 4px;
}
.history-hit:hover {
  background: var(--line);
}
.history-hit-media {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 6px;
  background: var(--bg-list);
  color: var(--text-2);
}
.history-hit-image .history-hit-media,
.history-thumb {
  width: 72px;
  height: 72px;
}
.history-thumb {
  display: block;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--bg-list);
}
.history-kind-icon {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
}
.history-hit-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.history-hit-title {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-hit-snippet {
  min-width: 0;
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.history-hit-meta {
  color: var(--text-3);
  font-size: 11px;
}
.head {
  /* 沉浸式（决议 #49）：头部背景直通窗口顶，内容压在 32px 拖拽带下方。
     这里不许设 no-drag —— no-drag 矩形会从系统 drag region 中挖洞，
     把聊天区顶部 32px 的拖拽带挖掉（Win7/mac 实测顶部无法拖窗）。 */
  height: 84px;
  flex: 0 0 84px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 32px 20px 0;
  background: var(--material-bar);
  border-bottom: 1px solid var(--line);
  box-shadow: var(--highlight-edge), 0 12px 30px rgba(24, 50, 37, 0.035);
  position: relative;
  z-index: 4;
}
.title {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title-block .title,
.title-button .title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-button .title {
  transition: color 150ms ease;
}
.peer-profile-scope {
  position: relative;
  min-width: 0;
  /* 容纳「头像 + 名字 / 在线·完整 IP」两行，避免 IP 被截断（决议 #88） */
  flex: 1 1 560px;
  max-width: 680px;
}
.title-button {
  min-width: 0;
  width: 100%;
  max-width: 100%;
  border: none;
  background: transparent;
  color: inherit;
  border-radius: 11px;
  padding: 5px 10px 5px 5px;
  margin-left: -4px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
}
.head-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex: 0 0 40px;
  color: #fff;
  font-size: 17px;
}
.group-head-avatar {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
}
.title-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title-button:hover .title,
.title-button.active .title {
  color: var(--primary);
}
.title-button:focus-visible {
  outline: 1px solid var(--primary);
  outline-offset: 2px;
}
.subtitle {
  font-size: 11px;
  line-height: 1.2;
  color: var(--text-3);
  min-width: 0;
  white-space: nowrap;
}
/* 顶部在线状态融入副标题（决议 #81）：在线茶绿、离线灰，不再用孤立的「● 在线」标签 */
.state-word {
  color: var(--text-3);
}
.state-word.on {
  color: var(--online);
}
.peer-profile-popover {
  position: absolute;
  left: 0;
  top: calc(100% + 9px);
  width: 360px;
  z-index: 22;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-float);
  backdrop-filter: blur(22px) saturate(140%);
  -webkit-backdrop-filter: blur(22px) saturate(140%);
}
.peer-profile-popover::before {
  content: '';
  position: absolute;
  left: 26px;
  top: -6px;
  width: 10px;
  height: 10px;
  background: var(--material-strong);
  border-left: 1px solid var(--line);
  border-top: 1px solid var(--line);
  transform: rotate(45deg);
}
.peer-profile-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.profile-avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 20px;
  flex: 0 0 46px;
}
.profile-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.profile-title strong {
  min-width: 0;
  color: var(--text-1);
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-title small {
  color: var(--text-3);
  font-size: 12px;
}
/* 在线状态与联系人资料页统一：对称状态点 + 文案的小药丸，不再用「● 在线」文本字形（决议 #122） */
.profile-status {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  margin-top: 3px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-list);
  color: var(--text-3);
  font-size: 12px;
  line-height: 1;
}
.profile-status.on {
  color: var(--online);
  background: rgba(43, 162, 69, 0.08);
  border-color: rgba(43, 162, 69, 0.18);
}
.profile-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--offline);
}
.profile-status.on .profile-status-dot {
  background: var(--online);
}
.profile-rows {
  padding: 10px 0 8px;
}
.profile-row {
  min-height: 26px;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.profile-row span {
  color: var(--text-3);
}
.profile-row strong {
  min-width: 0;
  color: var(--text-1);
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-remark {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  color: var(--text-3);
  font-size: 12px;
}
.profile-remark input {
  min-width: 0;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--material-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  padding: 0 9px;
  outline: none;
  user-select: text;
}
.profile-remark input:focus {
  border-color: rgba(61, 139, 107, 0.55);
  background: var(--bg-window);
}
.profile-actions {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 10px;
}
.profile-save-state {
  color: var(--online);
  font-size: 12px;
}
.profile-save {
  min-width: 76px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: transform 90ms ease-out, filter 150ms ease;
}
.profile-save:active:not(:disabled) {
  transform: scale(0.97);
}
.profile-save:disabled {
  opacity: 0.55;
  cursor: default;
}
.state {
  font-size: 12px;
  color: var(--text-3);
}
.state.on {
  color: var(--online);
}
.body-wrap {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.msgs {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 20px clamp(20px, 3vw, 42px) 24px;
}
.msgs-content {
  /* ResizeObserver 观察目标：跟随图片 / 文件卡片异步撑高贴底（决议 #133）；
     flow-root 让高度精确包含内容，消息流间距与无包裹时一致 */
  display: flow-root;
}
.head-spacer {
  flex: 1;
}
.head-btn {
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  width: 34px;
  height: 32px;
  padding: 0;
  border-radius: 9px;
  display: grid;
  place-items: center;
  transition:
    color 150ms ease,
    background 150ms ease,
    transform 90ms ease-out;
}
.head-btn:hover {
  background: var(--surface-hover);
  color: var(--text-1);
}
.head-btn.disabled {
  /* 灰显但保留 hover 提示，让用户能读到不可用的原因（决议 #17/#273） */
  color: var(--text-3);
  cursor: default;
}
.head-btn.disabled:hover {
  background: transparent;
  color: var(--text-3);
}
.head-btn.disabled:active {
  transform: none;
}
.head-btn:active {
  transform: scale(0.96);
}
.sep {
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  margin: 10px 0 6px;
}
.msg-menu {
  position: fixed;
  min-width: 128px;
  box-sizing: border-box;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--highlight-edge), var(--shadow-float);
  padding: 5px;
  backdrop-filter: blur(18px) saturate(135%);
  -webkit-backdrop-filter: blur(18px) saturate(135%);
  z-index: 20;
}
.msg-menu button {
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
  font-size: 13px;
  line-height: 1.25;
  white-space: nowrap;
  padding: 6px 12px;
  border-radius: 7px;
  cursor: pointer;
  transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}
.msg-menu button:hover {
  background: var(--surface-hover);
}
.msg-menu button.danger {
  color: var(--danger);
}
.msg-menu button:active:not(:disabled) {
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
.msg-menu button:disabled {
  color: var(--text-3);
  cursor: default;
}
.msg-menu button:disabled:hover {
  background: transparent;
}
.input-area {
  flex: 0 0 auto;
  margin: 0 14px 14px;
  padding: 9px 12px 10px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-soft);
  position: relative;
  z-index: 3;
}
/* 输入框高度拖拽手柄（决议 #127）：铺满顶部、压在消息/输入分隔线上；
   默认细灰 grip 提示可拖，hover 变深，ns-resize 光标 */
.input-resizer {
  height: 8px;
  margin: -9px -12px 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
}
.input-resizer-grip {
  width: 28px;
  height: 3px;
  border-radius: 2px;
  background: var(--line);
  transition: background 0.15s ease;
}
.input-resizer:hover .input-resizer-grip {
  background: var(--text-3);
}
.input-shell {
  position: relative;
  border-radius: 10px;
}
.input {
  position: relative;
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  resize: none;
  /* PantryEmojiBlank 在首位（决议 #56）：内置 emoji 恒占 1.3em 空白槽，
     文字不在其 cmap 内自动落到系统字体；镜像层必须保持同一字体栈 */
  font-family:
    'PantryEmojiBlank',
    'PingFang SC',
    'Microsoft YaHei',
    'Noto Sans CJK SC',
    sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: transparent;
  color: var(--text-1);
  /* 顶部留白（决议 #61）：Win7 微软雅黑 ascent 偏高，line-height 的顶部 half-leading
     不足，首行字形与 placeholder 顶部会被裁几像素；镜像层须用同一 padding 保持对齐 */
  padding: 5px 0 0;
  user-select: text;
}
.input.mirror-active {
  color: transparent;
  caret-color: var(--text-1);
}
.input.mirror-active::selection {
  color: transparent;
  background: rgba(61, 139, 107, 0.18);
}
.input-mirror {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  /* 必须与 .input 的 padding 完全一致，否则镜像 emoji 与光标错位（决议 #61） */
  padding: 5px 0 0;
  color: var(--text-1);
  font-family:
    'PantryEmojiBlank',
    'PingFang SC',
    'Microsoft YaHei',
    'Noto Sans CJK SC',
    sans-serif;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.input-mirror-content {
  min-height: 100%;
  padding: 0;
  will-change: transform;
}
/* emoji 占位槽：宽度由脚本按 textarea 字体逐字符测量，保证与底层文本逐一对齐；
   高度压在 1em 内不撑行高，图形绝对定位居中、允许少量视觉溢出 */
.mirror-emoji {
  position: relative;
  display: inline-block;
  height: 1em;
  vertical-align: -0.125em;
}
.mirror-emoji img {
  position: absolute;
  left: 50%;
  top: 50%;
  /* PantryEmojiBlank 生效时字符槽恒为 1.3em，图标恰好满槽（决议 #56）；
     字体加载失败时槽宽回落到系统字符宽，min() 让图标随槽缩小、对齐优先 */
  width: min(1.3em, 100%);
  height: auto;
  transform: translate(-50%, -52%);
  pointer-events: none;
}
.input-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 6px;
}
.counter {
  font-size: 11px;
  color: var(--text-3);
}
.counter.over {
  color: var(--danger);
}
.send {
  border: none;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  min-width: 72px;
  height: 32px;
  padding: 0 20px;
  border-radius: 9px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(44, 104, 78, 0.16);
  transition:
    filter 150ms ease,
    transform 90ms ease-out,
    box-shadow 150ms ease;
}
.send:hover:not(:disabled) {
  filter: brightness(1.04);
  box-shadow: 0 6px 16px rgba(44, 104, 78, 0.22);
}
.send:active:not(:disabled) {
  transform: scale(0.97);
}
.send:disabled {
  opacity: 0.4;
  cursor: default;
}
@media (prefers-reduced-motion: reduce) {
  .tool,
  .pk-popover button,
  .title-button .title,
  .head-btn,
  .profile-save,
  .send,
  .jump-latest {
    transition: none;
  }
  .tool:active:not(:disabled),
  .pk-popover button:active:not(:disabled),
  .head-btn:active,
  .profile-save:active:not(:disabled),
  .send:active:not(:disabled),
  .msg-menu button:active:not(:disabled),
  .jump-latest:active {
    transform: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .pk-popover,
  .peer-profile-popover,
  .msg-menu {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
</style>
