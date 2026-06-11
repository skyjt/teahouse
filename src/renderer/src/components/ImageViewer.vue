<script setup lang="ts">
// 大图查看器：点击遮罩关闭，Esc 关闭，「另存为」走主进程对话框
import { onBeforeUnmount, onMounted } from 'vue'

const props = defineProps<{ src: string; transferId: string }>()
const emit = defineEmits<{ close: [] }>()

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

async function saveAs(): Promise<void> {
  await window.pantry.saveImageAs(props.transferId)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="viewer" @click.self="emit('close')">
    <img :src="src" class="full" alt="[图片]" />
    <div class="bar">
      <button class="btn" @click="saveAs">另存为…</button>
      <button class="btn" @click="emit('close')">关闭</button>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.78);
  z-index: 20;
  display: grid;
  place-items: center;
}
.full {
  max-width: 88vw;
  max-height: 84vh;
  border-radius: 4px;
}
.bar {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
}
.btn {
  border: none;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 4px;
  font-size: 13px;
  padding: 7px 18px;
  cursor: pointer;
}
</style>
