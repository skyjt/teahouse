<script setup lang="ts">
import { tr, language } from '../utils/i18n'
import { computed, ref } from 'vue'
import type { PeerView } from '../../../shared/ipc'
import { usePeersStore } from '../stores/peers'
import AvatarMark from './AvatarMark.vue'
import PantryIcon from './PantryIcon.vue'

// 通讯录三级折叠树（F-DISC-4 / ui-design §4）：公司 ▸ 部门 ▸ 团队 ▸ 成员。
// 字段空缺逐级跳过，全空归"未分组"；组内在线优先（registry 已排序）。

const listHeading = ref<HTMLElement | null>(null)
defineExpose({ focusHeading: () => listHeading.value?.focus() })
const peersStore = usePeersStore()
const emit = defineEmits<{ select: [peer: PeerView]; chat: [nodeId: string] }>()
const collapsed = ref(new Set<string>())

interface Row {
  kind: 'group' | 'peer'
  key: string
  level: number
  label: string
  online?: number
  total?: number
  peer?: PeerView
}

const rows = computed<Row[]>(() => {
  // 三级嵌套分组：Map<公司, Map<部门, Map<团队, peers>>>，空串键=成员直挂上一级
  const tree = new Map<string, Map<string, Map<string, PeerView[]>>>()
  for (const peer of peersStore.peers) {
    const company = peer.company || ''
    const dept = peer.company ? peer.dept : '' // 没公司的直接归未分组扁平挂
    const team = dept ? peer.team : ''
    const level1 = tree.get(company) ?? new Map()
    tree.set(company, level1)
    const level2 = level1.get(dept) ?? new Map()
    level1.set(dept, level2)
    const list = level2.get(team) ?? []
    level2.set(team, list)
    list.push(peer)
  }

  const out: Row[] = []
  const stats = (peers: PeerView[]): { online: number; total: number } => ({
    online: peers.filter((p) => p.online).length,
    total: peers.length
  })
  const flatten = (map: Map<string, Map<string, PeerView[]>> | Map<string, PeerView[]>): PeerView[] => {
    const acc: PeerView[] = []
    for (const v of map.values()) {
      if (Array.isArray(v)) acc.push(...v)
      else acc.push(...flatten(v))
    }
    return acc
  }

  const companies = [...tree.keys()].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, language.value)
  )
  for (const company of companies) {
    const level1 = tree.get(company)!
    const companyKey = `c:${company}`
    const all = flatten(level1)
    const s1 = stats(all)
    out.push({ kind: 'group', key: companyKey, level: 0, label: company || tr('未分组'), ...s1 })
    if (collapsed.value.has(companyKey)) continue

    const depts = [...level1.keys()].sort((a, b) => a.localeCompare(b, language.value))
    for (const dept of depts) {
      const level2 = level1.get(dept)!
      const deptKey = `${companyKey}/d:${dept}`
      if (dept) {
        const s2 = stats(flatten(level2))
        out.push({ kind: 'group', key: deptKey, level: 1, label: dept, ...s2 })
        if (collapsed.value.has(deptKey)) continue
      }
      const teams = [...level2.keys()].sort((a, b) => a.localeCompare(b, language.value))
      for (const team of teams) {
        const peers = level2.get(team)!
        const teamKey = `${deptKey}/t:${team}`
        const baseLevel = dept ? 2 : 1
        if (team) {
          const s3 = stats(peers)
          out.push({ kind: 'group', key: teamKey, level: baseLevel, label: team, ...s3 })
          if (collapsed.value.has(teamKey)) continue
        }
        const peerLevel = team ? baseLevel + 1 : baseLevel
        for (const peer of peers) {
          out.push({ kind: 'peer', key: peer.nodeId, level: peerLevel, label: '', peer })
        }
      }
    }
  }
  return out
})

function toggle(key: string): void {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

function onRowClick(row: Row): void {
  if (row.kind === 'group') {
    toggle(row.key)
    return
  }
  if (row.peer) emit('select', row.peer)
}

function onRowDoubleClick(row: Row): void {
  if (row.kind === 'peer' && row.peer) {
    emit('chat', row.peer.nodeId)
  }
}

function displayName(peer: PeerView): string {
  return peer.remark || peer.nick
}

</script>

<template>
  <div class="pane">
    <h2 ref="listHeading" class="list-head" tabindex="-1">{{ tr('网内节点 {0} · 在线 {1}', { 0: peersStore.peers.length, 1: peersStore.onlineCount }) }}
    </h2>
    <ul v-if="peersStore.peers.length" class="tree">
      <li v-for="row in rows" :key="row.key">
        <button
          type="button"
          class="tree-row"
          :class="row.kind"
          :style="{ paddingLeft: `${12 + row.level * 14}px` }"
          @click="onRowClick(row)"
          @dblclick="onRowDoubleClick(row)"
          :aria-expanded="row.kind === 'group' ? !collapsed.has(row.key) : undefined"
          :aria-label="row.peer ? `${displayName(row.peer)}，${row.peer.online ? tr('在线') : tr('离线')}，${row.peer.ip}` : undefined"
        >
          <template v-if="row.kind === 'group'">
            <PantryIcon class="arrow" name="chevron-right" :size="14" />
            <span class="g-label">{{ row.label }}</span>
            <span class="g-count">({{ row.online }}/{{ row.total }})</span>
          </template>
          <template v-else>
            <AvatarMark
              class="peer-avatar"
              :class="{ off: !row.peer!.online }"
              :avatar="row.peer!.avatar"
              :avatar-hash="row.peer!.avatarHash"
              :name="displayName(row.peer!)"
              :offline="!row.peer!.online"
            />
            <span class="peer-main">
              <span class="peer-name" :class="{ dim: !row.peer!.online }">
                {{ displayName(row.peer!) }}
              </span>
              <span class="peer-sub">{{ row.peer!.ip }}</span>
            </span>
            <span class="dot" :class="row.peer!.online ? 'on' : 'off'"></span>
          </template>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding-bottom: 8px;
}
.list-head {
  height: 38px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.01em;
}
.tree {
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  flex: 1;
  padding: 0 8px 10px;
}
.tree-row {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  margin: 1px 0;
  padding-top: 7px;
  padding-bottom: 7px;
  padding-right: 10px;
  border-radius: var(--radius-panel);
  cursor: pointer;
  font-size: 13px;
  transition: background-color var(--motion-feedback) ease;
}
.tree-row:hover {
  background: var(--surface-hover);
}
.tree-row.peer {
  min-height: 52px;
  gap: 10px;
}
.tree-row:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.tree-row:active {
  background: var(--surface-pressed);
}
.arrow {
  color: var(--text-2);
  transition: transform var(--motion-feedback) var(--ease-out);
}
.tree-row[aria-expanded="true"] .arrow {
  transform: rotate(90deg);
}
.g-label {
  font-weight: 600;
  color: var(--text-2);
}
.g-count {
  font-size: 11px;
  color: var(--text-2);
}
.peer-avatar {
  width: var(--avatar-list);
  height: var(--avatar-list);
  border-radius: 50%;
  background: transparent;
  color: var(--on-primary);
  display: grid;
  place-items: center;
  font-size: 15px;
  flex-shrink: 0;
}
.peer-avatar.off {
  background: transparent;
}
.peer-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.peer-name {
  color: var(--text-1);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.peer-name.dim {
  color: var(--text-2);
}
.peer-sub {
  font-size: 12px;
  color: var(--text-2);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.on {
  background: var(--online);
}
.dot.off {
  background: var(--offline);
}
@media (prefers-reduced-motion: reduce) {
  .tree-row, .arrow { transition: none; }
}
</style>
