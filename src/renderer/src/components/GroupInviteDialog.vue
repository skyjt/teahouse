<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import type { GroupView } from '../../../shared/ipc'
import { GROUP_MAX_MEMBERS } from '../../../shared/protocol'
import { useGroupsStore } from '../stores/groups'
import GroupMemberPicker from './GroupMemberPicker.vue'

const props = defineProps<{ group: GroupView }>()
const emit = defineEmits<{ close: [] }>()

const groupsStore = useGroupsStore()
const selectedIds = ref<string[]>([])
const inviting = ref(false)
const error = ref('')
const dialogRef = ref<HTMLElement | null>(null)
const pickerRef = ref<InstanceType<typeof GroupMemberPicker> | null>(null)
let previousFocus: HTMLElement | null = null

const remaining = computed(() => Math.max(0, GROUP_MAX_MEMBERS - props.group.members.length))
const canInvite = computed(
  () =>
    props.group.amMember &&
    selectedIds.value.length > 0 &&
    selectedIds.value.length <= remaining.value &&
    !inviting.value
)

function updateSelection(ids: string[]): void {
  selectedIds.value = ids
  error.value = ''
}

function requestClose(): void {
  if (!inviting.value) emit('close')
}

async function invite(): Promise<void> {
  if (!canInvite.value) return
  error.value = ''
  inviting.value = true
  try {
    const updated = await window.pantry.updateGroup(props.group.groupId, {
      kind: 'invite',
      memberIds: [...selectedIds.value]
    })
    if (!updated) {
      error.value = tr('添加失败，请稍后重试')
      return
    }
    groupsStore.byId[updated.groupId] = updated
    emit('close')
  } catch {
    error.value = tr('添加失败，请稍后重试')
  } finally {
    inviting.value = false
  }
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || inviting.value) return
  event.preventDefault()
  emit('close')
}

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onWindowKeydown)
  void nextTick(() => {
    if (pickerRef.value) pickerRef.value.focusSearch()
    else dialogRef.value?.focus()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown.self="requestClose">
      <section
        ref="dialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-invite-dialog-title"
        tabindex="-1"
        @mousedown.stop
      >
        <header class="head">
          <h3 id="group-invite-dialog-title">{{ tr('添加群成员') }}</h3>
          <span>{{ tr('群内 {0} / {1} 人', { 0: group.members.length, 1: GROUP_MAX_MEMBERS }) }}</span>
        </header>

        <GroupMemberPicker
          ref="pickerRef"
          :selected-ids="selectedIds"
          :excluded-ids="group.members"
          :max-pick="remaining"
          :search-aria-label="tr('搜索可添加的群成员')"
          :selection-limit-label="tr('本群最多还可添加 {0} 人', { 0: remaining })"
          :empty-text="tr('所有联系人都已在群内')"
          @update:selected-ids="updateSelection"
        />

        <p class="error" aria-live="polite">{{ error }}</p>
        <div class="foot">
          <NButton size="small" secondary :disabled="inviting" @click="requestClose">{{ tr('取消') }}</NButton>
          <NButton
            type="primary"
            size="small"
            :disabled="!canInvite"
            :loading="inviting"
            @click="invite"
          >
            {{ inviting ? tr('添加中') : selectedIds.length > 0 ? tr('添加 {0} 人', { 0: selectedIds.length }) : tr('添加') }}
          </NButton>
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
  animation: group-invite-mask-in var(--motion-feedback) ease-out;
}
.dialog {
  width: min(460px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: 18px 20px;
  box-shadow: var(--highlight-edge), var(--shadow-float);
  animation: group-invite-dialog-in var(--motion-enter) var(--ease-out);
}
.dialog:focus {
  outline: none;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}
.head h3 {
  flex: 1;
  font-size: 15px;
}
.head span {
  color: var(--text-3);
  font-size: 12px;
}
.error {
  min-height: 18px;
  margin-top: 8px;
  color: var(--danger);
  font-size: 12px;
  line-height: 18px;
}
.foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
@keyframes group-invite-mask-in {
  from {
    opacity: 0;
  }
}
@keyframes group-invite-dialog-in {
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
