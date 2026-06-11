import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, shell, type Tray } from 'electron'
import { release } from 'node:os'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import {
  IpcChannels,
  IpcEvents,
  type AppInfo,
  type MessageView,
  type NetState,
  type PeerView,
  type ProfileSubmit,
  type SettingsView
} from '../shared/ipc'
import { DEFAULT_TCP_PORT, DEFAULT_UDP_PORT, LIMITS } from '../shared/protocol'
import { loadAppState, saveProfile, type AppState } from './store/app-state'
import { setupTray } from './windows/tray'
import { TransferRepo } from './store/transfer-repo'
import { FilesService } from './services/files'
import { openDatabase, openMemoryDatabase, type AppDatabase } from './store/db'
import { PeersRepo } from './store/peers-repo'
import { ConvRepo } from './store/conv-repo'
import { MsgRepo } from './store/msg-repo'
import { QueueRepo } from './store/queue-repo'
import { DedupRepo } from './store/dedup-repo'
import { UdpChannel } from './net/udp'
import { PeerRegistry } from './net/peer-registry'
import { Discovery, type ManualPeer } from './net/discovery'
import { Messenger } from './net/messenger'
import { ChatService } from './services/chat'
import type { PeerRecord } from './net/peer-registry'

// Win7（NT 6.1）终端为统一 VM 部署，虚拟显卡驱动不可靠 —— 默认软渲染（tech-design §9）
if (process.platform === 'win32' && release().startsWith('6.1')) {
  app.disableHardwareAcceleration()
}

// 本机双实例联调：PANTRY_USER_DATA 隔离数据目录（同时绕开单实例锁），见 README「开发」
if (process.env['PANTRY_USER_DATA']) {
  app.setPath('userData', resolve(process.env['PANTRY_USER_DATA']))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  // ---- 网络栈（端口可被环境变量覆盖，便于联调；正式配置入设置页后接管） ----
  const udpPort = Number(process.env['PANTRY_UDP_PORT']) || DEFAULT_UDP_PORT
  const tcpPort = Number(process.env['PANTRY_TCP_PORT']) || DEFAULT_TCP_PORT
  const manualPeers: ManualPeer[] = (process.env['PANTRY_PEERS'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const [host, port] = item.split(':')
      return { host, port: Number(port) || DEFAULT_UDP_PORT }
    })

  const netState: NetState = { ok: false, udpPort, error: '' }
  let discovery: Discovery | null = null
  let registry: PeerRegistry | null = null
  let db: AppDatabase | null = null
  let peersRepo: PeersRepo | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let chat: ChatService | null = null
  let files: FilesService | null = null
  let pruneTimer: ReturnType<typeof setInterval> | null = null
  let appState: AppState | null = null
  let tray: Tray | null = null
  let isQuitting = false

  function showMainWindow(): void {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  function toPeerView(record: PeerRecord): PeerView {
    return {
      nodeId: record.profile.nodeId,
      nick: record.profile.nick,
      company: record.profile.company,
      dept: record.profile.dept,
      team: record.profile.team,
      avatar: record.profile.avatar,
      host: record.profile.host,
      platform: record.profile.platform,
      ip: record.ip,
      online: record.online,
      lastSeen: record.lastSeen
    }
  }

  function peerViews(): PeerView[] {
    return registry ? registry.list().map(toPeerView) : []
  }

  async function startNet(): Promise<void> {
    const state = appState
    if (!state) return
    const udp = new UdpChannel({ port: udpPort })
    registry = new PeerRegistry(state.nodeId)
    discovery = new Discovery({ udp, registry, profile: state.profile, manualPeers })

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
      registry.seed(peersRepo.loadAll()) // 历史联系人以离线态回灌（F-DISC-7）

      const messenger = new Messenger({
        udp,
        registry,
        selfId: state.nodeId,
        queue: new QueueRepo(db),
        dedup: new DedupRepo(db)
      })
      chat = new ChatService({
        selfId: state.nodeId,
        convRepo: new ConvRepo(db),
        msgRepo: new MsgRepo(db),
        messenger,
        probe: (peerId) => {
          discovery?.probeNode(peerId) // 打开会话 → 探活（F-DISC-8）
        }
      })
      const onMessage = (msg: MessageView): void => {
        mainWindow?.webContents.send(IpcEvents.msgNew, msg)
        notifyIncoming(msg)
      }
      const onStatus = (ev: unknown): void => {
        mainWindow?.webContents.send(IpcEvents.msgStatus, ev)
      }
      const onConvs = (convs: Array<{ unread: number }>): void => {
        mainWindow?.webContents.send(IpcEvents.convsUpdated, convs)
        const total = convs.reduce((sum, c) => sum + c.unread, 0)
        if (process.platform === 'darwin') app.dock?.setBadge(total > 0 ? String(total) : '')
      }
      chat.on('message', onMessage)
      chat.on('status', onStatus)
      chat.on('convs', onConvs)

      files = new FilesService({
        selfId: state.nodeId,
        messenger,
        registry,
        convRepo: new ConvRepo(db),
        msgRepo: new MsgRepo(db),
        transferRepo: new TransferRepo(db),
        tcpPort,
        getSaveDir: () =>
          appState?.config.fileDir || join(app.getPath('downloads'), '茶话间'),
        getImagesDir: () => join(app.getPath('userData'), 'data', 'images')
      })
      files.on('message', onMessage)
      files.on('status', onStatus)
      files.on('convs', onConvs)
      files.on('transfer', (view) => mainWindow?.webContents.send(IpcEvents.transferUpdated, view))
      try {
        await files.start() // TCP 数据端口
      } catch (err) {
        console.error('[files] TCP 端口监听失败，文件发送可用但无法被拉取：', err)
      }
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
        mainWindow?.webContents.send(IpcEvents.peersUpdated, peerViews())
      }, 200)
      // 落库节流 1s：≤1000 行整表 upsert 在事务内毫秒级
      if (!persistTimer) {
        persistTimer = setTimeout(() => {
          persistTimer = null
          if (registry && peersRepo) peersRepo.upsertMany(registry.list())
        }, 1000)
      }
    })

    try {
      await udp.start()
      discovery.start()
      netState.ok = true
    } catch (err) {
      // 端口被占等启动失败：进"离线模式"，窗口照常可用（tech-design §2）
      netState.ok = false
      netState.error = err instanceof Error ? err.message : String(err)
      console.error('[net] UDP 启动失败，进入离线模式：', netState.error)
    }
    mainWindow?.webContents.send(IpcEvents.netState, netState)
  }

  /** 新消息系统通知（F-SYS-2）：窗口聚焦时不打扰（应用内角标已可见）；点击直达会话 */
  function notifyIncoming(msg: MessageView): void {
    if (msg.isMine) return
    if (appState && appState.config.notifications === false) return
    if (mainWindow && mainWindow.isFocused() && mainWindow.isVisible()) return
    if (!Notification.isSupported()) return

    const nick = registry?.get(msg.senderId)?.profile.nick ?? '新消息'
    const body = msg.text.length > 60 ? `${msg.text.slice(0, 60)}…` : msg.text
    const notification = new Notification({ title: nick, body, silent: true }) // 决议：默认静音
    notification.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send(IpcEvents.openConv, msg.convId)
    })
    notification.show()
    if (process.platform === 'win32') mainWindow?.flashFrame(true) // 任务栏闪烁提醒
  }

  function createMainWindow(): void {
    mainWindow = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: '茶话间',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    // 安全红线（README）：不放行任何窗口内导航与新窗口
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

    mainWindow.once('ready-to-show', () => mainWindow?.show())
    // 关窗 = 进托盘常驻（F-SYS-1）；托盘不可用的桌面环境降级为直接退出
    mainWindow.on('close', (event) => {
      if (isQuitting || !tray) return
      event.preventDefault()
      mainWindow?.hide()
    })
    mainWindow.on('focus', () => mainWindow?.flashFrame(false))
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
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
      platform: process.platform
    }
  })

  ipcMain.handle(IpcChannels.netState, (): NetState => netState)

  ipcMain.handle(IpcChannels.peersList, (): PeerView[] => peerViews())

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

  function settingsView(): SettingsView {
    const c = appState?.config
    return {
      nick: c?.nick ?? '',
      company: c?.company ?? '',
      dept: c?.dept ?? '',
      team: c?.team ?? '',
      setupDone: c?.setupDone ?? true,
      fileDir: c?.fileDir ?? '',
      defaultFileDir: join(app.getPath('downloads'), '茶话间')
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
      typeof s.fileDir === 'string' &&
      s.fileDir.length <= 1024
    )
  }

  ipcMain.handle(IpcChannels.settingsGet, (): SettingsView => settingsView())

  ipcMain.handle(IpcChannels.settingsSaveProfile, (_event, submit: unknown): SettingsView => {
    if (appState && isValidSubmit(submit)) {
      saveProfile(appState, {
        nick: submit.nick.trim(),
        company: submit.company.trim(),
        dept: submit.dept.trim(),
        team: submit.team.trim(),
        fileDir: submit.fileDir.trim()
      })
      discovery?.announceProfile() // 资料变更即时广播（F-DISC-7 的发送侧）
    }
    return settingsView()
  })

  ipcMain.handle(IpcChannels.settingsPickDir, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件保存位置',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IpcChannels.filePick, async (_event, directory: unknown): Promise<string[] | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: directory === true ? '选择要发送的文件夹' : '选择要发送的文件',
      properties: directory === true ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
  })

  ipcMain.handle(IpcChannels.fileOffer, async (_event, peerId: unknown, paths: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return null
    if (!paths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 2048)) return null
    return (await files?.offerPaths(peerId, paths as string[])) ?? null
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

  const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

  ipcMain.handle(
    IpcChannels.imgSendBytes,
    async (_event, peerId: unknown, name: unknown, bytes: unknown) => {
      if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
      if (typeof name !== 'string' || name.length === 0 || name.length > 128) return null
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return null
      if (bytes.byteLength > 20 * 1024 * 1024) return null
      const ext = IMG_EXTS.has(extname(name).toLowerCase()) ? extname(name).toLowerCase() : '.png'
      const dir = join(app.getPath('userData'), 'data', 'images', 'out')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${randomUUID()}${ext}`)
      writeFileSync(path, Buffer.from(bytes))
      return (await files?.offerPaths(peerId, [path], true)) ?? null
    }
  )

  ipcMain.handle(IpcChannels.imgOfferPath, async (_event, peerId: unknown, path: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    if (typeof path !== 'string' || path.length === 0 || path.length > 2048) return null
    if (!IMG_EXTS.has(extname(path).toLowerCase())) return null
    return (await files?.offerPaths(peerId, [path], true)) ?? null
  })

  ipcMain.handle(IpcChannels.imgSaveAs, async (_event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length > 64 || !mainWindow) return false
    const view = files?.transferView(transferId)
    if (!view?.savedPath) return false
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '图片另存为',
      defaultPath: basename(view.savedPath)
    })
    if (result.canceled || !result.filePath) return false
    try {
      copyFileSync(view.savedPath, result.filePath)
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
    appState = loadAppState(app.getPath('userData'), app.getVersion(), tcpPort)

    // pantry-img://<transferId> —— 渲染层取图的唯一通道（绕开 file:// 的 CSP/安全限制，
    // 且只放行 transfers 表里登记过的路径，不开任意文件读取口子）
    protocol.registerFileProtocol('pantry-img', (request, callback) => {
      try {
        const transferId = new URL(request.url).hostname
        const view = files?.transferView(transferId)
        if (view?.savedPath) {
          callback({ path: view.savedPath })
          return
        }
      } catch {
        // fallthrough
      }
      callback({ error: -6 }) // net::ERR_FILE_NOT_FOUND
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

    // 冒烟模式：窗口能起、1.5s 后干净退出即算通过（tech-design §10 的 CI 烟测同款）
    if (process.env['PANTRY_SMOKE']) {
      setTimeout(() => {
        isQuitting = true
        app.quit()
      }, 1500)
    }
  })

  app.on('activate', () => showMainWindow()) // macOS 点 Dock 唤起

  app.on('before-quit', () => {
    isQuitting = true
    discovery?.stop() // 广播 + 单播 exit，让对端立刻变灰而不是等 90s 超时
    discovery = null
    if (pruneTimer) clearInterval(pruneTimer)
    if (persistTimer) clearTimeout(persistTimer)
    void files?.stop()
    try {
      if (registry && peersRepo) peersRepo.upsertMany(registry.list()) // 离场前最后一次落库
      db?.close()
    } catch (err) {
      console.error('[store] 退出落库失败：', err)
    }
    db = null
  })

  // v0.1 尚未实现托盘常驻：关窗即退出；托盘落地后改为隐藏到托盘
  app.on('window-all-closed', () => {
    app.quit()
  })
}
