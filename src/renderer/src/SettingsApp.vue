<script setup lang="ts">
import { tr, language, applyLanguage } from './utils/i18n'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  darkTheme,
  dateZhCN,
  dateEnUS,
  enUS,
  NButton,
  NConfigProvider,
  NInput,
  NSelect,
  NSwitch,
  zhCN
} from 'naive-ui'
import {
  DEFAULT_CAPTURE_SHORTCUT,
  DEFAULT_SHOWHIDE_SHORTCUT,
  type AppInfo,
  type AppSettingsPatch,
  type AvatarSourcePick,
  type ConversationView,
  type DataExportOptions,
  type ScanRangeItemView,
  type SettingsView,
  type TransferView
} from '../../shared/ipc'
import { LANGUAGE_OPTIONS } from '../../shared/i18n'
import { DEFAULT_TCP_PORT, DEFAULT_UDP_PORT } from '../../shared/protocol'
import { applyAppearance } from './utils/appearance'
import { formatBytes } from './utils/format'
import { applyPerformanceProfile } from './utils/performance-profile'
import {
  AVATAR_COLORS,
  AVATAR_EMOJIS,
  avatarColorIndex,
  avatarEmojiIndex,
  avatarStyle,
  avatarValue,
  initialAvatarValue,
  isInitialAvatar
} from './utils/avatar'
import AvatarGlyph from './components/AvatarGlyph.vue'
import AvatarCropDialog from './components/AvatarCropDialog.vue'
import AvatarMark from './components/AvatarMark.vue'
import PantryBrandLogo from './components/PantryBrandLogo.vue'
import PantryIcon from './components/PantryIcon.vue'
import SettingsNavIcon from './components/SettingsNavIcon.vue'
import WindowControls from './components/WindowControls.vue'
import WindowDragStrip from './components/WindowDragStrip.vue'
import {
  teahouseDarkThemeOverrides,
  teahouseLightThemeOverrides
} from './ui/naive-theme'

// 设置独立小窗（ui-design §8）：按 7 组承载本地设置（决议 #150 重组，端口归网络、发送键归聊天、去掉杂物抽屉）。

type Section =
  | 'profile'
  | 'general'
  | 'notify'
  | 'storage'
  | 'network'
  | 'shortcuts'
  | 'about'

const sections = computed<Array<{ id: Section; icon: string; label: string; summary: string }>>(() => ([
  {
    id: 'profile',
    icon: 'settings-profile',
    label: tr('账号资料'),
    summary: tr('昵称、头像等会展示在通讯录和聊天窗口。')
  },
  {
    id: 'general',
    icon: 'settings-general',
    label: tr('通用'),
    summary: tr('启动方式、窗口行为与外观主题。')
  },
  {
    id: 'notify',
    icon: 'settings-notify',
    label: tr('通知'),
    summary: tr('新消息的桌面提醒与提示音。')
  },
  {
    id: 'storage',
    icon: 'settings-storage',
    label: tr('聊天与文件'),
    summary: tr('文件保存、发送键、聊天记录导出与传输记录。')
  },
  {
    id: 'network',
    icon: 'settings-network',
    label: tr('网络'),
    summary: tr('手动节点、网段扫描与端口。')
  },
  {
    id: 'shortcuts',
    icon: 'settings-shortcuts',
    label: tr('快捷键'),
    summary: tr('截图与主窗口的全局快捷键。')
  },
  {
    id: 'about',
    icon: 'settings-about',
    label: tr('关于'),
    summary: tr('版本、许可与纯内网安全说明。')
  }
]))

const section = ref<Section>('profile')
const settings = ref<SettingsView | null>(null)
const info = ref<AppInfo | null>(null)
// 关于页「更多信息」折叠（决议 #90）：默认收起开发者向运行时信息
const showAboutDetails = ref(false)

// 检测内网更新（决议 #167/#168/#170/#171/#172/#173）：主动查同平台更高版本在线源，并可发起索包请求。
type UpdateCheckKind = 'idle' | 'checking' | 'found' | 'requesting' | 'requested' | 'none' | 'error'
const checkingUpdate = ref(false)
const requestingUpdate = ref(false)
const updateCheckKind = ref<UpdateCheckKind>('idle')
const updateCheckMsg = ref('')
const updateHelpText = computed(() => (tr('只从已发现的在线同事中查找同平台更新源，不访问外网；同步更新只发起内网索包，不会静默安装。')))
const updateActionBusy = computed(() => checkingUpdate.value || requestingUpdate.value)
const updateCheckSummary = computed(() => {
  if (updateCheckKind.value === 'checking') return tr('正在检测')
  if (updateCheckKind.value === 'found') return tr('有新版')
  if (updateCheckKind.value === 'requesting') return tr('正在请求')
  if (updateCheckKind.value === 'requested') return tr('请求已发出')
  if (updateCheckKind.value === 'none') return tr('已是最新')
  if (updateCheckKind.value === 'error') return tr('检测失败')
  return tr('未检查')
})
async function checkForUpdate(): Promise<void> {
  if (updateActionBusy.value) return
  checkingUpdate.value = true
  updateCheckKind.value = 'checking'
  updateCheckMsg.value = ''
  try {
    const result = await window.pantry.checkUpdate()
    if (result) {
      updateCheckKind.value = 'found'
      updateCheckMsg.value = tr('v{0}，来自 {1}。', { 0: result.version, 1: result.fromName })
    } else {
      updateCheckKind.value = 'none'
      updateCheckMsg.value = ''
    }
  } catch {
    updateCheckKind.value = 'error'
    updateCheckMsg.value = tr('检测失败，请稍后重试。')
  } finally {
    checkingUpdate.value = false
  }
}
async function requestDetectedUpdate(): Promise<void> {
  if (updateActionBusy.value) return
  requestingUpdate.value = true
  updateCheckKind.value = 'requesting'
  updateCheckMsg.value = ''
  try {
    const ok = await window.pantry.requestUpdate()
    if (ok) {
      updateCheckKind.value = 'requested'
      updateCheckMsg.value = ''
    } else {
      updateCheckKind.value = 'error'
      updateCheckMsg.value = tr('请求未送达，请稍后重试。')
    }
  } catch {
    updateCheckKind.value = 'error'
    updateCheckMsg.value = tr('请求更新失败，请稍后重试。')
  } finally {
    requestingUpdate.value = false
  }
}
const updateActionIcon = computed(() => {
  if (updateActionBusy.value) return 'loader'
  return updateCheckKind.value === 'found' ? 'check' : 'refresh'
})
const updateActionLabel = computed(() => {
  if (checkingUpdate.value) return tr('检测中')
  if (requestingUpdate.value) return tr('请求中')
  if (updateCheckKind.value === 'found') return tr('同步更新')
  return tr('检测内网更新')
})
function runUpdateAction(): void {
  if (updateCheckKind.value === 'found') {
    void requestDetectedUpdate()
    return
  }
  void checkForUpdate()
}

// 我的资料表单
const nick = ref('')
const company = ref('')
const dept = ref('')
const team = ref('')
const avatar = ref(-1)
const avatarHash = ref('')
type AvatarMode = 'animal' | 'initial' | 'custom'
const avatarMode = ref<AvatarMode>('initial')
const avatarSource = ref<Extract<AvatarSourcePick, { ok: true }> | null>(null)
const avatarSaving = ref(false)
const avatarError = ref('')
const fileDir = ref('')
// 网络表单
const newPeer = ref('')
const newCidr = ref('')
const scanTip = ref('')
const confirmingCidr = ref<string | null>(null)
const transfers = ref<TransferView[]>([])
const conversations = ref<ConversationView[]>([])
const exportConvId = ref('')
const exportFrom = ref('')
const exportTo = ref('')
// 高级表单
const udpPortInput = ref('')
const tcpPortInput = ref('')
type PortField = 'udp' | 'tcp'
const pendingPortEdit = ref<PortField | null>(null)
const unlockedPort = ref<PortField | null>(null)
const udpPortElement = ref<HTMLInputElement | null>(null)
const tcpPortElement = ref<HTMLInputElement | null>(null)
const portWarningDialog = ref<HTMLElement | null>(null)
const pendingPortLabel = computed(() => (pendingPortEdit.value === 'udp' ? 'UDP' : 'TCP'))
// 快捷键表单
const captureShortcut = ref('')
const showHideShortcut = ref('')
let stopSettings: (() => void) | null = null
const selectedAvatarEmoji = computed(() => avatarEmojiIndex(avatar.value))
const selectedAvatarColor = computed(() => avatarColorIndex(avatar.value, nick.value || tr('茶')))
const avatarSummary = computed(() => {
  if (avatarHash.value) return tr('自定义头像')
  const colorName = tr(AVATAR_COLORS[selectedAvatarColor.value]?.name ?? '')
  return isInitialAvatar(avatar.value)
    ? tr('昵称首字 · {0}', { 0: colorName })
    : tr('动物表情 · {0}', { 0: colorName })
})
const currentSection = computed(() => sections.value.find((item) => item.id === section.value) ?? sections.value[0])
const isMacPlatform = computed(() => info.value?.platform === 'darwin')
const modifiedSendKeyLabel = computed(() =>
  isMacPlatform.value ? tr('Command + Enter 发送') : tr('Control + Enter 发送')
)
const activeNotice = computed(() => (section.value === 'network' ? scanTip.value : ''))
const hasManualPeers = computed(() => (settings.value?.manualPeers.length ?? 0) > 0)
const hasScanRanges = computed(() => (settings.value?.scanRangeItems.length ?? 0) > 0)
const hasTransfers = computed(() => transfers.value.length > 0)
const naiveTheme = computed(() => (settings.value?.theme === 'dark' ? darkTheme : null))
const naiveThemeOverrides = computed(() =>
  settings.value?.theme === 'dark' ? teahouseDarkThemeOverrides : teahouseLightThemeOverrides
)
const languageOptions = [...LANGUAGE_OPTIONS]
const fontScaleOptions = [
  { label: '100%', value: 100 },
  { label: '110%', value: 110 },
  { label: '125%', value: 125 }
]
const soundOptions = computed(() => ([
  { label: tr('关闭提示音'), value: 'none' },
  { label: tr('水滴'), value: 'drop' },
  { label: tr('木鱼'), value: 'wood' },
  { label: tr('叮咚'), value: 'ding' }
]))
const conversationOptions = computed(() => [
  { label: tr('全部会话'), value: '' },
  ...conversations.value.map((conv) => ({ label: convLabel(conv), value: conv.id }))
])

onMounted(async () => {
  info.value = await window.pantry.getAppInfo()
  applyPerformanceProfile(info.value)
  await reload()
  stopSettings = window.pantry.onSettingsUpdated((s) => {
    if (settings.value && settings.value.language !== s.language) {
      settings.value = s
      applyAppearance(s)
    } else syncForm(s)
  })
})

onUnmounted(() => {
  stopSettings?.()
  if (toastTimer) clearTimeout(toastTimer)
})

async function reload(): Promise<void> {
  const s = await window.pantry.getSettings()
  syncForm(s)
  conversations.value = await window.pantry.listConversations()
  transfers.value = await window.pantry.listTransfers(30)
}

function syncForm(s: SettingsView): void {
  const keepPendingCustomMode =
    avatarMode.value === 'custom' &&
    !avatarHash.value &&
    avatar.value === s.avatar &&
    !s.avatarHash
  settings.value = s
  nick.value = s.nick
  company.value = s.company
  dept.value = s.dept
  team.value = s.team
  avatar.value = s.avatar
  avatarHash.value = s.avatarHash
  if (!keepPendingCustomMode) {
    avatarMode.value = s.avatarHash ? 'custom' : isInitialAvatar(s.avatar) ? 'initial' : 'animal'
  }
  fileDir.value = s.fileDir
  udpPortInput.value = String(s.udpPort)
  tcpPortInput.value = String(s.tcpPort)
  captureShortcut.value = s.captureShortcut
  showHideShortcut.value = s.showHideShortcut
  applyAppearance(s)
}

// 「设置已保存」浮层 toast（决议 #151）：失焦 / 调整即时保存后，底部居中胶囊淡入，停留约 1.8s 后淡出
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashSaved(text = tr('设置已保存')): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1800)
}

// 关于页源码链接（决议 #90）：交系统浏览器打开，非 app 内加载远程内容，不违反纯内网红线
async function openUrl(url: string): Promise<void> {
  await window.pantry.openUrl(url)
}

async function changeLanguage(value: SettingsView['language']): Promise<void> {
  try {
    const next = await window.pantry.saveAppSettings({ language: value })
    await applyLanguage(next.language)
    settings.value = next
    flashSaved()
  } catch {
    flashSaved(tr('切换语言失败，请重试'))
  }
}

async function saveApp(patch: AppSettingsPatch, tip = tr('已保存')): Promise<void> {
  const next = await window.pantry.saveAppSettings(patch)
  syncForm(next)
  flashSaved(tip)
}

function profileDirty(): boolean {
  const s = settings.value
  if (!s) return false
  return (
    nick.value.trim() !== s.nick ||
    company.value.trim() !== s.company ||
    dept.value.trim() !== s.dept ||
    team.value.trim() !== s.team ||
    avatar.value !== s.avatar ||
    avatarHash.value !== s.avatarHash ||
    fileDir.value !== s.fileDir
  )
}

// 资料失焦 / 头像点击 / 改目录后即时保存（决议 #151）：昵称必填，空则复原并提示；无改动则跳过、不弹窗
async function autoSaveProfile(): Promise<void> {
  if (!nick.value.trim()) {
    if (settings.value) nick.value = settings.value.nick
    flashSaved(tr('昵称不能为空'))
    return
  }
  if (!profileDirty()) return
  settings.value = await window.pantry.saveProfile({
    nick: nick.value.trim(),
    company: company.value.trim(),
    dept: dept.value.trim(),
    team: team.value.trim(),
    avatar: avatar.value,
    avatarHash: avatarHash.value,
    fileDir: fileDir.value
  })
  if (settings.value) syncForm(settings.value)
  flashSaved(tr('设置已保存'))
}

function chooseInitialAvatar(): void {
  avatarMode.value = 'initial'
  avatarHash.value = ''
  avatar.value = initialAvatarValue(selectedAvatarColor.value)
  void autoSaveProfile()
}

function chooseAvatarEmoji(index: number): void {
  avatarMode.value = 'animal'
  avatarHash.value = ''
  avatar.value = avatarValue(index, selectedAvatarColor.value)
  void autoSaveProfile()
}

function chooseAvatarColor(index: number): void {
  avatarHash.value = ''
  avatar.value =
    avatarMode.value === 'initial'
      ? initialAvatarValue(index)
      : avatarValue(selectedAvatarEmoji.value >= 0 ? selectedAvatarEmoji.value : 0, index)
  void autoSaveProfile()
}

function selectCustomAvatarMode(): void {
  avatarMode.value = 'custom'
  avatarError.value = ''
}

async function pickCustomAvatar(): Promise<void> {
  if (avatarSaving.value) return
  const source = await window.pantry.pickAvatarSource()
  if (!source) return
  if (!source.ok) {
    flashSaved(source.error)
    return
  }
  avatarError.value = ''
  avatarSource.value = source
}

async function applyCustomAvatar(bytes: ArrayBuffer): Promise<void> {
  if (avatarSaving.value) return
  avatarSaving.value = true
  avatarError.value = ''
  try {
    const next = await window.pantry.setProfileAvatar({ kind: 'custom', bytes })
    syncForm(next)
    avatarSource.value = null
    flashSaved(tr('头像已更新'))
  } catch {
    avatarError.value = tr('保存头像失败，请稍后重试')
  } finally {
    avatarSaving.value = false
  }
}

function avatarOptionStyle(index: number): { backgroundColor: string; color: string } {
  return avatarStyle(avatarValue(index, selectedAvatarColor.value), nick.value || tr('茶'))
}

async function pickFileDir(): Promise<void> {
  const dir = await window.pantry.pickDirectory()
  if (dir) {
    fileDir.value = dir
    await autoSaveProfile()
  }
}

async function toggleNotifications(value: boolean): Promise<void> {
  await saveApp({ notifications: value })
}

async function toggleHideOnCapture(value: boolean): Promise<void> {
  await saveApp({ hideOnCapture: value })
}

async function toggleAutoLaunch(value: boolean): Promise<void> {
  await saveApp({ autoLaunch: value })
}

async function toggleCloseToTray(value: boolean): Promise<void> {
  await saveApp({ closeToTray: value })
}

async function toggleMessagePreview(value: boolean): Promise<void> {
  await saveApp({ showMessagePreview: value })
}

async function toggleDirectFileReceive(value: boolean): Promise<void> {
  await saveApp({ allowDirectFileSend: value })
}

function openCabinet(): void {
  void window.pantry.openCabinet()
}

async function changeFontScale(value: string | number | null): Promise<void> {
  if (value === 100 || value === 110 || value === 125) await saveApp({ fontScale: value })
}

async function changeSound(value: string | number | null): Promise<void> {
  if (value === 'none' || value === 'drop' || value === 'wood' || value === 'ding') {
    await saveApp({ sound: value })
  }
}

async function changeTheme(value: 'light' | 'dark'): Promise<void> {
  await saveApp({ theme: value })
}

async function changeSendKey(value: 'enter' | 'ctrlEnter'): Promise<void> {
  await saveApp({ sendKey: value })
}

async function resetAppSettings(): Promise<void> {
  await saveApp(
    {
      notifications: true,
      manualPeers: [],
      scanRanges: [],
      udpPort: DEFAULT_UDP_PORT,
      tcpPort: DEFAULT_TCP_PORT,
      hideOnCapture: true,
      autoLaunch: true,
      closeToTray: true,
      theme: 'light',
      fontScale: 100,
      showMessagePreview: true,
      allowDirectFileSend: true,
      sound: 'none',
      sendKey: 'enter',
      captureShortcut: DEFAULT_CAPTURE_SHORTCUT,
      showHideShortcut: DEFAULT_SHOWHIDE_SHORTCUT
    },
    tr('应用设置已重置')
  )
}

async function saveShortcuts(): Promise<void> {
  await saveApp(
    {
      captureShortcut: captureShortcut.value.trim(),
      showHideShortcut: showHideShortcut.value.trim()
    },
    tr('快捷键已保存')
  )
}

// 快捷键录制框失焦即保存（决议 #151）：清录制态，组合键有变才写入
async function onShortcutBlur(): Promise<void> {
  recordingShortcut.value = null
  const s = settings.value
  if (!s) return
  if (
    captureShortcut.value.trim() === s.captureShortcut &&
    showHideShortcut.value.trim() === s.showHideShortcut
  ) {
    return
  }
  await saveShortcuts()
}

async function resetShortcuts(): Promise<void> {
  captureShortcut.value = DEFAULT_CAPTURE_SHORTCUT
  showHideShortcut.value = DEFAULT_SHOWHIDE_SHORTCUT
  await saveApp(
    {
      captureShortcut: DEFAULT_CAPTURE_SHORTCUT,
      showHideShortcut: DEFAULT_SHOWHIDE_SHORTCUT
    },
    tr('已恢复默认快捷键')
  )
}

// ---- 录制式快捷键输入（决议 #57）：聚焦后直接按组合键，Esc/退格清空 = 禁用 ----

const recordingShortcut = ref<'capture' | 'showHide' | null>(null)

/** e.code → Electron accelerator 主键名；仅收常用且 normalizeShortcut 白名单内的键 */
function mainKeyOf(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  const map: Record<string, string> = {
    Space: 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Minus: '-'
  }
  return map[code] ?? null
}

function onShortcutKeydown(event: KeyboardEvent, target: 'capture' | 'showHide'): void {
  event.preventDefault()
  event.stopPropagation()
  const model = target === 'capture' ? captureShortcut : showHideShortcut
  if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Delete') {
    model.value = ''
    return
  }
  const mods: string[] = []
  if (event.ctrlKey || event.metaKey) mods.push('CommandOrControl')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  const key = mainKeyOf(event.code)
  // 全局快捷键必须带修饰键，避免吞掉普通按键
  if (!key || mods.length === 0) return
  model.value = [...mods, key].join('+')
}

/** accelerator → 给用户看的组合（存储仍是 accelerator 原文） */
function shortcutLabel(acc: string): string {
  if (!acc.trim()) return ''
  const mod = info.value?.platform === 'darwin' ? '⌘' : 'Ctrl'
  return acc.replace('CommandOrControl', mod).replace(/\+/g, ' + ')
}

// 端口框失焦即保存（决议 #151）：无改动跳过；无效值复原并提示
async function autoSavePorts(): Promise<void> {
  const s = settings.value
  if (!s) return
  if (udpPortInput.value === String(s.udpPort) && tcpPortInput.value === String(s.tcpPort)) return
  const udpPort = parsePort(udpPortInput.value)
  const tcpPort = parsePort(tcpPortInput.value)
  if (!udpPort || !tcpPort) {
    udpPortInput.value = String(s.udpPort)
    tcpPortInput.value = String(s.tcpPort)
    flashSaved(tr('端口需为 1-65535'))
    return
  }
  await saveApp({ udpPort, tcpPort }, tr('端口已保存，重启后生效'))
}

function parsePort(value: string): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

function requestPortEdit(field: PortField, event: FocusEvent): void {
  if (unlockedPort.value === field || pendingPortEdit.value === field) return
  if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur()
  pendingPortEdit.value = field
  void nextTick(() => {
    const cancelButton = portWarningDialog.value?.querySelector<HTMLButtonElement>(
      '.port-warning-actions button'
    )
    cancelButton?.focus()
  })
}

function cancelPortEdit(): void {
  pendingPortEdit.value = null
}

function confirmPortEdit(): void {
  const field = pendingPortEdit.value
  if (!field) return
  pendingPortEdit.value = null
  unlockedPort.value = field
  void nextTick(() => {
    const target = field === 'udp' ? udpPortElement.value : tcpPortElement.value
    target?.focus()
    target?.select()
  })
}

async function finishPortEdit(field: PortField): Promise<void> {
  if (unlockedPort.value !== field) return
  unlockedPort.value = null
  await autoSavePorts()
}

async function exportData(format: 'backup' | 'html' | 'txt'): Promise<void> {
  const path = await window.pantry.exportData(format, exportOptions())
  flashSaved(path ? tr('已导出') : tr('导出已取消'))
}

function exportOptions(): DataExportOptions | undefined {
  const out: DataExportOptions = {}
  if (exportConvId.value) out.convId = exportConvId.value
  const from = dateStart(exportFrom.value)
  const to = dateEnd(exportTo.value)
  if (from !== null) out.fromTs = from
  if (to !== null) out.toTs = to
  return Object.keys(out).length > 0 ? out : undefined
}

function dateStart(value: string): number | null {
  if (!value) return null
  const ts = new Date(`${value}T00:00:00`).getTime()
  return Number.isFinite(ts) ? ts : null
}

function dateEnd(value: string): number | null {
  if (!value) return null
  const ts = new Date(`${value}T23:59:59.999`).getTime()
  return Number.isFinite(ts) ? ts : null
}

function convLabel(conv: ConversationView): string {
  const prefix = conv.type === 'group' ? tr('讨论组') : tr('单聊')
  return `${prefix} ${conv.peerId}${conv.preview ? ` · ${conv.preview.slice(0, 18)}` : ''}`
}

async function importData(): Promise<void> {
  const result = await window.pantry.importData()
  flashSaved(result ? tr('已导入 {0} 条，跳过 {1} 条', { 0: result.imported, 1: result.skipped }) : tr('导入已取消'))
}

async function revealTransfer(transferId: string): Promise<void> {
  await window.pantry.revealTransfer(transferId)
}

function transferStatusLabel(view: TransferView): string {
  const map: Record<TransferView['status'], string> = {
    offering: tr('等待'),
    accepted: tr('传输中'),
    done: tr('完成'),
    declined: tr('已拒收'),
    canceled: tr('已取消'),
    failed: tr('失败'),
    expired: view.direction === 'out' ? tr('发送已到期') : tr('文件已过期')
  }
  return map[view.status]
}

function transferMeta(view: TransferView): string {
  const size = formatBytes(view.totalSize)
  const done = formatBytes(view.bytesDone)
  return view.status === 'accepted' ? `${done} / ${size}` : size
}

function scanRangeSourceLabel(item: ScanRangeItemView): string {
  if (item.source === 'self') return tr('本机')
  const name = item.sourceName?.trim() || tr('同事')
  return tr('来自 {0}', { 0: name })
}

async function addPeer(): Promise<void> {
  const addr = newPeer.value.trim()
  if (!addr) return
  const ok = await window.pantry.addManualPeer(addr)
  if (ok) {
    newPeer.value = ''
    await reload()
    flashSaved(tr('已添加并探测'))
  } else {
    flashSaved(tr('地址格式不对（ip 或 ip:端口）'))
  }
}

async function removePeer(addr: string): Promise<void> {
  if (!settings.value) return
  await saveApp({
    manualPeers: settings.value.manualPeers.filter((p) => p !== addr)
  })
}

async function addRange(): Promise<void> {
  const cidr = newCidr.value.trim()
  if (!cidr || !settings.value) return
  const count = await window.pantry.scanRange(cidr)
  if (count < 0) {
    scanTip.value = tr('网段不合法（如 10.1.2.0/24，最大 /22）')
    return
  }
  scanTip.value = tr('已向 {0} 个地址发出探测，在线的会出现在通讯录', { 0: count })
  if (!settings.value.scanRanges.includes(cidr)) {
    await saveApp({
      scanRanges: [...settings.value.scanRanges, cidr]
    })
  }
  newCidr.value = ''
}

async function rescan(cidr: string): Promise<void> {
  const count = await window.pantry.scanRange(cidr)
  scanTip.value =
    count >= 0 ? tr('已向 {0} 个地址发出探测，新上线的同事稍后计入在线数', { 0: count }) : tr('网段不合法')
  // 探测/应答异步滞后，延迟重拉设置以更新在线数（决议 #160）
  if (count >= 0) setTimeout(() => void reload(), 2500)
}

async function removeRange(cidr: string): Promise<void> {
  if (!settings.value) return
  await saveApp({
    scanRanges: settings.value.scanRanges.filter((r) => r !== cidr)
  })
}

// 删除二次确认（决议 #160）：点 ✕ 进确认态，点「删除」才真正移除
async function confirmRemove(cidr: string): Promise<void> {
  confirmingCidr.value = null
  await removeRange(cidr)
}
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="naiveThemeOverrides"
    :locale="language === 'en' ? enUS : zhCN"
    :date-locale="language === 'en' ? dateEnUS : dateZhCN"
  >
    <div class="settings">
    <!-- 沉浸式无标题栏（决议 #49/#52）：顶部拖拽带；设置窗 Win/Linux 仅自绘关闭按钮 -->
    <WindowDragStrip />
    <WindowControls buttons="close" />
    <aside class="sidebar">
      <nav class="nav" :aria-label="tr('设置分组')">
        <button
          v-for="item in sections"
          :key="item.id"
          :class="{ on: section === item.id }"
          @click="section = item.id"
        >
          <SettingsNavIcon class="nav-icon" :name="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
    </aside>

    <main class="body">
      <header class="page-head">
        <div>
          <h1>{{ currentSection.label }}</h1>
          <p>{{ currentSection.summary }}</p>
        </div>
        <span v-if="activeNotice" class="notice">{{ activeNotice }}</span>
      </header>

      <div v-if="!settings" class="empty-panel">{{ tr('正在读取设置...') }}</div>

      <template v-else>
        <section v-if="section === 'profile'" class="page-section">
          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('个人身份') }}</h2>
              <p>{{ tr('昵称必填。公司、部门、团队会用于通讯录树形分组。') }}</p>
            </div>
            <!-- 头像编辑器（决议 #50/#245）：三种模式按需展示动物、色板或上传入口 -->
            <div class="avatar-editor">
              <div class="avatar-stage">
                <AvatarMark
                  class="avatar-preview"
                  :avatar="avatar"
                  :avatar-hash="avatarHash"
                  :name="nick || tr('茶')"
                />
                <span class="avatar-current">{{ avatarSummary }}</span>
              </div>
              <div class="avatar-mode-block">
                <div
                  class="preference-segment avatar-mode"
                  role="radiogroup"
                  :aria-label="tr('头像样式')"
                >
                  <button
                    type="button"
                    role="radio"
                    :class="{ on: avatarMode === 'animal' }"
                    :aria-checked="avatarMode === 'animal'"
                    @click="chooseAvatarEmoji(selectedAvatarEmoji >= 0 ? selectedAvatarEmoji : 0)"
                  >{{ tr('动物表情') }}</button>
                  <button
                    type="button"
                    role="radio"
                    :class="{ on: avatarMode === 'initial' }"
                    :aria-checked="avatarMode === 'initial'"
                    @click="chooseInitialAvatar"
                  >{{ tr('昵称首字') }}</button>
                  <button
                    type="button"
                    role="radio"
                    :class="{ on: avatarMode === 'custom' }"
                    :aria-checked="avatarMode === 'custom'"
                    @click="selectCustomAvatarMode"
                  >{{ tr('自定义头像') }}</button>
                </div>
                <p class="avatar-mode-hint">
                  {{
                    avatarMode === 'custom'
                      ? tr('上传本地图片并裁剪；图片只会在局域网内按需同步。')
                      : avatarMode === 'initial'
                      ? tr('使用昵称第一个字作头像，并从下方选择背景色。')
                      : tr('从下方挑一个动物表情，再配一个背景色。')
                  }}
                </p>
              </div>
              <div v-if="avatarMode !== 'custom'" class="avatar-pick">
                <template v-if="avatarMode === 'animal'">
                  <span class="avatar-label">{{ tr('动物表情') }}</span>
                  <div class="avatar-grid" :aria-label="tr('精选动物表情')">
                    <button
                      v-for="(_, idx) in AVATAR_EMOJIS"
                      :key="idx"
                      type="button"
                      class="avatar-choice"
                      :class="{ on: selectedAvatarEmoji === idx }"
                      :style="avatarOptionStyle(idx)"
                      :aria-label="tr('动物表情 {0}', { 0: idx + 1 })"
                      @click="chooseAvatarEmoji(idx)"
                    >
                      <AvatarGlyph :index="idx" />
                    </button>
                  </div>
                </template>
                <span class="avatar-label">{{ tr('背景颜色') }}</span>
                <div class="avatar-colors" :aria-label="tr('头像背景颜色')">
                  <button
                    v-for="(color, idx) in AVATAR_COLORS"
                    :key="color.name"
                    type="button"
                    class="color-choice"
                    :class="{ on: selectedAvatarColor === idx }"
                    :style="{ backgroundColor: color.bg }"
                    :title="tr(color.name)"
                    :aria-label="tr('头像背景颜色：{0}', { 0: tr(color.name) })"
                    @click="chooseAvatarColor(idx)"
                  ></button>
                </div>
              </div>
              <div v-else class="avatar-pick avatar-picture-actions">
                <button type="button" :disabled="avatarSaving" @click="pickCustomAvatar">{{ tr('上传图片') }}</button>
              </div>
            </div>
            <div class="field-grid">
              <label class="field">
                <span>{{ tr('昵称') }}</span>
                <NInput
                  v-model:value="nick"
                  maxlength="32"
                  :placeholder="tr('请输入昵称')"
                  @blur="autoSaveProfile"
                />
              </label>
              <label class="field">
                <span>{{ tr('公司') }}</span>
                <NInput
                  v-model:value="company"
                  maxlength="32"
                  :placeholder="tr('选填')"
                  @blur="autoSaveProfile"
                />
              </label>
              <label class="field">
                <span>{{ tr('部门') }}</span>
                <NInput
                  v-model:value="dept"
                  maxlength="32"
                  :placeholder="tr('选填')"
                  @blur="autoSaveProfile"
                />
              </label>
              <label class="field">
                <span>{{ tr('团队') }}</span>
                <NInput
                  v-model:value="team"
                  maxlength="32"
                  :placeholder="tr('选填')"
                  @blur="autoSaveProfile"
                />
              </label>
            </div>
          </div>
        </section>

        <section v-else-if="section === 'general'" class="page-section">
          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('启动与窗口') }}</h2>
              <p>{{ tr('办公内网常驻使用，默认保持后台在线。') }}</p>
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('开机自启') }}</strong>
                <small>{{ tr('登录系统后自动启动茶话间。') }}</small>
              </div>
              <NSwitch :value="settings.autoLaunch" @update:value="toggleAutoLaunch" />
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('关闭到托盘') }}</strong>
                <small>{{ tr('点关闭按钮时保持在线，仍可接收消息。') }}</small>
              </div>
              <NSwitch :value="settings.closeToTray" @update:value="toggleCloseToTray" />
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('外观') }}</h2>
              <p>{{ tr('主题和字体缩放会同步到主窗口，调整后立即生效。') }}</p>
            </div>
            <div class="setting-line">
              <div>
                <strong>语言 / Language</strong>
                <small>{{ tr('立即应用到所有窗口。') }}</small>
              </div>
              <NSelect class="language-select" :value="settings.language" :options="languageOptions"
                aria-label="语言 / Language" @update:value="changeLanguage" />
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('主题') }}</strong>
                <small>{{ tr('深色主题适合弱光环境。') }}</small>
              </div>
              <div
                class="preference-segment theme-segment"
                role="radiogroup"
                :aria-label="tr('主题')"
                :data-second="settings.theme === 'dark'"
              >
                <button
                  type="button"
                  role="radio"
                  :aria-label="tr('浅色主题')"
                  :aria-checked="settings.theme === 'light'"
                  :class="{ on: settings.theme === 'light' }"
                  @click="changeTheme('light')"
                >
                  <PantryIcon name="sun" :size="16" />
                </button>
                <button
                  type="button"
                  role="radio"
                  :aria-label="tr('深色主题')"
                  :aria-checked="settings.theme === 'dark'"
                  :class="{ on: settings.theme === 'dark' }"
                  @click="changeTheme('dark')"
                >
                  <PantryIcon name="moon" :size="16" />
                </button>
              </div>
            </div>
            <label class="setting-line">
              <div>
                <strong>{{ tr('字体缩放') }}</strong>
                <small>{{ tr('适配投屏、远距离办公和高分屏。') }}</small>
              </div>
              <NSelect
                class="control-select"
                :value="settings.fontScale"
                :options="fontScaleOptions"
                @update:value="changeFontScale"
              />
            </label>
            <div class="panel-actions">
              <NButton secondary @click="resetAppSettings">{{ tr('重置应用设置') }}</NButton>
            </div>
          </div>
        </section>

        <section v-else-if="section === 'notify'" class="page-section">
          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('提醒') }}</h2>
              <p>{{ tr('通知开关只影响桌面提醒，不影响消息接收。') }}</p>
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('系统通知') }}</strong>
                <small>{{ tr('新消息到达时显示系统通知。') }}</small>
              </div>
              <NSwitch :value="settings.notifications" @update:value="toggleNotifications" />
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('通知内容预览') }}</strong>
                <small>{{ tr('关闭后通知只显示会话名称。') }}</small>
              </div>
              <NSwitch :value="settings.showMessagePreview" @update:value="toggleMessagePreview" />
            </div>
            <label class="setting-line">
              <div>
                <strong>{{ tr('提示音') }}</strong>
                <small>{{ tr('默认关闭，减少办公环境打扰。') }}</small>
              </div>
              <NSelect
                class="control-select"
                :value="settings.sound"
                :options="soundOptions"
                @update:value="changeSound"
              />
            </label>
          </div>
        </section>

        <section v-else-if="section === 'storage'" class="page-section">
          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('文件接收') }}</h2>
              <p>{{ tr('不用另存为时，收到的文件会按联系人名称分目录保存。') }}</p>
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('保存位置') }}</strong>
                <small class="path">{{ fileDir || settings.defaultFileDir }}</small>
              </div>
              <NButton secondary size="small" @click="pickFileDir">{{ tr('更改') }}</NButton>
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('允许同事直接发送文件') }}</strong>
                <small>{{ tr('开启后，私聊文件可由发送方免确认发来，同样保存到联系人目录。') }}</small>
              </div>
              <NSwitch
                :value="settings.allowDirectFileSend"
                @update:value="toggleDirectFileReceive"
              />
            </div>
            <!-- 我的文件柜已迁到文件柜窗口（决议 #283）：此处只留指路，不摆重复控件 -->
            <div class="setting-line">
              <div>
                <strong>{{ tr('我的文件柜') }}</strong>
                <small>{{ tr('共享目录、默认权限、按联系人例外都在主界面的「文件柜」里设置——左侧导航栏的文件柜按钮即可进入。') }}</small>
              </div>
              <NButton secondary size="small" @click="openCabinet">{{ tr('打开文件柜') }}</NButton>
            </div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('发送') }}</h2>
              <p>{{ tr('发送键影响所有单聊和讨论组输入框，调整后立即生效。') }}</p>
            </div>
            <div class="setting-line">
              <div>
                <strong>{{ tr('发送键') }}</strong>
                <small>{{ tr('另一组组合键用于换行。') }}</small>
              </div>
              <div
                class="preference-segment send-key-segment"
                role="radiogroup"
                :aria-label="tr('发送键')"
                :data-second="settings.sendKey === 'ctrlEnter'"
              >
                <button
                  type="button"
                  role="radio"
                  :aria-label="tr('Enter 发送')"
                  :aria-checked="settings.sendKey === 'enter'"
                  :class="{ on: settings.sendKey === 'enter' }"
                  @click="changeSendKey('enter')"
                >
                  <span class="key-chord" aria-hidden="true">
                    <span class="keycap"><PantryIcon name="key-enter" :size="14" /></span>
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  :aria-label="modifiedSendKeyLabel"
                  :aria-checked="settings.sendKey === 'ctrlEnter'"
                  :class="{ on: settings.sendKey === 'ctrlEnter' }"
                  @click="changeSendKey('ctrlEnter')"
                >
                  <span class="key-chord" aria-hidden="true">
                    <span class="keycap">
                      <PantryIcon :name="isMacPlatform ? 'key-command' : 'key-control'" :size="14" />
                    </span>
                    <span class="key-plus">+</span>
                    <span class="keycap"><PantryIcon name="key-enter" :size="14" /></span>
                  </span>
                </button>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('聊天记录') }}</h2>
              <p>{{ tr('导出阅读格式或迁移备份包；导入时会按消息 ID 去重。') }}</p>
            </div>
            <label class="field">
              <span>{{ tr('导出会话') }}</span>
              <NSelect
                v-model:value="exportConvId"
                :options="conversationOptions"
                filterable
              />
            </label>
            <div class="field">
              <span>{{ tr('时间范围') }}</span>
              <div class="date-range">
                <input v-model="exportFrom" type="date" />
                <span>{{ tr('至') }}</span>
                <input v-model="exportTo" type="date" />
              </div>
            </div>
            <div class="button-row export-actions">
              <NButton secondary @click="exportData('backup')">{{ tr('备份包') }}</NButton>
              <NButton secondary @click="exportData('html')">HTML</NButton>
              <NButton secondary @click="exportData('txt')">TXT</NButton>
              <NButton type="primary" secondary @click="importData">{{ tr('导入') }}</NButton>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('传输记录') }}</h2>
              <p>{{ tr('显示最近 30 条文件传输。') }}</p>
            </div>
            <div v-if="!hasTransfers" class="empty-state">{{ tr('暂无传输记录') }}</div>
            <ul v-else class="transfer-list">
              <li v-for="t in transfers" :key="t.transferId">
                <div>
                  <strong>{{ t.name }}</strong>
                  <small>{{ transferStatusLabel(t) }} · {{ transferMeta(t) }}</small>
                </div>
                <NButton
                  secondary
                  size="small"
                  :disabled="!t.savedPath"
                  @click="revealTransfer(t.transferId)"
                >{{ tr('打开') }}</NButton>
              </li>
            </ul>
          </div>
        </section>

        <section v-else-if="section === 'network'" class="page-section">
          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('手动节点') }}</h2>
              <p>{{ tr('跨网段发现失败时，可手动添加对方 IP 或 IP:端口。') }}</p>
            </div>
            <div class="inline-form">
              <NInput
                v-model:value="newPeer"
                :placeholder="tr('如 10.2.0.8 或 10.2.0.8:17878')"
                @keydown.enter="addPeer"
              />
              <NButton type="primary" @click="addPeer">{{ tr('添加') }}</NButton>
            </div>
            <div v-if="!hasManualPeers" class="empty-state">{{ tr('尚未添加手动节点') }}</div>
            <ul v-else class="chips">
              <li v-for="p in settings.manualPeers" :key="p">
                <span>{{ p }}</span>
                <button class="icon-button" :title="tr('移除')" @click="removePeer(p)">
                  <PantryIcon name="x" :size="13" />
                </button>
              </li>
            </ul>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('网段扫描') }}</h2>
              <p>{{ tr('用于发现同内网不同网段的同事，最大支持 /22。') }}</p>
            </div>
            <div class="inline-form">
              <NInput
                v-model:value="newCidr"
                :placeholder="tr('如 10.1.2.0/24')"
                @keydown.enter="addRange"
              />
              <NButton type="primary" @click="addRange">{{ tr('扫描') }}</NButton>
            </div>
            <div v-if="!hasScanRanges" class="empty-state">{{ tr('尚未保存扫描网段') }}</div>
            <div v-else class="range-table">
              <div class="range-row range-head">
                <span>{{ tr('网段') }}</span>
                <span>{{ tr('在线') }}</span>
                <span>{{ tr('操作') }}</span>
              </div>
              <div v-for="r in settings.scanRangeItems" :key="r.cidr" class="range-row">
                <div class="range-cidr">
                  <span class="cidr-text">{{ r.cidr }}</span>
                  <span class="cidr-source">（{{ scanRangeSourceLabel(r) }}）</span>
                </div>
                <span class="range-count">
                  <span class="count-badge" :class="{ zero: r.nodeCount === 0 }">{{ r.nodeCount }}</span>
                </span>
                <span class="range-ops">
                  <button class="icon-button accent" :title="tr('刷新该网段（重新探测）')" @click="rescan(r.cidr)">
                    <PantryIcon name="refresh" :size="14" />
                  </button>
                  <button class="icon-button danger" :title="tr('删除该网段')" @click="confirmingCidr = r.cidr">
                    <PantryIcon name="x" :size="14" />
                  </button>
                </span>
                <div v-if="confirmingCidr === r.cidr" class="range-confirm">
                  <span class="confirm-q">{{ tr('删除该网段？') }}</span>
                  <button class="confirm-del" @click="confirmRemove(r.cidr)">{{ tr('删除') }}</button>
                  <button class="confirm-cancel" @click="confirmingCidr = null">{{ tr('取消') }}</button>
                </div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('端口') }}</h2>
              <p>{{ tr('全员端口需一致，修改后重启应用生效。') }}</p>
            </div>
            <div class="field-grid">
              <label class="field">
                <span>{{ tr('UDP 端口') }}</span>
                <input
                  ref="udpPortElement"
                  v-model="udpPortInput"
                  class="port-input"
                  type="number"
                  min="1"
                  max="65535"
                  :readonly="unlockedPort !== 'udp'"
                  aria-haspopup="dialog"
                  @focus="requestPortEdit('udp', $event)"
                  @blur="finishPortEdit('udp')"
                />
              </label>
              <label class="field">
                <span>{{ tr('TCP 端口') }}</span>
                <input
                  ref="tcpPortElement"
                  v-model="tcpPortInput"
                  class="port-input"
                  type="number"
                  min="1"
                  max="65535"
                  :readonly="unlockedPort !== 'tcp'"
                  aria-haspopup="dialog"
                  @focus="requestPortEdit('tcp', $event)"
                  @blur="finishPortEdit('tcp')"
                />
              </label>
            </div>
          </div>
        </section>

        <section v-else-if="section === 'shortcuts'" class="page-section">
          <div class="panel">
            <div class="panel-head">
              <h2>{{ tr('全局快捷键') }}</h2>
              <p>{{ tr('点击输入框后直接按下组合键（需包含 Ctrl/Alt 等修饰键）；Esc 或退格清空表示禁用。') }}</p>
            </div>
            <label class="field">
              <span>{{ tr('截图') }}</span>
              <input
                class="shortcut-input"
                :class="{ recording: recordingShortcut === 'capture' }"
                :value="
                  recordingShortcut === 'capture' && !captureShortcut
                    ? ''
                    : shortcutLabel(captureShortcut)
                "
                :placeholder="recordingShortcut === 'capture' ? tr('按下新组合键…') : tr('未设置（已禁用）')"
                readonly
                @focus="recordingShortcut = 'capture'"
                @blur="onShortcutBlur"
                @keydown="onShortcutKeydown($event, 'capture')"
              />
              <small v-if="settings.shortcutStatus && !settings.shortcutStatus.capture" class="shortcut-warn">{{ tr('注册失败：组合键可能已被系统或其他程序占用（如 UOS 系统截图），请换一个组合后保存。') }}</small>
            </label>
            <label class="field">
              <span>{{ tr('显示/隐藏主窗') }}</span>
              <input
                class="shortcut-input"
                :class="{ recording: recordingShortcut === 'showHide' }"
                :value="
                  recordingShortcut === 'showHide' && !showHideShortcut
                    ? ''
                    : shortcutLabel(showHideShortcut)
                "
                :placeholder="recordingShortcut === 'showHide' ? tr('按下新组合键…') : tr('未设置（已禁用）')"
                readonly
                @focus="recordingShortcut = 'showHide'"
                @blur="onShortcutBlur"
                @keydown="onShortcutKeydown($event, 'showHide')"
              />
              <small v-if="settings.shortcutStatus && !settings.shortcutStatus.showHide" class="shortcut-warn">{{ tr('注册失败：组合键可能已被系统或其他程序占用，请换一个组合后保存。') }}</small>
            </label>
            <div class="setting-line">
              <div>
                <strong>{{ tr('截图时隐藏窗口') }}</strong>
                <small>{{ tr('避免把茶话间主窗口截进去。') }}</small>
              </div>
              <NSwitch :value="settings.hideOnCapture" @update:value="toggleHideOnCapture" />
            </div>
            <div class="panel-actions">
              <NButton secondary @click="resetShortcuts">{{ tr('恢复默认') }}</NButton>
            </div>
          </div>
        </section>

        <section v-else class="page-section">
          <div class="about-panel">
            <!-- 品牌标识区（决议 #90 重设计）：居中圆标 + 中英文名 + 定位 + 纯内网信任徽条 -->
            <div class="about-hero">
              <PantryBrandLogo variant="color" :size="60" class="about-logo" />
              <h2>{{ tr('茶话间') }}<span v-if="language === 'zh-CN'" class="about-latin">Teahouse</span></h2>
              <p class="about-tagline">{{ tr('纯内网即时通讯与文件传输') }}</p>
              <div class="about-trust">
                <PantryIcon name="shield" :size="13" />
                <span>{{ tr('无服务器 · 无遥测 · 数据不出局域网') }}</span>
              </div>
            </div>

            <!-- 默认只露版本 / 许可 / 源码 / 内网更新（决议 #90/#171/#225）：面向普通用户的核心信息 -->
            <dl class="about-rows">
              <div class="about-row">
                <dt>{{ tr('版本') }}</dt>
                <dd class="mono">{{ info?.version ?? '-' }}</dd>
              </div>
              <div class="about-row">
                <dt>{{ tr('许可') }}</dt>
                <dd>GPL-3.0-only</dd>
              </div>
              <div class="about-row">
                <dt>{{ tr('源码') }}</dt>
                <dd>
                  <a class="about-link" @click="openUrl('https://github.com/nameGXF/teahouse')">
                    github.com/nameGXF/teahouse
                    <PantryIcon name="external" :size="13" />
                  </a>
                </dd>
              </div>
              <div class="about-row about-update-row" :class="'is-' + updateCheckKind">
                <dt>{{ tr('内网更新') }}</dt>
                <dd aria-live="polite">
                  <div class="about-update-main">
                    <span class="about-update-status">
                      <strong>{{ updateCheckSummary }}</strong>
                      <span class="about-update-help">
                        <button
                          type="button"
                          class="about-help-trigger"
                          :aria-label="tr('内网更新说明')"
                          aria-describedby="about-update-help"
                        >
                          ?
                        </button>
                        <span id="about-update-help" class="about-help-pop" role="tooltip">
                          {{ updateHelpText }}
                        </span>
                      </span>
                    </span>
                    <button
                      class="ghost compact about-update-action"
                      :class="{ 'is-primary': updateCheckKind === 'found' }"
                      :disabled="updateActionBusy"
                      :aria-busy="updateActionBusy"
                      @click="runUpdateAction"
                    >
                      <PantryIcon :name="updateActionIcon" :size="13" />
                      <span>{{ updateActionLabel }}</span>
                    </button>
                  </div>
                  <small v-if="updateCheckMsg">{{ updateCheckMsg }}</small>
                </dd>
              </div>
            </dl>

            <!-- 开发者向运行时信息收进折叠区（决议 #90）：就地展开，Chrome 108 无原生 popover -->
            <button
              class="about-more"
              :aria-expanded="showAboutDetails"
              @click="showAboutDetails = !showAboutDetails"
            >
              <span>{{ showAboutDetails ? tr('收起详细信息') : tr('更多信息') }}</span>
              <PantryIcon :name="showAboutDetails ? 'chevron-up' : 'chevron-down'" :size="15" />
            </button>

            <dl v-if="showAboutDetails" class="about-rows about-detail">
              <div class="about-row">
                <dt>Electron</dt>
                <dd class="mono">{{ info?.electron ?? '-' }}</dd>
              </div>
              <div class="about-row">
                <dt>Chromium</dt>
                <dd class="mono">{{ info?.chrome ?? '-' }}</dd>
              </div>
              <div class="about-row">
                <dt>Node</dt>
                <dd class="mono">{{ info?.node ?? '-' }}</dd>
              </div>
              <div class="about-row">
                <dt>{{ tr('本机节点') }}</dt>
                <dd class="mono nodeid">{{ info?.nodeId ?? '-' }}</dd>
              </div>
              <div class="about-row">
                <dt>{{ tr('Emoji 图形') }}</dt>
                <dd class="muted">{{ tr('Twemoji（本地打包 · CC-BY 4.0）') }}</dd>
              </div>
            </dl>
          </div>
        </section>
      </template>
    </main>
    <Transition name="port-warning">
      <div
        v-if="pendingPortEdit"
        class="port-warning-mask"
        @mousedown.self="cancelPortEdit"
      >
        <section
          ref="portWarningDialog"
          class="port-warning-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="port-warning-title"
          aria-describedby="port-warning-description port-warning-emphasis"
          tabindex="-1"
          @keydown.esc.prevent.stop="cancelPortEdit"
        >
          <div class="port-warning-icon">
            <PantryIcon name="warning" :size="22" />
          </div>
          <h2 id="port-warning-title">{{ tr('确认修改 {0} 端口？', { 0: pendingPortLabel }) }}</h2>
          <p id="port-warning-description">{{ tr('UDP/TCP 端口共同用于局域网发现、消息和文件传输。修改后需要重启应用，并确保相关客户端、防火墙及网络策略使用匹配配置；配置不一致可能导致联系人无法发现、消息或文件无法送达。') }}</p>
          <p id="port-warning-emphasis" class="port-warning-emphasis">{{ tr('只有在你明确了解当前网络部署，并已准备同步调整相关配置时，才建议继续。') }}</p>
          <div class="port-warning-actions">
            <NButton secondary @click="cancelPortEdit">{{ tr('取消') }}</NButton>
            <NButton type="error" @click="confirmPortEdit">{{ tr('确认修改') }}</NButton>
          </div>
        </section>
      </div>
    </Transition>
    <Transition name="toast">
      <div v-if="toast" class="toast" role="status" aria-live="polite">
        <PantryIcon name="check" :size="15" />
        <span>{{ toast }}</span>
      </div>
    </Transition>
    <AvatarCropDialog
      v-if="avatarSource"
      :source="avatarSource"
      :title="tr('调整个人头像')"
      :busy="avatarSaving"
      :error="avatarError"
      @close="avatarSource = null"
      @apply="applyCustomAvatar"
    />
    </div>
  </NConfigProvider>
</template>

<style scoped>
.settings {
  /* 设置页专属标尺（决议 #150）：间距 4px 基准台阶 / 圆角 Shape Lock（容器 8 · 控件 6 · 胶囊 999）/
     字号 4 级阶梯，收敛全页魔数、统一节奏；仅设置页作用域，不影响聊天等其他界面 */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 20px;
  --sp-6: 24px;
  --r-card: 14px;
  --r-control: 9px;
  --r-pill: 999px;
  --fs-title: 22px;
  --fs-section: 15px;
  --fs-body: 13px;
  --fs-aux: 12px;
  display: flex;
  position: relative;
  isolation: isolate;
  height: 100vh;
  min-width: 620px;
  background: var(--bg-chat);
  color: var(--text-1);
}

.settings::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1000;
  pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(33, 59, 46, 0.26);
}

:global(html[data-theme='dark']) .settings::after {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}

.sidebar {
  width: 188px;
  flex: 0 0 188px;
  border-right: 1px solid var(--line);
  background: var(--material-panel);
  box-shadow: var(--highlight-edge), 8px 0 24px rgba(24, 50, 37, 0.035);
  padding: 38px 12px 14px; /* 顶部让出拖拽带与 mac 红绿灯 */
  display: flex;
  flex-direction: column;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav button {
  height: 38px;
  border: none;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--text-2);
  font-size: var(--fs-body);
  text-align: left;
  padding: 0 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 9px;
  transition:
    color 150ms ease,
    background 150ms ease,
    box-shadow 150ms ease,
    transform 90ms ease-out;
}

.nav-icon {
  opacity: 0.78;
  transition: opacity 150ms ease;
}

.nav button:hover {
  background: var(--surface-hover);
  color: var(--text-1);
}

.nav button:hover .nav-icon,
.nav button.on .nav-icon {
  opacity: 1;
}

.nav button.on {
  background: var(--surface-selected);
  color: var(--primary);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--primary), var(--highlight-edge);
}

.nav button:active {
  transform: scale(0.98);
}

.body {
  flex: 1;
  min-width: 0;
  /* 滚动视口从拖拽带下方开始，内容滚动时不会钻进顶部 32px 不可交互区 */
  margin-top: 32px;
  padding: 12px 24px 32px;
  overflow-y: auto;
}

.page-head {
  min-height: 64px;
  display: flex;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 2px 2px 10px;
  margin-bottom: var(--sp-3);
}

.page-head h1 {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-title);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
}

.page-head p,
.panel-head p {
  color: var(--text-3);
  font-size: var(--fs-aux);
  line-height: 1.5;
}

.notice {
  align-self: flex-start;
  max-width: 190px;
  border-radius: var(--r-control);
  background: var(--primary-weak);
  color: var(--primary);
  font-size: var(--fs-aux);
  line-height: 1.4;
  padding: var(--sp-1) var(--sp-2);
}

.page-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.panel,
.empty-panel {
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-soft);
}

.panel {
  padding: 18px;
}

.panel-head {
  margin-bottom: var(--sp-3);
}

.panel-head h2 {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-section);
  font-weight: 700;
  line-height: 1.35;
}

.setting-line {
  min-height: 50px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--line);
}

.panel-head + .setting-line {
  border-top: none;
  padding-top: 0;
}

.setting-line > div:first-child {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.setting-line strong,
.transfer-list strong {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.setting-line small,
.transfer-list small {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.4;
}

.control-select {
  width: 156px;
  flex: 0 0 auto;
}

.is-disabled {
  opacity: 0.72;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.field span {
  color: var(--text-2);
  font-size: 12px;
}

.field > .n-input,
.field > .n-select {
  width: 100%;
}

.inline-form > .n-input {
  flex: 1;
  min-width: 0;
}

.preference-segment {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  flex: 0 0 auto;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-list);
  isolation: isolate;
}

.preference-segment::before {
  content: '';
  position: absolute;
  z-index: 0;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc(50% - 2px);
  border-radius: 6px;
  background: var(--bg-window);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  transform: translateX(0);
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.preference-segment[data-second='true']::before {
  transform: translateX(100%);
}

.preference-segment button {
  position: relative;
  z-index: 1;
  height: 28px;
  min-width: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    color 140ms ease,
    transform 90ms ease-out;
}

.preference-segment button.on {
  color: var(--primary);
  font-weight: 600;
}

.preference-segment button:focus-visible {
  outline: 2px solid rgba(61, 139, 107, 0.55);
  outline-offset: -2px;
}

.preference-segment button:active {
  transform: scale(0.96);
}

.theme-segment {
  width: 86px;
}

.send-key-segment {
  width: 134px;
}

.key-chord {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}

.keycap {
  width: 22px;
  height: 22px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--material-strong);
  box-shadow: inset 0 -1px 0 rgba(24, 50, 37, 0.08);
}

.preference-segment button.on .keycap {
  border-color: rgba(61, 139, 107, 0.38);
}

.key-plus {
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
}

@media (prefers-reduced-motion: reduce) {
  .preference-segment::before,
  .preference-segment button {
    transition: none;
  }

  .preference-segment button:active {
    transform: none;
  }
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2) var(--sp-3);
}

.field-grid .field {
  margin-bottom: 0;
}

.field input,
.field select,
.inline-form input,
.date-range input,
.setting-line select {
  height: 32px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  background: var(--material-strong);
  color: var(--text-1);
  font-size: 13px;
  outline: none;
  padding: 0 10px;
  user-select: text;
}

.field input,
.field select,
.date-range input {
  width: 100%;
}

.field input:focus,
.field select:focus,
.inline-form input:focus,
.date-range input:focus,
.setting-line select:focus {
  border-color: var(--primary);
}

.field input:disabled,
.field select:disabled,
.setting-line select:disabled {
  background: var(--bg-list);
  color: var(--text-3);
}

.port-input[readonly] {
  background: var(--bg-list);
  color: var(--text-2);
  cursor: pointer;
}

.path {
  overflow-wrap: anywhere;
}

/* 录制式快捷键输入（决议 #57） */
.shortcut-input {
  cursor: pointer;
  caret-color: transparent;
}

.shortcut-input.recording {
  border-color: var(--primary);
  background: var(--primary-weak);
}

.shortcut-warn {
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
}

/* 头像编辑器（决议 #50）：预览与样式切换同行，图标网格与色板全宽分节 */
.avatar-editor {
  display: grid;
  grid-template-columns: 88px 1fr;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}

.avatar-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.avatar-preview {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 30px;
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.08),
    0 4px 14px rgba(0, 0, 0, 0.1);
}

.avatar-current {
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
  white-space: nowrap;
}

.avatar-mode-block {
  min-width: 0;
}

.avatar-pick {
  grid-column: 1 / -1;
  min-width: 0;
}

.avatar-mode {
  width: 276px;
  margin-bottom: 8px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.avatar-mode::before {
  display: none;
}

.avatar-mode button.on {
  background: var(--bg-window);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}

.avatar-mode-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}

.avatar-picture-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.avatar-picture-actions button {
  height: 30px;
  border: 1px solid var(--primary);
  border-radius: 7px;
  padding: 0 12px;
  background: var(--primary);
  color: #fff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.avatar-picture-actions button:disabled {
  cursor: default;
  opacity: 0.55;
}

.avatar-label {
  display: block;
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}

.avatar-grid {
  display: grid;
  grid-template-columns: repeat(10, 30px);
  gap: 8px;
  margin-bottom: 12px;
}

.avatar-choice {
  width: 30px;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  font-size: 15px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  transition:
    transform 0.12s ease,
    box-shadow 0.12s ease;
}

.avatar-choice:hover {
  transform: scale(1.12);
}

.avatar-choice.on {
  border-color: var(--primary);
  box-shadow:
    0 0 0 2px var(--primary),
    inset 0 0 0 1px rgba(255, 255, 255, 0.78);
}

.avatar-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.color-choice {
  position: relative;
  width: 24px;
  height: 24px;
  border: 2px solid var(--bg-window);
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--line);
  cursor: pointer;
  transition:
    transform 0.12s ease,
    box-shadow 0.12s ease;
}

.color-choice:hover {
  transform: scale(1.12);
}

.color-choice.on {
  box-shadow: 0 0 0 2px var(--primary);
}

.color-choice.on::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
}

.button-row,
.panel-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.panel-actions {
  justify-content: flex-end;
  margin-top: 14px;
}

.button-row {
  justify-content: flex-end;
  flex: 0 0 auto;
}

.primary,
.ghost {
  height: 32px;
  border-radius: 6px;
  font-size: 13px;
  padding: 0 14px;
  cursor: pointer;
}

.primary {
  border: none;
  background: var(--primary);
  color: #fff;
}

.primary.subtle {
  background: var(--primary-weak);
  color: var(--primary);
}

.ghost {
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-2);
}

.ghost:hover,
.primary.subtle:hover,
.icon-button:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.primary:disabled,
.ghost:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 保存按钮成功态（用户反馈）：保存成功就地变「✓ 保存成功！」+ 确认弹动，3 秒后恢复 */
.save-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition:
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

.save-btn.is-saved {
  box-shadow: 0 0 0 3px var(--primary-weak);
  animation: save-pop 0.34s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* 次要保存按钮（茶青弱底）成功时提升为实心茶青 + 白字，让对勾与文案有足够对比 */
.primary.subtle.save-btn.is-saved {
  background: var(--primary);
  color: #fff;
}

.save-check {
  animation: save-check-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes save-pop {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.06);
  }
  100% {
    transform: scale(1);
  }
}

@keyframes save-check-in {
  0% {
    transform: scale(0.2);
    opacity: 0;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .save-btn.is-saved,
  .save-check {
    animation: none;
  }
}

.compact {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}

.inline-form {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.inline-form input {
  flex: 1;
}

.chips,
.transfer-list {
  list-style: none;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chips li {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-list);
  color: var(--text-2);
  font-size: 12px;
  padding: 4px 6px 4px 10px;
}

.chips li span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-button {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.empty-panel,
.empty-state {
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}

.empty-panel {
  padding: 28px;
}

.empty-state {
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: var(--bg-list);
  padding: 14px;
}

/* 网段扫描表格（决议 #160）：网段 / 在线节点数 / 操作 三列对齐，贴合设置页标尺 */
.range-table {
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  overflow: hidden;
}

.range-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px 72px;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}

.range-row + .range-row {
  border-top: 1px solid var(--line);
}

.range-head {
  background: var(--bg-list);
  border-bottom: 1px solid var(--line);
}

.range-head > span {
  font-size: var(--fs-aux);
  color: var(--text-3);
}

.range-head > span:nth-child(2) {
  text-align: center;
}

.range-head > span:nth-child(3) {
  text-align: right;
}

.range-cidr {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.cidr-text {
  flex-shrink: 0;
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
  font-size: var(--fs-body);
  color: var(--text-1);
  white-space: nowrap;
}

.cidr-source {
  min-width: 0;
  font-size: var(--fs-aux);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.range-count {
  display: flex;
  justify-content: center;
}

.count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: var(--primary-weak);
  color: var(--primary);
  font-size: var(--fs-aux);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.count-badge.zero {
  background: var(--bg-list);
  color: var(--text-3);
}

.range-ops {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-1);
}

/* 操作按钮平时即带淡淡意图色（决议 #160）：刷新淡茶青、删除淡红，hover 加深 */
.icon-button.accent {
  color: var(--primary);
  opacity: 0.55;
}

.icon-button.danger {
  color: var(--danger);
  opacity: 0.55;
}

.icon-button.accent:hover,
.icon-button.danger:hover {
  opacity: 1;
}

/* 删除二次确认覆盖层（决议 #160）：盖住该行问「删除该网段？」 */
.range-confirm {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
  background: var(--bg-window);
}

.confirm-q {
  margin-right: auto;
  font-size: var(--fs-aux);
  color: var(--text-1);
}

.confirm-del,
.confirm-cancel {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: var(--fs-aux);
  padding: 4px 10px;
  border-radius: var(--r-control);
}

.confirm-del {
  color: var(--danger);
  font-weight: 600;
}

.confirm-cancel {
  color: var(--text-2);
}

.confirm-del:hover,
.confirm-cancel:hover {
  background: var(--bg-list);
}

.transfer-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.transfer-list li {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-radius: 6px;
  background: var(--bg-list);
  padding: 9px 10px;
}

.transfer-list li > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.transfer-list strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.date-range {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
}

.date-range > span {
  color: var(--text-3);
  font-size: 12px;
}

.export-actions {
  justify-content: flex-start;
  margin-top: 4px;
}

.port-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/* 关于页（决议 #90 重设计）：单卡片承载——居中品牌标识 + 键值信息行 + 折叠开发者托盘 */
.about-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-window);
  overflow: hidden;
}

.about-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 24px 20px 20px;
  border-bottom: 1px solid var(--line);
}

.about-logo {
  margin-bottom: 14px;
}

.about-hero h2 {
  margin: 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text-1);
}

.about-latin {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  color: var(--text-3);
}

.about-tagline {
  margin-top: 6px;
  color: var(--text-3);
  font-size: 12.5px;
  line-height: 1.5;
}

.about-trust {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 13px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 12px;
  line-height: 1.4;
}

.about-rows {
  list-style: none;
  padding: 2px 20px;
}

.about-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 0;
}

.about-row + .about-row {
  border-top: 1px solid var(--line);
}

.about-row dt {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 13px;
}

.about-row dd {
  min-width: 0;
  text-align: right;
  overflow-wrap: anywhere;
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
}

.about-row dd.muted {
  color: var(--text-2);
  font-weight: 500;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 500;
  letter-spacing: 0.2px;
}

.nodeid {
  font-size: 12px;
}

.about-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.about-link:hover {
  text-decoration: underline;
}

.about-update-row dd {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
}

.about-update-main {
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.about-update-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.about-update-main strong {
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.about-update-help {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
}

.about-help-trigger {
  width: 17px;
  height: 17px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--bg-list);
  color: var(--text-3);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: help;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease;
}

.about-help-trigger:hover,
.about-help-trigger:focus-visible {
  border-color: rgba(61, 139, 107, 0.42);
  background: var(--primary-weak);
  color: var(--primary);
  outline: none;
  box-shadow: 0 0 0 2px rgba(61, 139, 107, 0.1);
}

.about-help-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 80;
  width: 252px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--text-1);
  color: var(--bg-window);
  box-shadow: 0 8px 24px rgba(34, 49, 42, 0.22);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(3px);
  transition:
    opacity 0.14s ease,
    transform 0.14s ease,
    visibility 0.14s ease;
}

/* 端口修改风险确认（决议 #240）：纯色遮罩 + 静态卡片，兼顾 Win7 / UOS 软渲染。 */
.port-warning-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(18, 31, 25, 0.28);
}

:global(html[data-theme='dark']) .port-warning-mask {
  background: rgba(0, 0, 0, 0.48);
}

.port-warning-dialog {
  width: min(392px, 100%);
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  outline: none;
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), var(--shadow-float);
}

.port-warning-icon {
  width: 44px;
  height: 44px;
  margin-bottom: 14px;
  border: 1px solid var(--danger);
  border-radius: 50%;
  color: var(--danger);
  display: grid;
  place-items: center;
}

.port-warning-dialog h2 {
  margin: 0 0 10px;
  color: var(--text-1);
  font-size: 17px;
  line-height: 1.35;
}

.port-warning-dialog p {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.65;
}

.port-warning-dialog .port-warning-emphasis {
  margin-top: 10px;
  color: var(--text-1);
  font-weight: 600;
}

.port-warning-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.port-warning-enter-active,
.port-warning-leave-active {
  transition: opacity 140ms ease;
}

.port-warning-enter-active .port-warning-dialog,
.port-warning-leave-active .port-warning-dialog {
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.port-warning-enter-from,
.port-warning-leave-to {
  opacity: 0;
}

.port-warning-enter-from .port-warning-dialog,
.port-warning-leave-to .port-warning-dialog {
  transform: translateY(6px) scale(0.985);
}

.about-update-help:hover .about-help-pop,
.about-update-help:focus-within .about-help-pop {
  opacity: 1;
  visibility: visible;
  transform: none;
}

.about-update-row small {
  max-width: 360px;
  color: var(--text-3);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
}

.about-update-action {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.about-update-action.is-primary {
  border-color: transparent;
  background: var(--primary-weak);
  color: var(--primary);
}

.about-update-row.is-checking .about-update-action .pantry-icon,
.about-update-row.is-requesting .about-update-action .pantry-icon {
  animation: update-spin 0.9s linear infinite;
}

@keyframes update-spin {
  to {
    transform: rotate(360deg);
  }
}
.about-more {
  width: 100%;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  border-top: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.about-more:hover {
  color: var(--primary);
  background: var(--primary-weak);
}

.about-detail {
  border-top: 1px solid var(--line);
  background: var(--bg-list);
  animation: about-reveal 0.18s ease;
}

@keyframes about-reveal {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .about-detail,
  .about-update-row.is-checking .pantry-icon,
  .about-update-row.is-requesting .pantry-icon {
    animation: none;
  }
}

@media (max-width: 660px) {
  .settings {
    min-width: 0;
  }

  .sidebar {
    width: 150px;
    flex-basis: 150px;
  }

  .body {
    padding: 16px;
  }

  .field-grid,
  .port-grid {
    grid-template-columns: 1fr;
  }

  .about-update-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .about-update-row dd {
    width: 100%;
    align-items: flex-start;
    text-align: left;
  }

  .about-update-main {
    width: 100%;
    justify-content: space-between;
  }

  .about-help-pop {
    right: auto;
    left: 0;
  }
}

/* 「设置已保存」浮层 toast（决议 #152/#216/#218）：
   固定在设置窗口整体水平居中、底部上浮；
   深色胶囊对比当前主题、currentColor 对勾保证两主题对比、茶青味柔影（非纯黑）；淡入 + 上移 / 淡出 + 下移，尊重 reduced-motion */
.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 9px var(--sp-4);
  border-radius: var(--r-pill);
  background: var(--text-1);
  color: var(--bg-window);
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  box-shadow: var(--shadow-float);
  z-index: 60;
  pointer-events: none;
}
.toast .pantry-icon {
  flex: none;
}
.toast-enter-active {
  transition: opacity 0.24s ease, transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}
@media (prefers-reduced-motion: reduce) {
  .nav button {
    transition: none;
  }
  .nav button:active {
    transform: none;
  }
  .toast-enter-active,
  .toast-leave-active,
  .port-warning-enter-active,
  .port-warning-leave-active,
  .port-warning-enter-active .port-warning-dialog,
  .port-warning-leave-active .port-warning-dialog {
    transition: opacity 0.16s ease;
  }
  .toast-enter-from,
  .toast-leave-to {
    transform: translateX(-50%);
  }
  .port-warning-enter-from .port-warning-dialog,
  .port-warning-leave-to .port-warning-dialog {
    transform: none;
  }
}
</style>

<style scoped>
.language-select { width: 140px; flex-shrink: 0; }
</style>
