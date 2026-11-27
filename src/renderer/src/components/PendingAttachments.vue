<script setup lang="ts">
import { ref } from 'vue'
import type { PendingAttachment } from '../utils/pending-attachments'
import { formatBytes } from '../utils/format'
import { tr } from '../utils/i18n'
import FileTypeIcon from './FileTypeIcon.vue'
import PantryIcon from './PantryIcon.vue'

defineProps<{ items: PendingAttachment[]; busy: boolean; failed: boolean; available: boolean }>()
defineEmits<{ remove: [id: number]; cancel: [] }>()
const broken = ref<Record<number, boolean>>({})
</script>

<template>
  <section class="attachments" :aria-label="tr('待发送附件')" :aria-busy="busy">
    <div class="attachment-heading">
      <div class="attachment-title">{{ tr('待发送附件') }} <span class="attachment-count">{{ items.length }}</span></div>
      <button class="cancel-attachments" :disabled="busy" @click="$emit('cancel')">{{ tr('取消全部') }}</button>
    </div>
    <ul class="attachment-list">
      <li v-for="item in items" :key="item.id" class="attachment-card">
        <div class="attachment-preview">
          <img v-if="item.preview && !broken[item.id]" :src="item.preview" :alt="item.name" decoding="async" @error="broken[item.id] = true" />
          <FileTypeIcon v-else :name="item.name" :size="36" />
        </div>
        <div class="attachment-info">
          <span class="attachment-name" :title="item.name">{{ item.name }}</span>
          <span class="attachment-size">{{ formatBytes(item.size) }}</span>
        </div>
        <button class="remove-attachment" :disabled="busy" :aria-label="tr('移除附件：{0}', { 0: item.name })" :title="tr('移除附件：{0}', { 0: item.name })" @click="$emit('remove', item.id)">
          <PantryIcon name="x" :size="14" />
        </button>
      </li>
    </ul>
    <p class="attachment-status" :class="{ failed }" role="status">{{ failed ? tr('未发送的附件已保留，请重试或移除') : busy ? tr('正在发送，请稍候…') : !available ? tr('对方离线，附件暂不能发送') : tr('确认后发送 · 可继续粘贴') }}</p>
  </section>
</template>

<style scoped>
.attachments { margin: 4px 0 8px; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--bg-window); }
.attachment-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.attachment-title { display: flex; align-items: center; gap: 7px; font-size: var(--font-sm); font-weight: 600; color: var(--text-1); }
.attachment-count { padding: 1px 7px; border-radius: var(--radius-pill); background: var(--primary-weak); color: var(--primary); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.cancel-attachments { border: 0; background: transparent; color: var(--text-2); font-size: var(--font-xs); padding: 5px 4px; cursor: pointer; border-radius: var(--radius-control); }
.attachment-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 235px), 1fr)); gap: 8px; list-style: none; padding: 0; margin: 0; max-height: 176px; overflow-y: auto; overscroll-behavior: contain; }
.attachment-card { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 5px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--material-strong); }
.attachment-preview { width: 72px; height: 64px; flex: 0 0 72px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: var(--radius-control); background: var(--bg-list); }
.attachment-preview img { width: 100%; height: 100%; object-fit: contain; }
.attachment-info { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-sm); color: var(--text-1); }
.attachment-size { font-size: var(--font-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
.remove-attachment { display: flex; align-items: center; justify-content: center; flex: 0 0 28px; width: 28px; height: 28px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-3); cursor: pointer; }
.remove-attachment:hover:enabled, .cancel-attachments:hover:enabled { background: var(--surface-hover); color: var(--text-1); }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: default; }
.attachment-status { margin: 8px 0 0; color: var(--text-2); font-size: var(--font-xs); }
.attachment-status.failed { color: var(--danger); }
</style>
