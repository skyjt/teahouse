<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import type { PeerView } from '../../../shared/ipc'
import { GROUP_MAX_MEMBERS } from '../../../shared/protocol'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import {
  shouldCloseGroupCreatorFromMask,
  snapshotGroupMemberIds
} from '../utils/group-creator'
import GroupMemberPicker from './GroupMemberPicker.vue'
import { isPlainEscape } from '../utils/escape'

// 发起讨论组（ui-design §7.1）：搜索选人 → 下一步设置组名 / 管理密码 / 密码提示。

const props = defineProps<{ preselect?: string[] }>()
const emit = defineEmits<{ close: []; created: [] }>()

const peersStore = usePeersStore()
const chatStore = useChatStore()
const dialogEl = ref<HTMLDialogElement | null>(null)
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
const step = ref<'members' | 'settings'>('members')
const name = ref('')
const adminPassword = ref('')
const adminPasswordConfirm = ref('')
const adminHint = ref('')
const maxPickOthers = GROUP_MAX_MEMBERS - 1
const pickedIds = ref(
  [...new Set(props.preselect ?? [])]
    .filter((id) => !!peersStore.byId(id))
    .slice(0, maxPickOthers)
)
const creating = ref(false)
const createError = ref('')
let maskPointerStartedOnMask = false

const selectedPeers = computed(() =>
  pickedIds.value
    .map((id) => peersStore.byId(id))
    .filter((peer): peer is PeerView => !!peer)
)

const fallbackName = computed(() => {
  const names = selectedPeers.value.slice(0, 3).map((peer) => displayName(peer))
  return names.length > 0 ? tr('{0} 的讨论组', { 0: names.join('、') }) : tr('讨论组')
})

const passwordError = computed(() => {
  const password = adminPassword.value.trim()
  const confirm = adminPasswordConfirm.value.trim()
  if (!password && !confirm) {
    return adminHint.value.trim() ? tr('密码提示需要先设置管理密码') : ''
  }
  if (!password || !confirm) return tr('请完整输入两次管理密码')
  if (password !== confirm) return tr('两次输入的管理密码不一致')
  return ''
})

// 建群时本机会自动入组，可选他人最多 GROUP_MAX_MEMBERS - 1
const canNext = computed(() => pickedIds.value.length >= 1)
const canCreate = computed(() => canNext.value && !passwordError.value && !creating.value)

watch(pickedIds, (ids) => {
  if (ids.length === 0) step.value = 'members'
})

watch(step, async (current) => {
  await nextTick()
  const selector = current === 'settings' ? '#group-name' : 'input'
  dialogEl.value?.querySelector<HTMLInputElement>(selector)?.focus()
})

function containTab(event: KeyboardEvent): void {
  const controls = Array.from(dialogEl.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]'
  ) ?? []).filter((el) => el.getClientRects().length && !el.closest('details:not([open]) > :not(summary)'))
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function displayName(peer: PeerView): string {
  return peer.remark || peer.nick
}

function nextStep(): void {
  if (!canNext.value) return
  if (!name.value.trim()) name.value = fallbackName.value
  step.value = 'settings'
}

async function create(): Promise<void> {
  if (!canCreate.value) return
  creating.value = true
  createError.value = ''
  try {
    const group = await window.pantry.createGroup(
      name.value.trim() || fallbackName.value,
      snapshotGroupMemberIds(pickedIds.value),
      adminPassword.value.trim(),
      adminHint.value.trim()
    )
    if (!group) {
      createError.value = tr('创建失败，请检查成员后重试。')
      return
    }
    await chatStore.openConv(`group:${group.groupId}`).catch(() => undefined)
    emit('created')
    emit('close')
  } catch {
    createError.value = tr('创建失败，请重试。')
  } finally {
    creating.value = false
  }
}

function rememberMaskPointerDown(event: PointerEvent): void {
  maskPointerStartedOnMask = event.target === event.currentTarget
}

function requestMaskClose(): void {
  const shouldClose = shouldCloseGroupCreatorFromMask(maskPointerStartedOnMask, creating.value)
  maskPointerStartedOnMask = false
  if (shouldClose) emit('close')
}

function backOrClose(): void {
  if (creating.value) return
  if (step.value === 'settings') step.value = 'members'
  else emit('close')
}

function onEscape(event: KeyboardEvent): void {
  if (!isPlainEscape(event)) return
  event.preventDefault()
  if (!creating.value) emit('close')
}
onMounted(() => {
  dialogEl.value?.showModal()
  dialogEl.value?.querySelector<HTMLInputElement>('input')?.focus()
  document.addEventListener('keydown', onEscape)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onEscape)
  if (opener?.isConnected) opener.focus()
})
</script>

<template>
  <dialog ref="dialogEl"
    class="mask" :aria-label="tr('发起讨论组')" @keydown.tab="containTab" @cancel.prevent
    @pointerdown="rememberMaskPointerDown"
    @click.self="requestMaskClose"
  >
    <div class="dialog">
      <header class="head">
        <h3>{{ tr('发起讨论组') }}</h3>
        <div class="steps">
          <span :class="{ active: step === 'members' }">{{ tr('选人') }}</span>
          <span :class="{ active: step === 'settings' }">{{ tr('设置') }}</span>
        </div>
      </header>

      <section v-if="step === 'settings'" class="page">
        <div class="field">
          <label for="group-name">{{ tr('组名') }}</label>
          <NInput
            v-model:value="name"
            class="form-input"
            maxlength="32"
            :placeholder="fallbackName"
            :input-props="{ id: 'group-name' }"
          />
        </div>
        <details class="admin-options">
          <summary>{{ tr('管理设置（选填）') }}</summary>
          <div class="field">
            <label for="group-admin-password">{{ tr('管理密码') }}</label>
            <NInput
              v-model:value="adminPassword"
              class="form-input"
              maxlength="64"
              type="password"
              :placeholder="tr('选填；留空仅创建 IP 可管理')"
              :input-props="{ id: 'group-admin-password' }"
            />
          </div>
          <div class="field">
            <label for="group-admin-password-confirm">{{ tr('确认密码') }}</label>
            <NInput
              v-model:value="adminPasswordConfirm"
              class="form-input"
              maxlength="64"
              type="password"
              :placeholder="tr('再次输入管理密码')"
              :input-props="{ id: 'group-admin-password-confirm' }"
            />
          </div>
          <div class="field">
            <label for="group-admin-hint">{{ tr('密码提示') }}</label>
            <NInput
              v-model:value="adminHint"
              class="form-input"
              maxlength="40"
              :placeholder="tr('选填；成员输入密码时显示')"
              :input-props="{ id: 'group-admin-hint' }"
            />
          </div>
          <p class="hint">{{ tr('管理密码不会保存明文；提示只用于帮成员回忆密码。') }}</p>
        </details>
        <p v-if="passwordError || createError" class="error" aria-live="polite">{{ passwordError || createError }}</p>
      </section>

      <GroupMemberPicker
        v-model:selected-ids="pickedIds"
        :class="{ 'member-picker-page': step === 'members' }"
        :max-pick="maxPickOthers"
        :show-list="step === 'members'"
        autofocus
        :search-aria-label="tr('搜索讨论组成员')"
        :selection-limit-label="tr('+你，最多 {0}', { 0: GROUP_MAX_MEMBERS })"
      />

      <div class="foot">
        <NButton
          size="small"
          secondary
          :disabled="creating"
          @click="backOrClose"
        >
          {{ step === 'settings' ? tr('上一步') : tr('取消') }}
        </NButton>
        <NButton
          v-if="step === 'members'"
          type="primary"
          size="small"
          :disabled="!canNext"
          @click="nextStep"
        >{{ tr('下一步') }}</NButton>
        <NButton
          v-else
          type="primary"
          size="small"
          :disabled="!canCreate"
          :loading="creating"
          @click="create"
        >
          {{ creating ? tr('创建中') : tr('创建') }}
        </NButton>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.mask[open] {
  padding: 0;
  margin: 0;
  border: 0;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  color: var(--text-1);
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  z-index: 15;
}
.mask::backdrop { background: transparent; }
.admin-options summary { cursor: pointer; margin: 8px 0 12px; }
.dialog {
  width: min(460px, 94vw);
  max-height: 94vh;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: 18px 20px;
  box-shadow: var(--shadow-float);
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
h3 {
  font-size: 15px;
  flex: 1;
}
.steps {
  display: flex;
  gap: 6px;
  color: var(--text-3);
  font-size: 12px;
}
.steps span {
  border-radius: 4px;
  padding: 2px 7px;
}
.steps .active {
  color: var(--primary);
  background: var(--primary-weak);
}
.page,
.member-picker-page {
  min-height: 318px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-2);
}
.form-input {
  width: 100%;
}
.hint,
.error {
  font-size: 12px;
  line-height: 1.5;
}
.hint {
  color: var(--text-3);
}
.error {
  color: var(--danger);
}
.foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
