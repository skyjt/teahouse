<script setup lang="ts">
import { tr } from '../utils/i18n'
// 沉浸式无标题栏（决议 #49）：Windows / Linux 右上角自绘窗口控制按钮。
// macOS 使用系统红绿灯（hiddenInset），本组件自动不渲染。
// 关闭走 window.close()，主窗复用「关闭进托盘」逻辑；最小化/最大化经 IPC。
import { onMounted, onUnmounted, ref } from 'vue'

const props = withDefaults(defineProps<{ buttons?: 'all' | 'close' }>(), { buttons: 'all' })

const visible = ref(false)
const maximized = ref(false)
let stopMaximize: (() => void) | null = null

onMounted(async () => {
  const info = await window.pantry.getAppInfo()
  visible.value = info.platform !== 'darwin'
  if (!visible.value || props.buttons !== 'all') return
  maximized.value = await window.pantry.isWindowMaximized()
  stopMaximize = window.pantry.onWinMaximizeChanged((next) => {
    maximized.value = next
  })
})

onUnmounted(() => {
  stopMaximize?.()
})

function minimize(): void {
  void window.pantry.minimizeWindow()
}

async function toggleMaximize(): Promise<void> {
  maximized.value = await window.pantry.toggleMaximizeWindow()
}

function close(): void {
  // 决议 #59：不许用 DOM window.close() —— Electron 对渲染层发起的关闭走
  // CloseImmediately，绕过主进程 close 事件，"关闭进托盘"会失效直接退出。
  void window.pantry.closeWindow()
}
</script>

<template>
  <div v-if="visible" class="win-controls">
    <button
      v-if="buttons === 'all'"
      type="button"
      class="ctrl"
      :title="tr('最小化')"
      :aria-label="tr('最小化')"
      @click="minimize"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 5h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>
    <button
      v-if="buttons === 'all'"
      type="button"
      class="ctrl"
      :title="maximized ? tr('还原') : tr('最大化')"
      :aria-label="maximized ? tr('还原') : tr('最大化')"
      @click="toggleMaximize"
    >
      <svg v-if="maximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M3 3V1.6c0-.33.27-.6.6-.6h4.8c.33 0 .6.27.6.6v4.8c0 .33-.27.6-.6.6H7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
        />
        <rect x="1" y="3" width="6" height="6" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
      <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1" y="1" width="8" height="8" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <button type="button" class="ctrl close" :title="tr('关闭')" :aria-label="tr('关闭')" @click="close">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.win-controls {
  position: fixed;
  top: 0;
  right: 0;
  height: 32px;
  display: flex;
  z-index: 60; /* 永远盖在弹层之上，任何状态都能操作窗口 */
  -webkit-app-region: no-drag;
}
.ctrl {
  width: 42px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-2);
  display: grid;
  place-items: center;
  padding: 0;
}
.ctrl:focus-visible { outline-offset: -3px; }
.ctrl:hover {
  background: var(--surface-hover);
  color: var(--text-1);
}
.ctrl.close:hover {
  background: #e81123;
  color: #fff;
}
</style>
