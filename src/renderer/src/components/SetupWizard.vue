<script setup lang="ts">
import { tr, language } from '../utils/i18n'
import { computed, ref } from 'vue'
import { LANGUAGE_OPTIONS } from '../../../shared/i18n'
import { isLanguage } from '../../../i18n'
import type { SettingsView } from '../../../shared/ipc'
import PantryBrandLogo from './PantryBrandLogo.vue'

// 首次启动向导（F-SYS-6，ui-design §7.4）：三步必经，防止全网一片"未命名"。

const props = defineProps<{ settings: SettingsView }>()
const emit = defineEmits<{ done: [] }>()

async function changeLanguage(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  if (isLanguage(value)) await window.pantry.saveAppSettings({ language: value })
}

const step = ref(1)
const nick = ref(props.settings.nick)
const company = ref(props.settings.company)
const dept = ref(props.settings.dept)
const team = ref(props.settings.team)
const avatar = ref(props.settings.avatar)
const fileDir = ref(props.settings.fileDir)

const nickOk = computed(() => nick.value.trim().length > 0 && nick.value.trim().length <= 32)
const shownDir = computed(() => fileDir.value || props.settings.defaultFileDir)

async function pickDir(): Promise<void> {
  const dir = await window.pantry.pickDirectory()
  if (dir) fileDir.value = dir
}

async function finish(): Promise<void> {
  await window.pantry.saveProfile({
    nick: nick.value.trim(),
    company: company.value.trim(),
    dept: dept.value.trim(),
    team: team.value.trim(),
    avatar: avatar.value,
    fileDir: fileDir.value
  })
  emit('done')
}
</script>

<template>
  <div class="mask">
    <div class="card">
      <div class="brand">
        <PantryBrandLogo variant="color" :size="52" class="brand-logo" />
        <div class="brand-name">{{ tr('茶话间') }}<span v-if="language === 'zh-CN'" class="brand-latin">Teahouse</span></div>
      </div>
      <label class="language-choice">语言 / Language
        <select :value="language" @change="changeLanguage">
          <option v-for="option in LANGUAGE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <div class="dots">
        <span v-for="i in 3" :key="i" class="dot" :class="{ on: step >= i }"></span>
      </div>

      <div v-if="step === 1" class="body">
        <h2>{{ tr('怎么称呼你？') }}</h2>
        <p class="tip">{{ tr('昵称会显示在同事们的通讯录里（必填，可随时修改）') }}</p>
        <input v-model="nick" class="field" maxlength="32" :aria-label="tr('昵称')" :placeholder="tr('昵称')" autofocus />
        <button class="primary" :disabled="!nickOk" @click="step = 2">{{ tr('下一步') }}</button>
      </div>

      <div v-else-if="step === 2" class="body">
        <h2>{{ tr('你在哪个团队？') }}</h2>
        <p class="tip">{{ tr('选填——填了之后，你会出现在通讯录对应的分组树下') }}</p>
        <input v-model="company" class="field" maxlength="32" :aria-label="tr('公司（选填）')" :placeholder="tr('公司（选填）')" />
        <input v-model="dept" class="field" maxlength="32" :aria-label="tr('部门（选填）')" :placeholder="tr('部门（选填）')" />
        <input v-model="team" class="field" maxlength="32" :aria-label="tr('团队（选填）')" :placeholder="tr('团队（选填）')" />
        <div class="actions">
          <button class="ghost" @click="step = 1">{{ tr('上一步') }}</button>
          <button class="primary" @click="step = 3">{{ tr('下一步') }}</button>
        </div>
      </div>

      <div v-else class="body">
        <h2>{{ tr('收到的文件放哪？') }}</h2>
        <p class="tip">{{ tr('同事发来的文件会保存到这里，之后可在设置里随时更改') }}</p>
        <div class="dir">
          <span class="dir-path">{{ shownDir }}</span>
          <button class="ghost small" @click="pickDir">{{ tr('更改…') }}</button>
        </div>
        <div class="actions">
          <button class="ghost" @click="step = 2">{{ tr('上一步') }}</button>
          <button class="primary" @click="finish">{{ tr('进入茶话间') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: var(--bg-chat);
  display: grid;
  place-items: center;
  z-index: 10;
}
.card {
  width: min(380px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--line);
  background: var(--bg-window);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
  padding: 32px 36px 28px;
  text-align: center;
}
.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.brand-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 21px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text-1);
}
.brand-latin {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  color: var(--text-3);
}
.dots {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin: 16px 0 22px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line);
}
.dot.on {
  background: var(--primary);
}
.body h2 {
  font-size: 17px;
  margin-bottom: 6px;
}
.tip {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 18px;
}
.field {
  width: 100%;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  padding: 0 10px;
  font-size: 14px;
  outline: none;
  margin-bottom: 10px;
  user-select: text;
  background: var(--bg-input);
  color: var(--text-1);
}
.field:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -1px;
}
.dir {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-list);
  border-radius: var(--radius-control);
  padding: 8px 10px;
  margin-bottom: 18px;
}
.dir-path {
  flex: 1;
  font-size: 12px;
  color: var(--text-2);
  text-align: left;
  word-break: break-all;
}
.actions {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.primary {
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-size: 14px;
  padding: 8px 28px;
  border-radius: var(--radius-control);
  cursor: pointer;
  flex: 1;
}
@media (hover: hover) {
  .primary:enabled:hover { background: var(--primary-hover); }
  .ghost:hover { background: var(--surface-hover); }
}
.primary:disabled {
  opacity: 0.4;
  cursor: default;
}
.ghost {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  font-size: 14px;
  padding: 8px 18px;
  border-radius: var(--radius-control);
  cursor: pointer;
}
.ghost.small {
  font-size: 12px;
  padding: 4px 10px;
}
</style>

<style scoped>
.language-choice { display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 16px; font-size: 12px; color: var(--text-2); }
.language-choice select { color: var(--text-1); background: var(--bg-window); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
</style>
