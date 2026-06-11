import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  IMG_AUTO_ACCEPT,
  MAX_FILES_PER_TRANSFER,
  MSG_TYPES,
  OFFER_ASSEMBLE_TIMEOUT,
  OFFER_FILES_PER_PACKET,
  type Envelope,
  type FileCtlOffer,
  type FileCtlPayload,
  type FileMeta
} from '../../shared/protocol'
import type { FileRefView, MessageView, MsgStatusEvent, TransferView } from '../../shared/ipc'
import { makeEnvelope } from '../net/codec'
import type { Messenger } from '../net/messenger'
import type { PeerRegistry } from '../net/peer-registry'
import {
  TransferServer,
  dedupeTargetPath,
  pullTransfer,
  type IncomingFilePlan,
  type OutgoingFile
} from '../net/transfer'
import { sanitizeRelPath } from '../util/sanitize'
import type { ConvRepo } from '../store/conv-repo'
import { MsgRepo, msgRowToView } from '../store/msg-repo'
import type { TransferRepo } from '../store/transfer-repo'

// 文件传输编排（protocol §8 / 需求 F-FILE-1~3）：
// 控制面走 messenger 可靠投递（对方离线直接失败，不入队——决议 #4）；
// 数据面由 TransferServer（供流）与 pullTransfer（拉流）承担。
// 事件：'message' / 'status' / 'convs'（与 chat 同构）+ 'transfer'（卡片状态）。

interface OutgoingState {
  peerId: string
  msgId: string
  files: Map<string, OutgoingFile>
  totalSize: number
  bytesDone: number
  accepted: boolean
}

interface AssemblingOffer {
  peerId: string
  parts: Map<number, FileMeta[]>
  total: number
  totalSize: number
  fileCount: number
  rootName: string
  purpose?: 'image'
  timer: ReturnType<typeof setTimeout>
}

interface IncomingState {
  peerId: string
  msgId: string
  plans: IncomingFilePlan[]
  bytesDone: number
  cancelRef: { canceled: boolean; socket: import('node:net').Socket | null }
}

interface FilesBlob {
  name: string
  savedPath?: string
}

export interface FilesDeps {
  selfId: string
  messenger: Messenger
  registry: PeerRegistry
  convRepo: ConvRepo
  msgRepo: MsgRepo
  transferRepo: TransferRepo
  tcpPort: number
  getSaveDir: () => string
  /** 图片缓存目录（免确认接收的落点） */
  getImagesDir: () => string
  bindAddress?: string
}

export class FilesService extends EventEmitter {
  private readonly server: TransferServer
  private readonly outgoing = new Map<string, OutgoingState>()
  private readonly assembling = new Map<string, AssemblingOffer>()
  private readonly incoming = new Map<string, IncomingState>()
  private readonly lastEmit = new Map<string, number>()

  constructor(private readonly deps: FilesDeps) {
    super()
    const reset = deps.transferRepo.resetActive()
    if (reset > 0) console.warn(`[files] 启动自愈：${reset} 个残留传输已置失败`)

    this.server = new TransferServer(
      deps.tcpPort,
      {
        resolve: (transferId, fileId) => {
          const out = this.outgoing.get(transferId)
          if (!out || !out.accepted) return null
          return out.files.get(fileId) ?? null
        }
      },
      deps.bindAddress
    )
    this.server.on('progress', (transferId: string, delta: number) => {
      const out = this.outgoing.get(transferId)
      if (!out) return
      out.bytesDone += delta
      this.emitTransfer(transferId, false)
    })
    this.server.on('served', (transferId: string) => {
      const out = this.outgoing.get(transferId)
      if (!out) return
      this.deps.transferRepo.updateProgress(transferId, out.totalSize)
      this.finish(transferId, 'done')
    })

    deps.messenger.on('incoming', (env: Envelope) => {
      if (env.type === MSG_TYPES.fileCtl) this.onCtl(env)
    })
  }

  start(): Promise<void> {
    return this.server.start()
  }

  stop(): Promise<void> {
    return this.server.stop()
  }

  // ---------- 发送侧 ----------

  /** 发起传输；对方离线返回 null（决议 #4：提示不在线，不入队） */
  async offerPaths(
    peerId: string,
    paths: string[],
    wantImage = false
  ): Promise<MessageView | null> {
    const peer = this.deps.registry.get(peerId)
    if (!peer || !peer.online || paths.length === 0) return null

    const metas: FileMeta[] = []
    const outFiles = new Map<string, OutgoingFile>()
    let totalSize = 0
    let hasDir = false
    try {
      for (const p of paths) {
        const st = statSync(p)
        if (st.isDirectory()) {
          hasDir = true
          walkDir(p, basename(p), metas, outFiles)
        } else {
          const fileId = randomUUID()
          metas.push({ fileId, path: basename(p), size: st.size })
          outFiles.set(fileId, { fileId, absPath: p, size: st.size })
        }
      }
    } catch (err) {
      console.warn('[files] 读取待发送文件失败：', err)
      return null
    }
    const fileCount = metas.filter((m) => !m.isDir).length
    if (fileCount === 0 || fileCount > MAX_FILES_PER_TRANSFER) return null
    for (const m of metas) totalSize += m.size

    // 图片用途：单文件且 ≤20MB 才成立，否则退化为普通文件（决议 #2）
    const asImage = wantImage && !hasDir && fileCount === 1 && totalSize <= IMG_AUTO_ACCEPT

    const transferId = randomUUID()
    const rootName =
      paths.length === 1 ? basename(paths[0]) : `${basename(paths[0])} 等 ${fileCount} 个文件`
    const convId = this.deps.convRepo.ensureSingle(peerId)
    const msgId = randomUUID()
    const fileRef: FileRefView = {
      transferId,
      name: rootName,
      size: totalSize,
      count: fileCount,
      dir: hasDir
    }
    const now = Date.now()
    this.deps.msgRepo.insert({
      id: msgId,
      convId,
      senderId: this.deps.selfId,
      isMine: true,
      kind: asImage ? 'image' : 'file',
      content: asImage ? '[图片]' : `[文件] ${rootName}`,
      fileRef: JSON.stringify(fileRef),
      ts: now,
      status: 'sending'
    })
    this.deps.convRepo.bump(convId, now)
    this.deps.transferRepo.insert({
      transferId,
      msgId,
      peerId,
      direction: 'out',
      // 发送侧图片 savedPath=源文件：自己的气泡立即可渲染
      files: JSON.stringify({
        name: rootName,
        ...(asImage ? { savedPath: paths[0] } : {})
      } satisfies FilesBlob),
      status: 'offering',
      total: totalSize,
      ts: now
    })
    this.outgoing.set(transferId, {
      peerId,
      msgId,
      files: outFiles,
      totalSize,
      bytesDone: 0,
      accepted: false
    })
    this.emitConvs()
    this.emitTransfer(transferId, true)

    // offer 分包可靠发送；任一包失败 → 整体失败
    void (async () => {
      const totalPackets = Math.ceil(metas.length / OFFER_FILES_PER_PACKET)
      for (let i = 0; i < totalPackets; i++) {
        const slice = metas.slice(i * OFFER_FILES_PER_PACKET, (i + 1) * OFFER_FILES_PER_PACKET)
        const payload: FileCtlOffer = {
          op: 'offer',
          transferId,
          seq: i + 1,
          total: totalPackets,
          files: slice,
          totalSize,
          fileCount,
          rootName,
          ...(asImage ? { purpose: 'image' as const } : {})
        }
        const ok = await this.deps.messenger.sendReliable(
          peerId,
          makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, payload)
        )
        if (!ok) {
          this.finish(transferId, 'failed')
          this.applyMsgStatus(msgId, 'failed')
          return
        }
      }
      this.applyMsgStatus(msgId, 'sent')
    })()

    const row = this.deps.msgRepo.get(msgId)
    return row ? msgRowToView(row) : null
  }

  // ---------- 接收侧 ----------

  async accept(transferId: string, saveDirOverride?: string): Promise<boolean> {
    const inc = this.incoming.get(transferId)
    const row = this.deps.transferRepo.get(transferId)
    if (!inc || !row || row.status !== 'offering') return false
    const peer = this.deps.registry.get(inc.peerId)
    if (!peer || !peer.online) {
      this.finish(transferId, 'failed')
      return false
    }

    const base = saveDirOverride || this.deps.getSaveDir()
    // 根级重名避让：同名首段统一改名，保持目录结构（F-FILE-3）
    const rootMap = new Map<string, string>()
    for (const plan of inc.plans) {
      const first = plan.relPath.split('/')[0]
      if (!rootMap.has(first)) {
        const target = dedupeTargetPath(join(base, first))
        rootMap.set(first, basename(target))
      }
    }
    const plans = inc.plans.map((p) => {
      const segs = p.relPath.split('/')
      segs[0] = rootMap.get(segs[0]) ?? segs[0]
      return { ...p, relPath: segs.join('/') }
    })
    const savedPath = join(base, plans[0].relPath.split('/')[0])

    this.deps.transferRepo.updateStatus(transferId, 'accepted')
    this.updateBlob(transferId, { savedPath })
    this.emitTransfer(transferId, true)

    const ok = await this.deps.messenger.sendReliable(
      inc.peerId,
      makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, {
        op: 'accept',
        transferId
      } satisfies FileCtlPayload)
    )
    if (!ok) {
      this.finish(transferId, 'failed')
      return false
    }

    void pullTransfer({
      host: peer.ip,
      port: peer.profile.tcpPort,
      selfId: this.deps.selfId,
      transferId,
      files: plans,
      saveDir: base,
      cancelRef: inc.cancelRef,
      onProgress: (delta) => {
        inc.bytesDone += delta
        this.emitTransfer(transferId, false)
      }
    })
      .then(() => {
        this.deps.transferRepo.updateProgress(transferId, inc.bytesDone)
        this.finish(transferId, 'done')
      })
      .catch((err: Error) => {
        this.deps.transferRepo.updateProgress(transferId, inc.bytesDone)
        this.finish(transferId, inc.cancelRef.canceled ? 'canceled' : 'failed')
        if (!inc.cancelRef.canceled) console.warn('[files] 拉取失败：', err.message)
      })
    return true
  }

  async decline(transferId: string): Promise<void> {
    const inc = this.incoming.get(transferId)
    if (!inc) return
    this.finish(transferId, 'declined')
    await this.deps.messenger.sendReliable(
      inc.peerId,
      makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, {
        op: 'decline',
        transferId
      } satisfies FileCtlPayload)
    )
  }

  async cancel(transferId: string): Promise<void> {
    const out = this.outgoing.get(transferId)
    const inc = this.incoming.get(transferId)
    const peerId = out?.peerId ?? inc?.peerId
    if (inc) {
      inc.cancelRef.canceled = true
      inc.cancelRef.socket?.destroy()
    }
    this.finish(transferId, 'canceled')
    if (peerId) {
      await this.deps.messenger.sendReliable(
        peerId,
        makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, {
          op: 'cancel',
          transferId
        } satisfies FileCtlPayload)
      )
    }
  }

  transferView(transferId: string): TransferView | null {
    const row = this.deps.transferRepo.get(transferId)
    if (!row) return null
    let blob: FilesBlob = { name: '' }
    try {
      blob = JSON.parse(row.files) as FilesBlob
    } catch {
      // 留默认
    }
    const msg = this.deps.msgRepo.get(row.msg_id)
    const live = this.outgoing.get(transferId)?.bytesDone ?? this.incoming.get(transferId)?.bytesDone
    const fileRefCount = ((): number => {
      if (!msg?.file_ref) return 1
      try {
        return (JSON.parse(msg.file_ref) as FileRefView).count
      } catch {
        return 1
      }
    })()
    return {
      transferId,
      msgId: row.msg_id,
      convId: msg?.conv_id ?? '',
      direction: row.direction === 'out' ? 'out' : 'in',
      status: row.status as TransferView['status'],
      bytesDone: live ?? row.bytes_done,
      totalSize: row.total,
      fileCount: fileRefCount,
      name: blob.name,
      savedPath: blob.savedPath ?? ''
    }
  }

  // ---------- 控制面入站 ----------

  private onCtl(env: Envelope): void {
    const ctl = env.payload as FileCtlPayload
    if (ctl.op === 'offer') {
      this.onOfferPart(env.from, ctl)
      return
    }
    const row = this.deps.transferRepo.get(ctl.transferId)
    if (!row || row.peer_id !== env.from) return // 只认传输双方
    if (ctl.op === 'accept') {
      const out = this.outgoing.get(ctl.transferId)
      if (out && row.status === 'offering') {
        out.accepted = true
        this.deps.transferRepo.updateStatus(ctl.transferId, 'accepted')
        this.emitTransfer(ctl.transferId, true)
      }
    } else if (ctl.op === 'decline') {
      if (row.direction === 'out' && row.status === 'offering') this.finish(ctl.transferId, 'declined')
    } else if (ctl.op === 'cancel') {
      const inc = this.incoming.get(ctl.transferId)
      if (inc) {
        inc.cancelRef.canceled = true
        inc.cancelRef.socket?.destroy()
      }
      if (row.status === 'offering' || row.status === 'accepted') {
        this.finish(ctl.transferId, 'canceled')
      }
    }
  }

  private onOfferPart(peerId: string, offer: FileCtlOffer): void {
    if (this.deps.transferRepo.get(offer.transferId)) return // 重复 offer（dedup 之外的兜底）
    let asm = this.assembling.get(offer.transferId)
    if (!asm) {
      asm = {
        peerId,
        parts: new Map(),
        total: offer.total,
        totalSize: offer.totalSize,
        fileCount: offer.fileCount,
        rootName: offer.rootName,
        purpose: offer.purpose,
        timer: setTimeout(() => this.assembling.delete(offer.transferId), OFFER_ASSEMBLE_TIMEOUT)
      }
      this.assembling.set(offer.transferId, asm)
    }
    if (asm.peerId !== peerId) return
    asm.parts.set(offer.seq, offer.files)
    if (asm.parts.size < asm.total) return

    clearTimeout(asm.timer)
    this.assembling.delete(offer.transferId)

    const plans: IncomingFilePlan[] = []
    for (let seq = 1; seq <= asm.total; seq++) {
      for (const meta of asm.parts.get(seq) ?? []) {
        const rel = sanitizeRelPath(meta.path)
        if (!rel) {
          console.warn('[files] offer 含非法路径，整体拒绝：', meta.path)
          void this.declineUnknown(peerId, offer.transferId)
          return
        }
        plans.push({ fileId: meta.fileId, relPath: rel, size: meta.size, isDir: meta.isDir })
      }
    }
    if (plans.filter((p) => !p.isDir).length !== asm.fileCount) return // 分包不一致，丢弃

    // 图片免确认条件复核（不信任发送方标记，大小/单文件条件自己验——决议 #2）
    const asImage =
      asm.purpose === 'image' &&
      asm.fileCount === 1 &&
      asm.totalSize <= IMG_AUTO_ACCEPT &&
      plans.length === 1 &&
      !plans[0].isDir &&
      !plans[0].relPath.includes('/')

    const convId = this.deps.convRepo.ensureSingle(peerId)
    const msgId = randomUUID()
    const fileRef: FileRefView = {
      transferId: offer.transferId,
      name: asm.rootName,
      size: asm.totalSize,
      count: asm.fileCount,
      dir: plans.some((p) => p.relPath.includes('/'))
    }
    const now = Date.now()
    this.deps.msgRepo.insert({
      id: msgId,
      convId,
      senderId: peerId,
      isMine: false,
      kind: asImage ? 'image' : 'file',
      content: asImage ? '[图片]' : `[文件] ${asm.rootName}`,
      fileRef: JSON.stringify(fileRef),
      ts: now,
      status: 'sent'
    })
    this.deps.convRepo.bump(convId, now)
    this.deps.convRepo.incUnread(convId)
    this.deps.transferRepo.insert({
      transferId: offer.transferId,
      msgId,
      peerId,
      direction: 'in',
      files: JSON.stringify({ name: asm.rootName } satisfies FilesBlob),
      status: 'offering',
      total: asm.totalSize,
      ts: now
    })
    this.incoming.set(offer.transferId, {
      peerId,
      msgId,
      plans,
      bytesDone: 0,
      cancelRef: { canceled: false, socket: null }
    })
    const msgRow = this.deps.msgRepo.get(msgId)
    if (msgRow) this.emit('message', msgRowToView(msgRow))
    this.emitConvs()
    this.emitTransfer(offer.transferId, true)

    // 图片：免确认，立即拉进图片缓存（protocol §7.1）
    if (asImage) void this.accept(offer.transferId, this.deps.getImagesDir())
  }

  private async declineUnknown(peerId: string, transferId: string): Promise<void> {
    await this.deps.messenger.sendReliable(
      peerId,
      makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, {
        op: 'decline',
        transferId
      } satisfies FileCtlPayload)
    )
  }

  // ---------- 内部 ----------

  private finish(transferId: string, status: 'done' | 'declined' | 'canceled' | 'failed'): void {
    this.deps.transferRepo.updateStatus(transferId, status)
    this.outgoing.delete(transferId)
    this.incoming.delete(transferId)
    this.emitTransfer(transferId, true)
  }

  private updateBlob(transferId: string, patch: Partial<FilesBlob>): void {
    const row = this.deps.transferRepo.get(transferId)
    if (!row) return
    let blob: FilesBlob = { name: '' }
    try {
      blob = JSON.parse(row.files) as FilesBlob
    } catch {
      // 留默认
    }
    const merged = { ...blob, ...patch }
    // files 列复用 insert 的 REPLACE 太重，这里直接 update
    this.deps.transferRepo.updateFiles(transferId, JSON.stringify(merged))
  }

  /** 节流 250ms 推卡片状态；force 用于状态切换（必达） */
  private emitTransfer(transferId: string, force: boolean): void {
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(transferId) ?? 0) < 250) return
    this.lastEmit.set(transferId, now)
    const view = this.transferView(transferId)
    if (view) this.emit('transfer', view)
  }

  private applyMsgStatus(msgId: string, status: MessageView['status']): void {
    const row = this.deps.msgRepo.get(msgId)
    if (!row) return
    this.deps.msgRepo.updateStatus(msgId, status)
    const event: MsgStatusEvent = { id: msgId, convId: row.conv_id, status }
    this.emit('status', event)
  }

  private emitConvs(): void {
    this.emit('convs', this.deps.convRepo.list().map((row) => ({
      id: row.id,
      type: 'single' as const,
      peerId: row.peer_or_group_id,
      lastTs: row.last_ts,
      unread: row.unread,
      pinned: row.pinned !== 0,
      muted: row.muted !== 0,
      preview: row.preview ?? ''
    })))
  }
}

/** 递归展开文件夹（含空目录条目），相对路径以 rootName 开头 */
function walkDir(
  absDir: string,
  relDir: string,
  metas: FileMeta[],
  outFiles: Map<string, OutgoingFile>
): void {
  const entries = readdirSync(absDir, { withFileTypes: true })
  if (entries.length === 0) {
    metas.push({ fileId: randomUUID(), path: relDir, size: 0, isDir: true })
    return
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name)
    const rel = `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      walkDir(abs, rel, metas, outFiles)
    } else if (entry.isFile()) {
      const st = statSync(abs)
      const fileId = randomUUID()
      metas.push({ fileId, path: rel, size: st.size })
      outFiles.set(fileId, { fileId, absPath: abs, size: st.size })
    }
  }
}
