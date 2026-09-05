<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
const emit = defineEmits<{ close: [] }>()

const peersStore = usePeersStore()
const chatStore = useChatStore()
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
  return names.length > 0 ? `${names.join('、')} 的讨论组` : '讨论组'
})

const passwordError = computed(() => {
  const password = adminPassword.value.trim()
  const confirm = adminPasswordConfirm.value.trim()
  if (!password && !confirm) {
    return adminHint.value.trim() ? '密码提示需要先设置管理密码' : ''
  }
  if (!password || !confirm) return '请完整输入两次管理密码'
  if (password !== confirm) return '两次输入的管理密码不一致'
  return ''
})

// 建群时本机会自动入组，可选他人最多 GROUP_MAX_MEMBERS - 1
const canNext = computed(() => pickedIds.value.length >= 1)
const canCreate = computed(() => canNext.value && !passwordError.value && !creating.value)

watch(pickedIds, (ids) => {
  if (ids.length === 0) step.value = 'members'
})

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
      createError.value = '创建失败，请检查成员后重试。'
      return
    }
    await chatStore.openConv(`group:${group.groupId}`).catch(() => undefined)
    emit('close')
  } catch {
    createError.value = '创建失败，请重试。'
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
onMounted(() => document.addEventListener('keydown', onEscape))
onUnmounted(() => document.removeEventListener('keydown', onEscape))
</script>

<template>
  <div
    class="mask"
    @pointerdown="rememberMaskPointerDown"
    @click.self="requestMaskClose"
  >
    <div class="dialog" role="dialog" aria-modal="true" aria-label="发起讨论组">
      <header class="head">
        <h3>发起讨论组</h3>
        <div class="steps">
          <span :class="{ active: step === 'members' }">选人</span>
          <span :class="{ active: step === 'settings' }">设置</span>
        </div>
      </header>

      <section v-if="step === 'settings'" class="page">
        <div class="field">
          <label for="group-name">组名</label>
          <NInput
            v-model:value="name"
            class="form-input"
            maxlength="32"
            :placeholder="fallbackName"
            :input-props="{ id: 'group-name' }"
          />
        </div>
        <div class="field">
          <label for="group-admin-password">管理密码</label>
          <NInput
            v-model:value="adminPassword"
            class="form-input"
            maxlength="64"
            type="password"
            placeholder="选填；留空仅创建 IP 可管理"
            :input-props="{ id: 'group-admin-password' }"
          />
        </div>
        <div class="field">
          <label for="group-admin-password-confirm">确认密码</label>
          <NInput
            v-model:value="adminPasswordConfirm"
            class="form-input"
            maxlength="64"
            type="password"
            placeholder="再次输入管理密码"
            :input-props="{ id: 'group-admin-password-confirm' }"
          />
        </div>
        <div class="field">
          <label for="group-admin-hint">密码提示</label>
          <NInput
            v-model:value="adminHint"
            class="form-input"
            maxlength="40"
            placeholder="选填；成员输入密码时显示"
            :input-props="{ id: 'group-admin-hint' }"
          />
        </div>
        <p v-if="passwordError || createError" class="error" aria-live="polite">
          {{ passwordError || createError }}
        </p>
        <p v-else class="hint">管理密码不会保存明文；提示只用于帮成员回忆密码。</p>
      </section>

      <GroupMemberPicker
        v-model:selected-ids="pickedIds"
        :class="{ 'member-picker-page': step === 'members' }"
        :max-pick="maxPickOthers"
        :show-list="step === 'members'"
        autofocus
        search-aria-label="搜索讨论组成员"
        :selection-limit-label="`+你，最多 ${GROUP_MAX_MEMBERS}`"
      />

      <div class="foot">
        <NButton
          size="small"
          secondary
          :disabled="creating"
          @click="backOrClose"
        >
          {{ step === 'settings' ? '上一步' : '取消' }}
        </NButton>
        <NButton
          v-if="step === 'members'"
          type="primary"
          size="small"
          :disabled="!canNext"
          @click="nextStep"
        >
          下一步
        </NButton>
        <NButton
          v-else
          type="primary"
          size="small"
          :disabled="!canCreate"
          :loading="creating"
          @click="create"
        >
          {{ creating ? '创建中' : '创建' }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: grid;
  place-items: center;
  z-index: 15;
}
.dialog {
  width: 460px;
  background: var(--bg-window);
  border-radius: 8px;
  padding: 18px 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
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
