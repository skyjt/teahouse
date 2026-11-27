<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { previewCidrImport, SCAN_IMPORT_MAX_LENGTH, SCAN_MAX_RANGES, type ScanRangeImportError } from '../../../shared/cidr'
import type { SettingsView } from '../../../shared/ipc'
import { tr } from '../utils/i18n'

const props = defineProps<{ ranges: string[] }>()
const emit = defineEmits<{ updated: [view: SettingsView] }>()
const input = ref('')
const saving = ref(false)
const notice = ref('')
const preview = computed(() => previewCidrImport(input.value, props.ranges))
const canImport = computed(() => !saving.value && preview.value.error === null)

function errorText(reason: ScanRangeImportError): string {
  if (reason === 'invalid') return tr('存在无效网段，请按每行一个 IPv4 CIDR 修改（/22 至 /30）。')
  if (reason === 'too-many') return tr('保存的网段总数不能超过 {0} 个，请减少本次输入。', { 0: SCAN_MAX_RANGES })
  if (reason === 'too-long') return tr('输入内容过长，请减少网段数量。')
  if (reason === 'empty') return tr('没有需要添加的新网段。')
  return tr('保存失败，请重试。')
}

async function importRanges(): Promise<void> {
  if (!canImport.value) return
  saving.value = true
  notice.value = ''
  try {
    const result = await window.pantry.importScanRanges(input.value)
    emit('updated', result.view)
    if (result.ok) {
      input.value = ''
      notice.value = tr('已添加 {0} 个网段。可逐段刷新，或在主界面刷新全部网段。', { 0: result.added })
    } else notice.value = errorText(result.reason)
  } catch {
    notice.value = tr('保存失败，请重试。')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <details class="range-import">
    <summary>{{ tr('批量添加网段') }}</summary>
    <div class="import-body">
      <p class="hint">{{ tr('每行一个网段，最多共保存 {0} 个。确认后仅保存，不立即扫描。', { 0: SCAN_MAX_RANGES }) }}</p>
      <NInput
        v-model:value="input"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 6 }"
        :maxlength="SCAN_IMPORT_MAX_LENGTH"
        :disabled="saving"
        :input-props="{ 'aria-label': tr('批量网段列表') }"
        :placeholder="tr('如：每行填写 10.1.2.0/24 或 10.2.0.0/25')"
        @update:value="notice = ''"
      />
      <div v-if="input.trim()" class="preview" aria-live="polite">
        <p v-if="preview.invalidLines.length" class="error">{{ tr('第 {0} 行无效，请使用 /22 至 /30 的 IPv4 网段。', { 0: preview.invalidLines.join('、') }) }}</p>
        <p v-else-if="preview.error" class="error">{{ errorText(preview.error) }}</p>
        <template v-else>
          <p>{{ tr('新增 {0} 个，跳过重复 {1} 个；保存后共 {2} 个网段、{3} 个不重复探测地址。', { 0: preview.additions.length, 1: preview.duplicateCount, 2: preview.ranges.length, 3: preview.hostCount }) }}</p>
          <ul class="range-preview" :aria-label="tr('待添加网段')">
            <li v-for="cidr in preview.additions" :key="cidr"><code>{{ cidr }}</code></li>
          </ul>
        </template>
      </div>
      <NButton type="primary" :disabled="!canImport" :loading="saving" @click="importRanges">
        {{ tr('确认添加') }}
      </NButton>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    </div>
  </details>
</template>

<style scoped>
.range-import { margin: 12px 0; font-size: 12px; }
summary { width: fit-content; color: var(--primary); cursor: pointer; padding: 4px 0; }
.import-body { display: grid; gap: 10px; padding-top: 8px; }
p { margin: 0; line-height: 1.6; }
.hint, .notice { color: var(--text-2); }
.error { color: var(--danger); }
.range-preview { max-height: 96px; overflow-y: auto; overscroll-behavior: contain; margin: 6px 0 0; padding-left: 20px; }
.range-preview li { line-height: 1.6; }
.import-body > .n-button { justify-self: start; }
</style>
