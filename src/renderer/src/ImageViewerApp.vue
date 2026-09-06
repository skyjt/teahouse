<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ImageViewer from './components/ImageViewer.vue'
import type { ImageViewerNavigation } from '../../shared/ipc'
import { applyPerformanceProfile } from './utils/performance-profile'

const params = computed(() => {
  const query = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : ''
  return new URLSearchParams(query)
})

const transferId = ref(params.value.get('transferId') ?? '')
const src = computed(() => (transferId.value ? `pantry-img://${transferId.value}` : ''))
const navigation = ref<ImageViewerNavigation | null>(null)
const navigating = ref(false)
const navigationError = ref('')
const runtimeReady = ref(false)

onMounted(async () => {
  void loadNavigation(transferId.value)
  try {
    const info = await window.pantry.getAppInfo()
    applyPerformanceProfile(info)
  } finally {
    runtimeReady.value = true
  }
})

async function loadNavigation(id: string): Promise<void> {
  if (!id || navigating.value) return
  navigating.value = true
  navigationError.value = ''
  try {
    const result = await window.pantry.getImageViewerNavigation(id)
    if (!result) {
      navigationError.value = '图片不可用'
      // 图片可能刚被撤回或清理，刷新当前图的相邻项以便继续浏览。
      navigation.value = await window.pantry.getImageViewerNavigation(transferId.value)
      return
    }
    navigation.value = result
    transferId.value = id
    document.title = result.name.trim().slice(0, 120) || '图片'
  } catch {
    navigationError.value = '图片切换失败，请重试'
  } finally {
    navigating.value = false
  }
}

function navigate(direction: 'previous' | 'next'): void {
  const id = navigation.value?.[direction]
  if (id) void loadNavigation(id)
}

function closeViewer(): void {
  void window.pantry.closeWindow()
}
</script>

<template>
  <ImageViewer
    v-if="transferId && runtimeReady"
    :src="src"
    :transfer-id="transferId"
    :has-previous="Boolean(navigation?.previous)"
    :has-next="Boolean(navigation?.next)"
    :navigating="navigating"
    :navigation-error="navigationError"
    @navigate="navigate"
    @retry-navigation="loadNavigation(transferId)"
    @close="closeViewer"
  />
  <main v-else-if="!transferId" class="missing">
    <span>图片不可用</span>
  </main>
</template>

<style scoped>
.missing {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--text-2);
  background: var(--bg-chat);
  font-size: 13px;
}
</style>
