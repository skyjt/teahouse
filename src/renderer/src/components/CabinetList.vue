<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NInput } from 'naive-ui'
import { cabinetPeerName, useCabinetStore } from '../stores/cabinet'
import { tr } from '../utils/i18n'
import AvatarMark from './AvatarMark.vue'
import PantryIcon from './PantryIcon.vue'

const cabinet = useCabinetStore()
const query = ref('')
const visiblePeers = computed(() => {
  const q = query.value.trim().toLowerCase()
  return cabinet.cabinetPeers.filter((p) =>
    [p.remark, p.nick, p.dept, p.ip].some((field) => field.toLowerCase().includes(q))
  )
})
onMounted(() => { void cabinet.init() })
</script>

<template>
  <nav class="cabinet-list" :aria-label="tr('文件柜')">
    <h2>{{ tr('文件柜') }}</h2>
    <button
      type="button" class="destination mine" :aria-current="cabinet.target.kind === 'mine' ? 'page' : undefined"
      @click="cabinet.selectMine()"
    >
      <span class="mine-icon"><PantryIcon name="cabinet" size="action" /></span>
      <strong>{{ tr('我的文件柜') }}</strong>
    </button>

    <h3>{{ tr('访问同事的文件柜') }}</h3>
    <NInput v-model:value="query" size="small" clearable :placeholder="tr('搜索同事')" :input-props="{ 'aria-label': tr('搜索同事') }">
      <template #prefix><PantryIcon name="search" size="compact" /></template>
    </NInput>
    <div class="peers">
      <button
        v-for="p in visiblePeers" :key="p.nodeId" type="button" class="destination peer"
        :aria-current="cabinet.target.kind === 'peer' && cabinet.target.peerId === p.nodeId ? 'page' : undefined"
        :title="[cabinetPeerName(p), p.dept, p.ip].filter(Boolean).join(' · ')"
        @click="cabinet.selectPeer(p.nodeId)"
      >
        <AvatarMark class="peer-avatar" :name="cabinetPeerName(p)" :avatar="p.avatar" :avatar-hash="p.avatarHash" :presence="p.online ? 'online' : 'offline'" />
        <span class="peer-txt">
          <strong>{{ cabinetPeerName(p) }}</strong>
          <small>{{ [p.online ? tr('在线') : tr('离线'), p.dept].filter(Boolean).join(' · ') }}</small>
        </span>
      </button>
      <p v-if="!visiblePeers.length">{{ query.trim() ? tr('没有匹配的同事') : tr('还没有找到支持文件柜的同事。') }}</p>
    </div>
  </nav>
</template>

<style scoped>
.cabinet-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 32px 10px 8px;
}
h2 {
  display: flex;
  align-items: center;
  min-height: 52px;
  margin: 0 6px;
  font-size: var(--font-lg);
  font-weight: 650;
}
h3, small, p {
  color: var(--text-2);
  font-size: 12px;
}
h3 {
  margin: 20px 6px 8px;
}
.destination {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 52px;
  padding: 8px;
  border: 0;
  border-radius: var(--radius-panel);
  background: transparent;
  color: var(--text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .destination:hover { background: var(--surface-hover); }
}
.destination:focus-visible { outline-offset: -2px; }
.destination[aria-current] { background: var(--surface-selected); }
.destination:active { background: var(--surface-pressed); }
.mine-icon {
  display: grid;
  place-items: center;
  width: var(--avatar-list);
  height: var(--avatar-list);
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: var(--radius-panel);
  flex: none;
}
.peers {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-top: 8px;
}
.peer-avatar {
  width: var(--avatar-list);
  height: var(--avatar-list);
  flex: none;
}
.peer-txt {
  display: grid;
  min-width: 0;
}
strong, small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
strong { font-size: 14px; }
p { margin: 12px 6px; }
</style>
