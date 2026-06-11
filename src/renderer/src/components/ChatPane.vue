<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { useTransfersStore } from '../stores/transfers'
import { separatorTime } from '../utils/time'
import FileCard from './FileCard.vue'
import ImageBubble from './ImageBubble.vue'
import type { MessageView } from '../../../shared/ipc'

const peersStore = usePeersStore()
const chatStore = useChatStore()
const transfersStore = useTransfersStore()
transfersStore.init()

const draft = ref('')
const dragging = ref(false)
const scrollArea = ref<HTMLElement | null>(null)

const peer = computed(() => {
  const conv = chatStore.activeConv
  if (!conv) return null
  return peersStore.peers.find((p) => p.nodeId === conv.peerId) ?? null
})
const peerName = computed(() => peer.value?.nick ?? '未知节点')
const peerOnline = computed(() => peer.value?.online ?? false)

const draftBytes = computed(() => new TextEncoder().encode(draft.value.trim()).length)
const overLimit = computed(() => draftBytes.value > 800)

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
watch(
  () => chatStore.activeMessages.length,
  (len, oldLen) => {
    if (len > (oldLen ?? 0)) scrollToBottom()
  }
)

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || overLimit.value) return
  draft.value = ''
  await chatStore.send(text)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return
  if (event.ctrlKey || event.metaKey) {
    draft.value += '\n' // Ctrl/Cmd+Enter 换行（设置可互换，v0.1 先按默认）
    return
  }
  event.preventDefault()
  void send()
}

function statusHint(msg: MessageView): string {
  if (msg.kind === 'file') return '' // 文件卡片自带状态行
  if (msg.status === 'queued') return '对方上线后自动送达'
  if (msg.status === 'failed') return '发送失败，点击重发'
  return ''
}

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
function isImagePath(path: string): boolean {
  const lower = path.toLowerCase()
  return IMG_EXTS.some((ext) => lower.endsWith(ext))
}

async function sendFiles(directory: boolean): Promise<void> {
  if (!peerOnline.value) return
  const paths = await window.pantry.pickFiles(directory)
  if (paths) await chatStore.sendFilePaths(paths)
}

async function sendImage(): Promise<void> {
  if (!peerOnline.value) return
  const paths = await window.pantry.pickFiles(false)
  if (!paths) return
  for (const p of paths) {
    if (isImagePath(p)) await chatStore.sendImagePath(p)
    else await chatStore.sendFilePaths([p])
  }
}

/** 截图 Ctrl+V：剪贴板里的图片直接发送（F-MSG-3） */
async function onPaste(event: ClipboardEvent): Promise<void> {
  if (!peerOnline.value || !event.clipboardData) return
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
  if (peerOnline.value) dragging.value = true
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragging.value = false
  if (!peerOnline.value || !event.dataTransfer) return
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
  <div class="chat" @dragover="onDragOver" @dragleave="dragging = false" @drop="onDrop">
    <div v-if="dragging" class="drop-mask">松手发送给 {{ peerName }}</div>
    <header class="head">
      <span class="title">{{ peerName }}</span>
      <span class="state" :class="{ on: peerOnline }">{{ peerOnline ? '● 在线' : '离线' }}</span>
    </header>

    <div ref="scrollArea" class="msgs">
      <template v-for="(msg, i) in chatStore.activeMessages" :key="msg.id">
        <div v-if="needSeparator(msg, i)" class="sep">{{ separatorTime(msg.ts) }}</div>
        <div class="row" :class="msg.isMine ? 'mine' : 'peer'">
          <FileCard v-if="msg.kind === 'file'" :msg="msg" />
          <ImageBubble v-else-if="msg.kind === 'image'" :msg="msg" />
          <div v-else class="bubble">
            <span class="text">{{ msg.text }}</span>
          </div>
          <span v-if="msg.isMine" class="status">
            <span v-if="msg.status === 'sending'" class="spin" title="发送中">◌</span>
            <span v-else-if="msg.status === 'sent'" class="ok" title="已送达">✓</span>
            <span
              v-else-if="msg.status === 'queued'"
              class="queued"
              title="对方上线后自动送达"
              @click="chatStore.resend(msg.id)"
              >🕐</span
            >
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

    <footer class="input-area">
      <div class="toolbar">
        <button class="tool" title="发送图片" :disabled="!peerOnline" @click="sendImage">🖼</button>
        <button class="tool" title="发送文件" :disabled="!peerOnline" @click="sendFiles(false)">
          📁
        </button>
        <button class="tool" title="发送文件夹" :disabled="!peerOnline" @click="sendFiles(true)">
          🗂
        </button>
        <span v-if="!peerOnline" class="tool-hint">对方离线，无法发送图片/文件</span>
      </div>
      <textarea
        v-model="draft"
        class="input"
        placeholder="输入消息，Enter 发送，Ctrl+Enter 换行；粘贴截图直接发送"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>
      <div class="input-bar">
        <span v-if="draftBytes > 600" class="counter" :class="{ over: overLimit }">
          {{ draftBytes }} / 800 字节{{ overLimit ? '（超长文本将在 v0.2 随 TCP 通道支持）' : '' }}
        </span>
        <button class="send" :disabled="!draft.trim() || overLimit" @click="send">发送</button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-chat);
  position: relative;
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
}
.tool {
  border: none;
  background: transparent;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
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
.state {
  font-size: 12px;
  color: var(--text-3);
}
.state.on {
  color: var(--online);
}
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}
.sep {
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  margin: 10px 0 6px;
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
.bubble {
  max-width: 64%;
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
.status {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
  margin-bottom: 4px;
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
