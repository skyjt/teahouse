<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import PantryIcon from './PantryIcon.vue'
import { tr } from '../utils/i18n'

const props = defineProps<{ localIp?: string }>()
const networkIp = computed(() => props.localIp?.startsWith('127.') ? '' : props.localIp ?? '')
const address = ref('')
const probing = ref(false)
const probeStatus = ref<'added' | 'invalid' | 'failed' | null>(null)
const copyStatus = ref<'copied' | 'failed' | null>(null)

async function addAddress(): Promise<void> {
  if (!address.value.trim() || probing.value) return
  probing.value = true
  try {
    const ok = await window.pantry.addManualPeer(address.value.trim())
    probeStatus.value = ok ? 'added' : 'invalid'
    if (ok) address.value = ''
  } catch {
    probeStatus.value = 'failed'
  } finally {
    probing.value = false
  }
}

async function copyIp(): Promise<void> {
  if (!networkIp.value) return
  try {
    await navigator.clipboard.writeText(networkIp.value)
    copyStatus.value = 'copied'
  } catch {
    copyStatus.value = 'failed'
  }
}
</script>

<template>
  <section class="discovery" aria-labelledby="discovery-heading">
    <div class="pane-empty">
      <span class="pane-empty-icon"><PantryIcon name="users" :size="30" /></span>
      <h2 id="discovery-heading">{{ tr('还没找到同事') }}</h2>
      <p v-if="localIp && !networkIp">{{ tr('请先连接局域网，再请同事打开茶话间。') }}</p>
      <p v-else>{{ tr('请同事在同一局域网打开茶话间。发现后，对方会出现在左侧通讯录。') }}</p>
      <div v-if="networkIp" class="ip">
        <span>{{ tr('本机 IP：{0}', { 0: networkIp }) }}</span>
        <button class="icon-control compact-icon" type="button" :title="tr('复制本机 IP')" :aria-label="tr('复制本机 IP')" @click="copyIp">
          <PantryIcon :name="copyStatus === 'copied' ? 'check' : 'copy'" :size="15" />
        </button>
        <span role="status">{{ copyStatus === 'copied' ? tr('已复制') : copyStatus === 'failed' ? tr('复制失败') : '' }}</span>
      </div>
      <details>
        <summary>{{ tr('按 IP 添加同事') }}</summary>
        <form @submit.prevent="addAddress">
          <label for="contact-address">{{ tr('添加对方 IP') }}</label>
          <NInput v-model:value="address" size="small" placeholder="192.168.1.20" :disabled="probing"
            :input-props="{ id: 'contact-address', spellcheck: false, 'aria-invalid': probeStatus === 'invalid', 'aria-describedby': 'probe-status' }"
            @update:value="probeStatus = null" />
          <NButton attr-type="submit" size="small" type="primary" :loading="probing" :disabled="!address.trim() || probing">{{ tr('添加') }}</NButton>
        </form>
        <p id="probe-status" role="status">{{ probeStatus === 'added' ? tr('已添加并探测') : probeStatus === 'invalid' ? tr('地址格式不对（ip 或 ip:端口）') : probeStatus === 'failed' ? tr('添加失败，请重试。') : '' }}</p>
      </details>
    </div>
  </section>
</template>

<style scoped>
.discovery { display: flex; min-height: 0; overflow: auto; }
.pane-empty { margin: auto; flex: 0 1 420px; }
.ip { display: flex; align-items: center; gap: 4px; color: var(--text-2); font-size: var(--font-sm); }
.ip span:first-child { user-select: text; font-variant-numeric: tabular-nums; }
details { width: min(100%, 320px); padding-top: 12px; border-top: 1px solid var(--line); }
summary { color: var(--primary-hover); cursor: pointer; font-size: var(--font-sm); }
form { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; margin-top: 12px; text-align: start; }
label { grid-column: 1 / -1; font-size: var(--font-xs); }
#probe-status:not(:empty) { margin-top: 8px; }
</style>
