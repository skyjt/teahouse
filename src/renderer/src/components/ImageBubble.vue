<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { MessageView } from '../../../shared/ipc'
import { useTransfersStore } from '../stores/transfers'
import ImageViewer from './ImageViewer.vue'

// 图片消息气泡（ui-design §5）：缩略展示 ≤280px，点击进大图查看器。
// 图源走 pantry-img:// 自定义协议（只放行 transfers 表登记过的路径）。

const props = defineProps<{ msg: MessageView }>()
const transfers = useTransfersStore()
const viewing = ref(false)
const broken = ref(false)

const transferId = computed(() => props.msg.fileRef?.transferId ?? '')
const transfer = computed(() => transfers.byId[transferId.value])
const ready = computed(
  () => transfer.value?.status === 'done' || (props.msg.isMine && !!transfer.value?.savedPath)
)
const src = computed(() => `pantry-img://${transferId.value}`)
const failed = computed(
  () =>
    broken.value ||
    transfer.value?.status === 'failed' ||
    transfer.value?.status === 'canceled' ||
    transfer.value?.status === 'declined'
)

onMounted(() => {
  if (transferId.value) void transfers.ensure(transferId.value)
})
</script>

<template>
  <div class="img-bubble">
    <img
      v-if="ready && !failed"
      :src="src"
      class="thumb"
      alt="[图片]"
      @click="viewing = true"
      @error="broken = true"
    />
    <div v-else-if="failed" class="ph fail">图片传输失败</div>
    <div v-else class="ph">图片接收中…</div>
    <ImageViewer
      v-if="viewing"
      :src="src"
      :transfer-id="transferId"
      @close="viewing = false"
    />
  </div>
</template>

<style scoped>
.thumb {
  max-width: 280px;
  max-height: 280px;
  border-radius: 8px;
  cursor: zoom-in;
  display: block;
  border: 1px solid var(--line);
}
.ph {
  width: 180px;
  height: 120px;
  border-radius: 8px;
  background: var(--line);
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--text-3);
}
.ph.fail {
  color: var(--danger);
}
</style>
