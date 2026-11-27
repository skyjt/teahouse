<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ForwardTarget, MessageView } from '../../../shared/ipc'
import { usePeersStore } from '../stores/peers'
import { useGroupsStore } from '../stores/groups'
import { useChatStore } from '../stores/chat'
import PantryIcon from './PantryIcon.vue'

const props = defineProps<{ msg: MessageView }>()
const emit = defineEmits<{ close: [] }>()

const peersStore = usePeersStore()
const groupsStore = useGroupsStore()
const chatStore = useChatStore()

const picked = ref(new Set<string>())
const sending = ref(false)
const result = ref('')
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const dialogRef = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null

const allowGroup = computed(() => props.msg.kind === 'text')
const groups = computed(() => Object.values(groupsStore.byId).filter((g) => g.amMember))
const keyword = computed(() => query.value.trim().toLowerCase())
const forwardPeers = computed(() => peersStore.peers.filter((peer) =>
  !keyword.value || [peer.nick, peer.remark].some((name) => name.toLowerCase().includes(keyword.value))
))
const forwardGroups = computed(() => allowGroup.value
  ? groups.value.filter((group) => group.name.toLowerCase().includes(keyword.value))
  : []
)
const hasTargets = computed(() => peersStore.peers.length > 0 || (allowGroup.value && groups.value.length > 0))
const canSend = computed(() => picked.value.size > 0 && !sending.value)
const summary = computed(() => {
  if (props.msg.kind === 'text') return props.msg.text.slice(0, 50)
  if (props.msg.kind === 'image') return tr('[图片]')
  if (props.msg.kind === 'sticker') return tr('[表情]')
  return props.msg.fileRef ? tr('[文件] {0}', { 0: props.msg.fileRef.name }) : tr('[文件]')
})

function toggle(key: string): void {
  const next = new Set(picked.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  picked.value = next
  result.value = ''
}

function targets(): ForwardTarget[] {
  return [...picked.value]
    .map((key) => {
      const [type, id] = key.split(':')
      return type === 'group' || type === 'single' ? { type, id } : null
    })
    .filter((item): item is ForwardTarget => item !== null && item.id.length > 0)
}

async function forward(): Promise<void> {
  if (!canSend.value) return
  sending.value = true
  const res = await chatStore.forward(props.msg.id, targets())
  sending.value = false
  result.value = tr('已转发 {0}/{1}', { 0: res.ok, 1: res.total })
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing) return
  event.preventDefault()
  emit('close')
}

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onWindowKeydown)
  void nextTick(() => searchInput.value?.focus())
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown.self="emit('close')">
      <section
        ref="dialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-dialog-title"
        tabindex="-1"
        @mousedown.stop
      >
        <h3 id="forward-dialog-title">{{ tr('转发') }}</h3>
        <div class="summary">{{ summary }}</div>
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          class="search"
          :aria-label="tr('搜索转发目标')"
          :placeholder="allowGroup ? tr('搜索昵称、备注或讨论组') : tr('搜索昵称或备注')"
        />
        <div class="pick-list recipient-list">
          <label v-for="p in forwardPeers" :key="p.nodeId" class="pick recipient-option">
            <input
              type="checkbox"
              :checked="picked.has(`single:${p.nodeId}`)"
              @change="toggle(`single:${p.nodeId}`)"
            />
            <span class="dot" :class="p.online ? 'on' : 'off'"></span>
            <span class="nm">{{ p.remark || p.nick }}</span>
            <em v-if="!p.online" class="off-tag">{{ tr('离线') }}</em>
          </label>
          <label v-for="g in forwardGroups" :key="g.groupId" class="pick recipient-option">
            <input
              type="checkbox"
              :checked="picked.has(`group:${g.groupId}`)"
              @change="toggle(`group:${g.groupId}`)"
            />
            <span class="group-dot"><PantryIcon name="users" :size="13" /></span>
            <span class="nm">{{ g.name }}</span>
          </label>
          <p
            v-if="forwardPeers.length === 0 && forwardGroups.length === 0"
            class="empty"
            aria-live="polite"
          >{{ hasTargets ? tr('没有匹配的转发目标') : tr('没有可选目标') }}</p>
        </div>
        <div class="foot">
          <span class="count">{{ tr('已选 {0} 个目标', { 0: picked.size }) }}</span>
          <span class="result">{{ result }}</span>
          <button class="ghost" @click="emit('close')">{{ tr('取消') }}</button>
          <button class="primary" :disabled="!canSend" @click="forward">
            {{ sending ? tr('转发中') : tr('转发') }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  padding: 24px;
  background: var(--scrim);
  display: grid;
  place-items: center;
  z-index: 1200;
  animation: forward-mask-in var(--motion-feedback) ease-out;
}
.dialog {
  display: flex;
  flex-direction: column;
  width: min(380px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow: hidden;
  box-sizing: border-box;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: 18px 20px;
  box-shadow: var(--highlight-edge), var(--shadow-float);
  animation: forward-dialog-in var(--motion-enter) var(--ease-out);
}
.dialog:focus {
  outline: none;
}
h3 {
  flex-shrink: 0;
  font-size: 15px;
  margin-bottom: 10px;
}
.summary {
  flex-shrink: 0;
  max-height: 62px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: 8px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 10px;
  white-space: pre-wrap;
}
.search {
  flex-shrink: 0;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-window);
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
}
.search:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.search::placeholder {
  color: var(--text-placeholder);
}
.pick-list {
  min-height: 0;
  max-height: 240px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: 4px;
}
.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 8px;
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
.group-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #6b8e9e;
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 11px;
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
.foot {
  flex-shrink: 0;
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
.primary {
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-size: 13px;
  padding: 6px 18px;
  border-radius: var(--radius-panel);
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.4;
}
.ghost {
  border: 1px solid var(--line);
  background: transparent;
  border-radius: var(--radius-panel);
  font-size: 13px;
  padding: 6px 14px;
  cursor: pointer;
  color: var(--text-2);
}
@keyframes forward-mask-in {
  from {
    opacity: 0;
  }
}
@keyframes forward-dialog-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mask,
  .dialog {
    animation: none;
  }
}
</style>
