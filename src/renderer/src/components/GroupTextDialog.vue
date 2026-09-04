<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GroupView } from '../../../shared/ipc'
import PantryIcon from './PantryIcon.vue'

type GroupTextKind = 'description' | 'announce'

const props = withDefaults(
  defineProps<{
    group: GroupView
    kind: GroupTextKind
    busy?: boolean
    error?: string
  }>(),
  { busy: false, error: '' }
)
const emit = defineEmits<{
  close: []
  save: [value: string]
}>()

const value = ref('')
const initialValue = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
let previousFocus: HTMLElement | null = null

const isDescription = computed(() => props.kind === 'description')
const title = computed(() => (isDescription.value ? '设置群简介' : '设置群公告'))
const hint = computed(() =>
  isDescription.value
    ? '群简介将在群信息面板中展示，最多 200 字；留空可清空'
    : '群公告将在群信息面板中展示，最多 1,024 字；留空可清空'
)
const placeholder = computed(() => (isDescription.value ? '请输入群简介' : '请输入群公告'))
const maxLength = computed(() => (isDescription.value ? 200 : 1024))
const inputId = computed(() => (isDescription.value ? 'group-description-input' : 'group-announce-input'))
const normalizedValue = computed(() => value.value.trim())
const canSave = computed(() => !props.busy && normalizedValue.value !== initialValue.value)

function syncValue(): void {
  value.value = isDescription.value ? props.group.description ?? '' : props.group.announce ?? ''
  initialValue.value = value.value
}

function focusInput(): void {
  void nextTick(() => textareaRef.value?.focus())
}

function requestClose(): void {
  if (!props.busy) emit('close')
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || props.busy) return
  event.preventDefault()
  emit('close')
}

function save(): void {
  if (!canSave.value) return
  emit('save', normalizedValue.value)
}

watch(
  () => props.kind,
  () => {
    syncValue()
    focusInput()
  }
)

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  syncValue()
  window.addEventListener('keydown', onWindowKeydown)
  focusInput()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="mask" role="presentation" @mousedown.self="requestClose">
      <section
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-text-dialog-title"
        @mousedown.stop
      >
        <div class="header">
          <h3 id="group-text-dialog-title">{{ title }}</h3>
          <button
            class="close-btn"
            title="关闭"
            aria-label="关闭"
            :disabled="busy"
            @click="requestClose"
          >
            <PantryIcon name="x" :size="16" />
          </button>
        </div>
        <div class="body">
          <p class="hint">{{ hint }}</p>
          <textarea
            :id="inputId"
            ref="textareaRef"
            v-model="value"
            :maxlength="maxLength"
            :placeholder="placeholder"
            :aria-label="title"
            rows="5"
            class="textarea"
            :disabled="busy"
            @keydown.ctrl.enter.prevent="save"
            @keydown.meta.enter.prevent="save"
          ></textarea>
          <div class="char-count">{{ value.length }} / {{ maxLength }}</div>
          <div v-if="error" class="feedback" aria-live="polite">{{ error }}</div>
        </div>
        <div class="footer">
          <button class="ghost" :disabled="busy" @click="requestClose">取消</button>
          <button class="primary" :disabled="!canSave" @click="save">
            {{ busy ? '保存中…' : '保存' }}
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
  background: var(--scrim);
  display: grid;
  place-items: center;
  z-index: 1200;
  animation: mask-in 140ms ease-out;
}
.dialog {
  width: min(460px, calc(100vw - 32px));
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: dialog-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--line);
}
.header h3 {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: 600;
}
.close-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-3);
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-control);
}
.close-btn:hover {
  background: var(--bg-list);
  color: var(--text-1);
}
.close-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hint {
  font-size: var(--font-xs);
  color: var(--text-3);
  margin: 0;
}
.textarea {
  width: 100%;
  min-height: 120px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  padding: 8px 10px;
  font-size: var(--font-sm);
  line-height: 1.6;
  color: var(--text-1);
  background: var(--bg-list);
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}
.textarea:focus {
  border-color: var(--primary);
}
.textarea:disabled {
  opacity: 0.7;
  cursor: default;
}
.char-count {
  font-size: var(--font-xs);
  color: var(--text-3);
  text-align: right;
}
.feedback {
  font-size: var(--font-xs);
  color: var(--danger);
}
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--line);
}
.ghost {
  border: 1px solid var(--line);
  background: transparent;
  border-radius: var(--radius-control);
  font-size: var(--font-sm);
  padding: 6px 16px;
  cursor: pointer;
  color: var(--text-2);
}
.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}
.primary {
  border: none;
  background: var(--primary);
  color: var(--bg-window);
  font-size: var(--font-sm);
  padding: 6px 18px;
  border-radius: var(--radius-control);
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.4;
  cursor: default;
}
@keyframes mask-in {
  from { opacity: 0; }
}
@keyframes dialog-in {
  from { opacity: 0; transform: translateY(6px) scale(0.985); }
}
@media (prefers-reduced-motion: reduce) {
  .mask, .dialog { animation: none; }
}
</style>
