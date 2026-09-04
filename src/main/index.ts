import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  Notification,
  protocol,
  screen,
  shell,
  type Tray
} from 'electron'
import { networkInterfaces } from 'node:os'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import {
  DEFAULT_CAPTURE_SHORTCUT,
  DEFAULT_SHOWHIDE_SHORTCUT,
  IpcChannels,
  IpcEvents,
  type AvatarSourcePick,
  type AppInfo,
  type AppSettingsPatch,
  type ConversationSearchOptions,
  type CaptureFailureReason,
  type DataExportOptions,
  type DataImportResult,
  type ExportFormat,
  type ForwardTarget,
  type GroupPatch,
  type ImageOcrResult,
  type ImageOcrSource,
  type ImageSourceBytes,
  type MessageView,
  type NetState,
  type NudgeEvent,
  type NudgeResult,
  type PeerView,
  type ProfileSubmit,
  type ScanProgressView,
  type SettingsView,
  type ShareBrowseFailReason,
  type ShareBrowseResult,
  type ShareDownloadResult,
  type ShareGrantView,
  type ShareRecentUploadView,
  type ShareRootPickResult,
  type ShareUploadResult,
  type TableTextMeta,
  type TransferView,
  type UpdateAvailability
} from '../shared/ipc'
import {
  DEFAULT_TCP_PORT,
  DEFAULT_UDP_PORT,
  CAPS,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  AVATAR_SOURCE_MAX_BYTES,
  GROUP_MAX_MEMBERS,
  LIMITS,
  MSG_TYPES,
  TABLE_TEXT_LIMIT_BYTES,
  TIMINGS,
  SHARE_GET_AUTH_TTL,
  SHARE_GET_MAX_PATHS,
  SHARE_PATH_MAX,
  SHARE_PUT_MAX_BYTES,
  SHARE_REQ_TIMEOUT,
  isAvatarPresetValue,
  isShareMode,
  type Envelope,
  type SharePayload,
  type Platform,
  type RuntimeArch,
  type ScanRangeSummary,
  type UpdateReqPayload
} from '../shared/protocol'
import { isAvatarHash } from '../shared/protocol'
import { avatarHashFromUrl } from '../shared/avatar-url'
import { inspectImageMetadata } from '../shared/image-metadata'
import { DEFAULT_IMAGE_EXTENSION, IMAGE_FILE_EXTENSIONS } from '../shared/media'
import {
  addSharedScanRanges,
  loadAppState,
  markScanRangeAutoScanned,
  saveAppSettings,
  saveProfile,
  type AppState
} from './store/app-state'
import { setupTray, stopTrayUnreadFlash, updateTrayUnread } from './windows/tray'
import { openSettingsWindow, syncSettingsWindowZoom } from './windows/settings-window'
import {
  closeCaptureWindow,
  openCaptureWindow,
  showCaptureWindow
} from './windows/capture-window'
import { planCaptureGeometry } from './windows/capture-geometry'
import {
  captureFailureNotice,
  hideWindowForCapture,
  isWaylandSession,
  mergeChromiumFeature
} from './windows/capture-support'
import { openImageViewerWindow } from './windows/image-viewer-window'
import { fitImageViewerContent } from './windows/image-viewer-sizing'
import { showWindowForeground } from './windows/foreground'
import {
  incomingNotificationOptions,
  notificationIconPath
} from './notifications'
import { StickerRepo } from './store/sticker-repo'
import { buildCidrHostPlan, ipInCidr, normalizeCidr, parseCidr } from './net/cidr'
import { TransferRepo } from './store/transfer-repo'
import { GroupRepo } from './store/group-repo'
import { FilesService } from './services/files'
import { GroupsService } from './services/groups'
import { ForwardService } from './services/forward'
import { PorterService } from './services/porter'
import { SearchService } from './services/search'
import { openDatabase, openMemoryDatabase, type AppDatabase } from './store/db'
import { PeersRepo } from './store/peers-repo'
import { ShareGrantsRepo } from './store/share-grants-repo'
import {
  evaluateShareRoot,
  ShareDownloadGate,
  shareDownloadDirName,
  ShareService
} from './services/share'
import { ConvRepo } from './store/conv-repo'
import { MsgRepo, msgRowToView } from './store/msg-repo'
import { QueueRepo } from './store/queue-repo'
import { DedupRepo } from './store/dedup-repo'
import { UdpChannel } from './net/udp'
import { PeerRegistry } from './net/peer-registry'
import { Discovery, type ManualPeer } from './net/discovery'
import { RangeSync } from './net/range-sync'
import { Messenger } from './net/messenger'
import { PeerClock } from './net/peer-clock'
import { makeEnvelope } from './net/codec'
import { ChatService } from './services/chat'
import { ImageOcrResultCache } from './services/image-ocr-cache'
import { ImagePreviewService } from './services/image-preview'
import { AvatarStore } from './services/avatar-store'
import { AvatarService } from './services/avatars'
import type { PeerRecord } from './net/peer-registry'
import { filterImagePickerPaths, IMAGE_PICKER_EXTENSIONS } from './util/image-picker'
import { isPathInsideAny, PathGrantStore } from './util/path-policy'
import { resolveDevRendererUrl } from './util/renderer-url'
import { canServeUpdates } from './util/release-format'
import { measureUploadPaths } from './util/upload-measure'
import { isWindows7 } from './util/windows-version'
import { applyWindowZoom } from './util/window-zoom'
import {
  findLocalUpdatePackage,
  pickUpdateSource,
  shouldServeUpdateRequest,
  UpdateRequestGate
} from './services/updater'

// Win7（NT 6.1）终端为统一 VM 部署，虚拟显卡驱动不可靠；UOS/Debian 目标机多国产 GPU 或旧驱动，
// GPU 进程频报 ContextResult::kTransientFailure —— 两者默认软渲染（tech-design §9，决议 #55/#231）
const WINDOWS7 = isWindows7()
const SOFTWARE_RENDERING = WINDOWS7 || process.platform === 'linux'
if (SOFTWARE_RENDERING) {
  app.disableHardwareAcceleration()
}

// Electron 22 在 Wayland 上需要显式启用 PipeWire capturer 才能通过系统 portal 选屏。
// 这里只补能力，startCapture 仍会实际探测；Wayland 不再等同于“不可截图”。
const WAYLAND_SESSION = isWaylandSession()
if (WAYLAND_SESSION) {
  const features = mergeChromiumFeature(
    app.commandLine.getSwitchValue('enable-features'),
    'WebRTCPipeWireCapturer'
  )
  app.commandLine.appendSwitch('enable-features', features)
}

// 受管头像使用固定 authority + 哈希路径；提前登记为标准安全 scheme，确保 Chrome 108
// 在 Windows / Linux / macOS 上按同一规则解析后再交给受限文件协议处理器。
protocol.registerSchemesAsPrivileged([
  { scheme: 'pantry-avatar', privileges: { standard: true, secure: true } }
])

// 纯内网 IP 工具：全局禁用代理、强制直连（决议 #78）。不走系统/环境代理，
// 也不开放任何代理配置——代理对内网通信无意义，只会增加连接失败与信息泄漏面。
app.commandLine.appendSwitch('no-proxy-server')

// 运行时应用名固定为中文（决议 #60）：productName 已改 ASCII "Teahouse" 以保证
// 安装路径无中文（/opt/Teahouse 等），但 userData 目录（已有用户数据所在）与
// 系统通知标题必须保持「茶话间」——setName 必须在任何 getPath('userData') 之前。
app.setName('茶话间')
// Windows 通知/任务栏归属名（决议 #66）：不设则 Win10/11 的 toast 顶部显示默认
// "electron.app.Teahouse"；设为 appId，与 NSIS 安装的快捷方式 AUMID 一致，显示为「茶话间」。
if (process.platform === 'win32') app.setAppUserModelId('com.pantry.app')

// 本机双实例联调：PANTRY_USER_DATA 隔离数据目录（同时绕开单实例锁），见 README「开发」
if (process.env['PANTRY_USER_DATA']) {
  app.setPath('userData', resolve(process.env['PANTRY_USER_DATA']))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  // ---- 网络栈（环境变量仅供本机联调覆盖；正式端口从设置读取，重启生效） ----
  const envUdpPort = parsePort(process.env['PANTRY_UDP_PORT'])
  const envTcpPort = parsePort(process.env['PANTRY_TCP_PORT'])
  let udpPort = envUdpPort ?? DEFAULT_UDP_PORT
  let tcpPort = envTcpPort ?? DEFAULT_TCP_PORT
  const manualPeers: ManualPeer[] = (process.env['PANTRY_PEERS'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const [host, port] = item.split(':')
      return { host, port: Number(port) || DEFAULT_UDP_PORT }
    })

  const netState: NetState = { ok: false, udpPort, error: '' }
  const IMAGE_SOURCE_MAX_BYTES = 25 * 1024 * 1024
  const GLOBAL_SCAN_HOST_DELAY = 8
  const GLOBAL_SCAN_PROGRESS_PUSH_INTERVAL = 200
  const IMAGE_EXTS = new Set<string>(IMAGE_FILE_EXTENSIONS)
  const AVATAR_PICKER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp']
  const IMAGE_SEND_MAX_BYTES = 20 * 1024 * 1024
  const imageOcrCache = new ImageOcrResultCache()
  const rendererPathGrants = new PathGrantStore()
  const stickerImportPathGrants = new PathGrantStore()
  const updateRequestGate = new UpdateRequestGate()
  const shareDownloadGate = new ShareDownloadGate()
  /** 本机发出的 list / get 在等应答（决议 #275）：reqId → 决议函数，超时由发起方自行清理 */
  const sharePending = new Map<string, (payload: SharePayload | null) => void>()
  /** peerId → 正在等待的 get reqId，便于 offer 到货时提前收口 */
  const shareGetReq = new Map<string, string>()
  let discovery: Discovery | null = null
  let registry: PeerRegistry | null = null
  let messenger: Messenger | null = null
  const remarks = new Map<string, string>()
  let db: AppDatabase | null = null
  let peersRepo: PeersRepo | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let chat: ChatService | null = null
  let files: FilesService | null = null
  let groups: GroupsService | null = null
  let groupRepo: GroupRepo | null = null
  let avatars: AvatarService | null = null
  let forward: ForwardService | null = null
  let porter: PorterService | null = null
  let search: SearchService | null = null
  let msgRepoRef: MsgRepo | null = null
  let stickerRepo: StickerRepo | null = null
  let shareGrantsRepo: ShareGrantsRepo | null = null
  let share: ShareService | null = null
  let capturing = false
  let pruneTimer: ReturnType<typeof setInterval> | null = null
  let avatarPruneTimer: ReturnType<typeof setTimeout> | null = null
  let appState: AppState | null = null
  let rangeSync: RangeSync | null = null
  let tray: Tray | null = null
  let isQuitting = false
  let nudgeShakeOrigin: [number, number] | null = null
  let nudgeShakeTimers: Array<ReturnType<typeof setTimeout>> = []
  const rangeScanTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let globalScanTimer: ReturnType<typeof setTimeout> | null = null
  let globalScanSeq = 0
  let lastGlobalScanProgressPushAt = 0
  let globalScanProgress: ScanProgressView = {
    scanId: 0,
    status: 'idle',
    running: false,
    done: 0,
    total: 0,
    rangeCount: 0,
    startedAt: 0,
    finishedAt: 0
  }

  function parsePort(value: string | undefined): number | null {
    if (!value) return null
    const n = Number(value)
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
  }

  function parsePortValue(value: unknown): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
  }

  function parseImageDimension(value: unknown): number | null {
    const n = typeof value === 'number' ? value : NaN
    return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.floor(n) : null
  }

  function parseTableTextMeta(value: unknown): TableTextMeta | undefined | null {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'object' || Array.isArray(value)) return null
    const raw = value as { tableText?: unknown; tableTextTruncated?: unknown }
    if (typeof raw.tableText !== 'string' || raw.tableText.length === 0) return null
    if (raw.tableTextTruncated !== undefined && typeof raw.tableTextTruncated !== 'boolean') {
      return null
    }
    const truncated = truncateUtf8Text(raw.tableText, TABLE_TEXT_LIMIT_BYTES)
    return {
      tableText: truncated.text,
      ...(raw.tableTextTruncated || truncated.truncated ? { tableTextTruncated: true } : {})
    }
  }

  function truncateUtf8Text(text: string, maxBytes: number): { text: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
    let out = ''
    let used = 0
    for (const char of text) {
      const size = Buffer.byteLength(char, 'utf8')
      if (used + size > maxBytes) break
      out += char
      used += size
    }
    return { text: out, truncated: true }
  }

  /** Linux 窗口图标（决议 #58）：显式设置 _NET_WM_ICON，任务栏不依赖桌面环境的 desktop 关联 */
  function linuxWindowIcon(): { icon: string } | Record<string, never> {
    if (process.platform !== 'linux') return {}
    const icon = app.isPackaged
      ? join(process.resourcesPath, 'icons/pantry.png')
      : join(app.getAppPath(), 'build/icons/linux/256x256.png')
    return { icon }
  }

  function systemNotificationIcon(): string | undefined {
    const icon = notificationIconPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
    return icon && existsSync(icon) ? icon : undefined
  }

  function writeClipboardImage(bytes: ArrayBuffer): boolean {
    if (bytes.byteLength === 0 || bytes.byteLength > 30 * 1024 * 1024) return false
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return !clipboard.readImage().isEmpty()
  }

  function readClipboardImage(): ArrayBuffer | null {
    if (clipboard.readText().length > 0) return null
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const png = image.toPNG()
    if (png.byteLength === 0 || png.byteLength > 30 * 1024 * 1024) return null
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
  }

  // 文件默认保存目录：跨平台统一放「文档/teahouse」（决议 #159）。不用「下载/茶话间」——
  // 中文目录名在部分系统/命令行/跨平台工具链下编码兼容差，且收到的文件属长期归档、放文档更合语义。
  const defaultFileDir = (): string => join(app.getPath('documents'), 'teahouse')
  const imagesDir = (): string => join(app.getPath('userData'), 'data', 'images')
  const updatesDir = (): string => join(app.getPath('userData'), 'data', 'updates')
  const importedMediaDir = (): string => join(app.getPath('userData'), 'data', 'imported-media')
  const stickersDir = (): string => join(app.getPath('userData'), 'data', 'stickers')
  const imageThumbnailsDir = (): string => join(app.getPath('userData'), 'data', 'image-thumbnails')
  const avatarsDir = (): string => join(app.getPath('userData'), 'data', 'avatars')
  const dataRoot = (): string => join(app.getPath('userData'), 'data')
  const managedMediaRoots = (): string[] => [imagesDir(), importedMediaDir(), stickersDir()]
  const managedStickerRoots = (): string[] => [stickersDir(), importedMediaDir()]
  const imagePreview = new ImagePreviewService(imageThumbnailsDir())
  const avatarStore = new AvatarStore(avatarsDir())

  function broadcastAvatarReady(hash: string): void {
    if (!isAvatarHash(hash)) return
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcEvents.avatarReady, hash)
    }
  }

  function referencedAvatarHashes(): string[] {
    const hashes = new Set<string>()
    const selfHash = appState?.config.avatarHash
    if (isAvatarHash(selfHash)) hashes.add(selfHash)
    for (const record of registry?.values() ?? []) {
      if (isAvatarHash(record.profile.avatarHash)) hashes.add(record.profile.avatarHash)
    }
    for (const group of groupRepo?.list() ?? []) {
      if (isAvatarHash(group.avatarHash)) hashes.add(group.avatarHash)
    }
    return [...hashes]
  }

  function scheduleAvatarPrune(): void {
    if (avatarPruneTimer) clearTimeout(avatarPruneTimer)
    avatarPruneTimer = setTimeout(() => {
      avatarPruneTimer = null
      void avatarStore.prune(referencedAvatarHashes())
    }, 1_000)
    avatarPruneTimer.unref?.()
  }

  function avatarMime(
    format: 'png' | 'jpeg' | 'webp' | 'bmp'
  ): Extract<AvatarSourcePick, { ok: true }>['mime'] {
    if (format === 'jpeg') return 'image/jpeg'
    if (format === 'png') return 'image/png'
    if (format === 'bmp') return 'image/bmp'
    return 'image/webp'
  }

  async function stageOutgoingImagePath(sourcePath: string): Promise<string | null> {
    try {
      const ext = IMAGE_EXTS.has(extname(sourcePath).toLowerCase())
        ? extname(sourcePath).toLowerCase()
        : DEFAULT_IMAGE_EXTENSION
      const dir = join(imagesDir(), 'out')
      await mkdir(dir, { recursive: true })
      const staged = join(dir, `${randomUUID()}${ext}`)
      await copyFile(sourcePath, staged)
      return staged
    } catch {
      return null
    }
  }

  function parseImageSendTarget(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null
  }

  function parseImageSendName(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null
  }

  function parseImageSendBytes(value: unknown): ArrayBuffer | null {
    if (!(value instanceof ArrayBuffer) || value.byteLength === 0) return null
    return value.byteLength <= IMAGE_SEND_MAX_BYTES ? value : null
  }

  function parseImageOfferPath(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
    return IMAGE_EXTS.has(extname(value).toLowerCase()) ? value : null
  }

  function outgoingImageExt(name: string): string {
    const ext = extname(name).toLowerCase()
    return IMAGE_EXTS.has(ext) ? ext : DEFAULT_IMAGE_EXTENSION
  }

  async function stageImageBytes(name: string, bytes: ArrayBuffer): Promise<string> {
    const dir = join(imagesDir(), 'out')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${randomUUID()}${outgoingImageExt(name)}`)
    await writeFile(path, Buffer.from(bytes))
    return path
  }

  type OfferImagePaths = (
    targetId: string,
    paths: string[],
    want: 'file' | 'image',
    tableTextMeta?: TableTextMeta
  ) => Promise<MessageView | null> | undefined

  async function handleImageBytes(
    target: unknown,
    nameValue: unknown,
    bytesValue: unknown,
    tableText: unknown,
    offer: OfferImagePaths
  ): Promise<MessageView | null> {
    const targetId = parseImageSendTarget(target)
    const name = parseImageSendName(nameValue)
    const bytes = parseImageSendBytes(bytesValue)
    if (!targetId || !name || !bytes) return null
    const tableTextMeta = parseTableTextMeta(tableText)
    if (tableTextMeta === null) return null
    const want = imagePreview.isInlineNamedBytes(name, bytes) ? 'image' : 'file'
    const path = await stageImageBytes(name, bytes)
    return (await offer(targetId, [path], want, want === 'image' ? tableTextMeta : undefined)) ?? null
  }

  async function handleImagePath(
    senderId: number,
    target: unknown,
    pathValue: unknown,
    offer: OfferImagePaths
  ): Promise<MessageView | null> {
    const targetId = parseImageSendTarget(target)
    const path = parseImageOfferPath(pathValue)
    if (!targetId || !path) return null
    if (!rendererPathGrants.consume(senderId, [path])) return null
    const staged = await stageOutgoingImagePath(path)
    if (!staged) return null
    const want = (await imagePreview.inspectInlinePath(staged)) ? 'image' : 'file'
    return (await offer(targetId, [staged], want)) ?? null
  }

  function managedTransferMediaView(transferId: string): TransferView | null {
    const view = files?.transferView(transferId)
    if (!view?.savedPath) return null
    // 接收方的图要下载完（done）才落盘存在；发送方的图自始在本地受管目录，
    // 传输未完成（offering/accepted）也应能即时预览——否则发图瞬间取图被拒 → broken（issue #3，决议 #165）。
    if (view.direction === 'in' && view.status !== 'done') return null
    const msg = msgRepoRef?.get(view.msgId)
    if (!msg || (msg.kind !== 'image' && msg.kind !== 'sticker')) return null
    if (!isPathInsideAny(view.savedPath, managedMediaRoots())) return null
    return view
  }

  async function managedInlineImageView(
    transferId: string
  ): Promise<{ view: TransferView; width: number; height: number; animated: boolean } | null> {
    const view = managedTransferMediaView(transferId)
    if (!view) return null
    const metadata = await imagePreview.inspectInlinePath(view.savedPath)
    if (!metadata) return null
    return {
      view,
      width: metadata.width,
      height: metadata.height,
      animated: metadata.animated
    }
  }

  async function readStickerSource(path: string): Promise<ImageSourceBytes | null> {
    try {
      const buf = await readFile(path)
      if (buf.length === 0 || buf.length > IMAGE_SOURCE_MAX_BYTES) return null
      const metadata = imagePreview.isInlineNamedBytes(path, buf)
      if (!metadata) return null
      return {
        bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        ext: extname(path).toLowerCase() || '.png',
        width: metadata.width,
        height: metadata.height,
        animated: metadata.animated
      }
    } catch {
      return null
    }
  }

  function showMainWindow(options: { forceForeground?: boolean } = {}): void {
    if (!mainWindow) return
    showWindowForeground(mainWindow, options)
  }

  function clearNudgeShake(restore: boolean): void {
    for (const timer of nudgeShakeTimers) clearTimeout(timer)
    nudgeShakeTimers = []
    if (restore && nudgeShakeOrigin && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.setPosition(nudgeShakeOrigin[0], nudgeShakeOrigin[1])
      } catch {
        // 窗口可能正在销毁或由系统接管位置；震动是提示，不影响主流程。
      }
    }
    nudgeShakeOrigin = null
  }

  function fallbackNudgeAttention(win: BrowserWindow): void {
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    else win.flashFrame(true)
  }

  function shakeMainWindowForNudge(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    showMainWindow({ forceForeground: true })
    const win = mainWindow
    if (win.isMaximized() || win.isFullScreen()) {
      fallbackNudgeAttention(win)
      return
    }

    clearNudgeShake(true)
    const [originX, originY] = win.getPosition()
    nudgeShakeOrigin = [originX, originY]
    const offsets = [0, 12, -10, 8, -6, 4, -2, 0]
    nudgeShakeTimers = offsets.map((dx, index) => {
      const timer = setTimeout(() => {
        if (!mainWindow || win.isDestroyed()) {
          clearNudgeShake(false)
          return
        }
        try {
          win.setPosition(originX + dx, originY)
        } catch {
          clearNudgeShake(false)
          return
        }
        if (index === offsets.length - 1) {
          nudgeShakeTimers = []
          nudgeShakeOrigin = null
        }
      }, index * 45)
      timer.unref?.()
      return timer
    })
  }

  function mainWindowTitle(): string {
    const nick = appState?.config.setupDone ? appState.config.nick.trim() : ''
    return nick ? `${nick}-🍵Teahouse` : '茶话间'
  }

  function updateMainWindowTitle(): void {
    mainWindow?.setTitle(mainWindowTitle())
  }

  function currentLocalIpv4(): string {
    for (const list of Object.values(networkInterfaces())) {
      for (const addr of list ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address
      }
    }
    return '127.0.0.1'
  }

  function toggleMainWindow(): void {
    if (!mainWindow) return
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide()
      return
    }
    showMainWindow()
  }

  function syncMainWindowZoom(): void {
    applyWindowZoom(mainWindow?.webContents, settingsView().fontScale)
  }

  /**
   * 多窗口共享的事件（决议 #283）：文件柜窗口同样要节点在线状态与传输进度，
   * 否则它的同事列表与进度行只能靠轮询。未订阅的窗口收到即丢弃，成本可忽略。
   */
  function broadcastEvent(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, payload)
    }
  }

  function broadcastSettings(): SettingsView {
    const view = settingsView()
    syncMainWindowZoom()
    syncSettingsWindowZoom(view.fontScale)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcEvents.settingsUpdated, view)
    }
    return view
  }

  function normalizeShortcut(input: unknown): string | null {
    if (typeof input !== 'string') return null
    const value = input.trim()
    if (value.length > 64) return null
    // Electron accelerator 只需字母、数字、空格、+、-；空串表示禁用。
    return /^[A-Za-z0-9+\- ]*$/.test(value) ? value : null
  }

  function normalizeExportOptions(input: unknown): DataExportOptions | undefined {
    if (typeof input !== 'object' || input === null) return undefined
    const raw = input as Record<string, unknown>
    const out: DataExportOptions = {}
    if (typeof raw.convId === 'string' && raw.convId.length > 0 && raw.convId.length <= 128) {
      out.convId = raw.convId
    }
    if (typeof raw.fromTs === 'number' && Number.isFinite(raw.fromTs) && raw.fromTs >= 0) {
      out.fromTs = Math.floor(raw.fromTs)
    }
    if (typeof raw.toTs === 'number' && Number.isFinite(raw.toTs) && raw.toTs >= 0) {
      out.toTs = Math.floor(raw.toTs)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  function normalizeConversationSearch(input: unknown): ConversationSearchOptions | null {
    if (typeof input !== 'object' || input === null) return null
    const raw = input as Record<string, unknown>
    if (typeof raw.convId !== 'string' || raw.convId.length === 0 || raw.convId.length > 128) {
      return null
    }
    if (typeof raw.query !== 'string' || raw.query.length > 128) return null
    const kind =
      raw.kind === 'image' || raw.kind === 'file' || raw.kind === 'all' ? raw.kind : 'all'
    const out: ConversationSearchOptions = {
      convId: raw.convId,
      query: raw.query,
      kind
    }
    if (typeof raw.fromTs === 'number' && Number.isFinite(raw.fromTs) && raw.fromTs >= 0) {
      out.fromTs = Math.floor(raw.fromTs)
    }
    if (typeof raw.toTs === 'number' && Number.isFinite(raw.toTs) && raw.toTs >= 0) {
      out.toTs = Math.floor(raw.toTs)
    }
    if (typeof raw.limit === 'number' && Number.isInteger(raw.limit)) {
      out.limit = Math.max(1, Math.min(raw.limit, 100))
    }
    return out
  }

  /** 全局快捷键注册结果（决议 #57）：随 SettingsView 回传，设置页据此提示"被系统占用" */
  const shortcutStatus = { capture: true, showHide: true }

  function tryRegisterShortcut(accelerator: string, handler: () => void, label: string): boolean {
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (!ok) console.warn(`[shortcut] ${label}快捷键注册失败（可能被系统占用）：`, accelerator)
      return ok
    } catch {
      // 非法 accelerator（手填旧配置/导入数据）不致命，按注册失败处理
      console.warn(`[shortcut] ${label}快捷键格式无效：`, accelerator)
      return false
    }
  }

  function registerGlobalShortcuts(): void {
    const cfg = appState?.config
    if (!cfg) return
    globalShortcut.unregisterAll()
    const captureShortcut = cfg.captureShortcut.trim()
    shortcutStatus.capture = captureShortcut
      ? tryRegisterShortcut(captureShortcut, () => void startCapture(), '截图')
      : true
    const showHideShortcut = cfg.showHideShortcut.trim()
    shortcutStatus.showHide = showHideShortcut
      ? tryRegisterShortcut(showHideShortcut, () => toggleMainWindow(), '显示/隐藏')
      : true
  }

  function applyAutoLaunch(enabled: boolean): void {
    if (process.env['PANTRY_SMOKE']) return
    if (!app.isPackaged) return
    try {
      if (process.platform === 'linux') {
        const dir = join(app.getPath('home'), '.config', 'autostart')
        const file = join(dir, 'pantry.desktop')
        if (!enabled) {
          rmSync(file, { force: true })
          return
        }
        mkdirSync(dir, { recursive: true })
        const content = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=茶话间',
          `Exec="${process.execPath}"`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          ''
        ].join('\n')
        // 内容未变则跳过写入：此前每次启动无条件重写 autostart 文件，
        // UOS/部分桌面会检测到写入并弹"茶话间 正在设置开机自启动"提示（决议 #79）
        const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
        if (existing !== content) writeFileSync(file, content)
        return
      }
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
    } catch (err) {
      console.warn('[system] 开机自启设置失败：', err)
    }
  }

  function toPeerView(record: PeerRecord): PeerView {
    return {
      nodeId: record.profile.nodeId,
      nick: record.profile.nick,
      remark: remarks.get(record.profile.nodeId) ?? '',
      company: record.profile.company,
      dept: record.profile.dept,
      team: record.profile.team,
      avatar: record.profile.avatar,
      avatarHash: record.profile.avatarHash ?? '',
      host: record.profile.host,
      platform: record.profile.platform,
      ip: record.ip,
      online: record.online,
      lastSeen: record.lastSeen,
      ver: record.profile.ver,
      caps: Array.isArray(record.profile.caps) ? record.profile.caps : []
    }
  }

  function resolvePeerDisplayName(nodeId: string): string {
    const remark = remarks.get(nodeId)?.trim()
    if (remark) return remark
    return registry?.get(nodeId)?.profile.nick.trim() ?? ''
  }

  function peerViews(): PeerView[] {
    return registry ? registry.list().map(toPeerView) : []
  }

  /** 局域网自更新（决议 #166）：在线节点里同平台、更高版本、可作源的最佳更新来源，无则 null。 */
  function currentUpdateSource(): ReturnType<typeof pickUpdateSource> {
    if (!appState || !registry) return null
    const self = { version: appState.profile.ver, platform: appState.profile.platform }
    const candidates = registry.values().map((r) => ({
      profile: r.profile,
      online: r.online,
      displayName: resolvePeerDisplayName(r.profile.nodeId)
    }))
    return pickUpdateSource(self, candidates)
  }

  /** 局域网自更新（决议 #166）：在线节点里同平台、更高版本、可作源的最佳更新来源，无则 null。 */
  function currentUpdateAvailability(): UpdateAvailability | null {
    if (!appState) return null
    const self = { version: appState.profile.ver, platform: appState.profile.platform }
    const src = currentUpdateSource()
    if (!src) return null
    return {
      nodeId: src.nodeId,
      fromName: src.fromName,
      version: src.version,
      currentVersion: self.version
    }
  }

  async function requestUpdatePackage(): Promise<boolean> {
    if (!appState || !messenger) return false
    const src = currentUpdateSource()
    if (!src) return false
    const arch = currentRuntimeArch()
    const token = updateRequestGate.begin({
      nodeId: src.nodeId,
      version: src.version,
      platform: src.platform,
      arch
    })
    try {
      const ok = await messenger.sendReliable(
        src.nodeId,
        makeEnvelope<UpdateReqPayload>(MSG_TYPES.update, appState.nodeId, {
          op: 'req',
          platform: appState.profile.platform,
          arch
        })
      )
      if (!ok) updateRequestGate.cancel(token)
      return ok
    } catch {
      updateRequestGate.cancel(token)
      return false
    }
  }

  function currentProtocolPlatform(): Platform {
    if (process.platform === 'win32') return 'win'
    if (process.platform === 'darwin') return 'mac'
    return 'linux'
  }

  function currentRuntimeArch(): RuntimeArch {
    if (process.arch === 'arm64') return 'arm64'
    if (process.arch === 'ia32') return 'ia32'
    return 'x64'
  }

  function updatePackagePath(version: string, platform: Platform, arch = currentRuntimeArch()): string | null {
    return findLocalUpdatePackage({
      dirs: [updatesDir(), join(app.getAppPath(), 'release')],
      version,
      platform,
      arch
    })
  }

  function canAdvertiseUpdateSource(): boolean {
    if (
      !canServeUpdates({
        platform: process.platform,
        isPackaged: app.isPackaged,
        env: process.env
      })
    ) {
      return false
    }
    return updatePackagePath(app.getVersion(), currentProtocolPlatform()) !== null
  }

  function handleUpdateRequest(env: Envelope<UpdateReqPayload>): void {
    if (!appState || !files || !registry) return
    const peer = registry.get(env.from)
    if (
      !shouldServeUpdateRequest(
        { version: appState.profile.ver, platform: appState.profile.platform },
        peer ?? null,
        env.payload.platform
      )
    ) {
      return
    }
    const packagePath = updatePackagePath(
      appState.profile.ver,
      appState.profile.platform,
      env.payload.arch ?? currentRuntimeArch()
    )
    if (!packagePath) return
    void files.offerUpdatePackage(env.from, packagePath)
  }

  /**
   * 共享文件柜控制面（§8.2）：应答对端的 list / get，并把 list-ok / deny 交回本机等待中的请求。
   * 权限、路径、限流全部由 ShareService 判定，这里只做转发与超时收口。
   */
  function handleShareCtl(env: Envelope<SharePayload>): void {
    const payload = env.payload
    if (payload.op === 'list-ok' || payload.op === 'deny') {
      const settle = sharePending.get(payload.reqId)
      if (settle) {
        sharePending.delete(payload.reqId)
        settle(payload)
      }
      return
    }
    if (!share || !messenger) return
    if (payload.op === 'list') {
      const reply = share.handleList(env.from, payload)
      void messenger.sendReliable(env.from, makeEnvelope(MSG_TYPES.share, selfNodeId(), reply))
      return
    }
    if (payload.op === 'get') {
      const result = share.handleGet(env.from, payload.paths)
      if (!result.ok) {
        void messenger.sendReliable(
          env.from,
          makeEnvelope(MSG_TYPES.share, selfNodeId(), {
            op: 'deny',
            reqId: payload.reqId,
            reason: result.reason
          } satisfies SharePayload)
        )
        return
      }
      // 日志只记条目数，不记文件名与目录内容（决议 #6/#276）
      console.log(`[share] 应答下载请求：${result.absPaths.length} 项`)
      void files?.offerSharePaths(env.from, result.absPaths)
    }
  }

  /** 对端 share-get offer 已到，提前结束对应的 get 等待 */
  function settleShareGet(peerId: string): void {
    const reqId = shareGetReq.get(peerId)
    if (!reqId) return
    shareGetReq.delete(peerId)
    const settle = sharePending.get(reqId)
    if (!settle) return
    sharePending.delete(reqId)
    settle(null)
  }

  /** 上传前先在本机量一遍：递归统计文件数与总字节，读不到返回 null。 */
  function selfNodeId(): string {
    return appState?.nodeId ?? ''
  }

  /** 发一条 share 请求并等应答；超时返回 null，由调用方给出可重试的提示。 */
  async function requestShare(
    peerId: string,
    payload: SharePayload
  ): Promise<SharePayload | null> {
    if (!messenger) return null
    const waiter = new Promise<SharePayload | null>((resolve) => {
      sharePending.set(payload.reqId, resolve)
      setTimeout(() => {
        if (sharePending.delete(payload.reqId)) resolve(null)
      }, SHARE_REQ_TIMEOUT).unref?.()
    })
    const sent = await messenger.sendReliable(
      peerId,
      makeEnvelope(MSG_TYPES.share, selfNodeId(), payload)
    )
    if (!sent) {
      sharePending.delete(payload.reqId)
      return null
    }
    return waiter
  }

  function scanRangeItems(): SettingsView['scanRangeItems'] {
    const c = appState?.config
    if (!c) return []
    const sources = c.scanRangeSources ?? {}
    const onlinePeers = registry ? registry.values().filter((p) => p.online) : []
    return c.scanRanges.map((cidr) => {
      const source = sources[cidr] ?? { source: 'self' as const, addedAt: Date.now() }
      return {
        cidr,
        source: source.source,
        sourceNodeId: source.sourceNodeId,
        sourceName: source.sourceName,
        addedAt: source.addedAt,
        lastAutoScanAt: source.lastAutoScanAt,
        nodeCount: onlinePeers.filter((p) => ipInCidr(p.ip, cidr)).length
      }
    })
  }

  function sharedScanRanges(): ScanRangeSummary[] {
    const c = appState?.config
    if (!c) return []
    const ignored = c.ignoredScanRanges ?? {}
    const sources = c.scanRangeSources ?? {}
    const now = Date.now()
    const seen = new Set<string>()
    const ranges: ScanRangeSummary[] = []
    for (const raw of c.scanRanges) {
      const cidr = normalizeCidr(raw)
      if (!cidr || ignored[cidr] || seen.has(cidr)) continue
      seen.add(cidr)
      ranges.push({ cidr, addedAt: sources[cidr]?.addedAt ?? now })
    }
    return ranges
  }

  function collectGlobalScanHosts(): { hosts: string[]; rangeCount: number } {
    const c = appState?.config
    if (!c) return { hosts: [], rangeCount: 0 }
    return buildCidrHostPlan(c.scanRanges)
  }

  function emitGlobalScanProgress(force = false): void {
    const now = Date.now()
    if (
      !force &&
      globalScanProgress.running &&
      now - lastGlobalScanProgressPushAt < GLOBAL_SCAN_PROGRESS_PUSH_INTERVAL
    ) {
      return
    }
    lastGlobalScanProgressPushAt = now
    mainWindow?.webContents.send(IpcEvents.netScanProgress, globalScanProgress)
  }

  function setGlobalScanProgress(patch: Partial<ScanProgressView>, force = false): ScanProgressView {
    globalScanProgress = { ...globalScanProgress, ...patch }
    emitGlobalScanProgress(force)
    return globalScanProgress
  }

  function startGlobalRangeScan(): ScanProgressView {
    if (globalScanProgress.running) return globalScanProgress
    if (!discovery || !appState) {
      globalScanSeq += 1
      return setGlobalScanProgress(
        {
          scanId: globalScanSeq,
          status: 'unavailable',
          running: false,
          done: 0,
          total: 0,
          rangeCount: 0,
          startedAt: Date.now(),
          finishedAt: Date.now()
        },
        true
      )
    }

    const { hosts, rangeCount } = collectGlobalScanHosts()
    globalScanSeq += 1
    const scanId = globalScanSeq
    const now = Date.now()
    setGlobalScanProgress(
      {
        scanId,
        status: hosts.length > 0 ? 'running' : 'empty',
        running: hosts.length > 0,
        done: 0,
        total: hosts.length,
        rangeCount,
        startedAt: now,
        finishedAt: hosts.length > 0 ? 0 : now
      },
      true
    )
    if (hosts.length === 0) return globalScanProgress

    let index = 0
    const tick = (): void => {
      if (globalScanProgress.scanId !== scanId || !globalScanProgress.running) return
      const host = hosts[index]
      if (host && discovery) discovery.probe(host, udpPort)
      index += 1
      if (index >= hosts.length) {
        globalScanTimer = null
        setGlobalScanProgress(
          {
            status: 'done',
            running: false,
            done: hosts.length,
            finishedAt: Date.now()
          },
          true
        )
        return
      }
      setGlobalScanProgress({ done: index })
      globalScanTimer = setTimeout(tick, GLOBAL_SCAN_HOST_DELAY)
      globalScanTimer.unref?.()
    }
    globalScanTimer = setTimeout(tick, 0)
    globalScanTimer.unref?.()
    return globalScanProgress
  }

  function hashString(value: string): number {
    let hash = 2166136261
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }

  function shouldAutoScanRange(cidr: string): boolean {
    if (!appState || !registry) return false
    const onlineCount = registry.onlineCount()
    if (onlineCount <= TIMINGS.scanRangeAutoScanLargeOnlineThreshold) return true
    return (
      hashString(`${appState.nodeId}:${cidr}`) % TIMINGS.scanRangeAutoScanLargeOnlineModulo ===
      0
    )
  }

  function scheduleAutoScanRange(cidr: string): void {
    const state = appState
    if (!state || !discovery || rangeScanTimers.has(cidr)) return
    const meta = state.config.scanRangeSources?.[cidr]
    if (!meta || meta.source !== 'remote') return
    const now = Date.now()
    if (
      meta.lastAutoScanAt &&
      now - meta.lastAutoScanAt < TIMINGS.scanRangeAutoScanMinInterval
    ) {
      return
    }
    if (!shouldAutoScanRange(cidr)) return
    const delay =
      TIMINGS.scanRangeAutoScanInitialMin +
      Math.floor(
        Math.random() *
          (TIMINGS.scanRangeAutoScanInitialMax - TIMINGS.scanRangeAutoScanInitialMin + 1)
      )
    const timer = setTimeout(() => {
      rangeScanTimers.delete(cidr)
      const hosts = parseCidr(cidr)
      if (!hosts || !discovery || !appState) return
      discovery.scanHosts(hosts, udpPort, TIMINGS.scanRangeAutoScanHostDelay)
      markScanRangeAutoScanned(appState, cidr)
      broadcastSettings()
    }, delay)
    rangeScanTimers.set(cidr, timer)
    timer.unref?.()
  }

  function scheduleExistingRemoteRangeScans(): void {
    const c = appState?.config
    if (!c) return
    for (const cidr of c.scanRanges) scheduleAutoScanRange(cidr)
  }

  function acceptSharedScanRanges(fromNodeId: string, ranges: ScanRangeSummary[]): void {
    const state = appState
    if (!state) return
    const sourceName = resolvePeerDisplayName(fromNodeId) || '同事'
    const accepted = addSharedScanRanges(state, ranges, {
      nodeId: fromNodeId,
      name: sourceName
    })
    if (accepted.length === 0) return
    for (const cidr of accepted) scheduleAutoScanRange(cidr)
    broadcastSettings()
  }

  async function startNet(): Promise<void> {
    const state = appState
    if (!state) return
    // 手动节点 = 环境变量（联调用）∪ 设置持久化（F-DISC-2 第一板斧）
    const allManual: ManualPeer[] = [
      ...manualPeers,
      ...state.config.manualPeers.map((item) => {
        const [host, port] = item.split(':')
        return { host, port: Number(port) || udpPort }
      })
    ]
    const udp = new UdpChannel({ port: udpPort })
    registry = new PeerRegistry(state.nodeId)
    // 时钟偏移矫正（决议 #65）：发现层观测各节点时钟差，chat/groups 显示时矫正到本机钟
    const peerClock = new PeerClock()
    discovery = new Discovery({ udp, registry, profile: state.profile, manualPeers: allManual, peerClock })
    rangeSync = new RangeSync({
      udp,
      registry,
      selfId: state.nodeId,
      getRanges: sharedScanRanges,
      acceptRanges: acceptSharedScanRanges
    })

    // 存储层降级链：文件库 → 内存库（功能照常、不持久）→ 全不可用则只剩发现功能
    try {
      db = openDatabase(join(app.getPath('userData'), 'data', 'db', 'chat.db'))
    } catch (err) {
      console.error('[store] 文件库打开失败，尝试内存库：', err)
      try {
        db = openMemoryDatabase()
      } catch (err2) {
        console.error('[store] 内存库也不可用，本次会话仅发现功能：', err2)
      }
    }
    if (db) {
      peersRepo = new PeersRepo(db)
      groupRepo = new GroupRepo(db)
      registry.seed(peersRepo.loadAll()) // 历史联系人以离线态回灌（F-DISC-7）
      for (const [id, remark] of peersRepo.loadRemarks()) remarks.set(id, remark)

      messenger = new Messenger({
        udp,
        registry,
        selfId: state.nodeId,
        queue: new QueueRepo(db),
        dedup: new DedupRepo(db)
      })
      messenger.on('incoming', (env: Envelope) => {
        if (env.type === MSG_TYPES.update) handleUpdateRequest(env as Envelope<UpdateReqPayload>)
        else if (env.type === MSG_TYPES.share) handleShareCtl(env as Envelope<SharePayload>)
      })
      chat = new ChatService({
        selfId: state.nodeId,
        convRepo: new ConvRepo(db),
        msgRepo: new MsgRepo(db),
        groupRepo,
        messenger,
        peerClock,
        isOnline: (peerId) => registry?.get(peerId)?.online === true,
        probe: (peerId) => {
          discovery?.probeNode(peerId) // 打开会话 → 探活（F-DISC-8）
        },
        mediaRecall: {
          canRecall: (row) => files?.canRecallMessage(row.id) ?? false,
          applyLocalRecall: (row) => {
            files?.applyRecallMessage(row.id)
          },
          applyIncomingRecall: (row) => files?.applyRecallMessage(row.id) ?? false
        }
      })
      const onMessage = (msg: MessageView): void => {
        mainWindow?.webContents.send(IpcEvents.msgNew, msg)
        notifyIncoming(msg)
      }
      const onStatus = (ev: unknown): void => {
        mainWindow?.webContents.send(IpcEvents.msgStatus, ev)
      }
      const onNudge = (ev: NudgeEvent): void => {
        mainWindow?.webContents.send(IpcEvents.nudgeReceived, ev)
        shakeMainWindowForNudge()
      }
      const onConvs = (convs: Array<{ unread: number }>): void => {
        mainWindow?.webContents.send(IpcEvents.convsUpdated, convs)
        const total = convs.reduce((sum, c) => sum + c.unread, 0)
        updateTrayUnread(tray, mainWindow, total)
      }
      chat.on('message', onMessage)
      chat.on('status', onStatus)
      chat.on('nudge', onNudge)
      chat.on('convs', onConvs)
      onConvs(chat.listConversations())

      files = new FilesService({
        selfId: state.nodeId,
        messenger,
        registry,
        convRepo: new ConvRepo(db),
        msgRepo: new MsgRepo(db),
        transferRepo: new TransferRepo(db),
        groupRepo,
        tcpPort,
        getSaveDir: () =>
          appState?.config.fileDir || defaultFileDir(),
        getImagesDir: imagesDir,
        getUpdateDir: updatesDir,
        authorizeUpdateOffer: (peerId, name, totalSize) =>
          updateRequestGate.consume(peerId, name, totalSize),
        authorizeShareUpload: (peerId, totalSize) =>
          share?.handlePut(peerId, totalSize, resolvePeerDisplayName(peerId) || peerId) ?? null,
        authorizeShareDownload: (peerId) => {
          const dir = shareDownloadGate.consume(peerId)
          // 传输已开始即视为请求成功，立刻唤醒 share:download，不必干等超时
          if (dir !== null) settleShareGet(peerId)
          return dir
        },
        allowDirectFileSend: () => appState?.config.allowDirectFileSend !== false,
        peerDisplayName: resolvePeerDisplayName
      })
      files.on('message', onMessage)
      files.on('status', onStatus)
      files.on('convs', onConvs)
      files.on('transfer', (view) => broadcastEvent(IpcEvents.transferUpdated, view))
      try {
        await files.start() // TCP 数据端口
      } catch (err) {
        console.error('[files] TCP 端口监听失败，文件发送可用但无法被拉取：', err)
      }

      groups = new GroupsService({
        selfId: state.nodeId,
        messenger,
        convRepo: new ConvRepo(db),
        msgRepo: new MsgRepo(db),
        groupRepo,
        getSelfIp: currentLocalIpv4,
        peerClock,
        isOnline: (nodeId) => registry?.get(nodeId)?.online === true,
        resolveDisplayName: resolvePeerDisplayName
      })
      groups.on('message', onMessage)
      groups.on('convs', onConvs)
      groups.on('group', (view) => {
        mainWindow?.webContents.send(IpcEvents.groupUpdated, view)
        void avatars?.ensureGroup(view.groupId)
        scheduleAvatarPrune()
      })

      avatars = new AvatarService({
        selfId: state.nodeId,
        messenger,
        registry,
        groupRepo,
        store: avatarStore,
        getSelfProfile: () => state.profile
      })
      avatars.on('ready', (hash: string) => broadcastAvatarReady(hash))
      avatars.ensureAll()
      scheduleAvatarPrune()

      forward = new ForwardService({
        msgRepo: new MsgRepo(db),
        chat,
        groups,
        files,
        canInlineImage: async (path) => Boolean(await imagePreview.inspectInlinePath(path))
      })
      porter = new PorterService(
        db,
        state.nodeId,
        state.config.nick,
        importedMediaDir(),
        [imagesDir(), stickersDir()],
        avatarsDir(),
        state.config.avatarHash
      )
      search = new SearchService(db, registry, (id) => remarks.get(id) ?? '')
      msgRepoRef = new MsgRepo(db)
      stickerRepo = new StickerRepo(db)
      shareGrantsRepo = new ShareGrantsRepo(db)
      share?.reload() // 库比 ShareService 晚就绪，此处回灌已保存的按人例外
      chat.prune() // 启动清理（过期队列/去重窗口），之后每小时一次
      pruneTimer = setInterval(() => chat?.prune(), 3_600_000)
      pruneTimer.unref?.()
    }

    // 注册表变化 → 节流 200ms 推给渲染层（tech-design §4 事件推送约定）
    let pushTimer: ReturnType<typeof setTimeout> | null = null
    registry.on('updated', () => {
      if (pushTimer) return
      pushTimer = setTimeout(() => {
        pushTimer = null
        broadcastEvent(IpcEvents.peersUpdated, peerViews())
        mainWindow?.webContents.send(IpcEvents.updateAvailable, currentUpdateAvailability())
        avatars?.ensureAll()
      }, 200)
      // 落库节流 1s：≤1000 行整表 upsert 在事务内毫秒级
      if (!persistTimer) {
        persistTimer = setTimeout(() => {
          persistTimer = null
          if (registry && peersRepo) peersRepo.upsertMany(registry.values())
        }, 1000)
      }
    })

    try {
      await udp.start()
      discovery.start()
      rangeSync?.start()
      scheduleExistingRemoteRangeScans()
      netState.ok = true
    } catch (err) {
      // 端口被占等启动失败：进"离线模式"，窗口照常可用（tech-design §2）
      netState.ok = false
      netState.error = err instanceof Error ? err.message : String(err)
      console.error('[net] UDP 启动失败，进入离线模式：', netState.error)
    }
    mainWindow?.webContents.send(IpcEvents.netState, netState)
  }

  function reportCaptureFailure(
    reason: CaptureFailureReason,
    wasVisible: boolean,
    error?: unknown
  ): void {
    capturing = false
    const notice = captureFailureNotice(reason, WAYLAND_SESSION)
    console.warn('[capture]', notice.message, error ?? '')

    const sendToMainWindow = (): boolean => {
      showMainWindow({ forceForeground: true })
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IpcEvents.captureFailed, notice)
        return true
      }
      return false
    }

    // 原本可见时恢复主窗并走应用内提示；原本隐藏时尽量不打断用户，改用系统通知。
    if (wasVisible && sendToMainWindow()) return

    if (Notification.isSupported()) {
      try {
        const icon = systemNotificationIcon()
        new Notification({
          title: '茶话间',
          body: notice.message,
          ...(icon ? { icon } : {})
        }).show()
        return
      } catch (notificationError) {
        console.warn('[capture] 系统通知失败，改用主窗口提示：', notificationError)
      }
    }

    // 桌面环境不支持系统通知时显示主窗，保证全局快捷键失败也不会无声无息。
    sendToMainWindow()
  }

  /** 内置截图（F-CAP-1）：抓主屏 → 框选窗 → 剪贴板（可选直发当前会话） */
  async function startCapture(): Promise<void> {
    if (capturing) return
    capturing = true
    const hide = appState?.config.hideOnCapture !== false
    const captureMainWindow = mainWindow
    const wasVisible = captureMainWindow?.isVisible() ?? false
    // Electron 22 在 ARM64 Wayland 枚举屏幕时可能触发原生 SIGSEGV，JS 无法捕获；保留系统截图粘贴退路。
    if (WAYLAND_SESSION && process.arch === 'arm64') {
      reportCaptureFailure('screen-unavailable', wasVisible)
      return
    }
    try {
      if (hide && wasVisible && captureMainWindow) {
        const hidden = await hideWindowForCapture(captureMainWindow)
        if (!hidden) {
          reportCaptureFailure('window-hide-failed', wasVisible)
          return
        }
      }
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor)
        }
      })
      const source =
        sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null
      if (!source || source.thumbnail.isEmpty()) {
        reportCaptureFailure('screen-unavailable', wasVisible)
        return
      }
      const sourceSize = source.thumbnail.getSize()
      const geometry = planCaptureGeometry(
        process.platform,
        display.bounds,
        display.workArea,
        sourceSize
      )
      const crop = geometry.imageCrop
      const needsCrop =
        crop.x !== 0 ||
        crop.y !== 0 ||
        crop.width !== sourceSize.width ||
        crop.height !== sourceSize.height
      const captureImage = needsCrop ? source.thumbnail.crop(crop) : source.thumbnail
      if (captureImage.isEmpty()) {
        reportCaptureFailure('image-empty', wasVisible)
        return
      }
      const png = captureImage.toPNG()
      if (png.byteLength === 0) {
        reportCaptureFailure('image-empty', wasVisible)
        return
      }
      const pngBytes = png.buffer.slice(
        png.byteOffset,
        png.byteOffset + png.byteLength
      ) as ArrayBuffer
      openCaptureWindow(geometry.windowBounds, pngBytes, () => {
        capturing = false
        if (wasVisible) showMainWindow({ forceForeground: true })
      })
    } catch (err) {
      reportCaptureFailure('unexpected', wasVisible, err)
    }
  }

  /** 新消息系统通知（F-SYS-2）：窗口聚焦时不打扰（应用内角标已可见）；点击直达会话 */
  function notifyIncoming(msg: MessageView): void {
    if (msg.isMine) return
    if (msg.kind === 'system') return
    if (appState && appState.config.notifications === false) return
    if (chat?.isMuted(msg.convId)) return
    if (mainWindow && mainWindow.isFocused() && mainWindow.isVisible()) return
    if (!Notification.isSupported()) return

    const senderNick = registry?.get(msg.senderId)?.profile.nick ?? '新成员'
    const hidePreview = appState?.config.showMessagePreview === false
    const groupName = msg.convId.startsWith('group:')
      ? groups?.get(msg.convId.slice(6))?.name
      : undefined
    const icon = systemNotificationIcon()
    // 群消息：标题=群名，正文=「发送人：内容」（微信式，决议 #66）；正文走系统通知安全文本（决议 #108）
    const options = incomingNotificationOptions({
      msg,
      senderNick,
      groupName,
      hidePreview,
      silent: appState?.config.sound === 'none'
    })
    const notification = new Notification({
      ...options,
      ...(icon ? { icon } : {})
    })
    notification.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send(IpcEvents.openConv, msg.convId)
    })
    notification.show()
    if (process.platform === 'win32') mainWindow?.flashFrame(true) // 任务栏闪烁提醒
  }

  function createMainWindow(): void {
    // dev 模式 mac Dock 显示茶杯图标（决议 #72）：打包版靠 .app 内嵌 icns，而 `npm run dev`
    // 跑未打包 Electron、Dock 是其默认图标；运行时 setIcon 仅补 dev，打包版不覆盖（icns 更精细）。
    if (process.platform === 'darwin' && !app.isPackaged) {
      try {
        app.dock?.setIcon(join(app.getAppPath(), 'build/icons/pantry-logo-icon.png'))
      } catch {
        // 图标缺失不致命
      }
    }

    mainWindow = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: mainWindowTitle(),
      // 沉浸式无标题栏（决议 #49）：mac 保留内嵌红绿灯；Win/Linux 渲染层自绘控制按钮。
      // Windows 不关 thickFrame，边缘缩放与 Aero Snap 保持系统行为；不使用透明窗口（Win7 软渲染安全）。
      // 红绿灯置于列表栏顶部留白（决议 #51）：56px 导航栏放不下三钮，不允许横跨分界线。
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 9, y: 7 } }
        : { frame: false }),
      ...linuxWindowIcon(),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    syncMainWindowZoom()
    mainWindow.webContents.on('did-finish-load', syncMainWindowZoom)

    // 最大化状态推送：渲染层自绘「最大化/还原」按钮据此切图标
    mainWindow.on('maximize', () =>
      mainWindow?.webContents.send(IpcEvents.winMaximizeChanged, true)
    )
    mainWindow.on('unmaximize', () =>
      mainWindow?.webContents.send(IpcEvents.winMaximizeChanged, false)
    )

    // 安全红线（README）：不放行任何窗口内导航与新窗口
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (
        input.type === 'keyDown' &&
        (input.meta || input.control) &&
        !input.alt &&
        input.key.toLowerCase() === 'v'
      ) {
        mainWindow?.webContents.send(IpcEvents.clipboardPasteImage)
      }
    })

    mainWindow.once('ready-to-show', () => mainWindow?.show())
    // 关窗 = 进托盘常驻（F-SYS-1）；托盘不可用的桌面环境降级为直接退出
    mainWindow.on('close', (event) => {
      if (isQuitting || !tray || appState?.config.closeToTray === false) return
      event.preventDefault()
      mainWindow?.hide()
    })
    mainWindow.on('focus', () => mainWindow?.flashFrame(false))
    mainWindow.on('closed', () => {
      clearNudgeShake(false)
      mainWindow = null
    })

    const rendererUrl = resolveDevRendererUrl(
      process.env['ELECTRON_RENDERER_URL'],
      '',
      app.isPackaged
    )
    if (rendererUrl) {
      void mainWindow.loadURL(rendererUrl)
    } else {
      void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  // ---- IPC（只做参数校验与转发，业务禁入此层 —— tech-design §3） ----
  ipcMain.handle(IpcChannels.appInfo, (): AppInfo => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      windows7: WINDOWS7,
      softwareRendering: SOFTWARE_RENDERING,
      nodeId: appState?.nodeId ?? '',
      localIp: currentLocalIpv4()
    }
  })

  // 窗口控制（决议 #49）：按调用方 webContents 定位窗口，主窗/设置窗通用
  ipcMain.handle(IpcChannels.winMinimize, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle(IpcChannels.winToggleMaximize, (event): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !win.isMaximizable()) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle(IpcChannels.winIsMaximized, (event): boolean => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  // 决议 #59：自绘关闭按钮唯一入口。主进程 close() 走标准流程触发 close 事件，
  // 主窗的"关闭进托盘"拦截才有机会执行；DOM window.close() 会 CloseImmediately 绕过。
  ipcMain.handle(IpcChannels.winClose, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  // Linux JS 拖拽（决议 #52）：CSS 拖拽区在 Linux 命中不可靠（UOS 实测吞点击），
  // 渲染层按住拖拽带时由主进程按光标位置跟随移窗；单鼠标场景同一时刻只有一个拖拽。
  let dragTimer: NodeJS.Timeout | null = null

  function stopWindowDrag(): void {
    if (dragTimer) clearInterval(dragTimer)
    dragTimer = null
  }

  ipcMain.handle(IpcChannels.winBeginDrag, (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isMaximized() || win.isFullScreen()) return
    stopWindowDrag()
    const cursor = screen.getCursorScreenPoint()
    const [winX, winY] = win.getPosition()
    const offsetX = cursor.x - winX
    const offsetY = cursor.y - winY
    dragTimer = setInterval(() => {
      if (win.isDestroyed()) {
        stopWindowDrag()
        return
      }
      const point = screen.getCursorScreenPoint()
      win.setPosition(point.x - offsetX, point.y - offsetY)
    }, 16)
  })

  ipcMain.handle(IpcChannels.winEndDrag, (): void => stopWindowDrag())

  ipcMain.handle(IpcChannels.appOpenUrl, async (_event, raw: unknown): Promise<boolean> => {
    if (typeof raw !== 'string' || raw.length > 2048) return false
    try {
      const url = new URL(raw)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      await shell.openExternal(url.toString())
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IpcChannels.netState, (): NetState => netState)

  ipcMain.handle(IpcChannels.peersList, (): PeerView[] => peerViews())

  ipcMain.handle(IpcChannels.updateCheck, (): UpdateAvailability | null => currentUpdateAvailability())

  ipcMain.handle(IpcChannels.updateRequest, (): Promise<boolean> => requestUpdatePackage())

  ipcMain.handle(IpcChannels.peersProbe, (_event, nodeId: unknown): boolean => {
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 64) return false
    return discovery?.probeNode(nodeId) ?? false
  })

  ipcMain.handle(IpcChannels.convList, () => chat?.listConversations() ?? [])

  ipcMain.handle(IpcChannels.convOpen, (_event, peerId: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    return chat?.openConversation(peerId) ?? null
  })

  ipcMain.handle(IpcChannels.convMarkRead, (_event, convId: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128) chat?.markRead(convId)
  })

  ipcMain.handle(IpcChannels.convPin, (_event, convId: unknown, pinned: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128 && typeof pinned === 'boolean') {
      chat?.setPinned(convId, pinned)
    }
  })

  ipcMain.handle(IpcChannels.convMute, (_event, convId: unknown, muted: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128 && typeof muted === 'boolean') {
      chat?.setMuted(convId, muted)
    }
  })

  ipcMain.handle(IpcChannels.convRemove, (_event, convId: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128) chat?.removeConversation(convId)
  })

  ipcMain.handle(IpcChannels.msgPage, (_event, convId: unknown, beforeSeq: unknown, limit: unknown) => {
    if (typeof convId !== 'string' || convId.length > 128 || !chat) return []
    const before = typeof beforeSeq === 'number' && Number.isInteger(beforeSeq) ? beforeSeq : null
    const lim = typeof limit === 'number' && limit >= 1 && limit <= 200 ? limit : 50
    return chat.pageMessages(convId, before, lim)
  })

  ipcMain.handle(IpcChannels.msgSend, (_event, peerId: unknown, text: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return null
    return chat?.sendText(peerId, text) ?? null
  })

  ipcMain.handle(IpcChannels.msgResend, (_event, msgId: unknown): boolean => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > 64) return false
    return chat?.resend(msgId) ?? false
  })

  ipcMain.handle(IpcChannels.msgRecall, (_event, msgId: unknown): boolean => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > 64) return false
    return chat?.recall(msgId) ?? false
  })

  ipcMain.handle(IpcChannels.msgNudge, async (_event, peerId: unknown): Promise<NudgeResult> => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) {
      return { ok: false, reason: 'invalid' }
    }
    return chat?.sendNudge(peerId) ?? { ok: false, reason: 'invalid' }
  })

  ipcMain.handle(IpcChannels.msgPk, (_event, convId: unknown, game: unknown) => {
    if (typeof convId !== 'string' || convId.length === 0 || convId.length > 128) return null
    if (game !== 'dice' && game !== 'rps') return null
    if (convId.startsWith('single:')) return chat?.sendPk(convId.slice(7), game) ?? null
    if (convId.startsWith('group:')) return groups?.sendPk(convId.slice(6), game) ?? null
    return null
  })

  ipcMain.handle(IpcChannels.msgForward, async (_event, msgId: unknown, targets: unknown) => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > 64) {
      return { ok: 0, total: 0, messages: [] }
    }
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 50) {
      return { ok: 0, total: 0, messages: [] }
    }
    const clean: ForwardTarget[] = []
    for (const item of targets) {
      if (typeof item !== 'object' || item === null) continue
      const target = item as Record<string, unknown>
      if ((target.type !== 'single' && target.type !== 'group') || typeof target.id !== 'string') {
        continue
      }
      if (target.id.length === 0 || target.id.length > 64) continue
      clean.push({ type: target.type, id: target.id })
    }
    return forward?.forward(msgId, clean) ?? { ok: 0, total: clean.length, messages: [] }
  })

  function settingsView(): SettingsView {
    const c = appState?.config
    const fontScale = c && (c.fontScale === 110 || c.fontScale === 125) ? c.fontScale : 100
    const sound =
      c?.sound === 'drop' || c?.sound === 'wood' || c?.sound === 'ding' ? c.sound : 'none'
    return {
      nick: c?.nick ?? '',
      company: c?.company ?? '',
      dept: c?.dept ?? '',
      team: c?.team ?? '',
      host: appState?.profile.host ?? '',
      avatar: c?.avatar ?? -1,
      avatarHash: c?.avatarHash ?? '',
      setupDone: c?.setupDone ?? true,
      fileDir: c?.fileDir ?? '',
      defaultFileDir: defaultFileDir(),
      notifications: c?.notifications !== false,
      manualPeers: c?.manualPeers ?? [],
      scanRanges: c?.scanRanges ?? [],
      scanRangeItems: scanRangeItems(),
      udpPort: c?.udpPort ?? udpPort,
      tcpPort: c?.tcpPort ?? tcpPort,
      hideOnCapture: c?.hideOnCapture !== false,
      autoLaunch: c?.autoLaunch !== false,
      closeToTray: c?.closeToTray !== false,
      theme: c?.theme === 'dark' ? 'dark' : 'light',
      fontScale,
      showMessagePreview: c?.showMessagePreview !== false,
      allowDirectFileSend: c?.allowDirectFileSend !== false,
      fileCabinet: {
        root: c?.fileCabinet?.root ?? '',
        mode: c?.fileCabinet?.mode ?? 'off',
        grantCount: share?.listGrants().length ?? 0
      },
      sound,
      sendKey: c?.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
      captureShortcut: c?.captureShortcut ?? DEFAULT_CAPTURE_SHORTCUT,
      showHideShortcut: c?.showHideShortcut ?? DEFAULT_SHOWHIDE_SHORTCUT,
      shortcutStatus: { ...shortcutStatus }
    }
  }

  function isValidSubmit(x: unknown): x is ProfileSubmit {
    if (typeof x !== 'object' || x === null) return false
    const s = x as Record<string, unknown>
    const str = (v: unknown, max: number, allowEmpty: boolean): boolean =>
      typeof v === 'string' && v.length <= max && (allowEmpty || v.trim().length > 0)
    return (
      str(s.nick, LIMITS.nick, false) &&
      str(s.company, LIMITS.company, true) &&
      str(s.dept, LIMITS.dept, true) &&
      str(s.team, LIMITS.team, true) &&
      isAvatarPresetValue(s.avatar) &&
      (s.avatarHash === undefined || s.avatarHash === '' || isAvatarHash(s.avatarHash)) &&
      typeof s.fileDir === 'string' &&
      s.fileDir.length <= 1024
    )
  }

  ipcMain.handle(IpcChannels.settingsGet, (): SettingsView => settingsView())

  ipcMain.handle(IpcChannels.settingsSaveProfile, async (_event, submit: unknown): Promise<SettingsView> => {
    if (appState && isValidSubmit(submit)) {
      // 新头像哈希必须在受管缓存中真实存在，否则全网节点会对取不到的头像反复空请求（决议 #248）；
      // 与当前值相同的哈希放行，避免头像文件意外缺失时阻塞无关资料保存。
      if (
        submit.avatarHash !== undefined &&
        submit.avatarHash !== '' &&
        submit.avatarHash !== appState.config.avatarHash &&
        !(await avatarStore.has(submit.avatarHash))
      ) {
        return settingsView()
      }
      saveProfile(appState, {
        nick: submit.nick.trim(),
        company: submit.company.trim(),
        dept: submit.dept.trim(),
        team: submit.team.trim(),
        avatar: submit.avatar,
        ...(submit.avatarHash !== undefined ? { avatarHash: submit.avatarHash } : {}),
        fileDir: submit.fileDir.trim()
      })
      if (db) {
        porter = new PorterService(
          db,
          appState.nodeId,
          appState.config.nick,
          importedMediaDir(),
          [imagesDir(), stickersDir()],
          avatarsDir(),
          appState.config.avatarHash
        )
      }
      discovery?.announceProfile() // 资料变更即时广播（F-DISC-7 的发送侧）
      updateMainWindowTitle()
      broadcastSettings()
    }
    return settingsView()
  })

  ipcMain.handle(
    IpcChannels.avatarPickSource,
    async (event): Promise<AvatarSourcePick | null> => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: '选择头像图片',
            properties: ['openFile'],
            filters: [{ name: '图片', extensions: AVATAR_PICKER_EXTENSIONS }]
          })
        : await dialog.showOpenDialog({
            title: '选择头像图片',
            properties: ['openFile'],
            filters: [{ name: '图片', extensions: AVATAR_PICKER_EXTENSIONS }]
          })
      if (result.canceled || result.filePaths.length === 0) return null
      const path = result.filePaths[0]
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size <= 0) return { ok: false, error: '无法读取这张图片' }
        if (info.size > AVATAR_SOURCE_MAX_BYTES) {
          return { ok: false, error: '头像图片不能超过 20 MiB' }
        }
        const data = await readFile(path)
        const metadata = inspectImageMetadata(data)
        if (!metadata || metadata.format === 'gif') {
          return { ok: false, error: '请选择 JPG、PNG、WebP 或 BMP 静态图片' }
        }
        if (metadata.animated) return { ok: false, error: '暂不支持动态头像' }
        if (
          metadata.width > AVATAR_MAX_DIMENSION ||
          metadata.height > AVATAR_MAX_DIMENSION
        ) {
          return { ok: false, error: '头像图片单边不能超过 8192 像素' }
        }
        const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        return {
          ok: true,
          bytes,
          mime: avatarMime(metadata.format),
          width: metadata.width,
          height: metadata.height
        }
      } catch {
        return { ok: false, error: '无法读取这张图片' }
      }
    }
  )

  ipcMain.handle(
    IpcChannels.profileSetAvatar,
    async (_event, input: unknown): Promise<SettingsView> => {
      if (!appState || typeof input !== 'object' || input === null) {
        throw new Error('invalid-avatar')
      }
      const choice = input as { kind?: unknown; avatar?: unknown; bytes?: unknown }
      let avatar = appState.config.avatar
      let avatarHash = ''
      if (choice.kind === 'preset') {
        if (!isAvatarPresetValue(choice.avatar)) {
          throw new Error('invalid-avatar')
        }
        avatar = choice.avatar
      } else if (choice.kind === 'custom') {
        if (!(choice.bytes instanceof ArrayBuffer) || choice.bytes.byteLength > AVATAR_MAX_BYTES) {
          throw new Error('invalid-avatar')
        }
        avatarHash = (await avatarStore.save(choice.bytes)) ?? ''
        if (!avatarHash) throw new Error('invalid-avatar')
      } else {
        throw new Error('invalid-avatar')
      }

      saveProfile(appState, {
        nick: appState.config.nick,
        company: appState.config.company,
        dept: appState.config.dept,
        team: appState.config.team,
        avatar,
        avatarHash,
        fileDir: appState.config.fileDir
      })
      if (db) {
        porter = new PorterService(
          db,
          appState.nodeId,
          appState.config.nick,
          importedMediaDir(),
          [imagesDir(), stickersDir()],
          avatarsDir(),
          appState.config.avatarHash
        )
      }
      discovery?.announceProfile()
      const view = broadcastSettings()
      if (avatarHash) broadcastAvatarReady(avatarHash)
      scheduleAvatarPrune()
      return view
    }
  )

  ipcMain.handle(IpcChannels.settingsPickDir, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件保存位置',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // ——— 我的文件柜（决议 #271/#276/#277）：ipc 层只做参数校验与转发，判定在 ShareService ———

  function shareGrantViews(): ShareGrantView[] {
    if (!share) return []
    return share.listGrants().map((g) => {
      const record = registry?.get(g.nodeId)
      return {
        nodeId: g.nodeId,
        name: resolvePeerDisplayName(g.nodeId) || g.nodeId.slice(0, 8),
        avatar: record?.profile.avatar ?? -1,
        avatarHash: record?.profile.avatarHash ?? '',
        online: record?.online === true,
        mode: g.mode
      }
    })
  }

  ipcMain.handle(
    IpcChannels.shareMySetRoot,
    async (event, clear: unknown): Promise<ShareRootPickResult> => {
      if (!appState) return { ok: false, reason: 'empty' }
      if (clear === true) {
        saveAppSettings(appState, {
          fileCabinet: { root: '', mode: appState.config.fileCabinet.mode }
        })
        return { ok: true, canceled: false, view: broadcastSettings() }
      }
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      if (!owner) return { ok: true, canceled: true }
      const result = await dialog.showOpenDialog(owner, {
        title: '选择共享给同事的目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true }
      const picked = result.filePaths[0]
      const check = evaluateShareRoot(picked, {
        home: app.getPath('home'),
        dataRoot: dataRoot()
      })
      if (!check.ok) return { ok: false, reason: check.reason }
      try {
        if (!statSync(check.path).isDirectory()) return { ok: false, reason: 'unreadable' }
        accessSync(check.path, fsConstants.R_OK)
      } catch {
        return { ok: false, reason: 'unreadable' }
      }
      saveAppSettings(appState, {
        fileCabinet: { root: check.path, mode: appState.config.fileCabinet.mode }
      })
      // 日志只记是否已设置，绝不记录共享根路径本身（决议 #6/#276）
      console.log('[share] 共享目录已设置')
      return { ok: true, canceled: false, view: broadcastSettings() }
    }
  )

  ipcMain.handle(IpcChannels.shareMySetMode, (_event, mode: unknown): SettingsView => {
    if (!appState || !isShareMode(mode)) return settingsView()
    saveAppSettings(appState, {
      fileCabinet: { root: appState.config.fileCabinet.root, mode }
    })
    return broadcastSettings()
  })

  ipcMain.handle(IpcChannels.shareMyReveal, (): boolean => {
    const root = appState?.config.fileCabinet.root ?? ''
    if (root.length === 0 || !existsSync(root)) return false
    shell.openPath(root).catch(() => undefined)
    return true
  })

  ipcMain.handle(IpcChannels.shareGrantList, (): ShareGrantView[] => shareGrantViews())

  ipcMain.handle(
    IpcChannels.shareGrantSet,
    (_event, nodeId: unknown, mode: unknown): ShareGrantView[] => {
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > LIMITS.id) {
        return shareGrantViews()
      }
      if (mode !== null && !isShareMode(mode)) return shareGrantViews()
      share?.setGrant(nodeId, mode)
      broadcastSettings() // grantCount 变了，设置页与主窗一起刷新
      return shareGrantViews()
    }
  )

  // ——— 对方的文件柜（决议 #273/#275）：浏览与下载 ———

  /** 入口前置条件：对端在线且声明 shr1，否则给出确定的原因而不是让用户干等超时 */
  function shareTargetIssue(peerId: unknown): ShareBrowseFailReason | null {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > LIMITS.id) {
      return 'offline'
    }
    const peer = registry?.get(peerId)
    if (!peer || !peer.online) return 'offline'
    if (!Array.isArray(peer.profile.caps) || !peer.profile.caps.includes(CAPS.fileCabinet)) {
      return 'unsupported'
    }
    return null
  }

  ipcMain.handle(
    IpcChannels.shareBrowse,
    async (
      _event,
      peerId: unknown,
      path: unknown,
      offset: unknown,
      snapshotId: unknown
    ): Promise<ShareBrowseResult> => {
      const issue = shareTargetIssue(peerId)
      if (issue) return { ok: false, reason: issue }
      if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > SHARE_PATH_MAX) {
        return { ok: false, reason: 'not-found' }
      }
      const start = typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
      const reply = await requestShare(peerId as string, {
        op: 'list',
        reqId: randomUUID(),
        path,
        offset: start,
        ...(typeof snapshotId === 'string' && snapshotId.length > 0 && snapshotId.length <= LIMITS.id
          ? { snapshotId }
          : {})
      })
      if (!reply) return { ok: false, reason: 'timeout' }
      if (reply.op === 'deny') return { ok: false, reason: reply.reason }
      if (reply.op !== 'list-ok') return { ok: false, reason: 'timeout' }
      return {
        ok: true,
        path: reply.path,
        perm: reply.perm,
        snapshotId: reply.snapshotId,
        offset: reply.offset,
        total: reply.total,
        truncated: reply.truncated,
        entries: reply.entries
      }
    }
  )

  ipcMain.handle(
    IpcChannels.shareDownload,
    async (
      event,
      peerId: unknown,
      paths: unknown,
      saveAs: unknown
    ): Promise<ShareDownloadResult> => {
      const issue = shareTargetIssue(peerId)
      if (issue) return { ok: false, reason: issue }
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > SHARE_GET_MAX_PATHS) {
        return { ok: false, reason: 'not-found' }
      }
      const clean: string[] = []
      for (const raw of paths) {
        if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'not-found' }
        if (Buffer.byteLength(raw, 'utf8') > SHARE_PATH_MAX) return { ok: false, reason: 'not-found' }
        clean.push(raw)
      }
      const target = peerId as string

      let saveDir = join(
        appState?.config.fileDir || defaultFileDir(),
        shareDownloadDirName(resolvePeerDisplayName(target) || target)
      )
      if (saveAs === true) {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
        if (!owner) return { ok: true, canceled: true }
        const picked = await dialog.showOpenDialog(owner, {
          title: '选择下载到哪个目录',
          properties: ['openDirectory', 'createDirectory']
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: true, canceled: true }
        saveDir = picked.filePaths[0]
      }

      // 先登记一次性授权再发请求：offer 可能在 sendReliable 的 ACK 之前就到（决议 #275）。
      // 句柄化后每次下载各管各的，连点两次不会互相顶掉落点（决议 #280）。
      const grant = shareDownloadGate.begin(target, saveDir, SHARE_GET_AUTH_TTL)
      const reqId = randomUUID()
      shareGetReq.set(target, reqId)
      const reply = await requestShare(target, { op: 'get', reqId, paths: clean })
      shareGetReq.delete(target)
      if (reply && reply.op === 'deny') {
        shareDownloadGate.cancel(grant)
        return { ok: false, reason: reply.reason }
      }
      // reply 为 null 有两种情况：传输已开始（授权被消费时提前唤醒）或对方没回应；
      // 本次授权还在说明确实没等到 offer。
      if (!reply && shareDownloadGate.isPending(grant)) {
        shareDownloadGate.cancel(grant)
        return { ok: false, reason: 'timeout' }
      }
      return { ok: true }
    }
  )

  ipcMain.handle(
    IpcChannels.shareUpload,
    async (
      event,
      peerId: unknown,
      localPaths: unknown,
      directory: unknown
    ): Promise<ShareUploadResult> => {
      const issue = shareTargetIssue(peerId)
      if (issue) return { ok: false, reason: issue === 'offline' ? 'offline' : 'unsupported' }
      const target = peerId as string

      let paths: string[]
      if (localPaths === null || localPaths === undefined) {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
        if (!owner) return { ok: true, canceled: true }
        const picked = await dialog.showOpenDialog(owner, {
          title: directory === true ? '选择要上传的文件夹' : '选择要上传的文件',
          properties: directory === true ? ['openDirectory'] : ['openFile', 'multiSelections']
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: true, canceled: true }
        paths = picked.filePaths
      } else {
        // 拖拽进来的路径必须先经 file:grant-paths 授权，规则同普通文件发送
        if (!Array.isArray(localPaths) || localPaths.length === 0 || localPaths.length > 100) {
          return { ok: false, reason: 'unreadable' }
        }
        if (!localPaths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 2048)) {
          return { ok: false, reason: 'unreadable' }
        }
        paths = localPaths as string[]
        if (!rendererPathGrants.consume(event.sender.id, paths)) {
          return { ok: false, reason: 'unreadable' }
        }
      }

      // 异步测算：整棵目录树的遍历不能占住主进程事件循环（决议 #278）
      const measured = await measureUploadPaths(paths)
      if (!measured) return { ok: false, reason: 'unreadable' }
      if (measured.totalSize > SHARE_PUT_MAX_BYTES) return { ok: false, reason: 'too-large' }
      const ok = await files?.offerSharePut(target, paths)
      if (!ok) return { ok: false, reason: 'rejected' }
      // 日志只记数量与字节数，不记文件名（决议 #6/#276）
      console.log(`[share] 上传已发起：${measured.fileCount} 项`)
      return { ok: true, fileCount: measured.fileCount }
    }
  )

  // 「最近有人放进来」（决议 #283）：只汇总已有传输记录，落盘目录经既有 file:reveal 打开
  ipcMain.handle(
    IpcChannels.shareRecentUploads,
    (_event, limit: unknown): ShareRecentUploadView[] => {
      const lim = typeof limit === 'number' && Number.isInteger(limit) ? limit : 10
      return (files?.listShareUploads(lim) ?? []).map((item) => {
        const record = registry?.get(item.peerId)
        return {
          transferId: item.transferId,
          nodeId: item.peerId,
          name: resolvePeerDisplayName(item.peerId) || item.peerId.slice(0, 8),
          avatar: record?.profile.avatar ?? -1,
          avatarHash: record?.profile.avatarHash ?? '',
          fileCount: item.fileCount,
          totalSize: item.totalSize,
          ts: item.ts
        }
      })
    }
  )

  ipcMain.handle(IpcChannels.filePick, async (event, directory: unknown): Promise<string[] | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: directory === true ? '选择要发送的文件夹' : '选择要发送的文件',
      properties: directory === true ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    rendererPathGrants.grant(event.sender.id, result.filePaths)
    return result.filePaths
  })

  ipcMain.handle(IpcChannels.imgPick, async (event, purpose: unknown): Promise<string[] | null> => {
    if (!mainWindow) return null
    if (purpose !== undefined && purpose !== 'sticker') return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: purpose === 'sticker' ? '选择要导入的表情' : '选择要发送的图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: IMAGE_PICKER_EXTENSIONS }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const paths = filterImagePickerPaths(result.filePaths)
    if (paths.length === 0) return null
    const grants = purpose === 'sticker' ? stickerImportPathGrants : rendererPathGrants
    grants.grant(event.sender.id, paths)
    return paths
  })

  ipcMain.handle(IpcChannels.fileGrantPaths, (event, paths: unknown): string[] => {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return []
    const cleanPaths = paths.filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && p.length < 2048 && existsSync(p)
    )
    if (cleanPaths.length === 0) return []
    rendererPathGrants.grant(event.sender.id, cleanPaths)
    return cleanPaths
  })

  ipcMain.handle(IpcChannels.fileOffer, async (event, peerId: unknown, paths: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return null
    if (!paths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 2048)) return null
    const cleanPaths = paths as string[]
    if (!rendererPathGrants.consume(event.sender.id, cleanPaths)) return null
    return (await files?.offerPaths(peerId, cleanPaths)) ?? null
  })

  ipcMain.handle(IpcChannels.fileDirect, async (_event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) {
      return false
    }
    return (await files?.requestDirect(transferId)) ?? false
  })

  ipcMain.handle(IpcChannels.groupFileOffer, async (event, groupId: unknown, paths: unknown) => {
    if (typeof groupId !== 'string' || groupId.length === 0 || groupId.length > 64) return null
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return null
    if (!paths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 2048)) return null
    const cleanPaths = paths as string[]
    if (!rendererPathGrants.consume(event.sender.id, cleanPaths)) return null
    return (await files?.offerGroupPaths(groupId, cleanPaths)) ?? null
  })

  ipcMain.handle(IpcChannels.fileAccept, async (_event, transferId: unknown, saveAs: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64 || !files) return false
    let dir: string | undefined
    if (saveAs === true && mainWindow) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '保存到…',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return false
      dir = result.filePaths[0]
    }
    return files.accept(transferId, dir)
  })

  ipcMain.handle(IpcChannels.fileDecline, async (_event, transferId: unknown) => {
    if (typeof transferId === 'string' && transferId.length <= 64) await files?.decline(transferId)
  })

  ipcMain.handle(IpcChannels.fileCancel, async (_event, transferId: unknown) => {
    if (typeof transferId === 'string' && transferId.length <= 64) await files?.cancel(transferId)
  })

  ipcMain.handle(IpcChannels.fileReveal, (_event, transferId: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64) return
    const view = files?.transferView(transferId)
    if (view?.savedPath) shell.showItemInFolder(view.savedPath)
  })

  ipcMain.handle(IpcChannels.transferGet, (_event, transferId: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64) return null
    return files?.transferView(transferId) ?? null
  })

  ipcMain.handle(IpcChannels.transferList, (_event, limit: unknown) => {
    const lim = typeof limit === 'number' && Number.isInteger(limit) ? limit : 30
    return files?.listTransfers(lim) ?? []
  })

  ipcMain.handle(
    IpcChannels.dataExport,
    async (_event, format: unknown, options: unknown): Promise<string | null> => {
      if (format !== 'backup' && format !== 'html' && format !== 'txt') return null
      if (!mainWindow || !porter) return null
      const fmt = format as ExportFormat
      const exportOptions = normalizeExportOptions(options)
      const ext = fmt === 'backup' ? 'pantry-bak' : fmt
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出聊天记录',
        defaultPath: `茶话间导出-${new Date().toISOString().slice(0, 10)}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      })
      if (result.canceled || !result.filePath) return null
      try {
        porter.export(fmt, result.filePath, exportOptions)
        return result.filePath
      } catch (err) {
        console.warn('[porter] 导出失败：', err)
        return null
      }
    }
  )

  ipcMain.handle(IpcChannels.dataImport, async (): Promise<DataImportResult | null> => {
    if (!mainWindow || !porter) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入聊天记录备份',
      properties: ['openFile'],
      filters: [{ name: 'Teahouse Backup', extensions: ['pantry-bak', 'zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      const imported = porter.importBackup(result.filePaths[0])
      if (appState && imported.profileAvatarHash) {
        saveProfile(appState, {
          nick: appState.config.nick,
          company: appState.config.company,
          dept: appState.config.dept,
          team: appState.config.team,
          avatar: appState.config.avatar,
          avatarHash: imported.profileAvatarHash,
          fileDir: appState.config.fileDir
        })
        discovery?.announceProfile()
        broadcastSettings()
        if (db) {
          porter = new PorterService(
            db,
            appState.nodeId,
            appState.config.nick,
            importedMediaDir(),
            [imagesDir(), stickersDir()],
            avatarsDir(),
            appState.config.avatarHash
          )
        }
      }
      chat?.emit('convs', chat.listConversations())
      avatars?.ensureAll()
      for (const hash of referencedAvatarHashes()) broadcastAvatarReady(hash)
      scheduleAvatarPrune()
      return imported
    } catch (err) {
      console.warn('[porter] 导入失败：', err)
      return null
    }
  })

  ipcMain.handle(
    IpcChannels.imgSendBytes,
    async (_event, peerId: unknown, name: unknown, bytes: unknown, tableText: unknown) => {
      return handleImageBytes(peerId, name, bytes, tableText, (targetId, paths, want, tableTextMeta) =>
        files?.offerPaths(targetId, paths, want, tableTextMeta)
      )
    }
  )

  ipcMain.handle(
    IpcChannels.groupImgSendBytes,
    async (_event, groupId: unknown, name: unknown, bytes: unknown, tableText: unknown) => {
      return handleImageBytes(groupId, name, bytes, tableText, (targetId, paths, want, tableTextMeta) =>
        files?.offerGroupPaths(targetId, paths, want, tableTextMeta)
      )
    }
  )

  ipcMain.handle(IpcChannels.imgOfferPath, async (event, peerId: unknown, path: unknown) => {
    return handleImagePath(event.sender.id, peerId, path, (targetId, paths, want) =>
      files?.offerPaths(targetId, paths, want)
    )
  })

  ipcMain.handle(IpcChannels.groupImgOfferPath, async (event, groupId: unknown, path: unknown) => {
    return handleImagePath(event.sender.id, groupId, path, (targetId, paths, want) =>
      files?.offerGroupPaths(targetId, paths, want)
    )
  })

  ipcMain.handle(IpcChannels.settingsSaveApp, (_event, patch: unknown): SettingsView => {
    if (appState && typeof patch === 'object' && patch !== null) {
      const p = patch as Record<string, unknown>
      const clean: AppSettingsPatch = {}
      const previousScanRanges = new Set(appState.config.scanRanges)
      if (typeof p.notifications === 'boolean') clean.notifications = p.notifications
      if (Array.isArray(p.manualPeers)) {
        clean.manualPeers = p.manualPeers
          .filter((s): s is string => typeof s === 'string')
          .slice(0, 100)
      }
      if (Array.isArray(p.scanRanges)) {
        clean.scanRanges = [
          ...new Set(
            p.scanRanges
              .filter((s): s is string => typeof s === 'string')
              .map((s) => normalizeCidr(s))
              .filter((s): s is string => typeof s === 'string')
          )
        ]
          .slice(0, 20)
      }
      const nextUdpPort = parsePortValue(p.udpPort)
      if (nextUdpPort !== null) clean.udpPort = nextUdpPort
      const nextTcpPort = parsePortValue(p.tcpPort)
      if (nextTcpPort !== null) clean.tcpPort = nextTcpPort
      if (typeof p.hideOnCapture === 'boolean') clean.hideOnCapture = p.hideOnCapture
      if (typeof p.autoLaunch === 'boolean') clean.autoLaunch = p.autoLaunch
      if (typeof p.closeToTray === 'boolean') clean.closeToTray = p.closeToTray
      if (p.theme === 'light' || p.theme === 'dark') clean.theme = p.theme
      if (p.fontScale === 100 || p.fontScale === 110 || p.fontScale === 125) {
        clean.fontScale = p.fontScale
      }
      if (typeof p.showMessagePreview === 'boolean') {
        clean.showMessagePreview = p.showMessagePreview
      }
      if (typeof p.allowDirectFileSend === 'boolean') {
        clean.allowDirectFileSend = p.allowDirectFileSend
      }
      if (p.sound === 'none' || p.sound === 'drop' || p.sound === 'wood' || p.sound === 'ding') {
        clean.sound = p.sound
      }
      if (p.sendKey === 'enter' || p.sendKey === 'ctrlEnter') clean.sendKey = p.sendKey
      const captureShortcut = normalizeShortcut(p.captureShortcut)
      if (captureShortcut !== null) clean.captureShortcut = captureShortcut
      const showHideShortcut = normalizeShortcut(p.showHideShortcut)
      if (showHideShortcut !== null) clean.showHideShortcut = showHideShortcut
      saveAppSettings(appState, clean)
      if (clean.scanRanges !== undefined) {
        const nextScanRanges = new Set(clean.scanRanges)
        for (const cidr of previousScanRanges) {
          if (!nextScanRanges.has(cidr)) {
            const timer = rangeScanTimers.get(cidr)
            if (timer) clearTimeout(timer)
            rangeScanTimers.delete(cidr)
          }
        }
        if (clean.scanRanges.some((cidr) => !previousScanRanges.has(cidr))) {
          rangeSync?.scheduleShareSoon()
        }
      }
      if (clean.autoLaunch !== undefined) applyAutoLaunch(clean.autoLaunch)
      if (clean.captureShortcut !== undefined || clean.showHideShortcut !== undefined) {
        registerGlobalShortcuts()
      }
      return broadcastSettings()
    }
    return settingsView()
  })

  const ADDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/

  ipcMain.handle(IpcChannels.netAddPeer, (_event, addr: unknown): boolean => {
    if (typeof addr !== 'string' || !appState) return false
    const m = ADDR_RE.exec(addr.trim())
    if (!m) return false
    const host = m[1]
    const port = m[2] ? Number(m[2]) : udpPort
    if (port < 1 || port > 65535) return false
    const normalized = m[2] ? `${host}:${port}` : host
    if (!appState.config.manualPeers.includes(normalized)) {
      saveAppSettings(appState, {
        manualPeers: [...appState.config.manualPeers, normalized].slice(0, 100)
      })
    }
    discovery?.probe(host, port) // 立即探测，秒回 alive 即上列表
    return true
  })

  ipcMain.handle(IpcChannels.netScan, (_event, cidr: unknown): number => {
    if (typeof cidr !== 'string' || !discovery) return -1
    const normalized = normalizeCidr(cidr)
    if (!normalized) return -1
    const hosts = parseCidr(normalized)
    if (!hosts) return -1
    return discovery.scanHosts(hosts, udpPort)
  })

  ipcMain.handle(IpcChannels.netScanAllRanges, (): ScanProgressView => startGlobalRangeScan())

  ipcMain.handle(IpcChannels.peersSetRemark, (_event, nodeId: unknown, remark: unknown) => {
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 64) return
    if (typeof remark !== 'string' || remark.length > 32) return
    const trimmed = remark.trim()
    peersRepo?.setRemark(nodeId, trimmed)
    if (trimmed) remarks.set(nodeId, trimmed)
    else remarks.delete(nodeId)
    broadcastEvent(IpcEvents.peersUpdated, peerViews())
  })

  ipcMain.handle(IpcChannels.uiOpenSettings, () => {
    openSettingsWindow(mainWindow, settingsView().fontScale)
  })

  // 文件柜（决议 #283，形态改为主窗页签见 #284）：把主窗切到文件柜页签，
  // 带 peerId 时直接定位到该同事的柜子。设置窗与托盘等非主窗调用方都走这里。
  ipcMain.handle(IpcChannels.uiOpenCabinet, (_event, peerId: unknown) => {
    const target =
      typeof peerId === 'string' && peerId.length > 0 && peerId.length <= LIMITS.id ? peerId : ''
    showMainWindow()
    mainWindow?.webContents.send(IpcEvents.cabinetFocusPeer, target)
  })

  ipcMain.handle(IpcChannels.imgOpenViewer, async (_event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length > 64) return false
    const media = await managedInlineImageView(transferId)
    if (!media) return false
    openImageViewerWindow(transferId, media.view.name)
    return true
  })

  ipcMain.handle(IpcChannels.imgFitViewerWindow, (event, width: unknown, height: unknown): number => {
    const viewerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!viewerWindow || viewerWindow === mainWindow) return 1
    if (!event.sender.getURL().includes('#/image-viewer?')) return 1
    const imageWidth = parseImageDimension(width)
    const imageHeight = parseImageDimension(height)
    if (!imageWidth || !imageHeight) return 1

    const display = screen.getDisplayMatching(viewerWindow.getBounds())
    const fit = fitImageViewerContent({
      imageWidth,
      imageHeight,
      workAreaWidth: display.workAreaSize.width,
      workAreaHeight: display.workAreaSize.height
    })

    if (viewerWindow.isMaximized()) viewerWindow.unmaximize()
    viewerWindow.setContentSize(fit.contentWidth, fit.contentHeight)
    viewerWindow.center()
    return fit.scale
  })

  ipcMain.handle(IpcChannels.imgOcrSource, async (event, transferId: unknown): Promise<ImageOcrSource | null> => {
    if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) return null
    if (!event.sender.getURL().includes('#/image-viewer?')) return null
    const media = await managedInlineImageView(transferId)
    if (!media) return null
    const { view } = media
    if (view.totalSize <= 0 || view.totalSize > IMAGE_SOURCE_MAX_BYTES) return null
    try {
      const buf = await readFile(view.savedPath)
      if (buf.length === 0 || buf.length > IMAGE_SOURCE_MAX_BYTES) return null
      if (!imagePreview.isInlineNamedBytes(view.savedPath, buf)) return null
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      return { name: view.name, size: buf.length, bytes }
    } catch {
      return null
    }
  })

  ipcMain.handle(IpcChannels.imgOcrResultGet, (event, transferId: unknown, cacheKey: unknown): ImageOcrResult | null => {
    if (typeof transferId !== 'string' || typeof cacheKey !== 'string') return null
    if (!event.sender.getURL().includes('#/image-viewer?')) return null
    if (!managedTransferMediaView(transferId)) return null
    return imageOcrCache.get(transferId, cacheKey)
  })

  ipcMain.handle(
    IpcChannels.imgOcrResultSet,
    (event, transferId: unknown, cacheKey: unknown, result: unknown): boolean => {
      if (typeof transferId !== 'string' || typeof cacheKey !== 'string') return false
      if (!event.sender.getURL().includes('#/image-viewer?')) return false
      const view = files?.transferView(transferId)
      if (!view?.savedPath || view.status !== 'done') return false
      return imageOcrCache.set(transferId, cacheKey, result)
    }
  )

  ipcMain.handle(
    IpcChannels.groupCreate,
    (
      _event,
      name: unknown,
      memberIds: unknown,
      adminPassword: unknown,
      adminHint: unknown
    ) => {
      if (typeof name !== 'string' || name.length > 32) return null
      if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > GROUP_MAX_MEMBERS) {
        return null
      }
      if (!memberIds.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 64)) {
        return null
      }
      const secret = typeof adminPassword === 'string' && adminPassword.length <= 64 ? adminPassword : ''
      const hint = typeof adminHint === 'string' && adminHint.length <= 40 ? adminHint : ''
      return groups?.createGroup(name, memberIds as string[], secret, hint) ?? null
    }
  )

  ipcMain.handle(IpcChannels.groupUpdate, (_event, groupId: unknown, patch: unknown) => {
    if (typeof groupId !== 'string' || groupId.length > 64) return null
    if (typeof patch !== 'object' || patch === null) return null
    const p = patch as Record<string, unknown>
    const password = (): string | undefined =>
      p.adminPassword === undefined
        ? undefined
        : typeof p.adminPassword === 'string' && p.adminPassword.length <= 64
          ? p.adminPassword
          : undefined
    const ids = (value: unknown): string[] | null =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= GROUP_MAX_MEMBERS &&
      value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
        ? (value as string[])
        : null
    const hasOnly = (keys: string[]): boolean => Object.keys(p).every((key) => keys.includes(key))
    let clean: GroupPatch
    if (
      p.kind === 'rename' &&
      hasOnly(['kind', 'name', 'adminPassword']) &&
      typeof p.name === 'string' &&
      p.name.length <= 32
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = { kind: 'rename', name: p.name, ...(adminPassword ? { adminPassword } : {}) }
    } else if (p.kind === 'invite' && hasOnly(['kind', 'memberIds'])) {
      const memberIds = ids(p.memberIds)
      if (!memberIds) return null
      clean = { kind: 'invite', memberIds }
    } else if (p.kind === 'remove' && hasOnly(['kind', 'memberIds', 'adminPassword'])) {
      const memberIds = ids(p.memberIds)
      const adminPassword = password()
      if (!memberIds || (p.adminPassword !== undefined && adminPassword === undefined)) return null
      clean = { kind: 'remove', memberIds, ...(adminPassword ? { adminPassword } : {}) }
    } else if (
      p.kind === 'set-avatar' &&
      hasOnly(['kind', 'avatarHash', 'adminPassword']) &&
      (p.avatarHash === '' || isAvatarHash(p.avatarHash))
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = {
        kind: 'set-avatar',
        avatarHash: p.avatarHash,
        ...(adminPassword ? { adminPassword } : {})
      }
    } else if (
      p.kind === 'set-admin' &&
      hasOnly(['kind', 'memberId', 'enabled']) &&
      typeof p.memberId === 'string' &&
      p.memberId.length > 0 &&
      p.memberId.length <= 64 &&
      typeof p.enabled === 'boolean'
    ) {
      clean = { kind: 'set-admin', memberId: p.memberId, enabled: p.enabled }
    } else if (
      p.kind === 'set-description' &&
      hasOnly(['kind', 'description', 'adminPassword']) &&
      typeof p.description === 'string' &&
      p.description.length <= LIMITS.groupDescription
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = { kind: 'set-description', description: p.description, ...(adminPassword ? { adminPassword } : {}) }
    } else if (
      p.kind === 'set-announce' &&
      hasOnly(['kind', 'announce', 'adminPassword']) &&
      typeof p.announce === 'string' &&
      p.announce.length <= LIMITS.groupAnnounce
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = { kind: 'set-announce', announce: p.announce, ...(adminPassword ? { adminPassword } : {}) }
    } else {
      return null
    }
    return groups?.updateGroup(groupId, clean) ?? null
  })

  ipcMain.handle(
    IpcChannels.groupSetAvatar,
    async (
      _event,
      groupId: unknown,
      bytes: unknown,
      adminPassword: unknown
    ) => {
      if (typeof groupId !== 'string' || groupId.length === 0 || groupId.length > LIMITS.id) {
        return null
      }
      if (
        adminPassword !== undefined &&
        (typeof adminPassword !== 'string' || adminPassword.length > LIMITS.groupAdminPassword)
      ) {
        return null
      }
      let avatarHash = ''
      if (bytes !== null) {
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > AVATAR_MAX_BYTES) return null
        avatarHash = (await avatarStore.save(bytes)) ?? ''
        if (!avatarHash) return null
      }
      const updated = groups?.updateGroup(groupId, {
        kind: 'set-avatar',
        avatarHash,
        ...(typeof adminPassword === 'string' && adminPassword
          ? { adminPassword }
          : {})
      }) ?? null
      if (updated && avatarHash) broadcastAvatarReady(avatarHash)
      scheduleAvatarPrune()
      return updated
    }
  )

  ipcMain.handle(IpcChannels.groupLeave, (_event, groupId: unknown) => {
    if (typeof groupId === 'string' && groupId.length <= 64) groups?.leaveGroup(groupId)
  })

  ipcMain.handle(IpcChannels.groupGet, (_event, groupId: unknown) => {
    if (typeof groupId !== 'string' || groupId.length > 64) return null
    return groups?.get(groupId) ?? null
  })

  ipcMain.handle(IpcChannels.groupList, () => groups?.list() ?? [])

  ipcMain.handle(IpcChannels.groupSend, (_event, groupId: unknown, text: unknown, mentions: unknown, replyTo: unknown) => {
    if (typeof groupId !== 'string' || groupId.length > 64) return null
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return null
    const cleanMentions =
      Array.isArray(mentions) && mentions.every((m) => typeof m === 'string' && m.length <= 64)
        ? (mentions as string[]).slice(0, GROUP_MAX_MEMBERS)
        : []
    // IPC 只允许携带源消息 ID；senderName/text 由主进程在当前群会话内查询生成
    const replyMeta: string | undefined =
        replyTo && typeof replyTo === 'string' && replyTo.length > 0 && replyTo.length <= LIMITS.id
        ? replyTo
        : undefined
    return groups?.sendText(groupId, text, cleanMentions, replyMeta) ?? null
  })

  ipcMain.handle(IpcChannels.captureStart, () => startCapture())

  ipcMain.handle(IpcChannels.captureReady, (event) => {
    showCaptureWindow(event.sender)
  })

  ipcMain.handle(IpcChannels.captureDone, (_event, bytes: unknown, send: unknown) => {
    closeCaptureWindow()
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return
    if (bytes.byteLength > 30 * 1024 * 1024) return
    if (!writeClipboardImage(bytes)) return // 始终进剪贴板（随处可贴）
    if (send === true && mainWindow) {
      showMainWindow({ forceForeground: true })
      mainWindow.webContents.send(IpcEvents.captured, bytes)
    }
  })

  ipcMain.handle(IpcChannels.clipboardWriteImage, (_event, bytes: unknown) => {
    if (!(bytes instanceof ArrayBuffer)) return false
    return writeClipboardImage(bytes)
  })

  ipcMain.handle(IpcChannels.clipboardReadImage, () => readClipboardImage())

  ipcMain.handle(IpcChannels.stickerFetchSource, async (_event, transferId: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64) return null
    const media = await managedInlineImageView(transferId)
    if (!media) return null
    return readStickerSource(media.view.savedPath)
  })

  ipcMain.handle(IpcChannels.stickerImportSource, async (event, pathValue: unknown) => {
    if (typeof pathValue !== 'string') return null
    const path = filterImagePickerPaths([pathValue])[0]
    if (!path || !stickerImportPathGrants.consume(event.sender.id, [path])) return null
    return readStickerSource(path)
  })

  ipcMain.handle(IpcChannels.imgThumbnailHas, async (_event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) {
      return false
    }
    if (!(await managedInlineImageView(transferId))) return false
    return imagePreview.hasThumbnail(transferId)
  })

  ipcMain.handle(
    IpcChannels.imgThumbnailCache,
    async (_event, transferId: unknown, bytes: unknown): Promise<boolean> => {
      if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) {
        return false
      }
      if (!(bytes instanceof ArrayBuffer)) return false
      const media = await managedInlineImageView(transferId)
      if (!media || media.animated) return false
      return imagePreview.cacheThumbnail(transferId, bytes)
    }
  )

  ipcMain.handle(
    IpcChannels.stickerAdd,
    (_event, bytes: unknown, ext: unknown, w: unknown, h: unknown) => {
      if (!stickerRepo) return null
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return null
      if (bytes.byteLength > 2 * 1024 * 1024) return null // GIF ≤2MB / 静图压缩后远小于此
      if (ext !== '.webp' && ext !== '.gif' && ext !== '.png') return null
      const width = typeof w === 'number' && w > 0 ? Math.round(w) : 0
      const height = typeof h === 'number' && h > 0 ? Math.round(h) : 0
      const id = randomUUID()
      mkdirSync(stickersDir(), { recursive: true })
      const path = join(stickersDir(), `${id}${ext}`)
      writeFileSync(path, Buffer.from(bytes))
      stickerRepo.insert(id, path, width, height, ext === '.gif')
      return { id, w: width, h: height, animated: ext === '.gif' }
    }
  )

  ipcMain.handle(IpcChannels.stickerList, () =>
    (stickerRepo?.list() ?? []).map((r) => ({
      id: r.id,
      w: r.w,
      h: r.h,
      animated: r.animated !== 0
    }))
  )

  ipcMain.handle(IpcChannels.stickerRemove, (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length > 64 || !stickerRepo) return
    const path = stickerRepo.remove(id)
    if (path && isPathInsideAny(path, managedStickerRoots())) rmSync(path, { force: true })
  })

  ipcMain.handle(IpcChannels.stickerReorder, (_event, ids: unknown) => {
    if (!stickerRepo || !Array.isArray(ids)) return []
    const clean = ids.filter((id): id is string => typeof id === 'string' && id.length <= 64)
    stickerRepo.reorder(clean)
    return stickerRepo.list().map((r) => ({
      id: r.id,
      w: r.w,
      h: r.h,
      animated: r.animated !== 0
    }))
  })

  ipcMain.handle(IpcChannels.stickerSend, async (_event, targetId: unknown, id: unknown, isGroup: unknown) => {
    if (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > 64) return null
    if (typeof id !== 'string' || id.length > 64 || !stickerRepo) return null
    if (typeof isGroup !== 'boolean') return null
    const row = stickerRepo.get(id)
    if (!row) return null
    if (!isPathInsideAny(row.path, managedStickerRoots())) return null
    return (
      (await (isGroup
        ? files?.offerGroupPaths(targetId, [row.path], 'sticker')
        : files?.offerPaths(targetId, [row.path], 'sticker'))) ?? null
    )
  })

  ipcMain.handle(IpcChannels.searchQuery, (_event, query: unknown) => {
    if (typeof query !== 'string' || query.length > 64 || !search) {
      return { peers: [], messageGroups: [], files: [] }
    }
    return search.query(query)
  })

  ipcMain.handle(IpcChannels.msgSearch, (_event, options: unknown) => {
    const clean = normalizeConversationSearch(options)
    if (!clean || !search) return []
    return search.conversation(clean)
  })

  ipcMain.handle(IpcChannels.msgContext, (_event, convId: unknown, seq: unknown) => {
    if (typeof convId !== 'string' || convId.length > 128 || !msgRepoRef) return []
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return []
    return msgRepoRef.around(convId, seq, 25).map(msgRowToView)
  })

  ipcMain.handle(IpcChannels.msgGet, (_event, msgId: unknown) => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > LIMITS.id || !msgRepoRef) return null
    const row = msgRepoRef.get(msgId)
    if (!row) return null
    return msgRowToView(row)
  })

  ipcMain.handle(IpcChannels.imgSaveAs, async (event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length > 64) return false
    const view = managedTransferMediaView(transferId)
    if (!view) return false
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined
    const options = {
      title: '图片另存为',
      defaultPath: basename(view.savedPath)
    }
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    try {
      await copyFile(view.savedPath, result.filePath)
      return true
    } catch (err) {
      console.warn('[files] 图片另存失败：', err)
      return false
    }
  })

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    void imagePreview.prune()
    const updateCaps = canAdvertiseUpdateSource() ? [CAPS.updateSource] : []
    appState = loadAppState(app.getPath('userData'), app.getVersion(), tcpPort, udpPort, [
      CAPS.mediaRecall,
      CAPS.fileDirect,
      CAPS.tableText,
      CAPS.transferWait,
      CAPS.groupRoles,
      CAPS.avatarImages,
      CAPS.fileCabinet,
      ...updateCaps
    ])
    udpPort = envUdpPort ?? appState.config.udpPort
    tcpPort = envTcpPort ?? appState.config.tcpPort
    netState.udpPort = udpPort
    appState.profile.tcpPort = tcpPort
    applyAutoLaunch(appState.config.autoLaunch)
    // 文件柜权限判定只依赖本机配置，库不可用时例外退化为内存态（决议 #271/#277）
    share = new ShareService({
      getRoot: () => appState?.config.fileCabinet.root ?? '',
      getDefaultMode: () => appState?.config.fileCabinet.mode ?? 'off',
      getGrants: () => shareGrantsRepo
    })

    // pantry-img://<transferId> —— 渲染层取图的唯一通道（绕开 file:// 的 CSP/安全限制，
    // 且只放行 transfers 表里登记过的路径，不开任意文件读取口子）
    protocol.registerFileProtocol('pantry-img', (request, callback) => {
      try {
        const transferId = new URL(request.url).hostname
        void managedInlineImageView(transferId)
          .then((media) => {
            callback(media ? { path: media.view.savedPath } : { error: -6 })
          })
          .catch(() => callback({ error: -6 }))
        return
      } catch {
        // fallthrough
      }
      callback({ error: -6 }) // net::ERR_FILE_NOT_FOUND
    })

    // pantry-thumb://<transferId> —— 仅服务可重建的受限派生缩略图；未命中安全回退原图。
    protocol.registerFileProtocol('pantry-thumb', (request, callback) => {
      try {
        const transferId = new URL(request.url).hostname
        void managedInlineImageView(transferId)
          .then(async (media) => {
            if (!media) {
              callback({ error: -6 })
              return
            }
            const path = await imagePreview.resolvePreviewPath(transferId, media.view.savedPath)
            callback(path ? { path } : { error: -6 })
          })
          .catch(() => callback({ error: -6 }))
        return
      } catch {
        // fallthrough
      }
      callback({ error: -6 })
    })

    // pantry-sticker://<id> —— 同理，只放行表情库登记过的路径
    protocol.registerFileProtocol('pantry-sticker', (request, callback) => {
      try {
        const id = new URL(request.url).hostname
        const row = stickerRepo?.get(id)
        if (row && isPathInsideAny(row.path, managedStickerRoots())) {
          callback({ path: row.path })
          return
        }
      } catch {
        // fallthrough
      }
      callback({ error: -6 })
    })

    // pantry-avatar://asset/<sha256> —— 只映射受管目录中的已校验 WebP，不暴露任意本地路径。
    protocol.registerFileProtocol('pantry-avatar', (request, callback) => {
      try {
        const hash = avatarHashFromUrl(request.url)
        if (!hash) {
          callback({ error: -6 })
          return
        }
        void avatarStore
          .resolvePath(hash)
          .then((path) => callback(path ? { path } : { error: -6 }))
          .catch(() => callback({ error: -6 }))
        return
      } catch {
        // fallthrough
      }
      callback({ error: -6 })
    })

    createMainWindow()
    tray = setupTray({
      showWindow: showMainWindow,
      quit: () => {
        isQuitting = true
        app.quit()
      }
    })
    void startNet()
    registerGlobalShortcuts()

    // 冒烟模式：窗口能起、1.5s 后干净退出即算通过（tech-design §10 的 CI 烟测同款）
    if (process.env['PANTRY_SMOKE']) {
      setTimeout(() => {
        isQuitting = true
        app.quit()
      }, 1500)
    }
  })

  app.on('activate', () => showMainWindow()) // macOS 点 Dock 唤起

  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.on('before-quit', () => {
    isQuitting = true
    stopTrayUnreadFlash(tray)
    rangeSync?.stop()
    rangeSync = null
    if (globalScanTimer) clearTimeout(globalScanTimer)
    globalScanTimer = null
    if (globalScanProgress.running) {
      globalScanProgress = {
        ...globalScanProgress,
        status: 'idle',
        running: false,
        finishedAt: Date.now()
      }
    }
    for (const timer of rangeScanTimers.values()) clearTimeout(timer)
    rangeScanTimers.clear()
    discovery?.stop() // 广播 + 单播 exit，让对端立刻变灰而不是等 90s 超时
    discovery = null
    if (pruneTimer) clearInterval(pruneTimer)
    if (persistTimer) clearTimeout(persistTimer)
    if (avatarPruneTimer) clearTimeout(avatarPruneTimer)
    void files?.stop()
    try {
      if (registry && peersRepo) peersRepo.upsertMany(registry.values()) // 离场前最后一次落库
      db?.close()
    } catch (err) {
      console.error('[store] 退出落库失败：', err)
    }
    db = null
  })

  // 所有窗口都关闭时退出；主窗关闭到托盘由 createMainWindow 的 close 事件拦截。
  app.on('window-all-closed', () => {
    app.quit()
  })
}
