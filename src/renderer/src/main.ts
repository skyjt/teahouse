import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { loadRendererRoot, resolveRendererEntry } from './renderer-entry'
import { installLinuxNumpad } from './utils/linux-numpad'
import { copyEmojiSelection } from './utils/clipboard'
import './styles/tokens.css'

async function bootstrap(): Promise<void> {
  document.addEventListener('copy', copyEmojiSelection)
  if (navigator.platform.startsWith('Linux')) installLinuxNumpad()
  const entry = resolveRendererEntry(location.hash)
  if (entry === 'capture') document.documentElement.dataset.window = 'capture'
  const root = await loadRendererRoot(entry)
  createApp(root.default).use(createPinia()).mount('#app')
}

void bootstrap().catch(() => {
  console.error('[renderer] 窗口入口加载失败')
})
