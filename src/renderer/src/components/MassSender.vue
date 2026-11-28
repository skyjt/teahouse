<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, ref } from 'vue'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { TEXT_TCP_LIMIT, TEXT_UDP_LIMIT } from '../../../shared/protocol'

// ⚠️ 已停用（决议 #62，2026-06-13）：群发功能取消——建讨论组即可满足同样诉求，
// 群发（拆成多个单聊逐发）无实际意义。本组件已无任何引用（App.vue 入口已注释），
// 保留全文留痕，便于日后需要时恢复。请勿在新代码中重新挂载。
//
// 多选收件人群发（requirements 决议 #3）：拆成多个单聊上下文发送，不引入群发协议。

const emit = defineEmits<{ close: [] }>()
const peersStore = usePeersStore()
const chatStore = useChatStore()

const picked = ref(new Set<string>())
const text = ref('')
const sending = ref(false)
const result = ref('')

const bytes = computed(() => new TextEncoder().encode(text.value.trim()).length)
const overUdpLimit = computed(() => bytes.value > TEXT_UDP_LIMIT)
const overLimit = computed(() => bytes.value > TEXT_TCP_LIMIT)
const canSend = computed(
  () => picked.value.size > 0 && text.value.trim().length > 0 && !overLimit.value && !sending.value
)

function toggle(nodeId: string): void {
  const next = new Set(picked.value)
  if (next.has(nodeId)) next.delete(nodeId)
  else next.add(nodeId)
  picked.value = next
  result.value = ''
}

async function sendAll(): Promise<void> {
  if (!canSend.value) return
  sending.value = true
  result.value = ''
  const body = text.value.trim()
  const ids = [...picked.value]
  let ok = 0
  for (const id of ids) {
    const view = await window.pantry.sendText(id, body)
    if (view) ok += 1
  }
  sending.value = false
  result.value = tr('已发送 {0}/{1}', { 0: ok, 1: ids.length })
  if (ids[0]) await chatStore.openPeer(ids[0])
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <h3>{{ tr('群发消息') }}</h3>
      <div class="pick-list recipient-list">
        <label v-for="p in peersStore.peers" :key="p.nodeId" class="pick recipient-option">
          <input type="checkbox" :checked="picked.has(p.nodeId)" @change="toggle(p.nodeId)" />
          <span class="dot" :class="p.online ? 'on' : 'off'"></span>
          <span class="nm">{{ p.remark || p.nick }}</span>
          <em v-if="!p.online" class="off-tag">{{ tr('离线') }}</em>
        </label>
        <p v-if="peersStore.peers.length === 0" class="empty">{{ tr('还没有发现任何节点') }}</p>
      </div>
      <textarea v-model="text" class="message" :maxlength="TEXT_TCP_LIMIT"></textarea>
      <div class="foot">
        <span class="count">{{ tr('已选 {0} 人', { 0: picked.size }) }}<template v-if="bytes > 600">{{ tr('· {0} / {1} 字节', { 0: bytes, 1: TEXT_TCP_LIMIT }) }}<template v-if="overUdpLimit && !overLimit">· TCP</template>
          </template>
        </span>
        <span class="result" :class="{ over: overLimit }">{{ overLimit ? tr('文本过长') : result }}</span>
        <button class="ghost" @click="emit('close')">{{ tr('取消') }}</button>
        <button class="primary" :disabled="!canSend" @click="sendAll">
          {{ sending ? tr('发送中') : tr('发送') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  z-index: 15;
}
.dialog {
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  border: 1px solid var(--line);
  background: var(--bg-window);
  border-radius: var(--radius-panel);
  padding: 18px 20px;
  box-shadow: var(--shadow-float);
}
h3 {
  font-size: 15px;
  margin-bottom: 12px;
}
.pick-list {
  max-height: 180px;
  overscroll-behavior: contain;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px;
  margin-bottom: 10px;
}
.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.dot.on {
  background: var(--online);
}
.dot.off {
  background: var(--offline);
}
.nm {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.off-tag {
  font-style: normal;
  font-size: 11px;
  color: var(--text-3);
}
.empty {
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
  padding: 16px 0;
}
.message {
  width: 100%;
  height: 110px;
  resize: none;
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-1);
  border-radius: 4px;
  padding: 8px;
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  user-select: text;
}
.message:focus {
  border-color: var(--primary);
}
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.count {
  flex: 1;
  font-size: 12px;
  color: var(--text-3);
}
.result {
  font-size: 12px;
  color: var(--primary);
}
.result.over {
  color: var(--danger);
}
.primary {
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-size: 13px;
  padding: 6px 18px;
  border-radius: 4px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.4;
}
.ghost {
  border: 1px solid var(--line);
  background: transparent;
  border-radius: 4px;
  font-size: 13px;
  padding: 6px 14px;
  cursor: pointer;
  color: var(--text-2);
}
</style>
