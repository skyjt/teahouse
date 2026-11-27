<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, ref, watch } from 'vue'
import { NInput } from 'naive-ui'
import type { PeerView } from '../../../shared/ipc'
import { usePeersStore } from '../stores/peers'
import {
  filterGroupMemberCandidates,
  normalizeGroupMemberSelection,
  toggleGroupMemberSelection
} from '../utils/group-member-picker'
import PantryIcon from './PantryIcon.vue'

const props = withDefaults(
  defineProps<{
    selectedIds: string[]
    excludedIds?: string[]
    maxPick: number
    searchAriaLabel: string
    selectionLimitLabel: string
    emptyText?: string
    autofocus?: boolean
    showList?: boolean
  }>(),
  {
    excludedIds: () => [],
    emptyText: tr('没有可选联系人'),
    autofocus: false,
    showList: true
  }
)
const emit = defineEmits<{ 'update:selectedIds': [ids: string[]] }>()

const peersStore = usePeersStore()
const query = ref('')
const searchInput = ref<InstanceType<typeof NInput> | null>(null)
const excludedSet = computed(() => new Set(props.excludedIds))
const availableRows = computed(() =>
  filterGroupMemberCandidates(peersStore.peers, excludedSet.value, '')
)
const filteredRows = computed(() =>
  filterGroupMemberCandidates(peersStore.peers, excludedSet.value, query.value)
)
const selectedPeers = computed(() =>
  props.selectedIds
    .map((id) => peersStore.byId(id))
    .filter((peer): peer is PeerView => !!peer && !excludedSet.value.has(peer.nodeId))
)
const atPickCap = computed(() => props.selectedIds.length >= props.maxPick)

function displayName(peer: PeerView): string {
  return peer.remark || peer.nick
}

function toggle(nodeId: string): void {
  emit(
    'update:selectedIds',
    toggleGroupMemberSelection(props.selectedIds, nodeId, props.maxPick)
  )
}

function removePicked(nodeId: string): void {
  emit(
    'update:selectedIds',
    props.selectedIds.filter((id) => id !== nodeId)
  )
}

function focusSearch(): void {
  searchInput.value?.focus()
}

watch(
  () => ({
    selectedIds: props.selectedIds,
    excludedIds: props.excludedIds,
    maxPick: props.maxPick
  }),
  ({ selectedIds, excludedIds, maxPick }) => {
    const normalized = normalizeGroupMemberSelection(
      selectedIds,
      new Set(excludedIds),
      maxPick
    )
    if (
      normalized.length !== selectedIds.length ||
      normalized.some((id, index) => id !== selectedIds[index])
    ) {
      emit('update:selectedIds', normalized)
    }
  },
  { immediate: true }
)

defineExpose({ focusSearch })
</script>

<template>
  <div class="member-picker">
    <template v-if="showList">
      <NInput
        ref="searchInput"
        v-model:value="query"
        class="search"
        size="small"
        maxlength="40"
        :autofocus="autofocus"
        :placeholder="tr('搜索联系人、部门、团队或 IP')"
        :input-props="{ 'aria-label': searchAriaLabel }"
      />
      <div class="pick-list recipient-list">
        <label
          v-for="{ peer: p, organization } in filteredRows"
          :key="p.nodeId"
          class="pick recipient-option"
          :class="{ disabled: atPickCap && !selectedIds.includes(p.nodeId) }"
        >
          <input
            type="checkbox"
            :checked="selectedIds.includes(p.nodeId)"
            :disabled="atPickCap && !selectedIds.includes(p.nodeId)"
            @change="toggle(p.nodeId)"
          />
          <span class="dot" :class="p.online ? 'on' : 'off'"></span>
          <span class="person" :class="{ 'has-meta': organization }">
            <span class="nm" :title="displayName(p)">{{ displayName(p) }}</span>
            <span v-if="organization" class="meta" :title="organization">
              {{ organization }}
            </span>
          </span>
          <em v-if="!p.online" class="off-tag">{{ tr('离线') }}</em>
        </label>
        <p v-if="peersStore.peers.length === 0" class="empty">{{ tr('还没有发现任何节点') }}</p>
        <p v-else-if="availableRows.length === 0" class="empty">{{ emptyText }}</p>
        <p v-else-if="filteredRows.length === 0" class="empty">{{ tr('没有匹配的联系人') }}</p>
      </div>
    </template>

    <div v-if="selectedPeers.length > 0" class="picked-bar">
      <span class="count">{{ tr('已选 {0} 人（{1}）', { 0: selectedPeers.length, 1: selectionLimitLabel }) }}</span>
      <button
        v-for="peer in selectedPeers"
        :key="peer.nodeId"
        class="chip"
        type="button"
        @click="removePicked(peer.nodeId)"
      >
        <span>{{ displayName(peer) }}</span>
        <PantryIcon name="x" :size="12" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.search {
  width: 100%;
  margin-bottom: 10px;
}
.pick-list {
  max-height: 274px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px;
}
.pick {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 3px 7px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}
.pick.disabled {
  opacity: 0.45;
  cursor: default;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.on {
  background: var(--online);
}
.dot.off {
  background: var(--offline);
}
.person {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
  overflow: hidden;
}
.nm,
.meta {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nm {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  font-weight: 500;
}
.person.has-meta .nm {
  max-width: 48%;
}
.meta {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
}
.off-tag {
  flex-shrink: 0;
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
.picked-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
  padding-right: 3px;
  margin-top: 10px;
  max-height: 76px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.count {
  color: var(--text-3);
  font-size: 12px;
  flex: 0 0 auto;
  margin-right: 2px;
}
.chip {
  max-width: 76px;
  height: 24px;
  border: none;
  border-radius: 4px;
  padding: 0 6px;
  background: var(--primary-weak);
  color: var(--primary);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
}
.chip span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
