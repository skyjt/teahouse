import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  IpcEvents,
  type AppInfo,
  type AppSettingsPatch,
  type AvatarSourcePick,
  type ConversationMessageHit,
  type ConversationSearchOptions,
  type ConversationView,
  type CaptureFailureNotice,
  type DataExportOptions,
  type DataImportResult,
  type ExportFormat,
  type ForwardResult,
  type ForwardTarget,
  type GroupPatch,
  type GroupView,
  type ImageOcrResult,
  type ImageOcrSource,
  type ImageSourceBytes,
  type MessageView,
  type MsgStatusEvent,
  type NetState,
  type NudgeEvent,
  type NudgeResult,
  type PantryApi,
  type PeerView,
  type ProfileSubmit,
  type ProfileAvatarChoice,
  type SearchResult,
  type ScanProgressView,
  type SettingsView,
  type ShareBrowseResult,
  type ShareDownloadResult,
  type ShareGrantView,
  type ShareRecentUploadView,
  type ShareRootPickResult,
  type ShareUploadResult,
  type StickerView,
  type TableTextMeta,
  type TransferView,
  type UpdateAvailability
} from '../shared/ipc'
import type { ShareMode } from '../shared/protocol'
import { createCaptureInitReplay } from './capture-init-replay'

function subscribe<T>(channel: string, listener: (data: T) => void): () => void {
  const wrapped = (_event: unknown, data: T): void => listener(data)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

// preload 早于 renderer 动态入口执行，先缓存截图初始化，避免 CaptureApp 晚订阅丢事件（决议 #218）。
const captureInitReplay = createCaptureInitReplay()
ipcRenderer.on(IpcEvents.captureInit, (_event, pngBytes: ArrayBuffer) => {
  captureInitReplay.publish(pngBytes)
})

// 渲染进程一切能力的唯一入口（tech-design §2 安全基线：sandbox + contextBridge）
const api: PantryApi = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannels.appInfo),
  openUrl: (url: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.appOpenUrl, url),
  getNetState: (): Promise<NetState> => ipcRenderer.invoke(IpcChannels.netState),
  getPeers: (): Promise<PeerView[]> => ipcRenderer.invoke(IpcChannels.peersList),
  checkUpdate: (): Promise<UpdateAvailability | null> => ipcRenderer.invoke(IpcChannels.updateCheck),
  requestUpdate: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.updateRequest),
  probePeer: (nodeId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.peersProbe, nodeId),
  listConversations: (): Promise<ConversationView[]> => ipcRenderer.invoke(IpcChannels.convList),
  openConversation: (peerNodeId: string): Promise<ConversationView | null> =>
    ipcRenderer.invoke(IpcChannels.convOpen, peerNodeId),
  markRead: (convId: string): Promise<void> => ipcRenderer.invoke(IpcChannels.convMarkRead, convId),
  pinConversation: (convId: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.convPin, convId, pinned),
  muteConversation: (convId: string, muted: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.convMute, convId, muted),
  removeConversation: (convId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.convRemove, convId),
  pageMessages: (convId: string, beforeSeq: number | null, limit?: number): Promise<MessageView[]> =>
    ipcRenderer.invoke(IpcChannels.msgPage, convId, beforeSeq, limit),
  sendText: (peerNodeId: string, text: string): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.msgSend, peerNodeId, text),
  resendMessage: (msgId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.msgResend, msgId),
  recallMessage: (msgId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.msgRecall, msgId),
  sendNudge: (peerNodeId: string): Promise<NudgeResult> =>
    ipcRenderer.invoke(IpcChannels.msgNudge, peerNodeId),
  sendPk: (convId, game) => ipcRenderer.invoke(IpcChannels.msgPk, convId, game),
  forwardMessage: (msgId: string, targets: ForwardTarget[]): Promise<ForwardResult> =>
    ipcRenderer.invoke(IpcChannels.msgForward, msgId, targets),
  getSettings: (): Promise<SettingsView> => ipcRenderer.invoke(IpcChannels.settingsGet),
  saveProfile: (submit: ProfileSubmit): Promise<SettingsView> =>
    ipcRenderer.invoke(IpcChannels.settingsSaveProfile, submit),
  pickAvatarSource: (): Promise<AvatarSourcePick | null> =>
    ipcRenderer.invoke(IpcChannels.avatarPickSource),
  setProfileAvatar: (choice: ProfileAvatarChoice): Promise<SettingsView> =>
    ipcRenderer.invoke(IpcChannels.profileSetAvatar, choice),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.settingsPickDir),
  pickFiles: (directory: boolean): Promise<string[] | null> =>
    ipcRenderer.invoke(IpcChannels.filePick, directory),
  pickImages: (): Promise<string[] | null> => ipcRenderer.invoke(IpcChannels.imgPick),
  grantFilePaths: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.fileGrantPaths, paths),
  offerFiles: (peerNodeId: string, paths: string[]): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.fileOffer, peerNodeId, paths),
  directTransfer: (transferId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.fileDirect, transferId),
  offerGroupFiles: (groupId: string, paths: string[]): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.groupFileOffer, groupId, paths),
  acceptTransfer: (transferId: string, saveAs: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.fileAccept, transferId, saveAs),
  declineTransfer: (transferId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.fileDecline, transferId),
  cancelTransfer: (transferId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.fileCancel, transferId),
  revealTransfer: (transferId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.fileReveal, transferId),
  getTransfer: (transferId: string): Promise<TransferView | null> =>
    ipcRenderer.invoke(IpcChannels.transferGet, transferId),
  listTransfers: (limit?: number): Promise<TransferView[]> =>
    ipcRenderer.invoke(IpcChannels.transferList, limit),
  exportData: (format: ExportFormat, options?: DataExportOptions): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.dataExport, format, options),
  importData: (): Promise<DataImportResult | null> => ipcRenderer.invoke(IpcChannels.dataImport),
  sendImageBytes: (
    peerNodeId: string,
    name: string,
    bytes: ArrayBuffer,
    tableText?: TableTextMeta
  ): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.imgSendBytes, peerNodeId, name, bytes, tableText),
  offerImagePath: (peerNodeId: string, path: string): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.imgOfferPath, peerNodeId, path),
  sendGroupImageBytes: (
    groupId: string,
    name: string,
    bytes: ArrayBuffer,
    tableText?: TableTextMeta
  ): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.groupImgSendBytes, groupId, name, bytes, tableText),
  offerGroupImagePath: (groupId: string, path: string): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.groupImgOfferPath, groupId, path),
  openImageViewer: (transferId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.imgOpenViewer, transferId),
  fitImageViewerWindow: (width: number, height: number): Promise<number> =>
    ipcRenderer.invoke(IpcChannels.imgFitViewerWindow, width, height),
  getImageOcrSource: (transferId: string): Promise<ImageOcrSource | null> =>
    ipcRenderer.invoke(IpcChannels.imgOcrSource, transferId),
  getImageOcrResult: (transferId: string, cacheKey: string): Promise<ImageOcrResult | null> =>
    ipcRenderer.invoke(IpcChannels.imgOcrResultGet, transferId, cacheKey),
  saveImageOcrResult: (
    transferId: string,
    cacheKey: string,
    result: ImageOcrResult
  ): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.imgOcrResultSet, transferId, cacheKey, result),
  saveImageAs: (transferId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.imgSaveAs, transferId),
  hasImageThumbnail: (transferId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.imgThumbnailHas, transferId),
  cacheImageThumbnail: (transferId: string, bytes: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.imgThumbnailCache, transferId, bytes),
  search: (query: string): Promise<SearchResult> =>
    ipcRenderer.invoke(IpcChannels.searchQuery, query),
  searchMessages: (options: ConversationSearchOptions): Promise<ConversationMessageHit[]> =>
    ipcRenderer.invoke(IpcChannels.msgSearch, options),
  getMessageContext: (convId: string, seq: number): Promise<MessageView[]> =>
    ipcRenderer.invoke(IpcChannels.msgContext, convId, seq),
  saveAppSettings: (patch: AppSettingsPatch): Promise<SettingsView> =>
    ipcRenderer.invoke(IpcChannels.settingsSaveApp, patch),
  setShareRoot: (clear?: boolean): Promise<ShareRootPickResult> =>
    ipcRenderer.invoke(IpcChannels.shareMySetRoot, clear === true),
  setShareMode: (mode: ShareMode): Promise<SettingsView> =>
    ipcRenderer.invoke(IpcChannels.shareMySetMode, mode),
  revealShareRoot: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.shareMyReveal),
  listShareGrants: (): Promise<ShareGrantView[]> =>
    ipcRenderer.invoke(IpcChannels.shareGrantList),
  setShareGrant: (nodeId: string, mode: ShareMode | null): Promise<ShareGrantView[]> =>
    ipcRenderer.invoke(IpcChannels.shareGrantSet, nodeId, mode),
  browseShare: (
    peerId: string,
    path: string,
    offset: number,
    snapshotId?: string
  ): Promise<ShareBrowseResult> =>
    ipcRenderer.invoke(IpcChannels.shareBrowse, peerId, path, offset, snapshotId),
  downloadShare: (
    peerId: string,
    paths: string[],
    saveAs?: boolean
  ): Promise<ShareDownloadResult> =>
    ipcRenderer.invoke(IpcChannels.shareDownload, peerId, paths, saveAs === true),
  uploadShare: (
    peerId: string,
    localPaths?: string[],
    directory?: boolean
  ): Promise<ShareUploadResult> =>
    ipcRenderer.invoke(IpcChannels.shareUpload, peerId, localPaths ?? null, directory === true),
  listRecentShareUploads: (limit?: number): Promise<ShareRecentUploadView[]> =>
    ipcRenderer.invoke(IpcChannels.shareRecentUploads, limit ?? 10),
  addManualPeer: (addr: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.netAddPeer, addr),
  scanRange: (cidr: string): Promise<number> => ipcRenderer.invoke(IpcChannels.netScan, cidr),
  scanAllRanges: (): Promise<ScanProgressView> =>
    ipcRenderer.invoke(IpcChannels.netScanAllRanges),
  setPeerRemark: (nodeId: string, remark: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.peersSetRemark, nodeId, remark),
  openSettings: (): Promise<void> => ipcRenderer.invoke(IpcChannels.uiOpenSettings),
  openCabinet: (peerId?: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.uiOpenCabinet, peerId ?? null),
  createGroup: (
    name: string,
    memberIds: string[],
    adminPassword?: string,
    adminHint?: string
  ): Promise<GroupView | null> =>
    ipcRenderer.invoke(IpcChannels.groupCreate, name, memberIds, adminPassword, adminHint),
  updateGroup: (groupId: string, patch: GroupPatch): Promise<GroupView | null> =>
    ipcRenderer.invoke(IpcChannels.groupUpdate, groupId, patch),
  setGroupAvatar: (
    groupId: string,
    bytes: ArrayBuffer | null,
    adminPassword?: string
  ): Promise<GroupView | null> =>
    ipcRenderer.invoke(IpcChannels.groupSetAvatar, groupId, bytes, adminPassword),
  leaveGroup: (groupId: string): Promise<void> => ipcRenderer.invoke(IpcChannels.groupLeave, groupId),
  getGroup: (groupId: string): Promise<GroupView | null> =>
    ipcRenderer.invoke(IpcChannels.groupGet, groupId),
  listGroups: (): Promise<GroupView[]> => ipcRenderer.invoke(IpcChannels.groupList),
  sendGroupText: (groupId: string, text: string, mentions?: string[]): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.groupSend, groupId, text, mentions),
  startCapture: (): Promise<void> => ipcRenderer.invoke(IpcChannels.captureStart),
  captureReady: (): Promise<void> => ipcRenderer.invoke(IpcChannels.captureReady),
  captureDone: (bytes: ArrayBuffer, send: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.captureDone, bytes, send),
  writeImageToClipboard: (bytes: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.clipboardWriteImage, bytes),
  readImageFromClipboard: (): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke(IpcChannels.clipboardReadImage),
  fetchStickerSource: (transferId: string): Promise<ImageSourceBytes | null> =>
    ipcRenderer.invoke(IpcChannels.stickerFetchSource, transferId),
  addSticker: (bytes: ArrayBuffer, ext: string, w: number, h: number): Promise<StickerView | null> =>
    ipcRenderer.invoke(IpcChannels.stickerAdd, bytes, ext, w, h),
  listStickers: (): Promise<StickerView[]> => ipcRenderer.invoke(IpcChannels.stickerList),
  removeSticker: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannels.stickerRemove, id),
  reorderStickers: (ids: string[]): Promise<StickerView[]> =>
    ipcRenderer.invoke(IpcChannels.stickerReorder, ids),
  sendSticker: (peerNodeId: string, stickerId: string): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.stickerSend, peerNodeId, stickerId),
  onPeersUpdated: (listener) => subscribe<PeerView[]>(IpcEvents.peersUpdated, listener),
  onUpdateAvailable: (listener) =>
    subscribe<UpdateAvailability | null>(IpcEvents.updateAvailable, listener),
  onMsgNew: (listener) => subscribe<MessageView>(IpcEvents.msgNew, listener),
  onMsgStatus: (listener) => subscribe<MsgStatusEvent>(IpcEvents.msgStatus, listener),
  onNudgeReceived: (listener) => subscribe<NudgeEvent>(IpcEvents.nudgeReceived, listener),
  onConvsUpdated: (listener) => subscribe<ConversationView[]>(IpcEvents.convsUpdated, listener),
  onTransferUpdated: (listener) => subscribe<TransferView>(IpcEvents.transferUpdated, listener),
  onGroupUpdated: (listener) => subscribe<GroupView>(IpcEvents.groupUpdated, listener),
  onCaptureInit: (listener) => captureInitReplay.subscribe(listener),
  onCaptured: (listener) => subscribe<ArrayBuffer>(IpcEvents.captured, listener),
  onCaptureFailed: (listener) =>
    subscribe<CaptureFailureNotice>(IpcEvents.captureFailed, listener),
  onOpenConv: (listener) => subscribe<string>(IpcEvents.openConv, listener),
  onSettingsUpdated: (listener) => subscribe<SettingsView>(IpcEvents.settingsUpdated, listener),
  onAvatarReady: (listener) => subscribe<string>(IpcEvents.avatarReady, listener),
  onSettingsWindowState: (listener) =>
    subscribe<boolean>(IpcEvents.settingsWindowState, listener),
  onCabinetFocusPeer: (listener) => subscribe<string>(IpcEvents.cabinetFocusPeer, listener),
  onScanProgress: (listener) => subscribe<ScanProgressView>(IpcEvents.netScanProgress, listener),
  onClipboardPasteImage: (listener): (() => void) =>
    subscribe<void>(IpcEvents.clipboardPasteImage, listener),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winMinimize),
  toggleMaximizeWindow: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.winToggleMaximize),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.winIsMaximized),
  onWinMaximizeChanged: (listener) => subscribe<boolean>(IpcEvents.winMaximizeChanged, listener),
  beginWindowDrag: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winBeginDrag),
  endWindowDrag: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winEndDrag),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winClose)
}

contextBridge.exposeInMainWorld('pantry', api)
