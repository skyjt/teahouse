<script setup lang="ts">
import { computed } from 'vue'
import type { MessageView } from '../../../shared/ipc'
import type { PkGame } from '../../../shared/pk'
import { splitEmojiText } from '../utils/compat-emoji'
import { messageStatusHint, shouldShowSeparator, textParts } from '../utils/message-row'
import { separatorTime } from '../utils/time'
import AvatarMark from './AvatarMark.vue'
import CompatEmoji from './CompatEmoji.vue'
import FileCard from './FileCard.vue'
import ImageBubble from './ImageBubble.vue'
import PantryIcon from './PantryIcon.vue'
import PkBubble from './PkBubble.vue'

const props = defineProps<{
  msg: MessageView
  prevTs: number | null
  isGroupConv: boolean
  senderName: string
  senderAvatar: number
  senderAvatarHash: string
  highlighted: boolean
  canSendPk: boolean
  pkDisabledReason: string
  recallVisible: boolean
  recallDisabledReason: string
}>()

const emit = defineEmits<{
  contextmenu: [event: MouseEvent, msg: MessageView]
  forward: [msg: MessageView]
  recall: [msg: MessageView]
  'participate-pk': [game: PkGame]
  resend: [msgId: string]
  'reply-to': [msgId: string]
}>()

const showSeparator = computed(() => shouldShowSeparator(props.msg.ts, props.prevTs))
const showGroupSender = computed(
  () =>
    props.isGroupConv &&
    !props.msg.isMine &&
    props.msg.kind !== 'system' &&
    props.msg.status !== 'recalled'
)
const parts = computed(() => textParts(props.msg.text))
const statusHint = computed(() => messageStatusHint(props.msg.kind, props.msg.status))

function openMessageMenu(event: MouseEvent): void {
  emit('contextmenu', event, props.msg)
}

function openTextLink(url: string): void {
  void window.pantry.openUrl(url)
}

/** 文件柜上传提示：点一下直接打开本机落盘目录（决议 #274） */
function revealSystemTarget(): void {
  const transferId = props.msg.fileRef?.transferId
  if (transferId) void window.pantry.revealTransfer(transferId)
}
</script>

<template>
  <div v-if="showSeparator" class="sep">{{ separatorTime(props.msg.ts) }}</div>
  <!-- 文件柜上传提示（决议 #274）带 fileRef，可点开落盘目录；其余系统提示是纯文本 -->
  <button
    v-if="props.msg.kind === 'system' && props.msg.fileRef"
    class="system-line system-action"
    @click="revealSystemTarget"
  >
    {{ props.msg.text }}
  </button>
  <div v-else-if="props.msg.kind === 'system'" class="system-line">{{ props.msg.text }}</div>
  <div
    v-else-if="props.msg.status !== 'recalled'"
    :id="`msg-${props.msg.id}`"
    class="row"
    :class="[props.msg.isMine ? 'mine' : 'peer', { highlight: props.highlighted }]"
  >
    <AvatarMark
      v-if="showGroupSender"
      class="msg-avatar"
      :avatar="props.senderAvatar"
      :avatar-hash="props.senderAvatarHash"
      :name="props.senderName"
    />
    <span class="message-stack">
      <span v-if="showGroupSender" class="sender">{{ props.senderName }}</span>
      <FileCard
        v-if="props.msg.kind === 'file'"
        :msg="props.msg"
        class="message-surface"
        @contextmenu.prevent.stop="openMessageMenu"
      />
      <ImageBubble
        v-else-if="props.msg.kind === 'image' || props.msg.kind === 'sticker'"
        :msg="props.msg"
        class="message-surface"
        :recall-visible="props.recallVisible"
        :recall-disabled-reason="props.recallDisabledReason"
        @forward="emit('forward', props.msg)"
        @recall="emit('recall', props.msg)"
      />
      <PkBubble
        v-else-if="props.msg.kind === 'pk'"
        :msg="props.msg"
        :mine="props.msg.isMine"
        :show-action="!props.msg.isMine"
        :action-disabled="!props.canSendPk"
        :disabled-reason="props.pkDisabledReason"
        class="message-surface"
        @participate="emit('participate-pk', $event)"
        @contextmenu.prevent.stop="openMessageMenu"
      />
      <div
        v-else
        class="bubble message-surface"
        @contextmenu.prevent.stop="openMessageMenu"
      >
        <template v-for="(part, partIndex) in parts" :key="partIndex">
          <button
            v-if="part.url"
            class="text-link"
            type="button"
            @click.stop="openTextLink(part.url)"
          >
            {{ part.text }}
          </button>
          <span v-else>
            <template
              v-for="(emojiPart, emojiPartIndex) in splitEmojiText(part.text)"
              :key="emojiPartIndex"
            >
              <CompatEmoji v-if="emojiPart.emoji" :emoji="emojiPart.text" />
              <span v-else>{{ emojiPart.text }}</span>
            </template>
          </span>
        </template>
      </div>
      <div v-if="props.msg.replyTo" class="reply-quote" @click.stop="$emit('reply-to', props.msg.replyTo.id)">
        <span class="reply-quote-label">引用</span>
        <span class="reply-quote-sender" v-if="props.msg.replyTo.senderName">{{ props.msg.replyTo.senderName }}：</span>
        <span class="reply-quote-text">{{ props.msg.replyTo.text }}</span>
      </div>
    </span>
    <span v-if="props.msg.isMine" class="status">
      <PantryIcon v-if="props.msg.status === 'sending'" class="spin" name="loader" :size="13" />
      <PantryIcon v-else-if="props.msg.status === 'sent'" class="ok" name="check" :size="13" />
      <PantryIcon
        v-else-if="props.msg.status === 'canceled'"
        class="canceled"
        name="x"
        :size="13"
        title="发送取消"
      />
      <span
        v-else-if="props.msg.status === 'queued'"
        class="queued"
        title="对方上线后自动送达"
        @click="emit('resend', props.msg.id)"
      >
        <PantryIcon name="clock" :size="13" />
      </span>
      <span
        v-else
        class="fail"
        title="发送失败，点击重发"
        @click="emit('resend', props.msg.id)"
      >
        !
      </span>
    </span>
  </div>
  <div v-if="props.msg.isMine && statusHint" class="hint" :class="props.msg.status">
    {{ statusHint }}
  </div>
</template>

<style scoped>
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
  margin: 10px 0;
}
.system-action {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  cursor: pointer;
}
.system-action:hover {
  color: var(--primary);
  text-decoration: underline;
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin: 6px 0;
}
.row.mine {
  flex-direction: row-reverse;
}
.row.highlight {
  animation: hl 2.4s ease;
  border-radius: 14px;
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
  max-width: 68%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  flex-shrink: 0;
}
.row.mine .message-stack {
  align-items: flex-end;
}
.sender {
  font-size: 11px;
  color: var(--text-3);
  margin-left: 4px;
}
.message-surface {
  flex-shrink: 0;
}
.reply-quote {
  max-width: 100%;
  padding: 5px 9px;
  border-radius: 8px;
  border-left: 2px solid var(--primary);
  background: rgb(0 0 0 / 6%);
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-2);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  display: flex;  /* 使用 flex 布局 */
  align-items: baseline;  /* 基线对齐 */
  gap: 4px;  /* 元素间距 */
}
.reply-quote:hover {
  background: rgba(61, 139, 107, 0.12);
  border-left-color: rgba(61, 139, 107, 0.7);
}
.row.mine .reply-quote {
  border-left-color: rgba(61, 139, 107, 0.5);
}
.row.mine .reply-quote:hover {
  border-left-color: rgba(61, 139, 107, 0.8);
}
.reply-quote-label {
  display: none;
}
.reply-quote-sender {
  font-weight: 600;
  color: var(--primary);
  /* margin-right: 4px; */
  flex-shrink: 0;  /* 不收缩，保持完整 */
  white-space: nowrap;  /* 强制不换行 */
}
.reply-quote-text {
  flex: 1;  /* 占据剩余空间 */
  min-width: 0;  /* 关键：允许收缩 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}
.bubble {
  max-width: 100%;
  padding: 9px 13px;
  border: 1px solid transparent;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
  user-select: text;
}
.row.peer .bubble {
  background: var(--bubble-peer);
  border-color: var(--line);
  box-shadow: 0 5px 16px rgba(24, 50, 37, 0.055);
}
.row.mine .bubble {
  background: var(--bubble-mine);
  border-color: rgba(61, 139, 107, 0.1);
  box-shadow: none;
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
.status .canceled {
  color: var(--text-3);
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
@media (prefers-reduced-motion: reduce) {
  .row.highlight,
  .spin {
    animation: none;
  }
}
</style>
