import { computed, ref } from 'vue'
import { tr, language } from '../utils/i18n'
import { defineStore } from 'pinia'
import {
  SHARE_ROOT_REJECT_TEXT,
  type PeerView,
  type SettingsView,
  type ShareGrantView,
  type ShareRecentUploadView
} from '../../../shared/ipc'
import { CAPS, type ShareMode } from '../../../shared/protocol'
import { usePeersStore } from './peers'
import { useShareBrowser } from '../utils/share-browser'

// 文件柜（ui-design §8.2 / 决议 #283，改为主窗第三个页签见决议 #284）：
// 列表栏（CabinetList）与内容区（CabinetPane）分处三栏的两格，状态集中在本 store。
// 只做展示与请求编排，权限判定全部在对方本机（protocol §8.2）。

export type CabinetTarget = { kind: 'mine' } | { kind: 'peer'; peerId: string }
export type MinePage = 'files' | 'access' | 'received'
export type CabinetViewMode = 'list' | 'grid'

const VIEW_MODE_KEY = 'pantry.cabinet.viewMode'

export const SHARE_MODE_OPTIONS = computed<Array<{ label: string; value: ShareMode }>>(() => ([
  { label: tr('不可访问'), value: 'off' },
  { label: tr('可下载'), value: 'read' },
  { label: tr('可下载和上传'), value: 'write' }
]))

export function cabinetPeerName(p: PeerView): string {
  return p.remark || p.nick || p.nodeId.slice(0, 8)
}

export const useCabinetStore = defineStore('cabinet', () => {
  const initialized = ref(false)
  const settings = ref<SettingsView | null>(null)
  const grants = ref<ShareGrantView[]>([])
  const recentUploads = ref<ShareRecentUploadView[]>([])
  const shareRootError = ref('')
  const target = ref<CabinetTarget>({ kind: 'mine' })
  const minePage = ref<MinePage>('files')
  const viewMode = ref<CabinetViewMode>('list')
  const toast = ref('')
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  const browser = useShareBrowser(() => target.value.kind === 'peer' ? target.value.peerId : null)

  const shareRoot = computed(() => settings.value?.fileCabinet.root ?? '')
  const shareMode = computed((): ShareMode => settings.value?.fileCabinet.mode ?? 'off')
  const shareAudience = computed(() => {
    if (!shareRoot.value) return tr('尚未选择文件夹')
    const exceptions = grants.value.filter((g) => g.mode !== shareMode.value)
    if (shareMode.value === 'off') return exceptions.length ? tr('已向 {0} 位同事开放', { 0: exceptions.length }) : tr('仅自己可见')
    if (exceptions.length) return shareMode.value === 'write' ? tr('默认可下载和上传，部分同事另有权限') : tr('默认可下载，部分同事另有权限')
    return shareMode.value === 'write' ? tr('所有同事可下载和上传') : tr('所有同事可下载')
  })
  const cabinetPeers = computed((): PeerView[] => {
    return usePeersStore()
      .peers.filter((p) => p.caps.includes(CAPS.fileCabinet))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1
        return cabinetPeerName(a).localeCompare(cabinetPeerName(b), language.value)
      })
  })
  // 可提前给任何联系人设置例外，不要求对方当前已支持文件柜。
  const grantCandidates = computed((): Array<{ label: string; value: string }> => {
    const grantedIds = new Set(grants.value.map((g) => g.nodeId))
    return usePeersStore()
      .peers.filter((p) => !grantedIds.has(p.nodeId))
      .map((p) => ({
        label: `${cabinetPeerName(p)}${p.online ? '' : tr('（离线）')}`,
        value: p.nodeId
      }))
  })
  const activePeer = computed((): PeerView | null => {
    if (target.value.kind !== 'peer') return null
    return usePeersStore().byId(target.value.peerId) ?? null
  })

  async function init(): Promise<void> {
    if (initialized.value) return
    initialized.value = true
    await usePeersStore().init()
    let pendingSettings: SettingsView | undefined
    window.pantry.onSettingsUpdated((view) => {
      if (settings.value) settings.value = view
      else pendingSettings = view
    })
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY)
      if (saved === 'grid' || saved === 'list') viewMode.value = saved
    } catch {
      // 读不到就用默认列表视图
    }
    // 文件柜传输不进聊天流，进度只在文件柜里就地显示（决议 #275）
    window.pantry.onTransferUpdated((view) => {
      if (!view.msgId.startsWith('share:')) return
      // 别人往我柜子里放完东西：正看着「我的文件柜」时顺手刷新汇总列表（决议 #283）
      if (target.value.kind === 'mine') {
        if (view.direction === 'in' && view.status === 'done') void loadRecentUploads()
        return
      }
      browser.updateTransfer(view)
    })
    // 首次展示访问范围时，个人权限与默认权限必须都已就绪。
    const [initialSettings] = await Promise.all([window.pantry.getSettings(), loadGrants(), loadRecentUploads()])
    settings.value = pendingSettings ?? initialSettings
  }

  function flashToast(text: string): void {
    toast.value = text
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = ''), 1800)
  }

  function selectMine(page: MinePage = 'files'): void {
    minePage.value = page
    target.value = { kind: 'mine' }
    browser.resetBrowse()
    void loadRecentUploads()
  }

  function selectPeer(peerId: string): void {
    if (target.value.kind === 'peer' && target.value.peerId === peerId) return
    target.value = { kind: 'peer', peerId }
    browser.resetBrowse()
    void browser.load('')
  }

  function revealUpload(transferId: string): void {
    void window.pantry.revealTransfer(transferId)
  }

  function setViewMode(mode: CabinetViewMode): void {
    viewMode.value = mode
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode)
    } catch {
      // 隐私模式等写不进去不影响使用
    }
  }

  async function loadGrants(): Promise<void> {
    grants.value = await window.pantry.listShareGrants()
  }

  async function loadRecentUploads(): Promise<void> {
    recentUploads.value = await window.pantry.listRecentShareUploads(10)
  }

  async function pickShareRoot(): Promise<void> {
    const firstFolder = !shareRoot.value
    shareRootError.value = ''
    const result = await window.pantry.setShareRoot()
    if (!result.ok) {
      shareRootError.value = tr(SHARE_ROOT_REJECT_TEXT[result.reason])
      return
    }
    if (result.canceled) return
    settings.value = result.view
    if (firstFolder) minePage.value = 'access'
    flashToast(tr('共享目录已设置'))
  }

  async function clearShareRoot(): Promise<void> {
    shareRootError.value = ''
    const result = await window.pantry.setShareRoot(true)
    if (result.ok && !result.canceled) {
      settings.value = result.view
      minePage.value = 'files'
      flashToast(tr('已停止共享'))
    }
  }

  async function revealShareRoot(path = ''): Promise<void> {
    if (!await window.pantry.revealShareRoot(path)) flashToast(tr('无法打开这个位置，请刷新文件列表。'))
  }

  async function changeShareMode(mode: ShareMode): Promise<void> {
    if (mode === shareMode.value) return
    settings.value = await window.pantry.setShareMode(mode)
    flashToast(tr('设置已保存'))
  }

  async function changeGrant(nodeId: string, mode: ShareMode): Promise<void> {
    grants.value = await window.pantry.setShareGrant(nodeId, mode)
    flashToast(tr('设置已保存'))
  }

  async function removeGrant(nodeId: string): Promise<void> {
    grants.value = await window.pantry.setShareGrant(nodeId, null)
    flashToast(tr('已恢复跟随默认'))
  }

  return {
    ...browser,
    initialized, settings, grants, recentUploads, shareRootError, target,
    minePage, viewMode, toast, shareRoot, shareMode, shareAudience,
    cabinetPeers, grantCandidates, activePeer, init, flashToast, selectMine,
    selectPeer, revealUpload, setViewMode, loadGrants, loadRecentUploads, pickShareRoot,
    clearShareRoot, revealShareRoot, changeShareMode, changeGrant, removeGrant
  }
})
