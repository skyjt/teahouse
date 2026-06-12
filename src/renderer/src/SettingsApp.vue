<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  AppInfo,
  AppSettingsPatch,
  ConversationView,
  DataExportOptions,
  SettingsView,
  TransferView
} from '../../shared/ipc'
import { DEFAULT_TCP_PORT, DEFAULT_UDP_PORT } from '../../shared/protocol'
import { applyAppearance } from './utils/appearance'
import {
  AVATAR_COLORS,
  AVATAR_EMOJIS,
  avatarColorIndex,
  avatarEmojiIndex,
  avatarStyle,
  avatarText,
  avatarValue
} from './utils/avatar'
import PantryIcon from './components/PantryIcon.vue'

// 设置独立小窗（ui-design §8）：P1 起按 8 组完整承载本地设置。

type Section =
  | 'profile'
  | 'general'
  | 'notify'
  | 'storage'
  | 'network'
  | 'advanced'
  | 'shortcuts'
  | 'about'

const sections: Array<{ id: Section; label: string }> = [
  { id: 'profile', label: '我的资料' },
  { id: 'general', label: '通用' },
  { id: 'notify', label: '消息与通知' },
  { id: 'storage', label: '文件与存储' },
  { id: 'network', label: '网络' },
  { id: 'advanced', label: '高级' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'about', label: '关于' }
]

const section = ref<Section>('profile')
const settings = ref<SettingsView | null>(null)
const info = ref<AppInfo | null>(null)
const savedTip = ref('')

// 我的资料表单
const nick = ref('')
const company = ref('')
const dept = ref('')
const team = ref('')
const avatar = ref(-1)
const fileDir = ref('')
// 网络表单
const newPeer = ref('')
const newCidr = ref('')
const scanTip = ref('')
const transfers = ref<TransferView[]>([])
const conversations = ref<ConversationView[]>([])
const exportConvId = ref('')
const exportFrom = ref('')
const exportTo = ref('')
// 高级表单
const udpPortInput = ref('')
const tcpPortInput = ref('')
// 快捷键表单
const captureShortcut = ref('')
const showHideShortcut = ref('')
let stopSettings: (() => void) | null = null
const selectedAvatarEmoji = computed(() => avatarEmojiIndex(avatar.value))
const selectedAvatarColor = computed(() => avatarColorIndex(avatar.value, nick.value || '茶'))
const avatarPreviewStyle = computed(() => avatarStyle(avatar.value, nick.value || '茶'))

onMounted(async () => {
  info.value = await window.pantry.getAppInfo()
  await reload()
  stopSettings = window.pantry.onSettingsUpdated((s) => {
    syncForm(s)
  })
})

onUnmounted(() => {
  stopSettings?.()
})

async function reload(): Promise<void> {
  const s = await window.pantry.getSettings()
  syncForm(s)
  conversations.value = await window.pantry.listConversations()
  transfers.value = await window.pantry.listTransfers(30)
}

function syncForm(s: SettingsView): void {
  settings.value = s
  nick.value = s.nick
  company.value = s.company
  dept.value = s.dept
  team.value = s.team
  avatar.value = s.avatar
  fileDir.value = s.fileDir
  udpPortInput.value = String(s.udpPort)
  tcpPortInput.value = String(s.tcpPort)
  captureShortcut.value = s.captureShortcut
  showHideShortcut.value = s.showHideShortcut
  applyAppearance(s)
}

function flashSaved(text = '已保存'): void {
  savedTip.value = text
  setTimeout(() => (savedTip.value = ''), 1500)
}

async function saveApp(patch: AppSettingsPatch, tip = '已保存'): Promise<void> {
  const next = await window.pantry.saveAppSettings(patch)
  syncForm(next)
  flashSaved(tip)
}

async function saveProfile(): Promise<void> {
  if (!nick.value.trim()) return
  settings.value = await window.pantry.saveProfile({
    nick: nick.value.trim(),
    company: company.value.trim(),
    dept: dept.value.trim(),
    team: team.value.trim(),
    avatar: avatar.value,
    fileDir: fileDir.value
  })
  if (settings.value) syncForm(settings.value)
  flashSaved('已保存，全网通讯录将自动刷新')
}

function chooseInitialAvatar(): void {
  avatar.value = -1
}

function chooseAvatarEmoji(index: number): void {
  avatar.value = avatarValue(index, selectedAvatarColor.value)
}

function chooseAvatarColor(index: number): void {
  const emoji = selectedAvatarEmoji.value >= 0 ? selectedAvatarEmoji.value : 0
  avatar.value = avatarValue(emoji, index)
}

function avatarOptionStyle(index: number): { backgroundColor: string; color: string } {
  return avatarStyle(avatarValue(index, selectedAvatarColor.value), nick.value || '茶')
}

async function pickFileDir(): Promise<void> {
  const dir = await window.pantry.pickDirectory()
  if (dir) fileDir.value = dir
}

async function toggleNotifications(): Promise<void> {
  if (!settings.value) return
  await saveApp({
    notifications: !settings.value.notifications
  })
}

async function toggleHideOnCapture(): Promise<void> {
  if (!settings.value) return
  await saveApp({
    hideOnCapture: !settings.value.hideOnCapture
  })
}

async function toggleAutoLaunch(): Promise<void> {
  if (!settings.value) return
  await saveApp({ autoLaunch: !settings.value.autoLaunch })
}

async function toggleCloseToTray(): Promise<void> {
  if (!settings.value) return
  await saveApp({ closeToTray: !settings.value.closeToTray })
}

async function toggleMessagePreview(): Promise<void> {
  if (!settings.value) return
  await saveApp({ showMessagePreview: !settings.value.showMessagePreview })
}

async function changeTheme(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'light' || value === 'dark') await saveApp({ theme: value })
}

async function changeFontScale(event: Event): Promise<void> {
  const value = Number((event.target as HTMLSelectElement).value)
  if (value === 100 || value === 110 || value === 125) await saveApp({ fontScale: value })
}

async function changeSound(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'none' || value === 'drop' || value === 'wood' || value === 'ding') {
    await saveApp({ sound: value })
  }
}

async function changeSendKey(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'enter' || value === 'ctrlEnter') await saveApp({ sendKey: value })
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
      sound: 'none',
      sendKey: 'enter',
      captureShortcut: 'CommandOrControl+Alt+A',
      showHideShortcut: 'CommandOrControl+Alt+P'
    },
    '应用设置已重置'
  )
}

async function saveShortcuts(): Promise<void> {
  await saveApp(
    {
      captureShortcut: captureShortcut.value.trim(),
      showHideShortcut: showHideShortcut.value.trim()
    },
    '快捷键已保存'
  )
}

async function savePorts(): Promise<void> {
  const udpPort = parsePort(udpPortInput.value)
  const tcpPort = parsePort(tcpPortInput.value)
  if (!udpPort || !tcpPort) {
    flashSaved('端口需为 1-65535')
    return
  }
  await saveApp({ udpPort, tcpPort }, '端口已保存，重启后生效')
}

function parsePort(value: string): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

async function exportData(format: 'backup' | 'html' | 'txt'): Promise<void> {
  const path = await window.pantry.exportData(format, exportOptions())
  flashSaved(path ? '已导出' : '导出已取消')
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
  const prefix = conv.type === 'group' ? '讨论组' : '单聊'
  return `${prefix} ${conv.peerId}${conv.preview ? ` · ${conv.preview.slice(0, 18)}` : ''}`
}

async function importData(): Promise<void> {
  const result = await window.pantry.importData()
  flashSaved(result ? `已导入 ${result.imported} 条，跳过 ${result.skipped} 条` : '导入已取消')
}

async function revealTransfer(transferId: string): Promise<void> {
  await window.pantry.revealTransfer(transferId)
}

function transferStatusLabel(status: TransferView['status']): string {
  const map: Record<TransferView['status'], string> = {
    offering: '等待',
    accepted: '传输中',
    done: '完成',
    declined: '已拒收',
    canceled: '已取消',
    failed: '失败'
  }
  return map[status]
}

async function addPeer(): Promise<void> {
  const addr = newPeer.value.trim()
  if (!addr) return
  const ok = await window.pantry.addManualPeer(addr)
  if (ok) {
    newPeer.value = ''
    await reload()
    flashSaved('已添加并探测')
  } else {
    flashSaved('地址格式不对（ip 或 ip:端口）')
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
    scanTip.value = '网段不合法（如 10.1.2.0/24，最大 /22）'
    return
  }
  scanTip.value = `已向 ${count} 个地址发出探测，在线的会出现在通讯录`
  if (!settings.value.scanRanges.includes(cidr)) {
    await saveApp({
      scanRanges: [...settings.value.scanRanges, cidr]
    })
  }
  newCidr.value = ''
}

async function rescan(cidr: string): Promise<void> {
  const count = await window.pantry.scanRange(cidr)
  scanTip.value = count >= 0 ? `已向 ${count} 个地址发出探测` : '网段不合法'
}

async function removeRange(cidr: string): Promise<void> {
  if (!settings.value) return
  await saveApp({
    scanRanges: settings.value.scanRanges.filter((r) => r !== cidr)
  })
}
</script>

<template>
  <div class="settings">
    <nav class="nav">
      <button
        v-for="item in sections"
        :key="item.id"
        :class="{ on: section === item.id }"
        @click="section = item.id"
      >
        {{ item.label }}
      </button>
    </nav>

    <main class="body">
      <section v-if="section === 'profile'">
        <h2>我的资料</h2>
        <div class="row avatar-row">
          <span>头像</span>
          <div class="avatar-editor">
            <div class="avatar-preview" :style="avatarPreviewStyle">
              {{ avatarText(avatar, nick || '茶') }}
            </div>
            <div class="avatar-tools">
              <button
                type="button"
                class="avatar-initial"
                :class="{ on: avatar === -1 }"
                aria-label="使用昵称首字头像"
                @click="chooseInitialAvatar"
              >
                昵称首字
              </button>
              <div class="avatar-grid" aria-label="精选头像图标">
                <button
                  v-for="(label, idx) in AVATAR_EMOJIS"
                  :key="label"
                  type="button"
                  class="avatar-choice"
                  :class="{ on: selectedAvatarEmoji === idx }"
                  :style="avatarOptionStyle(idx)"
                  :aria-label="`头像图标 ${idx + 1}`"
                  @click="chooseAvatarEmoji(idx)"
                >
                  {{ label }}
                </button>
              </div>
              <div class="avatar-colors" aria-label="头像背景色">
                <button
                  v-for="(color, idx) in AVATAR_COLORS"
                  :key="color.name"
                  type="button"
                  class="color-choice"
                  :class="{ on: selectedAvatarColor === idx && avatar >= 0 }"
                  :style="{ backgroundColor: color.bg }"
                  :title="color.name"
                  :aria-label="`头像背景色：${color.name}`"
                  @click="chooseAvatarColor(idx)"
                ></button>
              </div>
            </div>
          </div>
        </div>
        <label class="row"><span>昵称</span><input v-model="nick" maxlength="32" /></label>
        <label class="row"><span>公司</span><input v-model="company" maxlength="32" /></label>
        <label class="row"><span>部门</span><input v-model="dept" maxlength="32" /></label>
        <label class="row"><span>团队</span><input v-model="team" maxlength="32" /></label>
        <div class="actions">
          <span class="tip">{{ savedTip }}</span>
          <button class="primary" :disabled="!nick.trim()" @click="saveProfile">保存</button>
        </div>
      </section>

      <section v-else-if="section === 'general'">
        <h2>通用</h2>
        <label class="row toggle">
          <span>开机自启</span>
          <input type="checkbox" :checked="settings?.autoLaunch" @change="toggleAutoLaunch" />
        </label>
        <label class="row toggle">
          <span>关闭到托盘</span>
          <input type="checkbox" :checked="settings?.closeToTray" @change="toggleCloseToTray" />
        </label>
        <label class="row">
          <span>主题</span>
          <select :value="settings?.theme ?? 'light'" @change="changeTheme">
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label class="row">
          <span>字体缩放</span>
          <select :value="settings?.fontScale ?? 100" @change="changeFontScale">
            <option :value="100">100%</option>
            <option :value="110">110%</option>
            <option :value="125">125%</option>
          </select>
        </label>
        <label class="row">
          <span>语言</span>
          <select disabled>
            <option>简体中文</option>
          </select>
        </label>
        <div class="actions">
          <span class="tip">{{ savedTip }}</span>
          <button class="ghost" @click="resetAppSettings">重置应用设置</button>
        </div>
      </section>

      <section v-else-if="section === 'notify'">
        <h2>消息与通知</h2>
        <label class="row toggle">
          <span>系统通知</span>
          <input
            type="checkbox"
            :checked="settings?.notifications"
            @change="toggleNotifications"
          />
        </label>
        <label class="row toggle">
          <span>显示内容</span>
          <input
            type="checkbox"
            :checked="settings?.showMessagePreview"
            @change="toggleMessagePreview"
          />
        </label>
        <label class="row">
          <span>提示音</span>
          <select :value="settings?.sound ?? 'none'" @change="changeSound">
            <option value="none">关闭</option>
            <option value="drop">水滴</option>
            <option value="wood">木鱼</option>
            <option value="ding">叮咚</option>
          </select>
        </label>
        <label class="row">
          <span>发送键</span>
          <select :value="settings?.sendKey ?? 'enter'" @change="changeSendKey">
            <option value="enter">Enter 发送</option>
            <option value="ctrlEnter">Ctrl/Cmd + Enter 发送</option>
          </select>
        </label>
        <p class="tip">{{ savedTip }}</p>
      </section>

      <section v-else-if="section === 'storage'">
        <h2>文件与存储</h2>
        <div class="row">
          <span>文件保存</span>
          <span class="dir">{{ fileDir || settings?.defaultFileDir }}</span>
          <button class="ghost" @click="pickFileDir">更改…</button>
          <button class="ghost" :disabled="!settings" @click="saveProfile">保存</button>
        </div>
        <label class="row toggle">
          <span>每次询问</span>
          <input type="checkbox" disabled />
        </label>
        <label class="row toggle">
          <span>图片自动接收</span>
          <input type="checkbox" checked disabled />
        </label>
        <div class="row">
          <span>聊天记录</span>
          <button class="ghost" @click="exportData('backup')">备份包…</button>
          <button class="ghost" @click="exportData('html')">HTML…</button>
          <button class="ghost" @click="exportData('txt')">TXT…</button>
          <button class="ghost" @click="importData">导入…</button>
        </div>
        <label class="row">
          <span>导出会话</span>
          <select v-model="exportConvId">
            <option value="">全部会话</option>
            <option v-for="conv in conversations" :key="conv.id" :value="conv.id">
              {{ convLabel(conv) }}
            </option>
          </select>
        </label>
        <div class="row range-row">
          <span>时间范围</span>
          <input v-model="exportFrom" type="date" />
          <span class="dash">至</span>
          <input v-model="exportTo" type="date" />
        </div>
        <h3>传输记录</h3>
        <ul class="transfer-list">
          <li v-for="t in transfers" :key="t.transferId">
            <span class="transfer-name">{{ t.name }}</span>
            <span class="transfer-status">{{ transferStatusLabel(t.status) }}</span>
            <button class="x" :disabled="!t.savedPath" @click="revealTransfer(t.transferId)">打开</button>
          </li>
        </ul>
        <p class="tip">{{ savedTip }}</p>
      </section>

      <section v-else-if="section === 'network'">
        <h2>网络</h2>

        <h3>手动添加节点（跨网段保底）</h3>
        <div class="inline">
          <input v-model="newPeer" placeholder="如 10.2.0.8 或 10.2.0.8:17878" @keydown.enter="addPeer" />
          <button class="primary" @click="addPeer">添加</button>
        </div>
        <ul class="chips">
          <li v-for="p in settings?.manualPeers ?? []" :key="p">
            {{ p }}
            <button class="x icon-only" title="移除" @click="removePeer(p)">
              <PantryIcon name="x" :size="13" />
            </button>
          </li>
        </ul>

        <h3>网段扫描</h3>
        <div class="inline">
          <input v-model="newCidr" placeholder="如 10.1.2.0/24（最大 /22）" @keydown.enter="addRange" />
          <button class="primary" @click="addRange">扫描并保存</button>
        </div>
        <ul class="chips">
          <li v-for="r in settings?.scanRanges ?? []" :key="r">
            {{ r }}
            <button class="x icon-only" title="再次扫描" @click="rescan(r)">
              <PantryIcon name="refresh" :size="13" />
            </button>
            <button class="x icon-only" title="移除" @click="removeRange(r)">
              <PantryIcon name="x" :size="13" />
            </button>
          </li>
        </ul>
        <p class="tip">{{ scanTip }}</p>
      </section>

      <section v-else-if="section === 'advanced'">
        <h2>高级</h2>
        <label class="row">
          <span>UDP 端口</span>
          <input v-model="udpPortInput" type="number" min="1" max="65535" />
        </label>
        <label class="row">
          <span>TCP 端口</span>
          <input v-model="tcpPortInput" type="number" min="1" max="65535" />
        </label>
        <div class="actions">
          <span class="tip">{{ savedTip }}</span>
          <button class="primary" @click="savePorts">保存端口</button>
        </div>
        <label class="row">
          <span>监听网卡</span>
          <select disabled>
            <option>全部 IPv4 网卡</option>
          </select>
        </label>
        <div class="row">
          <span>诊断日志</span>
          <button class="ghost" disabled>导出…</button>
        </div>
      </section>

      <section v-else-if="section === 'shortcuts'">
        <h2>快捷键</h2>
        <label class="row">
          <span>截图</span>
          <input v-model="captureShortcut" maxlength="64" placeholder="留空禁用" />
        </label>
        <label class="row">
          <span>显示/隐藏</span>
          <input v-model="showHideShortcut" maxlength="64" placeholder="留空禁用" />
        </label>
        <label class="row toggle">
          <span>截图隐藏窗口</span>
          <input
            type="checkbox"
            :checked="settings?.hideOnCapture"
            @change="toggleHideOnCapture"
          />
        </label>
        <div class="actions">
          <span class="tip">{{ savedTip }}</span>
          <button class="primary" @click="saveShortcuts">保存</button>
        </div>
      </section>

      <section v-else>
        <h2>关于</h2>
        <p class="meta">茶话间（Pantry）v{{ info?.version }}</p>
        <p class="meta">
          Electron {{ info?.electron }} · Chromium {{ info?.chrome }} · Node {{ info?.node }}
        </p>
        <p class="meta">纯内网即时通讯与文件传输 —— 数据不出局域网，无遥测。</p>
        <p class="meta">开源许可：本项目暂定 MIT；依赖许可清单随 v1.0 整理发布。</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  height: 100vh;
  background: var(--bg-window);
}
.nav {
  width: 130px;
  background: var(--bg-list);
  border-right: 1px solid var(--line);
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav button {
  border: none;
  background: transparent;
  text-align: left;
  padding: 9px 18px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
.nav button.on {
  background: rgba(61, 139, 107, 0.12);
  color: var(--primary);
  font-weight: 600;
}
.body {
  flex: 1;
  padding: 20px 24px;
  overflow-y: auto;
}
h2 {
  font-size: 16px;
  margin-bottom: 14px;
}
h3 {
  font-size: 13px;
  margin: 16px 0 8px;
  color: var(--text-2);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 13px;
}
.row > span:first-child {
  width: 92px;
  color: var(--text-2);
  flex-shrink: 0;
}
.row input[type='text'],
.row input[type='number'],
.row input[type='date'],
.row input:not([type]),
.row select {
  flex: 1;
  height: 30px;
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-1);
  border-radius: 4px;
  padding: 0 8px;
  font-size: 13px;
  outline: none;
  user-select: text;
}
.row input:focus,
.row select:focus {
  border-color: var(--primary);
}
.row input[readonly],
.row select:disabled {
  color: var(--text-3);
  background: var(--bg-list);
}
.range-row input {
  min-width: 0;
}
.dash {
  width: auto !important;
  color: var(--text-3);
  flex-shrink: 0;
}
.avatar-row {
  align-items: flex-start;
}
.avatar-editor {
  flex: 1;
  display: flex;
  gap: 12px;
  min-width: 0;
}
.avatar-preview {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 26px;
  flex-shrink: 0;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.avatar-tools {
  flex: 1;
  min-width: 0;
}
.avatar-initial {
  border: 1px solid var(--line);
  background: var(--bg-list);
  color: var(--text-2);
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  margin-bottom: 8px;
}
.avatar-initial.on {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(61, 139, 107, 0.1);
}
.avatar-grid {
  display: grid;
  grid-template-columns: repeat(8, 30px);
  gap: 6px;
}
.avatar-choice {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.72);
  cursor: pointer;
  display: grid;
  place-items: center;
  font-size: 15px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.avatar-choice.on {
  border-color: var(--primary);
  box-shadow:
    0 0 0 2px rgba(61, 139, 107, 0.18),
    inset 0 0 0 1px rgba(255, 255, 255, 0.78);
}
.avatar-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.color-choice {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--bg-window);
  box-shadow: 0 0 0 1px var(--line);
  cursor: pointer;
}
.color-choice.on {
  box-shadow:
    0 0 0 2px var(--primary),
    inset 0 0 0 1px rgba(255, 255, 255, 0.55);
}
.dir {
  flex: 1;
  font-size: 12px;
  color: var(--text-2);
  word-break: break-all;
}
.toggle input {
  width: 16px;
  height: 16px;
}
.inline {
  display: flex;
  gap: 8px;
}
.inline input {
  flex: 1;
  height: 30px;
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-1);
  border-radius: 4px;
  padding: 0 8px;
  font-size: 13px;
  outline: none;
  user-select: text;
}
.chips {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}
.chips li {
  background: var(--bg-list);
  border: 1px solid var(--line);
  border-radius: 12px;
  font-size: 12px;
  padding: 3px 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.transfer-list {
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 4px;
  max-height: 150px;
  overflow-y: auto;
}
.transfer-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}
.transfer-list li:last-child {
  border-bottom: none;
}
.transfer-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transfer-status {
  color: var(--text-3);
  flex-shrink: 0;
}
.x {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 11px;
}
.x.icon-only {
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-grid;
  place-items: center;
}
.x:disabled {
  opacity: 0.4;
  cursor: default;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 16px;
}
.primary {
  border: none;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  padding: 7px 22px;
  border-radius: 4px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.4;
}
.ghost {
  border: 1px solid var(--line);
  background: transparent;
  border-radius: 4px;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-2);
}
.ghost:disabled {
  opacity: 0.45;
  cursor: default;
}
.tip {
  font-size: 12px;
  color: var(--primary);
}
.meta {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 8px;
}
</style>
