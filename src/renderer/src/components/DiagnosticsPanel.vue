<script setup lang="ts">
import { ref } from 'vue'
import { NButton } from 'naive-ui'
import { tr } from '../utils/i18n'

const includeNetwork = ref(false)
const busy = ref(false)
const saved = ref('')
const notice = ref('')
const failed = ref(false)

async function exportBundle(): Promise<void> {
  if (busy.value) return
  busy.value = true
  notice.value = ''
  failed.value = false
  try {
    const result = await window.pantry.exportDiagnostics(includeNetwork.value)
    if (result.status === 'saved') {
      saved.value = result.name
      notice.value = '诊断包已保存，可作为附件提交反馈。'
    } else if (result.status !== 'canceled') {
      saved.value = ''
      failed.value = true
      notice.value = result.status === 'busy' ? '正在导出，请稍候。' : '导出失败，请检查保存位置的权限和剩余空间后重试。'
    }
  } catch {
    saved.value = ''
    failed.value = true
    notice.value = '导出失败，请检查保存位置的权限和剩余空间后重试。'
  } finally { busy.value = false }
}

async function copyEnvironment(): Promise<void> {
  try {
    failed.value = !(await window.pantry.copyDiagnosticEnvironment())
  } catch { failed.value = true }
  notice.value = failed.value ? '复制失败，请重试。' : '已复制脱敏环境信息，可粘贴到问题描述中。'
}

async function reveal(): Promise<void> {
  try {
    if (await window.pantry.revealDiagnostics()) return
  } catch { /* 在同一提示区呈现失败 */ }
  failed.value = true
  notice.value = '无法打开所在文件夹，请到保存位置查找诊断包。'
}
</script>

<template>
  <section class="diagnostics" aria-labelledby="diagnostics-heading">
    <h2 id="diagnostics-heading">{{ tr('诊断与反馈') }}</h2>
    <p>{{ tr('遇到问题时，导出诊断包并附在问题反馈中。') }}</p>
    <p class="diagnostic-detail">{{ tr('仅保存到本机，不会自动上传。包含环境信息与近期运行记录，不含聊天和文件内容。') }}</p>
    <details class="screen-help">
      <summary>{{ tr('屏幕协助的使用条件') }}</summary>
      <p>{{ tr('双方需在线并保持桌面解锁。本机需支持锁屏检测，对方需支持并允许共享屏幕。') }}</p>
    </details>
    <label class="diagnostic-option">
      <input v-model="includeNetwork" type="checkbox" :disabled="busy" aria-describedby="diagnostic-network-help" />
      <span>{{ tr('附带真实网络地址') }}</span>
    </label>
    <small id="diagnostic-network-help">{{ includeNetwork ? tr('将附上本次运行的真实 IP；发布附件前请确认可以公开。') : tr('默认隐藏 IP 和节点身份；排查网络问题时可勾选。') }}</small>
    <div class="diagnostic-actions">
      <NButton type="primary" :disabled="busy" :aria-busy="busy" @click="exportBundle">
        {{ busy ? tr('正在整理诊断包…') : tr('导出诊断包') }}
      </NButton>
      <NButton secondary :disabled="busy" @click="copyEnvironment">{{ tr('复制环境信息') }}</NButton>
    </div>
    <div v-if="notice" class="diagnostic-result" :class="{ failed }" role="status" aria-live="polite">{{ tr(notice) }}</div>
    <div v-if="saved" class="diagnostic-saved">
      <span :title="saved">{{ saved }}</span>
      <button type="button" @click="reveal">{{ tr('打开所在文件夹') }}</button>
    </div>
    <small class="diagnostic-tip">{{ tr('反馈时请注明发生时间和操作步骤。传输问题建议双方分别导出。') }}</small>
  </section>
</template>

<style scoped>
.diagnostics {
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--bg-window);
  color: var(--text-1);
}
.diagnostics h2 { margin: 0 0 7px; font-size: var(--font-md); font-weight: 600; }
.diagnostics p { margin: 0 0 8px; font-size: var(--font-sm); line-height: 1.6; color: var(--text-2); }
.diagnostics p.diagnostic-detail, .diagnostics small { font-size: var(--font-xs); color: var(--text-2); line-height: 1.6; }
.diagnostics small { display: block; }
.diagnostics p { max-inline-size: 64ch; overflow-wrap: anywhere; }
.diagnostics p.diagnostic-detail { font-size: var(--font-sm); line-height: 1.75; margin-bottom: 12px; }
.screen-help { margin: 10px 0; font-size: var(--font-sm); }
.screen-help summary { cursor: pointer; }
.screen-help p { margin: 5px 0; }
.diagnostic-option { display: flex; align-items: center; gap: 7px; margin-top: 14px; font-size: var(--font-sm); cursor: pointer; }
:global(html[data-theme='dark']) .diagnostic-option input { color-scheme: dark; }
.diagnostic-option input { margin: 0; accent-color: var(--primary); }
#diagnostic-network-help { margin: 4px 0 0 20px; }
.diagnostic-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.diagnostic-result { margin-top: 12px; font-size: var(--font-xs); line-height: 1.6; color: var(--primary); }
.diagnostic-result.failed { color: var(--danger); }
.diagnostic-saved { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-top: 6px; font-size: var(--font-xs); }
.diagnostic-saved span { overflow-wrap: anywhere; color: var(--text-2); }
.diagnostic-saved button { padding: 0; border: 0; background: none; color: var(--primary); font-size: inherit; cursor: pointer; }
.diagnostics .diagnostic-tip { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
</style>
