<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import { useTransfersStore } from '../stores/transfers'
import { avatarStyle, avatarText } from '../utils/avatar'
import { separatorTime } from '../utils/time'
import FileCard from './FileCard.vue'
import ImageBubble from './ImageBubble.vue'
import EmojiPanel from './EmojiPanel.vue'
import GroupPanel from './GroupPanel.vue'
import ForwardDialog from './ForwardDialog.vue'
import PantryIcon from './PantryIcon.vue'
import type { MessageView, PeerView, SettingsView } from '../../../shared/ipc'
import { RECALL_WINDOW_MS, TEXT_TCP_LIMIT, TEXT_UDP_LIMIT } from '../../../shared/protocol'

const peersStore = usePeersStore()
const chatStore = useChatStore()
const groupsStore = useGroupsStore()
const transfersStore = useTransfersStore()
transfersStore.init()

const draft = ref('')
const dragging = ref(false)
const showEmoji = ref(false)
const showMembers = ref(false)
const showMentionPicker = ref(false)
const mentionIds = ref<string[]>([])
const pendingMentionAt = ref<number | null>(null)
const loadingEarlier = ref(false)
const scrollArea = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const emojiScope = ref<HTMLElement | null>(null)
const msgMenu = ref<{ x: number; y: number; msg: MessageView } | null>(null)
const forwardMsg = ref<MessageView | null>(null)
const settings = ref<SettingsView | null>(null)
let stopSettings: (() => void) | null = null
const MSG_MENU_WIDTH = 112
const MSG_MENU_ITEM_HEIGHT = 32
const MSG_MENU_PADDING = 10
const MENU_MARGIN = 8
interface TextPart {
  text: string
  url: string
}

const isGroup = computed(() => chatStore.activeConv?.type === 'group')
const group = computed(() =>
  isGroup.value && chatStore.activeConv
    ? (groupsStore.byId[chatStore.activeConv.peerId] ?? null)
    : null
)
const peer = computed(() => {
  const conv = chatStore.activeConv
  if (!conv || conv.type === 'group') return null
  return peersStore.peers.find((p) => p.nodeId === conv.peerId) ?? null
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
  return group.value.members.filter((id) => {
    if (id === chatStore.selfId) return false
    return peersStore.byId(id)?.online ?? false
  }).length
})
const canSendMedia = computed(() =>
  isGroup.value ? canSend.value && onlineGroupRecipientCount.value > 0 : peerOnline.value
)
const mentionMembers = computed(() =>
  group.value ? group.value.members.filter((id) => id !== chatStore.selfId) : []
)
const inputPlaceholder = computed(() => {
  if (!canSend.value) return '你已不在该讨论组，无法发言'
  return settings.value?.sendKey === 'ctrlEnter'
    ? '输入消息，Ctrl+Enter 发送，Enter 换行；粘贴截图直接发送'
    : '输入消息，Enter 发送，Ctrl+Enter 换行；粘贴截图直接发送'
})

function onDocumentPointerDown(event: MouseEvent): void {
  if (!showEmoji.value) return
  const target = event.target
  if (target instanceof Node && emojiScope.value?.contains(target)) return
  showEmoji.value = false
}

onMounted(async () => {
  document.addEventListener('mousedown', onDocumentPointerDown)
  settings.value = await window.pantry.getSettings()
  stopSettings = window.pantry.onSettingsUpdated((next) => {
    settings.value = next
  })
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown)
  stopSettings?.()
})

watch(
  () => chatStore.activeConv?.peerId,
  (id) => {
    showMembers.value = false
    showMentionPicker.value = false
    mentionIds.value = []
    if (isGroup.value && id) void groupsStore.ensure(id)
  },
  { immediate: true }
)

function senderName(msg: MessageView): string {
  return peersStore.nameOf(msg.senderId)
}

function senderPeer(msg: MessageView): PeerView | undefined {
  return peersStore.byId(msg.senderId)
}

function showGroupSender(msg: MessageView): boolean {
  return isGroup.value && !msg.isMine && msg.kind !== 'system' && msg.status !== 'recalled'
}

function senderAvatarStyle(msg: MessageView): { backgroundColor: string; color: string } {
  const peer = senderPeer(msg)
  return avatarStyle(peer?.avatar ?? -1, senderName(msg))
}

function senderAvatarText(msg: MessageView): string {
  const peer = senderPeer(msg)
  return avatarText(peer?.avatar ?? -1, senderName(msg))
}

const draftBytes = computed(() => new TextEncoder().encode(draft.value.trim()).length)
const overUdpLimit = computed(() => draftBytes.value > TEXT_UDP_LIMIT)
const overLimit = computed(() => draftBytes.value > TEXT_TCP_LIMIT)

/** 与上一条间隔 >5 分钟时插时间分隔（ui-design §5） */
function needSeparator(msg: MessageView, index: number): boolean {
  if (index === 0) return true
  return msg.ts - chatStore.activeMessages[index - 1].ts > 5 * 60_000
}

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollArea.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(() => chatStore.activeConvId, scrollToBottom)
// 只在"末尾追加"时贴底（向上加载历史是前插，不该滚动）
watch(
  () => {
    const list = chatStore.activeMessages
    return list.length > 0 ? list[list.length - 1].id : ''
  },
  (id, oldId) => {
    if (id && id !== oldId) scrollToBottom()
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
  if (!el || el.scrollTop > 40 || loadingEarlier.value) return
  loadingEarlier.value = true
  const prevHeight = el.scrollHeight
  const loaded = await chatStore.loadEarlier()
  if (loaded > 0) {
    await nextTick()
    el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop
  }
  loadingEarlier.value = false
}

function window_startCapture(): void {
  void window.pantry.startCapture()
}

async function sendStickerById(stickerId: string): Promise<void> {
  showEmoji.value = false
  await chatStore.sendSticker(stickerId)
}

function insertEmoji(emoji: string): void {
  const ta = inputEl.value
  if (!ta) {
    draft.value += emoji
    return
  }
  const start = ta.selectionStart ?? draft.value.length
  const end = ta.selectionEnd ?? start
  draft.value = draft.value.slice(0, start) + emoji + draft.value.slice(end)
  void nextTick(() => {
    ta.focus()
    ta.selectionStart = ta.selectionEnd = start + emoji.length
  })
}

function insertNewline(): void {
  const ta = inputEl.value
  if (!ta) {
    draft.value += '\n'
    return
  }
  const start = ta.selectionStart ?? draft.value.length
  const end = ta.selectionEnd ?? start
  draft.value = draft.value.slice(0, start) + '\n' + draft.value.slice(end)
  void nextTick(() => {
    ta.focus()
    ta.selectionStart = ta.selectionEnd = start + 1
  })
}

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || overLimit.value || !canSend.value) return
  const mentions = isGroup.value
    ? [...new Set(mentionIds.value)].filter((id) => text.includes(`@${peersStore.nameOf(id)}`))
    : []
  draft.value = ''
  mentionIds.value = []
  showMentionPicker.value = false
  await chatStore.send(text, mentions)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === '@' && isGroup.value && canSend.value && mentionMembers.value.length > 0) {
    pendingMentionAt.value = inputEl.value?.selectionStart ?? draft.value.length
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
  }
}

function insertMention(nodeId: string): void {
  const name = peersStore.nameOf(nodeId)
  const at = pendingMentionAt.value ?? draft.value.length
  const ta = inputEl.value
  const end = Math.max(at, ta?.selectionStart ?? at)
  draft.value = `${draft.value.slice(0, at)}@${name} ${draft.value.slice(end)}`
  mentionIds.value = [...new Set([...mentionIds.value, nodeId])]
  showMentionPicker.value = false
  pendingMentionAt.value = null
  void nextTick(() => {
    const pos = at + name.length + 2
    inputEl.value?.focus()
    if (inputEl.value) inputEl.value.selectionStart = inputEl.value.selectionEnd = pos
  })
}

function statusHint(msg: MessageView): string {
  if (msg.kind === 'file') return '' // 文件卡片自带状态行
  if (msg.status === 'recalled') return ''
  if (msg.status === 'queued') return '对方上线后自动送达'
  if (msg.status === 'failed') return '发送失败，点击重发'
  return ''
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi
const URL_TRAILING = /[),.，。!！?？;；:：]+$/

function textParts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    const index = match.index ?? 0
    const trimmed = raw.replace(URL_TRAILING, '')
    if (!trimmed) continue
    if (index > last) parts.push({ text: text.slice(last, index), url: '' })
    parts.push({ text: trimmed, url: trimmed })
    const tailStart = index + trimmed.length
    if (tailStart < index + raw.length) {
      parts.push({ text: text.slice(tailStart, index + raw.length), url: '' })
    }
    last = index + raw.length
  }
  if (last < text.length) parts.push({ text: text.slice(last), url: '' })
  return parts.length > 0 ? parts : [{ text, url: '' }]
}

function openTextLink(url: string): void {
  void window.pantry.openUrl(url)
}

function canCopyMessage(msg: MessageView): boolean {
  return msg.kind === 'text' && msg.status !== 'recalled'
}

function canRecallMessage(msg: MessageView): boolean {
  if (!msg.isMine || msg.kind !== 'text' || msg.status === 'recalled') return false
  return Date.now() - msg.ts <= RECALL_WINDOW_MS
}

function canForwardMessage(msg: MessageView): boolean {
  return msg.status !== 'recalled' && msg.kind !== 'system'
}

function messageMenuItemCount(msg: MessageView): number {
  return (
    Number(canCopyMessage(msg)) +
    Number(canForwardMessage(msg)) +
    Number(canRecallMessage(msg))
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
  msgMenu.value = null
  if (!msg || !canRecallMessage(msg)) return
  await chatStore.recall(msg.id)
}

function forwardSelectedMessage(): void {
  const msg = msgMenu.value?.msg
  msgMenu.value = null
  if (!msg || !canForwardMessage(msg)) return
  forwardMsg.value = msg
}

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
function isImagePath(path: string): boolean {
  const lower = path.toLowerCase()
  return IMG_EXTS.some((ext) => lower.endsWith(ext))
}

async function sendFiles(directory: boolean): Promise<void> {
  if (!canSendMedia.value) return
  const paths = await window.pantry.pickFiles(directory)
  if (paths) await chatStore.sendFilePaths(paths)
}

async function sendImage(): Promise<void> {
  if (!canSendMedia.value) return
  const paths = await window.pantry.pickFiles(false)
  if (!paths) return
  for (const p of paths) {
    if (isImagePath(p)) await chatStore.sendImagePath(p)
    else await chatStore.sendFilePaths([p])
  }
}

/** 截图 Ctrl+V：剪贴板里的图片直接发送（F-MSG-3） */
async function onPaste(event: ClipboardEvent): Promise<void> {
  if (!canSendMedia.value || !event.clipboardData) return
  for (const item of Array.from(event.clipboardData.items)) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    event.preventDefault()
    const bytes = await file.arrayBuffer()
    const ext = item.type === 'image/jpeg' ? '.jpg' : '.png'
    await chatStore.sendImageBytes(`粘贴图片${ext}`, bytes)
    return
  }
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  if (canSendMedia.value) dragging.value = true
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
  // 单张图片拖入 → 按图片消息发；其余按文件
  if (paths.length === 1 && isImagePath(paths[0])) {
    await chatStore.sendImagePath(paths[0])
  } else {
    await chatStore.sendFilePaths(paths)
  }
}
</script>

<template>
  <div class="chat" @click="msgMenu = null" @dragover="onDragOver" @dragleave="dragging = false" @drop="onDrop">
    <ForwardDialog v-if="forwardMsg" :msg="forwardMsg" @close="forwardMsg = null" />
    <div v-if="dragging" class="drop-mask">松手发送给 {{ peerName }}</div>
    <header class="head">
      <span class="title-block">
        <span class="title">{{ peerName }}</span>
        <span v-if="!isGroup && peerIp" class="subtitle">{{ peerIp }}</span>
      </span>
      <span v-if="isGroup" class="state">{{ group?.members.length ?? 0 }} 人</span>
      <span v-else class="state" :class="{ on: peerOnline }">{{
        peerOnline ? '● 在线' : '离线'
      }}</span>
      <span class="head-spacer"></span>
      <button v-if="isGroup" class="head-btn" title="成员" @click="showMembers = !showMembers">
        <PantryIcon name="users" :size="17" />
      </button>
    </header>

    <div class="body-wrap">
      <div ref="scrollArea" class="msgs" @scroll="onScroll">
      <div v-if="loadingEarlier" class="sep">加载更早的消息…</div>
      <template v-for="(msg, i) in chatStore.activeMessages" :key="msg.id">
        <div v-if="needSeparator(msg, i)" class="sep">{{ separatorTime(msg.ts) }}</div>
        <div v-if="msg.kind === 'system'" class="system-line">{{ msg.text }}</div>
        <div
          v-else-if="msg.status !== 'recalled'"
          :id="`msg-${msg.id}`"
          class="row"
          :class="[msg.isMine ? 'mine' : 'peer', { highlight: msg.id === chatStore.highlightId }]"
        >
          <span v-if="showGroupSender(msg)" class="msg-avatar" :style="senderAvatarStyle(msg)">
            {{ senderAvatarText(msg) }}
          </span>
          <span class="message-stack">
            <span v-if="showGroupSender(msg)" class="sender">{{ senderName(msg) }}</span>
            <FileCard
              v-if="msg.kind === 'file'"
              :msg="msg"
              class="message-surface"
              @contextmenu.prevent.stop="openMessageMenu($event, msg)"
            />
            <ImageBubble
              v-else-if="msg.kind === 'image' || msg.kind === 'sticker'"
              :msg="msg"
              class="message-surface"
              @forward="forwardMsg = msg"
            />
            <div
              v-else
              class="bubble message-surface"
              @contextmenu.prevent.stop="openMessageMenu($event, msg)"
            >
              <template v-for="(part, partIndex) in textParts(msg.text)" :key="partIndex">
                <button
                  v-if="part.url"
                  class="text-link"
                  type="button"
                  @click.stop="openTextLink(part.url)"
                >
                  {{ part.text }}
                </button>
                <span v-else>{{ part.text }}</span>
              </template>
            </div>
          </span>
          <span v-if="msg.isMine" class="status">
            <PantryIcon v-if="msg.status === 'sending'" class="spin" name="loader" :size="13" />
            <PantryIcon v-else-if="msg.status === 'sent'" class="ok" name="check" :size="13" />
            <span
              v-else-if="msg.status === 'queued'"
              class="queued"
              title="对方上线后自动送达"
              @click="chatStore.resend(msg.id)"
            >
              <PantryIcon name="clock" :size="13" />
            </span>
            <span v-else class="fail" title="发送失败，点击重发" @click="chatStore.resend(msg.id)"
              >!</span
            >
          </span>
        </div>
        <div v-if="msg.isMine && statusHint(msg)" class="hint" :class="msg.status">
          {{ statusHint(msg) }}
        </div>
      </template>
      </div>
      <GroupPanel
        v-if="isGroup && showMembers && group"
        :group="group"
        :self-id="chatStore.selfId"
        @close="showMembers = false"
      />
    </div>

    <button v-if="chatStore.viewingHistory" class="back-latest" @click="chatStore.backToLatest()">
      <PantryIcon name="chevron-down" :size="14" />回到最新
    </button>

    <div
      v-if="msgMenu"
      class="msg-menu"
      :style="{ left: `${msgMenu.x}px`, top: `${msgMenu.y}px` }"
      @click.stop
    >
      <button v-if="canCopyMessage(msgMenu.msg)" @click="copySelectedMessage">复制</button>
      <button v-if="canForwardMessage(msgMenu.msg)" @click="forwardSelectedMessage">转发</button>
      <button v-if="canRecallMessage(msgMenu.msg)" class="danger" @click="recallSelectedMessage">
        撤回
      </button>
    </div>

    <footer class="input-area">
      <div class="toolbar">
        <span ref="emojiScope" class="emoji-scope">
          <EmojiPanel
            v-if="showEmoji"
            :sticker-enabled="!isGroup && peerOnline"
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
      <textarea
        ref="inputEl"
        v-model="draft"
        class="input"
        :disabled="!canSend"
        :placeholder="inputPlaceholder"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>
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
  padding-bottom: 4px;
  position: relative;
}
.emoji-scope {
  display: inline-grid;
  place-items: center;
}
.mention-picker {
  position: absolute;
  left: 12px;
  bottom: 104px;
  width: 220px;
  max-height: 180px;
  overflow-y: auto;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 4;
}
.mention-picker button {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  padding: 7px 10px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}
.mention-picker button:hover {
  background: var(--line);
}
.row.highlight {
  animation: hl 2.4s ease;
  border-radius: 8px;
}
@keyframes hl {
  0%,
  60% {
    background: rgba(61, 139, 107, 0.16);
  }
  100% {
    background: transparent;
  }
}
.back-latest {
  position: absolute;
  right: 20px;
  bottom: 150px;
  border: 1px solid var(--line);
  background: var(--bg-window);
  border-radius: 14px;
  font-size: 12px;
  color: var(--primary);
  padding: 5px 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 4px;
}
.tool {
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  width: 30px;
  height: 28px;
  padding: 0;
  border-radius: 4px;
  display: grid;
  place-items: center;
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
  border-radius: 4px;
  background: rgba(35, 35, 35, 0.94);
  color: #fff;
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
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
  background: var(--line);
}
.tool:disabled {
  opacity: 0.35;
  cursor: default;
}
.tool-hint {
  font-size: 11px;
  color: var(--text-3);
}
.head {
  height: 52px;
  flex: 0 0 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  background: var(--bg-window);
  border-bottom: 1px solid var(--line);
  -webkit-app-region: no-drag;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.subtitle {
  font-size: 11px;
  line-height: 1.2;
  color: var(--text-3);
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
}
.msgs {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
}
.sender {
  font-size: 11px;
  color: var(--text-3);
  margin-left: 4px;
}
.head-spacer {
  flex: 1;
}
.head-btn {
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  width: 30px;
  height: 28px;
  padding: 0;
  border-radius: 4px;
  display: grid;
  place-items: center;
}
.head-btn:hover {
  background: var(--line);
}
.sep {
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  margin: 10px 0 6px;
}
.system-line {
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  margin: 8px 0;
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin: 4px 0;
}
.row.mine {
  flex-direction: row-reverse;
}
.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 13px;
  flex: 0 0 30px;
  align-self: flex-start;
  margin-top: 18px;
}
.message-stack {
  max-width: 64%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  flex-shrink: 0;
}
.row.mine .message-stack {
  align-items: flex-end;
}
.message-surface {
  flex-shrink: 0;
}
.bubble {
  max-width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
  user-select: text;
}
.row.peer .bubble {
  background: var(--bubble-peer);
}
.row.mine .bubble {
  background: var(--bubble-mine);
}
.text-link {
  border: none;
  background: transparent;
  color: var(--primary);
  font: inherit;
  line-height: inherit;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
  user-select: text;
}
.status {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
  margin-bottom: 4px;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
}
.status .ok {
  color: var(--online);
}
.status .fail {
  color: var(--danger);
  cursor: pointer;
  font-weight: 700;
  padding: 0 4px;
}
.status .queued {
  cursor: pointer;
  display: grid;
  place-items: center;
}
.msg-menu {
  position: fixed;
  min-width: 96px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 20;
}
.msg-menu button {
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
.msg-menu button:hover {
  background: var(--line);
}
.msg-menu button.danger {
  color: var(--danger);
}
.spin {
  display: inline-block;
  animation: rotate 1s linear infinite;
}
@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}
.hint {
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
  margin: 0 28px 4px 0;
}
.hint.failed {
  color: var(--danger);
}
.input-area {
  flex: 0 0 auto;
  background: var(--bg-window);
  border-top: 1px solid var(--line);
  padding: 8px 12px 10px;
}
.input {
  width: 100%;
  height: 72px;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  background: transparent;
  user-select: text;
}
.input-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
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
  padding: 6px 22px;
  border-radius: 4px;
  cursor: pointer;
}
.send:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
