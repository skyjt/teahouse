import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  IpcEvents,
  type AppInfo,
  type ConversationView,
  type MessageView,
  type MsgStatusEvent,
  type NetState,
  type PantryApi,
  type PeerView,
  type ProfileSubmit,
  type SettingsView,
  type TransferView
} from '../shared/ipc'

function subscribe<T>(channel: string, listener: (data: T) => void): () => void {
  const wrapped = (_event: unknown, data: T): void => listener(data)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

// 渲染进程一切能力的唯一入口（tech-design §2 安全基线：sandbox + contextBridge）
const api: PantryApi = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannels.appInfo),
  getNetState: (): Promise<NetState> => ipcRenderer.invoke(IpcChannels.netState),
  getPeers: (): Promise<PeerView[]> => ipcRenderer.invoke(IpcChannels.peersList),
  probePeer: (nodeId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.peersProbe, nodeId),
  listConversations: (): Promise<ConversationView[]> => ipcRenderer.invoke(IpcChannels.convList),
  openConversation: (peerNodeId: string): Promise<ConversationView | null> =>
    ipcRenderer.invoke(IpcChannels.convOpen, peerNodeId),
  markRead: (convId: string): Promise<void> => ipcRenderer.invoke(IpcChannels.convMarkRead, convId),
  pageMessages: (convId: string, beforeSeq: number | null, limit?: number): Promise<MessageView[]> =>
    ipcRenderer.invoke(IpcChannels.msgPage, convId, beforeSeq, limit),
  sendText: (peerNodeId: string, text: string): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.msgSend, peerNodeId, text),
  resendMessage: (msgId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.msgResend, msgId),
  getSettings: (): Promise<SettingsView> => ipcRenderer.invoke(IpcChannels.settingsGet),
  saveProfile: (submit: ProfileSubmit): Promise<SettingsView> =>
    ipcRenderer.invoke(IpcChannels.settingsSaveProfile, submit),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.settingsPickDir),
  pickFiles: (directory: boolean): Promise<string[] | null> =>
    ipcRenderer.invoke(IpcChannels.filePick, directory),
  offerFiles: (peerNodeId: string, paths: string[]): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.fileOffer, peerNodeId, paths),
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
  sendImageBytes: (peerNodeId: string, name: string, bytes: ArrayBuffer): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.imgSendBytes, peerNodeId, name, bytes),
  offerImagePath: (peerNodeId: string, path: string): Promise<MessageView | null> =>
    ipcRenderer.invoke(IpcChannels.imgOfferPath, peerNodeId, path),
  saveImageAs: (transferId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.imgSaveAs, transferId),
  onPeersUpdated: (listener) => subscribe<PeerView[]>(IpcEvents.peersUpdated, listener),
  onMsgNew: (listener) => subscribe<MessageView>(IpcEvents.msgNew, listener),
  onMsgStatus: (listener) => subscribe<MsgStatusEvent>(IpcEvents.msgStatus, listener),
  onConvsUpdated: (listener) => subscribe<ConversationView[]>(IpcEvents.convsUpdated, listener),
  onTransferUpdated: (listener) => subscribe<TransferView>(IpcEvents.transferUpdated, listener),
  onOpenConv: (listener) => subscribe<string>(IpcEvents.openConv, listener)
}

contextBridge.exposeInMainWorld('pantry', api)
