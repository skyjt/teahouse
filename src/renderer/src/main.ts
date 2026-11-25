import { initLanguage } from './utils/i18n'
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
  const [root] = await Promise.all([loadRendererRoot(entry), initLanguage()])
  const app = createApp(root.default).use(createPinia())
  app.config.errorHandler = error => {
    window.pantry.reportDiagnosticError('vue', error instanceof Error ? error.name : 'Error')
    console.error(error)
  }
  app.mount('#app')
  if (entry === 'main') window.pantry.mainReady()
}

void bootstrap().catch(error => {
  window.pantry.reportDiagnosticError('bootstrap', error instanceof Error ? error.name : 'Error')
  console.error(error)
})
