<script setup lang="ts">
import { tr } from '../utils/i18n'
import type { ScreenState, ScreenAvailability } from '../../../shared/remote-view'
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
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
import { filterMentionCandidates, detectMentionInsertion, hasMentionAllToken, matchesMentionAll, parseMentionQuery, stepMentionIndex } from '../utils/mention-picker'
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
import MessageRow from './MessageRow.vue'
import EmojiPanel from './EmojiPanel.vue'
import GroupPanel from './GroupPanel.vue'
import FileCabinetPanel from './FileCabinetPanel.vue'
import GroupAvatar from './GroupAvatar.vue'
import ForwardDialog from './ForwardDialog.vue'
import ScreenRequestDialog from './ScreenRequestDialog.vue'
import PantryIcon from './PantryIcon.vue'
import PendingAttachments from './PendingAttachments.vue'
import { usePendingAttachments, type PendingAttachment } from '../utils/pending-attachments'
import Win7ChatEditor from './Win7ChatEditor.vue'
import type {
  MessageView,
  PeerView,
  SettingsView,
  TransferView
} from '../../../shared/ipc'
import { IMAGE_FILE_EXTENSIONS } from '../../../shared/media'
import type { PkGame } from '../../../shared/pk'
import {
  CAPS,
  MENTION_ALL,
  NUDGE_MIN_INTERVAL_MS,
  RECALL_WINDOW_MS,
  TEXT_TCP_LIMIT,
  TEXT_UDP_LIMIT
} from '../../../shared/protocol'

const props = withDefaults(defineProps<{ win7ImeCompat?: boolean; historyOpen?: boolean }>(), {
  win7ImeCompat: false
})

const emit = defineEmits<{ find: [] }>()
const isMac = /Mac/i.test(navigator.platform)
const findButton = ref<HTMLButtonElement | null>(null)
function revealMessages(): void {
  showMembers.value = false
  showCabinet.value = false
  showEmoji.value = false
  showPk.value = false
  closePeerProfile()
}
defineExpose({ revealMessages, focusFind: () => findButton.value?.focus() })

const peersStore = usePeersStore()
const chatStore = useChatStore()
const groupsStore = useGroupsStore()
const transfersStore = useTransfersStore()
transfersStore.init()

const draft = ref('')
const attachments = usePendingAttachments()
const { items: pendingAttachments, busy: attachmentsSending, failed: attachmentsFailed } = attachments
const sendDisabled = computed(() => attachmentsSending.value || overLimit.value || !canSend.value ||
  (!draft.value.trim() && !pendingAttachments.value.length) ||
  (pendingAttachments.value.length > 0 && !canSendMedia.value))
function cancelAttachments(): void { attachments.clear(); markClipboardPasteHandled(); focusInput() }
const screenState = ref<ScreenState | null>(null)
const screenAvailability = ref<ScreenAvailability | null>(null)
const screenFeedback = ref('')
const screenConfirmation = ref<{ nodeId: string; name: string; ip: string } | null>(null)
const screenRequestBusy = ref(false)
let stopScreenState: (() => void) | undefined
function receiveScreenState(state: ScreenState | null): void {
  if (state && (!screenState.value || state.revision >= screenState.value.revision)) screenState.value = state
}
async function refreshScreenAvailability(): Promise<void> {
  screenAvailability.value = await window.pantry.getScreenAvailability()
}
const screenDisabledReason = computed(() => {
  if (!peerOnline.value) return tr('对方离线，无法查看屏幕')
  if (!screenAvailability.value?.view) return screenAvailability.value?.reason || tr('正在检查屏幕协助能力')
  if (!peer.value?.caps.includes(CAPS.remoteShare)) return tr('对方当前系统暂不支持共享屏幕')
  if (screenState.value && screenState.value.phase !== 'ended' && screenState.value.peerId !== peer.value?.nodeId) return tr('请先结束当前屏幕协助')
  return ''
})
function requestScreen(): void {
  if (screenDisabledReason.value || !peer.value || screenRequestBusy.value) return
  if (screenState.value?.phase !== 'ended' && screenState.value?.peerId === peer.value.nodeId) {
    void sendScreenRequest(peer.value.nodeId, true)
    return
  }
  screenConfirmation.value = { nodeId: peer.value.nodeId, name: peerName.value, ip: peer.value.ip }
}
async function sendScreenRequest(id: string, focusOnly = false): Promise<void> {
  if (screenRequestBusy.value) return
  screenRequestBusy.value = true
  screenFeedback.value = ''
  try {
    const result = await window.pantry.requestScreen(id, focusOnly)
    if (peer.value?.nodeId !== id) return
    if (!result.ok) screenFeedback.value = result.reason === 'rate-limited' ? tr('请求过于频繁，请稍后再试') : tr('暂时无法发起屏幕协助，请检查双方状态')
  } catch { if (peer.value?.nodeId === id) screenFeedback.value = tr('暂时无法发起屏幕协助，请检查双方状态') }
  finally { screenRequestBusy.value = false; screenConfirmation.value = null }
}
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
const showMembers = ref(false)
const showCabinet = ref(false)
const showMentionPicker = ref(false)
const mentionIds = ref<string[]>([])
const pendingMentionAt = ref<number | null>(null)
const mentionQuery = ref('')
const mentionActiveIndex = ref(0)
const mentionPickerEl = ref<HTMLElement | null>(null)
const loadingEarlier = ref(false)
const scrollArea = ref<HTMLElement | null>(null)
const msgsContent = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const win7EditorEl = ref<InstanceType<typeof Win7ChatEditor> | null>(null)
const inputComposing = ref(false)
const emojiScope = ref<HTMLElement | null>(null)
const pkScope = ref<HTMLElement | null>(null)
const peerProfileScope = ref<HTMLElement | null>(null)
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
        replyToMeta.value = {id: newId, senderName: tr('原消息不可用'), text: ''}
        return
      }
      // 直接读取源消息自身的发送者 ID 和文本；原消息是普通消息时 replyTo 字段为空
      const senderName = peersStore.nameOf(msg.senderId) || tr('未知成员')
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
// 历史搜索结果点图片：单击放大 / 双击定位的延时区分（决议 #74）
let peerProfileSavedTimer: ReturnType<typeof setTimeout> | null = null
const MSG_MENU_WIDTH = 128
const MSG_MENU_ITEM_HEIGHT = 32
const MSG_MENU_PADDING = 10
const MENU_MARGIN = 8
const ACTIVE_MESSAGE_TRIM_THRESHOLD = 400
const ACTIVE_MESSAGE_TRIM_KEEP = 300
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
  if (!p) return tr('对方资料还没同步到')
  if (!p.online) return tr('对方离线')
  if (!p.caps.includes(CAPS.fileCabinet)) return tr('对方版本不支持文件柜')
  return ''
})
const cabinetTitle = computed(() => cabinetDisabledReason.value || tr('文件柜'))

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
  if (isGroup.value) return group.value?.name ?? tr('讨论组')
  return peer.value ? peer.value.remark || peer.value.nick : tr('未知节点')
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
const pkDisabledReason = computed(() => tr('PK 只能和在线的人玩'))
const pkToolTip = computed(() => (canSendPk.value ? 'PK' : pkDisabledReason.value))
const nudgeRetryRemainingMs = computed(() => Math.max(0, nudgeRetryUntil.value - nudgeNow.value))
const canSendNudge = computed(
  () => !isGroup.value && peerOnline.value && !nudgeSending.value && nudgeRetryRemainingMs.value <= 0
)
const nudgeToolTip = computed(() => {
  if (isGroup.value) return tr('窗口震动仅支持私聊')
  if (!peerOnline.value) return tr('对方离线，无法震动')
  if (nudgeRetryRemainingMs.value > 0) {
    return tr('{0} 秒后可再震动', { 0: Math.ceil(nudgeRetryRemainingMs.value / 1000) })
  }
  return tr('窗口震动')
})
const mentionMembers = computed(() =>
  group.value ? group.value.members.filter((id) => id !== chatStore.selfId) : []
)
/** 候选展示名：真实成员用备注优先显示名，保留值用文案（决议 #318） */
function mentionLabel(id: string): string {
  return id === MENTION_ALL ? tr('所有人') : peersStore.nameOf(id)
}
// 键盘导航 + 实时过滤（决议 #318）：按备注与昵称做包含匹配，显示名（备注优先）不变；
// @所有人（决议 #318）仅在查询命中「所有人 / 全体 / all / everyone」时作为首项出现
const mentionCandidates = computed(() => {
  const members = filterMentionCandidates(
    mentionMembers.value,
    (id) => {
      const p = peersStore.byId(id)
      return p ? `${p.remark} ${p.nick}` : peersStore.nameOf(id)
    },
    mentionQuery.value
  )
  return matchesMentionAll(mentionQuery.value) ? [MENTION_ALL, ...members] : members
})
const inputPlaceholder = computed(() => {
  if (!canSend.value) return tr('你已不在该讨论组，无法发言')
  return tr('输入消息…')
})
const sendKeyHint = computed(() => settings.value?.sendKey === 'ctrlEnter'
  ? tr('Ctrl+Enter 发送，Enter 换行')
  : tr('Enter 发送，Ctrl+Enter 换行'))
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
  else if (showMentionPicker.value) closeMentionPicker()
  else if (showEmoji.value) showEmoji.value = false
  else if (showPk.value) showPk.value = false
  else if (showPeerProfile.value) closePeerProfile()
  else if (!props.historyOpen && pendingAttachments.value.length && !attachmentsSending.value) cancelAttachments()
  else return
  event.preventDefault()
}

onMounted(async () => {
  stopScreenState = window.pantry.onScreenState(receiveScreenState)
  void window.pantry.getScreenState().then(receiveScreenState)
  void refreshScreenAvailability()
  window.addEventListener('focus', refreshScreenAvailability)
  document.addEventListener('keydown', onEscape)
  document.addEventListener('mousedown', onDocumentPointerDown)
  document.addEventListener('selectionchange', syncMentionQuery)
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
  attachments.clear()
  markClipboardPasteHandled()
  stopScreenState?.()
  window.removeEventListener('focus', refreshScreenAvailability)
  rememberConversationScroll()
  document.removeEventListener('keydown', onEscape)
  bottomKeeper?.disconnect()
  bottomKeeper = null
  document.removeEventListener('mousedown', onDocumentPointerDown)
  document.removeEventListener('selectionchange', syncMentionQuery)
  if (peerProfileSavedTimer) clearTimeout(peerProfileSavedTimer)
  if (nudgeFeedbackTimer) clearTimeout(nudgeFeedbackTimer)
  if (nudgeRetryTimer) clearInterval(nudgeRetryTimer)
  clearTablePasteHint()
  stopRecallCountdownTimer()
  if (clipboardImageFallbackTimer) clearTimeout(clipboardImageFallbackTimer)
  stopSettings?.()
  stopClipboardPaste?.()
})

watch(
  () => chatStore.activeConv?.peerId,
  (id) => {
    screenFeedback.value = ''
    showMembers.value = false
    // 文件柜面板跟着会话走：留着会直接挂到新对端身上，对方离线 / 不支持时
    // 顶部按钮已经灰掉、面板却还开着报错，状态自相矛盾（决议 #278）
    showCabinet.value = false
    closeMentionPicker()
    closePeerProfile()
    nudgeFeedback.value = null
    clearTablePasteHint()
    if (isGroup.value && id) void groupsStore.ensure(id)
  },
  { immediate: true }
)

let draftConvId: string | null = null
function saveConversationDraft(): void {
  if (!draftConvId) return
  if (!draft.value && !pendingAttachments.value.length && !replyToId.value) {
    delete chatStore.drafts[draftConvId]
    return
  }
  chatStore.drafts[draftConvId] = {
    text: draft.value,
    mentionIds: [...mentionIds.value],
    replyToId: replyToId.value,
    // 预览 URL 随组件释放，恢复时重新创建；Blob 保持在内存中。
    attachments: pendingAttachments.value.map(({ file, name, path }) => ({ file, name, path }))
  }
}
watch(() => chatStore.activeConvId, (convId) => {
  saveConversationDraft()
  attachments.clear()
  markClipboardPasteHandled()
  draftConvId = convId
  const saved = convId ? chatStore.drafts[convId] : undefined
  draft.value = saved?.text ?? ''
  mentionIds.value = [...(saved?.mentionIds ?? [])]
  replyToId.value = saved?.replyToId ?? null
  for (const item of saved?.attachments ?? []) attachments.add(item.file, item.name, item.path)
  if (convId) delete chatStore.drafts[convId]
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(saveConversationDraft)


watch(draft, (next, prev) => {
  void nextTick(syncInputMirrorScroll)
  // 用户一改草稿，捕获的表格素材就与输入框对不上了，直接收起提示条（决议 #270）
  if (tablePasteHint.value && !tablePasteHintIntact(draft.value, tablePasteHint.value)) {
    clearTablePasteHint()
  }
  // 中文输入法上屏的 @ 在 keydown 会被 IME 保护拦下，改从输入值变化识别（决议 #318）
  if (openMentionFromInsertion(prev, next)) return
  // 草稿变化后复核 @ 令牌：查询实时过滤，删掉 @ 或输入空白即收起（决议 #318）
  if (showMentionPicker.value) void nextTick(syncMentionQuery)
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
  if (mode === 'target') {
    stickBottom = false
    const id = chatStore.highlightId
    if (id) void nextTick(() => {
      const area = scrollArea.value
      const row = document.getElementById(`msg-${id}`)
      if (!area || !row || !area.contains(row) || chatStore.highlightId !== id) return
      const offset = row.getBoundingClientRect().top - area.getBoundingClientRect().top
      applyScrollTop(area.scrollTop + offset - Math.max(0, (area.clientHeight - row.offsetHeight) / 2))
    })
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
    if (chatStore.openScrollMode === 'target' && chatStore.highlightId) return
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

function peerOrgPath(p: PeerView): string {
  return [p.company, p.dept, p.team].filter(Boolean).join(' / ') || tr('未分组')
}

function peerPlatformLabel(platform: PeerView['platform']): string {
  if (platform === 'win') return 'Windows'
  if (platform === 'mac') return 'macOS'
  return 'Linux'
}

function peerLastSeenLabel(p: PeerView): string {
  if (p.online) return tr('当前在线')
  if (!p.lastSeen) return tr('离线')
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

function window_startCapture(): void {
  if (chatStore.activeConvId) void window.pantry.startCapture(chatStore.activeConvId)
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

async function submitAttachment(item: PendingAttachment, valid: () => boolean): Promise<boolean> {
  if (!valid() || !canSendMedia.value) return false
  if (item.path) {
    // 确认后才申请一次性授权；每次 await 后复核会话/取消代次。
    const paths = await grantLocalFilePaths([item.path])
    if (!valid() || !canSendMedia.value || paths.length !== 1) return false
    return item.image ? chatStore.sendImagePath(paths[0]) : chatStore.sendFilePaths(paths)
  }
  const bytes = await item.file.arrayBuffer()
  if (!valid() || !canSendMedia.value) return false
  return chatStore.sendImageBytes(item.name, bytes)
}

async function send(): Promise<void> {
  if (sendDisabled.value) return
  const text = draft.value.trim()
  const originalDraft = draft.value
  const generation = attachments.token()
  const convId = chatStore.activeConvId
  const mentions = isGroup.value
    ? [...new Set(mentionIds.value)].filter((id) =>
        id === MENTION_ALL
          ? hasMentionAllToken(text)
          : text.includes(`@${peersStore.nameOf(id)}`)
      )
    : []
  const id = replyToId.value || undefined
  await attachments.send(submitAttachment, text ? async () => {
    // 同步摘下本次文字，发送期间继续输入不会带着已发正文再发一次。
    draft.value = ''
    mentionIds.value = []
    closeMentionPicker()
    replyToId.value = null
    const restore = (): void => {
      if (!attachments.isCurrent(generation) || chatStore.activeConvId !== convId) return
      draft.value = originalDraft + (draft.value ? '\n' + draft.value : '')
      mentionIds.value = [...new Set([...mentions, ...mentionIds.value])]
      if (!replyToId.value) replyToId.value = id ?? null
    }
    try {
      const ok = await chatStore.send(text, mentions, id)
      if (!ok) restore()
      return ok
    } catch (error) { restore(); throw error }
  } : undefined)
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
    attachments.add(new Blob([bytes], { type: 'image/png' }), tr('粘贴图片.png'))
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
      setNudgeFeedback(tr('太频繁，{0} 秒后再试', { 0: Math.ceil(wait / 1000) }), 'warn')
      return
    }
    if (result.reason === 'undelivered') {
      startNudgeRetry(NUDGE_MIN_INTERVAL_MS)
      setNudgeFeedback(tr('对方暂时无响应'), 'warn')
      return
    }
    setNudgeFeedback(tr('当前会话无法震动'), 'warn')
  } finally {
    nudgeSending.value = false
  }
}

async function sendPk(game: PkGame): Promise<void> {
  if (!canSendPk.value) return
  showPk.value = false
  await chatStore.sendPk(game)
}

/** 输入值里出现新插入的 @/＠ 时打开面板；中文输入法下不经过按键分流（决议 #318） */
function openMentionFromInsertion(prev: string, next: string): boolean {
  if (!isGroup.value || !canSend.value || mentionMembers.value.length === 0) return false
  const at = detectMentionInsertion(prev, next, inputSelectionRange().start)
  if (at === null) return false
  pendingMentionAt.value = at
  mentionQuery.value = ''
  mentionActiveIndex.value = 0
  showMentionPicker.value = true
  return true
}

/** 收起 @ 面板并复位键盘导航状态（决议 #318） */
function closeMentionPicker(): void {
  showMentionPicker.value = false
  pendingMentionAt.value = null
  mentionQuery.value = ''
  mentionActiveIndex.value = 0
}

/** 复核 @ 到光标之间的令牌：查询实时过滤，令牌失效（删 @ / 越界 / 空白）即收起 */
function syncMentionQuery(): void {
  if (!showMentionPicker.value || inputComposing.value) return
  const at = pendingMentionAt.value
  if (at === null) {
    closeMentionPicker()
    return
  }
  const { start, end } = inputSelectionRange()
  const query = start === end ? parseMentionQuery(draft.value, at, start) : null
  if (query === null) {
    closeMentionPicker()
    return
  }
  if (query === mentionQuery.value) return
  mentionQuery.value = query
  mentionActiveIndex.value = 0
}

function scrollMentionActiveIntoView(): void {
  mentionPickerEl.value?.querySelector('button.active')?.scrollIntoView({ block: 'nearest' })
}

function moveMentionActive(delta: 1 | -1): void {
  const total = mentionCandidates.value.length
  if (total === 0) return
  mentionActiveIndex.value = stepMentionIndex(mentionActiveIndex.value, delta, total)
  void nextTick(scrollMentionActiveIntoView)
}

function confirmMention(): void {
  const candidates = mentionCandidates.value
  if (candidates.length === 0) return
  const index = Math.min(Math.max(mentionActiveIndex.value, 0), candidates.length - 1)
  insertMention(candidates[index])
}

function onKeydown(event: KeyboardEvent): void {
  if (isImeCompositionKey(event, inputComposing.value)) return
  // 原生选区事件可能尚未派发：每次按键先校验，尤其不能让 Enter 使用旧候选。
  syncMentionQuery()
  if (event.key === '@' && isGroup.value && canSend.value && mentionMembers.value.length > 0) {
    pendingMentionAt.value = inputSelectionRange().start
    mentionQuery.value = ''
    mentionActiveIndex.value = 0
    showMentionPicker.value = true
    return
  }
  if (showMentionPicker.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (mentionCandidates.value.length > 0) {
        event.preventDefault()
        moveMentionActive(event.key === 'ArrowDown' ? 1 : -1)
      }
      return
    }
    if (event.key === 'Enter' && mentionCandidates.value.length > 0) {
      event.preventDefault()
      confirmMention()
      return
    }
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
  if (inputComposing.value) return
  syncMentionQuery()
  if (!showMentionPicker.value || !mentionCandidates.value.includes(nodeId)) return
  const name = mentionLabel(nodeId)
  const at = pendingMentionAt.value ?? draft.value.length
  // 光标在查询串中间时替换整个令牌，保留其后的空白与正文。
  const end = at + 1 + (draft.value.slice(at + 1).match(/^\S*/)?.[0].length ?? 0)
  draft.value = `${draft.value.slice(0, at)}@${name} ${draft.value.slice(end)}`
  mentionIds.value = [...new Set([...mentionIds.value, nodeId])]
  closeMentionPicker()
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
  if (!mediaPeersSupportRecall(msg)) return tr('不可用')
  if (msg.kind !== 'file') return ''
  const transfers = messageTransfers(msg)
  if (transfers.length === 0) return tr('不可用')
  if (transfers.some((transfer) => transfer.status === 'done')) {
    return msg.convId.startsWith('group:') ? tr('部分已接收') : tr('已接收')
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
  const recipient = chatStore.activeConv
  if (!canSendMedia.value || !recipient) return
  const paths = await window.pantry.pickFiles(directory, peerName.value)
  if (paths) await chatStore.sendFilePaths(paths, recipient)
}

async function sendImage(): Promise<void> {
  const recipient = chatStore.activeConv
  if (!canSendMedia.value || !recipient) return
  const paths = await window.pantry.pickImages(peerName.value)
  if (!paths) return
  for (const path of paths) await chatStore.sendImagePath(path, recipient)
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
  ctx.strokeStyle = '#E5E9F0'
  ctx.lineWidth = 1
  ctx.font = measureCtx.font
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#293241'

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
  await chatStore.sendImageBytes(tr('粘贴表格{0}', { 0: payload.imageExt }), bytes, payload.meta)
}

/** Ctrl+V 只加入本地附件草稿；普通文本与表格保留原有优先级。 */
async function onPaste(event: ClipboardEvent): Promise<void> {
  if (!canSend.value) return
  const data = event.clipboardData
  // 任何 await 前同步标记，避免原生剪贴板兜底重复入队（#207）。
  markClipboardPasteHandled()
  if (data) {
    const files = Array.from(data.files)
    const localFiles = files.filter(file => (file as File & { path?: string }).path)
    if (localFiles.length) {
      event.preventDefault()
      for (const file of files) {
        const path = (file as File & { path?: string }).path || ''
        if (path || file.type.startsWith('image/')) attachments.add(file, file.name, path)
      }
      return
    }
    const tableText = readClipboardTableText(data)
    if (tableText) {
      event.preventDefault()
      await prepareTablePaste(data, tableText)
      return
    }
    // 富文本中的附带位图不替代正文（已有 emoji/表格粘贴约定）。
    if (hasClipboardText(data)) return
    const images = files.filter(file => file.type.startsWith('image/'))
    if (images.length) {
      event.preventDefault()
      for (const file of images) attachments.add(file, file.name || tr('粘贴图片{0}', { 0: imageExtFromMime(file.type) }))
      return
    }
  }
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
    <ScreenRequestDialog v-if="screenConfirmation" :name="screenConfirmation.name" :ip="screenConfirmation.ip"
      :busy="screenRequestBusy" @close="screenConfirmation = null" @confirm="sendScreenRequest(screenConfirmation.nodeId)" />
    <ForwardDialog v-if="forwardMsg" :msg="forwardMsg" @close="forwardMsg = null" />
    <div v-if="dragging" class="drop-mask">{{ tr('松手发送给 {0}', { 0: peerName }) }}</div>
    <header class="head">
      <div v-if="!isGroup && peer" ref="peerProfileScope" class="peer-profile-scope">
        <button
          class="title-button"
          :class="{ active: showPeerProfile }"
          type="button"
          :aria-label="tr('查看对方资料')"
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
                peerOnline ? tr('在线') : tr('离线')
              }}</span>
              <template v-if="peerIp"> · {{ peerIp }}</template>
            </span>
          </span>
        </button>
        <section
          v-if="showPeerProfile"
          class="peer-profile-popover"
          role="dialog"
          :aria-label="tr('对方详细信息')"
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
              <small v-if="peer.remark">{{ tr('昵称：{0}', { 0: peer.nick }) }}</small>
              <span class="profile-status" :class="{ on: peer.online }">
                <span class="profile-status-dot"></span>
                {{ peer.online ? tr('在线') : tr('离线') }}
              </span>
            </span>
          </header>
          <div class="profile-rows">
            <div class="profile-row"><span>{{ tr('组织') }}</span><strong>{{ peerOrgPath(peer) }}</strong></div>
            <div class="profile-row"><span>IP</span><strong>{{ peer.ip || tr('未知') }}</strong></div>
            <div class="profile-row"><span>{{ tr('MAC 地址') }}</span><strong>{{ peer.mac || tr('未知') }}</strong></div>
            <div class="profile-row"><span>{{ tr('主机') }}</span><strong>{{ peer.host || tr('未知') }}</strong></div>
            <div class="profile-row">
              <span>{{ tr('平台') }}</span><strong>{{ peerPlatformLabel(peer.platform) }}</strong>
            </div>
            <div class="profile-row">
              <span>{{ tr('最近') }}</span><strong>{{ peerLastSeenLabel(peer) }}</strong>
            </div>
          </div>
          <label class="profile-remark">
            <span>{{ tr('备注') }}</span>
            <input
              v-model="peerProfileRemark"
              maxlength="32"
              :placeholder="tr('仅自己可见')"
              @keydown.enter="savePeerProfileRemark"
            />
          </label>
          <div class="profile-actions">
            <span class="profile-save-state">{{ peerProfileSaved ? tr('已保存') : '' }}</span>
            <button
              type="button"
              class="profile-save"
              :disabled="peerProfileSaving"
              @click="savePeerProfileRemark"
            >
              {{ peerProfileSaving ? tr('保存中') : tr('保存备注') }}
            </button>
          </div>
        </section>
      </div>
      <template v-else>
        <GroupAvatar
          class="group-head-avatar"
          :avatar-hash="group?.avatarHash"
          :icon-size="26"
        />
        <span class="title-block">
          <span class="title">{{ peerName }}</span>
        </span>
      </template>
      <span v-if="isGroup" class="state">{{ tr('{0} 人', { 0: group?.members.length ?? 0 }) }}</span>
      <span class="head-spacer"></span>
      <div class="head-actions">
        <button ref="findButton" type="button" class="icon-control head-btn find-button"
          :aria-label="tr('查找聊天记录')" :aria-expanded="historyOpen"
          :title="tr('查找聊天记录') + (isMac ? ' (⌘F)' : ' (Ctrl+F)')" @click="emit('find')">
          <PantryIcon name="search" size="action" />
        </button>
        <button v-if="!isGroup && peer?.caps.includes(CAPS.remoteView)" class="icon-control head-btn"
          :disabled="!!screenDisabledReason" :title="screenDisabledReason || tr('查看屏幕')" :aria-label="tr('查看屏幕')"
          :aria-description="screenDisabledReason || undefined"
          @click="requestScreen"><PantryIcon name="screen" size="action" /></button>
        <button
          v-if="!isGroup"
          class="icon-control head-btn"
          :aria-expanded="showCabinet"
          :aria-label="tr('文件柜')"
          :aria-description="cabinetDisabledReason || undefined"
          :title="cabinetTitle"
          :aria-disabled="!!cabinetDisabledReason"
          @click="toggleCabinet"
        >
          <PantryIcon name="cabinet" size="action" />
        </button>
        <button v-if="isGroup" class="icon-control head-btn" :title="tr('成员')" :aria-label="tr('成员')" :aria-expanded="showMembers" @click="showMembers = !showMembers">
          <PantryIcon name="users" size="action" />
        </button>
      </div>
    </header>

    <p v-if="screenFeedback" class="screen-status" role="status">{{ screenFeedback }}</p>

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
      <div v-if="loadingEarlier" class="sep">{{ tr('加载更早的消息…') }}</div>
      <MessageRow
        v-for="(msg, i) in chatStore.activeMessages"
        :key="msg.id"
        :msg="msg"
        :next-msg="chatStore.activeMessages[i + 1]"
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
          :title="tr('回到最新消息')"
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
      <button v-if="canCopyMessage(msgMenu.msg)" @click="copySelectedMessage">{{ tr('复制') }}</button>
      <button v-if="canForwardMessage(msgMenu.msg)" @click="forwardSelectedMessage">{{ tr('转发') }}</button>
      <button v-if="canQuoteMessage(msgMenu.msg) && isGroup && !msgMenu.msg.isMine" @click="quoteSelectedMessage">{{ tr('引用回复') }}</button>
      <button
        v-if="isRecallableKind(msgMenu.msg)"
        class="danger recall-action"
        :disabled="recallButtonDisabled"
        @click="recallSelectedMessage"
      >
        <span>{{ tr('撤回') }}</span>
        <span class="recall-action-meta" :class="{ 'is-urgent': recallButtonUrgent }">
          {{ recallButtonMeta }}
        </span>
      </button>
    </div>

    <footer class="input-area">
      <!-- 桌面端在分隔线上保留拖拽热区，通过鼠标光标提示，不显示额外手柄。 -->
      <div
        class="input-resizer"
        role="separator"
        :aria-label="tr('拖动调整输入框高度')"
        :title="tr('拖动调整输入框高度')"
        @pointerdown="startInputResize"
      ></div>
      <div class="toolbar">
        <span ref="emojiScope" class="emoji-scope">
          <EmojiPanel
            v-if="showEmoji"
            :sticker-enabled="canSendMedia"
            @select="insertEmoji"
            @sticker="sendStickerById"
          />
          <span class="tool-wrap" :data-tip="tr('表情')">
            <button
              class="icon-control tool"
              type="button"
              :aria-label="tr('表情')"
              :aria-expanded="showEmoji"
              :disabled="!canSend"
              @click="showEmoji = !showEmoji"
            >
              <PantryIcon name="smile" size="action" />
            </button>
          </span>
        </span>
        <span ref="pkScope" class="pk-scope">
          <div v-if="showPk" class="pk-popover">
            <button
              type="button"
              :disabled="!canSendPk"
              :title="canSendPk ? tr('猜拳') : pkDisabledReason"
              @click="sendPk('rps')"
            >
              <span class="pk-pop-window"><PantryIcon name="pk-rps" :size="28" /></span>
              <span>{{ tr('猜拳') }}</span>
            </button>
            <button
              type="button"
              :disabled="!canSendPk"
              :title="canSendPk ? tr('骰子') : pkDisabledReason"
              @click="sendPk('dice')"
            >
              <span class="pk-pop-window"><PantryIcon name="pk-dice" :size="28" /></span>
              <span>{{ tr('骰子') }}</span>
            </button>
          </div>
          <span class="tool-wrap" :data-tip="pkToolTip">
            <button
              class="icon-control tool"
              type="button"
              aria-label="PK"
              aria-haspopup="menu"
              :aria-expanded="showPk ? 'true' : 'false'"
              @click="showPk = !showPk"
            >
              <PantryIcon name="pk" size="action" />
            </button>
          </span>
        </span>
        <span v-if="!isGroup" class="tool-wrap" :data-tip="nudgeToolTip">
          <button
            class="icon-control tool"
            type="button"
            :aria-label="tr('窗口震动')"
            :disabled="!canSendNudge"
            @click="sendNudge"
          >
            <PantryIcon name="nudge" size="action" />
          </button>
        </span>
        <span class="tool-wrap" :data-tip="tr('截图')">
          <button
            class="icon-control tool"
            type="button"
            :aria-label="tr('截图（Ctrl/Cmd+Alt+A）')"
            @click="window_startCapture"
          >
            <PantryIcon name="scissors" size="action" />
          </button>
        </span>
        <span class="tool-wrap" :data-tip="tr('发送图片')">
          <button
            class="icon-control tool"
            type="button"
            :aria-label="tr('发送图片')"
            :disabled="!canSendMedia"
            @click="sendImage"
          >
            <PantryIcon name="image" size="action" />
          </button>
        </span>
        <span class="tool-wrap" :data-tip="tr('发送文件')">
          <button
            class="icon-control tool"
            type="button"
            :aria-label="tr('发送文件')"
            :disabled="!canSendMedia"
            @click="sendFiles(false)"
          >
            <PantryIcon name="file" size="action" />
          </button>
        </span>
        <span class="tool-wrap" :data-tip="tr('发送文件夹')">
          <button
            class="icon-control tool"
            type="button"
            :aria-label="tr('发送文件夹')"
            :disabled="!canSendMedia"
            @click="sendFiles(true)"
          >
            <PantryIcon name="folder" size="action" />
          </button>
        </span>
        <span v-if="nudgeFeedback" class="nudge-feedback" :class="nudgeFeedback.kind">
          {{ nudgeFeedback.text }}
        </span>
        <span class="toolbar-spacer"></span>
      </div>
      <span v-if="isGroup && canSend && onlineGroupRecipientCount === 0" class="tool-hint">{{ tr('群成员均离线，文字待成员上线后补发，图片和文件需在线接收。') }}</span>
      <span v-else-if="isGroup" class="tool-hint">{{ tr('仅在线群成员可接收图片/文件') }}</span>
      <span v-else-if="!peerOnline" class="tool-hint">{{ tr('对方上线后会收到文字消息。图片和文件需双方在线。') }}</span>
      <div
        v-if="showMentionPicker"
        ref="mentionPickerEl"
        class="mention-picker"
        role="listbox"
        :aria-label="tr('选择要 @ 的成员')"
      >
        <div v-if="mentionCandidates.length === 0" class="mention-empty">{{ tr('没有匹配的成员') }}</div>
        <button
          v-for="(id, index) in mentionCandidates"
          :key="id"
          type="button"
          role="option"
          :aria-selected="index === mentionActiveIndex"
          :class="{ active: index === mentionActiveIndex }"
          @mouseenter="mentionActiveIndex = index"
          @mousedown.prevent="insertMention(id)"
        >
          {{ mentionLabel(id) }}
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
        >{{ tr('发送为图片') }}</button>
        <button
          class="table-paste-hint-close"
          type="button"
          :aria-label="tr('忽略')"
          @click="clearTablePasteHint"
        >
          <PantryIcon name="x" :size="14" />
        </button>
      </div>
      <div v-if="replyToId" class="reply-preview">
        <span class="reply-preview-label">{{ tr('引用回复') }}</span>
        <span class="reply-preview-sender">{{ replyToMeta?.senderName ?? tr('原消息不可用') }}</span>
        <span class="reply-preview-text">{{ replyToMeta?.text ?? '' }}</span>
        <button
          class="reply-preview-close"
          type="button"
          :aria-label="tr('取消引用')"
          @click="replyToId = null"
        >
          <PantryIcon name="x" :size="12" />
        </button>
      </div>
      <PendingAttachments
        v-if="pendingAttachments.length"
        :items="pendingAttachments"
        :busy="attachmentsSending"
        :failed="attachmentsFailed"
        :available="canSendMedia"
        @remove="attachments.remove"
        @cancel="cancelAttachments"
      />
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
          :title="tr('可粘贴截图或文件')"
          aria-describedby="composer-send-hint"
          @update:model-value="onWin7EditorValue"
          @keydown="onKeydown"
          @keyup="syncMentionQuery"
          @mouseup="syncMentionQuery"
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
          :title="tr('可粘贴截图或文件')"
          aria-describedby="composer-send-hint"
          @keydown="onKeydown"
          @keyup="syncMentionQuery"
          @mouseup="syncMentionQuery"
          @paste="onPaste"
          @scroll="syncInputMirrorScroll"
          @compositionstart="onInputCompositionStart"
          @compositionend="onInputCompositionEnd"
        ></textarea>
      </div>
      <div class="input-bar">
        <span v-if="draftBytes > 600" class="counter" :class="{ over: overLimit }">
          {{ tr('{0} / {1} 字节{2}', { 0: draftBytes, 1: TEXT_TCP_LIMIT, 2: overLimit ? tr('（文本过长）') : overUdpLimit ? tr('（将通过 TCP 发送）') : '' }) }}
        </span>
        <span v-if="canSend" id="composer-send-hint" class="send-hint">{{ sendKeyHint }}</span>
        <button class="send" :disabled="sendDisabled" @click="send">{{ attachmentsSending ? tr('正在发送…') : pendingAttachments.length ? tr('发送（{0}）', { 0: pendingAttachments.length }) : tr('发送') }}</button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.screen-status { margin: 0; padding: 8px 16px; color: var(--text-2); background: var(--bg-list); font-size: var(--font-sm); border-bottom: 1px solid var(--line); }
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
  background: rgba(var(--primary-rgb), 0.12);
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
  gap: 6px;
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
  border-radius: var(--radius-panel);
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-float);

  z-index: 28;
}
.pk-popover button {
  padding: 8px 6px 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-panel);
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
/* 玩法卡的图标小窗：与 PkBubble 开奖窗同底（--bg-chat）、同蓝色语义，让浮层与气泡视觉呼应 */
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
  outline: 2px solid rgba(var(--primary-rgb), 0.35);
  outline-offset: 2px;
}
.pk-popover button:disabled {
  opacity: 0.4;
  cursor: default;
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
  border-radius: var(--radius-panel);
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
.mention-picker button:is(:hover, .active) {
  background: var(--surface-hover);
}
.mention-empty {
  padding: 7px 10px;
  color: var(--text-3);
  font-size: 12px;
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
  background: rgba(var(--primary-rgb), 0.08);
  border: 1px solid rgba(var(--primary-rgb), 0.22);
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
/* "回到最新"悬浮圆按钮（决议 #134）：贴消息区右下角，白底 + 蓝色箭头 + 柔和阴影 */
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
/* hover 只做高亮：蓝色描边 + 阴影略增，保持白底，不加半透明、不浮动（决议 #135） */
.jump-latest:hover {
  background: var(--material-strong);
  border-color: var(--primary);
  box-shadow: var(--shadow-float);
  opacity: 1;
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
  transform: translateX(-50%);
  transition: opacity var(--motion-feedback) ease;
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
  width: max-content;
  max-width: 190px;
  padding: 4px 7px;
  border-radius: 7px;
  background: rgba(35, 35, 35, 0.94);
  color: #fff;
  font-size: 11px;
  line-height: 1.3;
  text-align: center;
  box-shadow: var(--shadow-soft);
}
.emoji-scope .tool-wrap::after,
.pk-scope .tool-wrap::after {
  left: 0;
  transform: none;
}
.tool-wrap:hover::before,
.tool-wrap:hover::after,
.tool-wrap:focus-within::before,
.tool-wrap:focus-within::after {
  opacity: 1;
  transition-delay: 400ms;
}
.tool-hint {
  display: block;
  line-height: 1.35;
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
.head {
  /* 沉浸式（决议 #49）：头部背景直通窗口顶，内容压在 32px 拖拽带下方。
     这里不许设 no-drag —— no-drag 矩形会从系统 drag region 中挖洞，
     把聊天区顶部 32px 的拖拽带挖掉（Win7/mac 实测顶部无法拖窗）。 */
  height: 84px;
  flex: 0 0 84px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 32px var(--pane-inset) 0;
  background: var(--material-bar);
  border-bottom: 1px solid var(--line);
  box-shadow: none;
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
  border-radius: var(--radius-panel);
  padding: 4px 4px 4px 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
}
.head-avatar {
  width: var(--avatar-heading);
  height: var(--avatar-heading);
  border-radius: 50%;
  flex: 0 0 var(--avatar-heading);
  color: #fff;
  font-size: 17px;
}
.group-head-avatar {
  width: var(--avatar-heading);
  height: var(--avatar-heading);
  flex: 0 0 var(--avatar-heading);
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
  font-size: 12px;
  line-height: 1.4;
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
  border-radius: var(--radius-panel);
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-float);

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
  background: var(--online-weak);
  border-color: transparent;
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
  border-radius: var(--radius-panel);
  background: var(--material-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  padding: 0 9px;
  outline: none;
  user-select: text;
}
.profile-remark input:focus {
  border-color: rgba(var(--primary-rgb), 0.55);
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
  color: var(--on-primary);
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
  overscroll-behavior: contain;
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
.head-actions { display: flex; align-items: center; gap: 4px; flex: none; }
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
  border-radius: var(--radius-panel);
  box-shadow: var(--highlight-edge), var(--shadow-float);
  padding: 5px;

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
  margin: 0;
  padding: 9px 20px 14px;
  border: none;
  border-top: 1px solid var(--line);
  border-radius: 0;
  background: var(--bg-input);
  box-shadow: none;
  position: relative;
  z-index: 3;
}
/* 输入框高度拖拽热区：铺满顶部并压在分隔线上，仅通过 ns-resize 光标提示。 */
.input-resizer {
  height: 8px;
  margin: -13px -20px 7px;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
}
.input-area:focus-within { border-top-color: var(--primary-border); }
.input-shell {
  position: relative;
  border-radius: var(--radius-panel);
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
  background: rgba(var(--primary-rgb), 0.18);
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
  margin-right: auto;
}
.send-hint {
  color: var(--text-2);
  font-size: 12px;
  text-align: right;
}
.counter.over {
  color: var(--danger);
}
.send {
  flex: 0 0 auto;
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-size: 13px;
  min-width: 76px;
  height: 32px;
  padding: 0 16px;
  border-radius: var(--radius-control);
  font-weight: 600;
  cursor: pointer;
  box-shadow: none;
  transition:
    filter 150ms ease,
    transform 90ms ease-out,
    box-shadow 150ms ease;
}
.send:hover:not(:disabled) {
  background: var(--primary-hover);
  box-shadow: none;
}
.send:active:not(:disabled) {
  transform: scale(0.97);
}
.send:disabled {
  background: var(--surface-selected);
  color: var(--text-3);
  cursor: default;
}
@media (prefers-reduced-motion: reduce) {
  .tool-wrap::before,
  .tool-wrap::after,
  .pk-popover button,
  .title-button .title,
  .profile-save,
  .send,
  .jump-latest {
    transition: none;
  }
  .pk-popover button:active:not(:disabled),
  .profile-save:active:not(:disabled),
  .send:active:not(:disabled),
  .msg-menu button:active:not(:disabled),
  .jump-latest:active {
    transform: none;
  }
}

</style>
