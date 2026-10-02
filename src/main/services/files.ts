import type { DiagnosticReporter } from './diagnostics'
import { systemMessage } from '../../i18n/messages'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  FILE_OFFER_TTL,
  GROUP_IMG_AUTO_ACCEPT,
  IMG_AUTO_ACCEPT,
  MAX_FILES_PER_TRANSFER,
  MSG_TYPES,
  OFFER_ASSEMBLE_TIMEOUT,
  OFFER_FILES_PER_PACKET,
  PULL_IDLE_TIMEOUT,
  SHARE_PUT_MAX_BYTES,
  CAPS,
  TABLE_TEXT_LIMIT_BYTES,
  UPDATE_PACKAGE_MAX_BYTES,
  type Envelope,
  type FileCtlOffer,
  type FileCtlPayload,
  type FileMeta,
  type GroupPayload
} from '../../shared/protocol'
import type { FileRefView, MessageView, MsgStatusEvent, TableTextMeta, TransferView } from '../../shared/ipc'
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
import { convRowToView, type ConvRepo } from '../store/conv-repo'
import { MsgRepo, msgRowToView, type MsgRow } from '../store/msg-repo'
import type { TransferRepo } from '../store/transfer-repo'
import type { GroupRepo } from '../store/group-repo'

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
  /** 普通文件本机截止时间；自动媒体/更新包为 0。 */
  expiresAt: number
  /** 最近一次在期限内收到 accept 的本机时间，用于等待 TCP 建连的短宽限。 */
  acceptedAt: number
}

interface AssemblingOffer {
  peerId: string
  msgId?: string
  parts: Map<number, FileMeta[]>
  total: number
  totalSize: number
  fileCount: number
  rootName: string
  purpose?: FileCtlOffer['purpose']
  offerExpiresAt?: number
  /** 按发送端剩余时长换算出的本机截止时间。 */
  expiresAt: number
  groupId?: string
  groupRev?: number
  tableText?: string
  tableTextTruncated?: boolean
  timer: ReturnType<typeof setTimeout>
}

interface IncomingState {
  peerId: string
  msgId: string
  plans: IncomingFilePlan[]
  bytesDone: number
  /** 普通文件本机截止时间；自动媒体/更新包为 0。 */
  expiresAt: number
  /** 发送端并发预算满、本传输在对端 FIFO 排队中（决议 #211，wait 帧驱动） */
  queued: boolean
  cancelRef: { canceled: boolean; socket: import('node:net').Socket | null }
}

interface FilesBlob {
  name: string
  savedPath?: string
  purpose?: 'update' | 'share-get' | 'share-put'
  direct?: boolean
  directPeerName?: string
  /** 普通入站文件的已清洗相对清单，用于期限内重启恢复。 */
  plans?: IncomingFilePlan[]
}

interface PreparedOutgoing {
  metas: FileMeta[]
  outFiles: Map<string, OutgoingFile>
  totalSize: number
  fileCount: number
  hasDir: boolean
  rootName: string
  purpose?: FileCtlOffer['purpose']
  savedPath?: string
}

interface GroupOfferContext {
  groupId: string
  groupRev: number
}

export interface FilesDeps {
  diagnostic?: DiagnosticReporter
  openScreen?: import('../net/transfer').OutgoingLookup['openScreen']
  selfId: string
  messenger: Messenger
  registry: PeerRegistry
  convRepo: ConvRepo
  msgRepo: MsgRepo
  transferRepo: TransferRepo
  groupRepo?: GroupRepo
  tcpPort: number
  getSaveDir: () => string
  /** 图片缓存目录（免确认接收的落点） */
  getImagesDir: () => string
  /** 更新包临时目录（决议 #166）：不进聊天接收目录 */
  getUpdateDir?: () => string
  /** 用户确认更新请求后，对来源、包名与大小做一次性授权消费。 */
  authorizeUpdateOffer?: (peerId: string, name: string, totalSize: number) => boolean
  /**
   * 本机刚向该节点发过 share{op:"get"} 才允许接收其 share-get 传输（决议 #275）。
   * 命中返回落盘目录并消费授权，未授权返回 null。
   */
  authorizeShareDownload?: (peerId: string) => string | null
  /**
   * 别人上传到本机文件柜（决议 #272）：按写权限与总量复核，
   * 通过返回落盘目录（`共享根/上传者显示名/`），拒绝返回 null。
   */
  authorizeShareUpload?: (peerId: string, totalSize: number) => string | null
  /** 是否允许私聊直接发送自动接收；默认允许。 */
  allowDirectFileSend?: () => boolean
  /** 展示名：用于默认接收子目录（备注优先可由 main 注入）。 */
  peerDisplayName?: (peerId: string) => string
  bindAddress?: string
}

export class FilesService extends EventEmitter {
  private readonly server: TransferServer
  private readonly outgoing = new Map<string, OutgoingState>()
  private readonly assembling = new Map<string, AssemblingOffer>()
  private readonly incoming = new Map<string, IncomingState>()
  private readonly lastEmit = new Map<string, number>()
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private convsScheduled = false

  constructor(private readonly deps: FilesDeps) {
    super()
    this.server = new TransferServer(
      deps.tcpPort,
      {
        resolve: (transferId, fileId) => {
          const out = this.outgoing.get(transferId)
          if (!out || !out.accepted) return null
          if (!this.canServeOutgoing(transferId, out)) return null
          return out.files.get(fileId) ?? null
        },
        receiveMessage: (env, ip) => this.deps.messenger.acceptTcpEnvelope(env, ip),
        openScreen: deps.openScreen,
        supportsWait: (peerId) => this.peerSupportsTransferWait(peerId)
      },
      deps.bindAddress
    )
    this.server.on('diagnostic-error', error => deps.diagnostic?.('network.listen', { kind: 'tcp', port: deps.tcpPort, status: 'failed' }, error))
    this.server.on('progress', (transferId: string, delta: number) => {
      const out = this.outgoing.get(transferId)
      if (!out) return
      out.bytesDone += delta
      this.emitTransfer(transferId, false)
    })
    this.server.on('served', (transferId: string) => {
      deps.diagnostic?.('transfer.phase', { transferId, direction: 'out', stage: 'served' })
      const row = this.deps.transferRepo.get(transferId)
      if (!row || row.direction !== 'out') return
      const out = this.outgoing.get(transferId)
      this.deps.transferRepo.updateProgress(transferId, out?.totalSize ?? row.total)
      // 数据完整送达是最权威的成功信号：即便 offer 回程 ACK 判负已先把卡片标为 failed，
      // 这里也以数据面为准救回 done/sent（issue #3，决议 #165）。
      this.applyMsgStatus(row.msg_id, 'sent')
      this.finish(transferId, 'done')
    })
    this.server.on('disconnected', (transferId: string) => {
      deps.diagnostic?.('transfer.phase', { transferId, direction: 'out', stage: 'disconnected' })
      const row = this.deps.transferRepo.get(transferId)
      if (row?.status === 'accepted' && this.isExpired(row)) {
        this.finish(transferId, 'expired')
      } else {
        this.scheduleExpiry()
      }
    })

    deps.messenger.on('incoming', (env: Envelope) => {
      if (env.type === MSG_TYPES.fileCtl) this.onCtl(env)
    })

    this.recoverTransfers()
  }

  start(): Promise<void> {
    return this.server.start()
  }

  stop(): Promise<void> {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    return this.server.stop()
  }

  // ---------- 发送侧 ----------

  /** 发起传输；对方离线返回 null（决议 #4：提示不在线，不入队） */
  async offerPaths(
    peerId: string,
    paths: string[],
    want: 'file' | 'image' | 'sticker' = 'file',
    tableTextMeta?: TableTextMeta
  ): Promise<MessageView | null> {
    const peer = this.deps.registry.get(peerId)
    if (!peer || !peer.online || paths.length === 0) return null
    const prepared = this.prepareOutgoing(paths, want)
    if (!prepared) return null
    const transferId = randomUUID()
    const convId = this.deps.convRepo.ensureSingle(peerId)
    const msgId = randomUUID()
    const tableText = normalizeTableTextMeta(prepared.purpose, tableTextMeta)
    const fileRef: FileRefView = {
      transferId,
      name: prepared.rootName,
      size: prepared.totalSize,
      count: prepared.fileCount,
      dir: prepared.hasDir,
      ...(tableText ?? {})
    }
    const now = Date.now()
    const expiresAt = prepared.purpose ? 0 : now + FILE_OFFER_TTL
    this.deps.msgRepo.insert({
      id: msgId,
      convId,
      senderId: this.deps.selfId,
      isMine: true,
      kind: messageKindForPurpose(prepared.purpose),
      content:
        prepared.purpose === 'sticker'
          ? '[表情]'
          : prepared.purpose === 'image'
            ? '[图片]'
            : `[文件] ${prepared.rootName}`,
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
      // 发送侧记录单路径源文件/目录：图片可立即渲染，文件可再次转发。
      files: JSON.stringify({
        name: prepared.rootName,
        ...(prepared.savedPath ? { savedPath: prepared.savedPath } : {})
      } satisfies FilesBlob),
      status: 'offering',
      total: prepared.totalSize,
      ts: now,
      expiresAt
    })
    if (expiresAt > 0) {
      this.deps.transferRepo.saveOutgoingManifest(
        msgId,
        JSON.stringify([...prepared.outFiles.values()]),
        expiresAt
      )
    }
    this.outgoing.set(transferId, {
      peerId,
      msgId,
      files: new Map(prepared.outFiles),
      totalSize: prepared.totalSize,
      bytesDone: 0,
      accepted: false,
      expiresAt,
      acceptedAt: 0
    })
    this.scheduleExpiry()
    this.emitConvs()
    this.emitTransfer(transferId, true)

    // offer 分包可靠发送。注意：发送成败要以「数据面真实结果」为准，不能只看 offer 回程 ACK（issue #3）
    void this.sendOfferPackets(peerId, transferId, prepared, expiresAt, tableText, undefined, msgId).then((ok) => {
      if (ok) {
        this.applyMsgStatus(msgId, 'sent')
        return
      }
      // offer 回程 ACK 丢失：若对方已接受或数据已送达，判已发送、不翻失败；否则才算真失败
      const row = this.deps.transferRepo.get(transferId)
      if (
        row &&
        (row.status === 'accepted' || row.status === 'done' || row.status === 'canceled')
      ) {
        return
      }
      this.finish(transferId, 'failed')
      this.applyMsgStatus(msgId, 'failed')
    })

    const row = this.deps.msgRepo.get(msgId)
    return row ? msgRowToView(row) : null
  }

  /** 群聊媒体：只给当前在线群成员逐个发点对点 transfer（决议 #32）。 */
  async offerGroupPaths(
    groupId: string,
    paths: string[],
    want: 'file' | 'image' | 'sticker' = 'file',
    tableTextMeta?: TableTextMeta
  ): Promise<MessageView | null> {
    const meta = this.deps.groupRepo?.get(groupId)
    if (!meta || !meta.members.includes(this.deps.selfId) || paths.length === 0) return null
    const recipients = meta.members.filter((member) => {
      if (member === this.deps.selfId) return false
      const peer = this.deps.registry.get(member)
      return !!peer && peer.online
    })
    if (recipients.length === 0) return null
    const prepared = this.prepareOutgoing(paths, want, GROUP_IMG_AUTO_ACCEPT)
    if (!prepared) return null

    const transfers = recipients.map((peerId) => ({ peerId, transferId: randomUUID() }))
    const convId = this.deps.convRepo.ensureGroup(groupId)
    const msgId = randomUUID()
    const tableText = normalizeTableTextMeta(prepared.purpose, tableTextMeta)
    const fileRef: FileRefView = {
      transferId: transfers[0].transferId,
      ...(transfers.length > 1 ? { transferIds: transfers.map((t) => t.transferId) } : {}),
      name: prepared.rootName,
      size: prepared.totalSize,
      count: prepared.fileCount,
      dir: prepared.hasDir,
      ...(tableText ?? {})
    }
    const now = Date.now()
    const expiresAt = prepared.purpose ? 0 : now + FILE_OFFER_TTL
    this.deps.msgRepo.insert({
      id: msgId,
      convId,
      senderId: this.deps.selfId,
      isMine: true,
      kind: messageKindForPurpose(prepared.purpose),
      content:
        prepared.purpose === 'sticker'
          ? '[表情]'
          : prepared.purpose === 'image'
            ? '[图片]'
            : `[文件] ${prepared.rootName}`,
      fileRef: JSON.stringify(fileRef),
      ts: now,
      status: 'sending'
    })
    this.deps.convRepo.bump(convId, now)

    if (expiresAt > 0) {
      this.deps.transferRepo.saveOutgoingManifest(
        msgId,
        JSON.stringify([...prepared.outFiles.values()]),
        expiresAt
      )
    }

    for (const target of transfers) {
      this.deps.transferRepo.insert({
        transferId: target.transferId,
        msgId,
        peerId: target.peerId,
        direction: 'out',
        files: JSON.stringify({
          name: prepared.rootName,
          ...(prepared.savedPath ? { savedPath: prepared.savedPath } : {})
        } satisfies FilesBlob),
        status: 'offering',
        total: prepared.totalSize,
        ts: now,
        expiresAt
      })
      this.outgoing.set(target.transferId, {
        peerId: target.peerId,
        msgId,
        files: prepared.outFiles,
        totalSize: prepared.totalSize,
        bytesDone: 0,
        accepted: false,
        expiresAt,
        acceptedAt: 0
      })
      this.emitTransfer(target.transferId, true)
    }
    this.scheduleExpiry()
    this.emitConvs()

    void Promise.all(
      transfers.map((target) =>
        this.sendOfferPackets(
          target.peerId,
          target.transferId,
          prepared,
          expiresAt,
          tableText,
          {
            groupId,
            groupRev: meta.rev
          },
          msgId
        ).then((ok) => {
          // offer 回程 ACK 丢失但对方已接受/数据已送达时不翻失败（issue #3）
          if (!ok) {
            const row = this.deps.transferRepo.get(target.transferId)
            if (
              !row ||
              (row.status !== 'accepted' &&
                row.status !== 'done' &&
                row.status !== 'canceled')
            ) {
              this.finish(target.transferId, 'failed')
            }
          }
          return ok
        })
      )
    ).then((results) => {
      this.applyMsgStatus(msgId, results.some(Boolean) ? 'sent' : 'failed')
    })

    const row = this.deps.msgRepo.get(msgId)
    return row ? msgRowToView(row) : null
  }

  /**
   * 隐藏传输的共同收尾（决议 #282）：登记传输行与出站上下文、发 offer、失败回滚。
   *
   * 自更新包与文件柜的上下行三条链路都"不写聊天消息、不套领取期限"，
   * 差别只在怎么准备文件、msgId 用什么前缀、blob 里写什么 purpose，
   * 这后半段原先一字不差地各写了一遍。
   */
  private async offerHidden(
    peerId: string,
    prepared: PreparedOutgoing,
    msgIdPrefix: 'update' | 'share',
    blob: Omit<FilesBlob, 'name'>
  ): Promise<boolean> {
    const transferId = randomUUID()
    const msgId = `${msgIdPrefix}:${transferId}`
    this.deps.transferRepo.insert({
      transferId,
      msgId,
      peerId,
      direction: 'out',
      files: JSON.stringify({ name: prepared.rootName, ...blob } satisfies FilesBlob),
      status: 'offering',
      total: prepared.totalSize,
      ts: Date.now(),
      expiresAt: 0
    })
    this.outgoing.set(transferId, {
      peerId,
      msgId,
      files: new Map(prepared.outFiles),
      totalSize: prepared.totalSize,
      bytesDone: 0,
      accepted: false,
      expiresAt: 0,
      acceptedAt: 0
    })

    const ok = await this.sendOfferPackets(peerId, transferId, prepared, 0, undefined)
    if (ok) return true
    // offer 发失败但对方已经接上了（ACK 与传输抢跑）就不当失败处理
    const row = this.deps.transferRepo.get(transferId)
    if (row && (row.status === 'accepted' || row.status === 'done')) return true
    this.finish(transferId, 'failed')
    return false
  }

  /** 自更新包：隐藏传输，不写聊天消息，不进入普通传输列表（决议 #170）。 */
  async offerUpdatePackage(peerId: string, path: string): Promise<boolean> {
    const peer = this.deps.registry.get(peerId)
    if (!peer || !peer.online) return false
    const prepared = this.prepareUpdatePackage(path)
    if (!prepared) return false
    return this.offerHidden(peerId, prepared, 'update', { savedPath: path, purpose: 'update' })
  }

  /**
   * 共享文件柜下载（决议 #275）：对方请求后由共享方发起，走既有拉取式数据面。
   * 不写聊天消息、不套领取期限；路径已由 ShareService 复核在共享根内。
   */
  async offerSharePaths(peerId: string, absPaths: string[]): Promise<boolean> {
    const peer = this.deps.registry.get(peerId)
    if (!peer || !peer.online) return false
    const prepared = this.prepareOutgoing(absPaths, 'file')
    if (!prepared) return false
    prepared.purpose = 'share-get'
    return this.offerHidden(peerId, prepared, 'share', { purpose: 'share-get' })
  }

  /**
   * 上传到对方的文件柜（决议 #272）：本机是数据发送方，对方复核写权限后来拉。
   * 不写聊天消息、不套领取期限；落点由接收方本机计算，本端无从指定。
   */
  async offerSharePut(peerId: string, absPaths: string[]): Promise<boolean> {
    const peer = this.deps.registry.get(peerId)
    if (!peer || !peer.online) return false
    if (!Array.isArray(peer.profile.caps) || !peer.profile.caps.includes(CAPS.fileCabinet)) {
      return false
    }
    const prepared = this.prepareOutgoing(absPaths, 'file')
    if (!prepared) return false
    if (prepared.totalSize > SHARE_PUT_MAX_BYTES) return false
    prepared.purpose = 'share-put'
    return this.offerHidden(peerId, prepared, 'share', { purpose: 'share-put' })
  }

  /** 发送方在已有私聊文件卡片上请求直接发送；只升级当前 transfer，不重新建消息。 */
  async requestDirect(transferId: string): Promise<boolean> {
    this.expireTransferIfDue(transferId)
    const row = this.deps.transferRepo.get(transferId)
    if (!row || row.direction !== 'out' || row.status !== 'offering') return false
    const msg = this.deps.msgRepo.get(row.msg_id)
    if (!msg || msg.kind !== 'file' || msg.conv_id.startsWith('group:')) return false
    const peer = this.deps.registry.get(row.peer_id)
    if (!peer || !peer.online) return false
    if (!Array.isArray(peer.profile.caps) || !peer.profile.caps.includes(CAPS.fileDirect)) {
      return false
    }
    const ok = await this.deps.messenger.sendReliable(
      row.peer_id,
      makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, {
        op: 'direct',
        transferId
      } satisfies FileCtlPayload)
    )
    if (!ok) return false
    this.markDirect(transferId, '')
    return true
  }

  private prepareOutgoing(
    paths: string[],
    want: 'file' | 'image' | 'sticker',
    imageLimit = IMG_AUTO_ACCEPT
  ): PreparedOutgoing | null {
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

    // 图片/表情用途：单文件且小于当前会话阈值才成立，否则退化为普通文件。
    const purpose =
      want !== 'file' && !hasDir && fileCount === 1 && totalSize <= imageLimit
        ? want
        : undefined
    const rootName =
      paths.length === 1 ? basename(paths[0]) : `${basename(paths[0])} 等 ${fileCount} 个文件`
    return {
      metas,
      outFiles,
      totalSize,
      fileCount,
      hasDir,
      rootName,
      purpose,
      ...(paths.length === 1 ? { savedPath: paths[0] } : {})
    }
  }

  private prepareUpdatePackage(path: string): PreparedOutgoing | null {
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size <= 0) return null
      const fileId = randomUUID()
      return {
        metas: [{ fileId, path: basename(path), size: st.size }],
        outFiles: new Map([[fileId, { fileId, absPath: path, size: st.size }]]),
        totalSize: st.size,
        fileCount: 1,
        hasDir: false,
        rootName: basename(path),
        purpose: 'update',
        savedPath: path
      }
    } catch (err) {
      console.warn('[files] 读取更新包失败：', err)
      return null
    }
  }

  private async sendOfferPackets(
    peerId: string,
    transferId: string,
    prepared: PreparedOutgoing,
    expiresAt: number,
    tableText: TableTextMeta | undefined,
    group?: GroupOfferContext,
    msgId?: string
  ): Promise<boolean> {
    const totalPackets = Math.ceil(prepared.metas.length / OFFER_FILES_PER_PACKET)
    for (let i = 0; i < totalPackets; i++) {
      const slice = prepared.metas.slice(
        i * OFFER_FILES_PER_PACKET,
        (i + 1) * OFFER_FILES_PER_PACKET
      )
      const payload: FileCtlOffer = {
        op: 'offer',
        transferId,
        seq: i + 1,
        total: totalPackets,
        files: slice,
        totalSize: prepared.totalSize,
        fileCount: prepared.fileCount,
        rootName: prepared.rootName,
        ...(msgId ? { msgId } : {}),
        ...(expiresAt > 0 ? { expiresAt } : {}),
        ...(prepared.purpose ? { purpose: prepared.purpose } : {}),
        ...(tableText && this.peerSupportsTableText(peerId) ? tableText : {}),
        ...(group ? { groupId: group.groupId, groupRev: group.groupRev } : {})
      }
      const ok = await this.deps.messenger.sendReliable(
        peerId,
        makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, payload)
      )
      if (!ok) return false
    }
    return true
  }

  // ---------- 接收侧 ----------

  async accept(transferId: string, saveDirOverride?: string): Promise<boolean> {
    this.expireTransferIfDue(transferId)
    const inc = this.incoming.get(transferId)
    const row = this.deps.transferRepo.get(transferId)
    if (
      !inc ||
      !row ||
      (row.status !== 'offering' && row.status !== 'failed' && row.status !== 'canceled')
    ) {
      return false
    }
    // 取消后重新下载（决议 #211）：旧版本发送端收到 cancel 已作废供流授权，重拉必 not-found
    if (row.status === 'canceled' && !this.peerSupportsTransferWait(inc.peerId)) return false
    const peer = this.deps.registry.get(inc.peerId)
    if (!peer || !peer.online) {
      this.finish(transferId, 'failed')
      return false
    }

    let rememberedBase = ''
    try {
      const blob = JSON.parse(row.files) as FilesBlob
      if ((row.status === 'failed' || row.status === 'canceled') && blob.savedPath) {
        rememberedBase = dirname(blob.savedPath)
      }
    } catch {
      rememberedBase = ''
    }
    const base = saveDirOverride || rememberedBase || this.defaultReceiveDir(inc.peerId)
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
    inc.bytesDone = 0
    inc.queued = false
    inc.cancelRef = { canceled: false, socket: null }
    this.updateBlob(transferId, { savedPath })
    this.scheduleExpiry()
    this.emitTransfer(transferId, true)

    const ok = await this.deps.messenger.sendReliable(
      inc.peerId,
      makeEnvelope(MSG_TYPES.fileCtl, this.deps.selfId, {
        op: 'accept',
        transferId
      } satisfies FileCtlPayload)
    )
    if (!ok) {
      this.finish(transferId, this.isExpired(this.deps.transferRepo.get(transferId)) ? 'expired' : 'failed')
      return false
    }

    void pullTransfer({
      onPhase: (stage, localAddress, localPort) => this.deps.diagnostic?.('transfer.phase', {
        transferId, peerId: inc.peerId, direction: 'in', host: peer.ip, port: peer.profile.tcpPort, stage, localAddress, localPort
      }),
      host: peer.ip,
      port: peer.profile.tcpPort,
      selfId: this.deps.selfId,
      transferId,
      files: plans,
      saveDir: base,
      cancelRef: inc.cancelRef,
      supportsWait: this.peerSupportsTransferWait(inc.peerId),
      onProgress: (delta) => {
        inc.bytesDone += delta
        this.emitTransfer(transferId, false)
      },
      onQueued: (queued) => {
        if (inc.queued === queued) return
        inc.queued = queued
        this.emitTransfer(transferId, true)
      }
    })
      .then(() => {
        inc.queued = false
        this.deps.transferRepo.updateProgress(transferId, inc.bytesDone)
        this.finish(transferId, 'done')
      })
      .catch((err: Error & { stage?: string }) => {
        this.deps.diagnostic?.('transfer.error', { transferId, peerId: inc.peerId, host: peer.ip,
          port: peer.profile.tcpPort, direction: 'in', stage: err.stage, reason: err.message.replace(/^peer:/, '') }, err)
        inc.queued = false
        this.deps.transferRepo.updateProgress(transferId, inc.bytesDone)
        const status = this.isExpired(this.deps.transferRepo.get(transferId))
          ? 'expired'
          : inc.cancelRef.canceled
            ? 'canceled'
            : 'failed'
        this.finish(transferId, status)
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
    this.expireTransferIfDue(transferId)
    const out = this.outgoing.get(transferId)
    const inc = this.incoming.get(transferId)
    const peerId = out?.peerId ?? inc?.peerId
    if (inc) {
      inc.cancelRef.canceled = true
      inc.cancelRef.socket?.destroy()
    }
    // 本机发送方主动取消：消息与传输同步进入取消终态，供文件卡区分真实失败。
    if (out) this.applyMsgStatus(out.msgId, 'canceled')
    this.finish(transferId, 'canceled')
    if (out) this.clearTerminalExpiry(transferId)
    if (inc && !this.peerSupportsTransferWait(inc.peerId)) {
      this.discardIncomingContext(transferId)
    }
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
    if (blob.purpose === 'update') return null
    const msg = this.deps.msgRepo.get(row.msg_id)
    const inc = this.incoming.get(transferId)
    const live = this.outgoing.get(transferId)?.bytesDone ?? inc?.bytesDone
    // 失败可无条件「继续」；取消后重新下载要求对端支持 tw1（旧端已作废供流授权）
    const retryable =
      row.direction === 'in' &&
      inc !== undefined &&
      (row.status === 'failed' ||
        (row.status === 'canceled' && this.peerSupportsTransferWait(row.peer_id)))
    const fileRef = ((): FileRefView | null => {
      if (!msg?.file_ref) return null
      try {
        return JSON.parse(msg.file_ref) as FileRefView
      } catch {
        return null
      }
    })()
    const fileRefCount = fileRef?.count ?? 1
    return {
      transferId,
      msgId: row.msg_id,
      convId: msg?.conv_id ?? '',
      peerId: row.peer_id,
      direction: row.direction === 'out' ? 'out' : 'in',
      status: row.status as TransferView['status'],
      bytesDone: live ?? row.bytes_done,
      totalSize: row.total,
      fileCount: fileRefCount,
      name: blob.name,
      expiresAt: row.expires_at,
      savedPath: blob.savedPath ?? '',
      direct: blob.direct === true || fileRef?.direct === true,
      queued: inc?.queued === true,
      retryable,
      ...(blob.directPeerName ? { directPeerName: blob.directPeerName } : {})
    }
  }

  /**
   * 「最近有人放进来」（决议 #283）：别人上传到我文件柜的已完成记录。
   * 文件数取自落盘时写的那条汇总系统提示（`share:<id>:uploaded` 的 fileRef.count），
   * 与私聊里显示的数字同源；purpose 在此复核，不信 SQL 的 LIKE 粗筛。
   */
  listShareUploads(
    limit = 10
  ): Array<{ transferId: string; peerId: string; fileCount: number; totalSize: number; ts: number }> {
    return this.deps.transferRepo
      .listSharePutIncoming(Math.max(1, Math.min(50, limit)))
      .filter((row) => this.blobPurpose(row) === 'share-put')
      .map((row) => {
        const notice = this.deps.msgRepo.get(`share:${row.transfer_id}:uploaded`)
        let fileCount = 0
        if (notice?.file_ref) {
          try {
            fileCount = (JSON.parse(notice.file_ref) as FileRefView).count ?? 0
          } catch {
            fileCount = 0
          }
        }
        return {
          transferId: row.transfer_id,
          peerId: row.peer_id,
          fileCount,
          totalSize: row.total,
          ts: row.ts
        }
      })
  }

  listTransfers(limit = 30): TransferView[] {
    return this.deps.transferRepo
      .list(Math.max(1, Math.min(100, limit)))
      .map((row) => this.transferView(row.transfer_id))
      .filter((view): view is TransferView => view !== null)
  }

  canRecallMessage(msgId: string): boolean {
    const msg = this.deps.msgRepo.get(msgId)
    if (!msg || msg.status === 'recalled') return false
    const transferIds = mediaTransferIds(msg)
    if (transferIds.length === 0) return false
    const transferRows = transferIds.map((id) => this.deps.transferRepo.get(id))
    if (transferRows.some((row) => !row || !this.peerSupportsMediaRecall(row.peer_id))) return false
    if (msg.kind === 'image') return true
    if (msg.kind !== 'file') return false
    return transferIds.every((id) => this.deps.transferRepo.get(id)?.status !== 'done')
  }

  /** 撤回媒体消息时取消尚未完成的传输；已完成文件返回 false，避免删除/隐藏。 */
  applyRecallMessage(msgId: string): boolean {
    const msg = this.deps.msgRepo.get(msgId)
    if (!msg || msg.status === 'recalled') return false
    const transferIds = mediaTransferIds(msg)
    if (msg.kind === 'file' && !this.canRecallMessage(msgId)) return false
    if (msg.kind !== 'file' && msg.kind !== 'image') return false

    for (const transferId of transferIds) {
      const row = this.deps.transferRepo.get(transferId)
      if (!row || row.status === 'done') continue
      const inc = this.incoming.get(transferId)
      if (inc) {
        inc.cancelRef.canceled = true
        inc.cancelRef.socket?.destroy()
      }
      this.finish(transferId, 'canceled')
      // 撤回是终态：不保留重新下载上下文
      this.discardIncomingContext(transferId)
    }
    return true
  }

  // ---------- 控制面入站 ----------

  private onCtl(env: Envelope): void {
    const ctl = env.payload as FileCtlPayload
    if (ctl.op === 'offer') {
      this.onOfferPart(env.from, ctl, env.ts)
      return
    }
    this.expireTransferIfDue(ctl.transferId)
    const row = this.deps.transferRepo.get(ctl.transferId)
    if (!row || row.peer_id !== env.from) return // 只认传输双方
    if (ctl.op === 'accept') {
      const out = this.outgoing.get(ctl.transferId)
      // canceled → accepted：对端取消后点「重新下载」，供流授权仍在，卡片恢复传输中（决议 #211）
      if (
        out &&
        (row.status === 'offering' || row.status === 'failed' || row.status === 'canceled')
      ) {
        out.accepted = true
        out.acceptedAt = Date.now()
        this.deps.transferRepo.updateStatus(ctl.transferId, 'accepted')
        // 对方已接受即「已发送」，迟到的 offer-ACK 判负不再翻成失败（issue #3）
        this.applyMsgStatus(out.msgId, 'sent')
        this.scheduleExpiry()
        this.emitTransfer(ctl.transferId, true)
      }
    } else if (ctl.op === 'decline') {
      if (row.direction === 'out' && (row.status === 'offering' || row.status === 'failed')) {
        const out = this.outgoing.get(ctl.transferId)
        if (out) this.applyMsgStatus(out.msgId, 'sent')
        this.finish(ctl.transferId, 'declined')
      }
    } else if (ctl.op === 'cancel') {
      const inc = this.incoming.get(ctl.transferId)
      if (inc) {
        inc.cancelRef.canceled = true
        inc.cancelRef.socket?.destroy()
      }
      if (
        row.status === 'offering' ||
        row.status === 'accepted' ||
        row.status === 'failed' ||
        row.status === 'canceled'
      ) {
        if (row.direction === 'out') {
          // 对端（接收方）取消：卡片置已取消但保留供流授权，对方可断点重拉（决议 #211）
          const out = this.outgoing.get(ctl.transferId)
          if (out) this.applyMsgStatus(out.msgId, 'sent')
          this.deps.transferRepo.updateStatus(ctl.transferId, 'canceled')
          this.emitTransfer(ctl.transferId, true)
        } else {
          // 发送方主动取消才是终态：作废本地传输上下文，不再提供重新下载
          this.finish(ctl.transferId, 'canceled')
          this.discardIncomingContext(ctl.transferId)
        }
      }
    } else if (ctl.op === 'direct') {
      this.onDirectRequest(env.from, ctl.transferId, row)
    }
  }

  private onDirectRequest(peerId: string, transferId: string, row: { direction: string; status: string; msg_id: string }): void {
    if (row.direction !== 'in' || row.status !== 'offering') return
    if (this.deps.allowDirectFileSend?.() === false) return
    const msg = this.deps.msgRepo.get(row.msg_id)
    if (!msg || msg.kind !== 'file' || msg.conv_id.startsWith('group:')) return
    this.markDirect(transferId, this.peerDirName(peerId))
    void this.accept(transferId)
  }

  private onOfferPart(peerId: string, offer: FileCtlOffer, envelopeTs: number): void {
    if (this.deps.transferRepo.get(offer.transferId)) return // 重复 offer（dedup 之外的兜底）
    let asm = this.assembling.get(offer.transferId)
    if (!asm) {
      const now = Date.now()
      const remaining =
        offer.purpose === undefined
          ? Math.max(
              0,
              Math.min(
                FILE_OFFER_TTL,
                offer.expiresAt === undefined ? FILE_OFFER_TTL : offer.expiresAt - envelopeTs
              )
            )
          : 0
      asm = {
        peerId,
        ...(offer.msgId ? { msgId: offer.msgId } : {}),
        parts: new Map(),
        total: offer.total,
        totalSize: offer.totalSize,
        fileCount: offer.fileCount,
        rootName: offer.rootName,
        purpose: offer.purpose,
        offerExpiresAt: offer.expiresAt,
        expiresAt:
          offer.purpose === undefined && offer.expiresAt !== undefined
            ? remaining > 0
              ? now + remaining
              : now
            : 0,
        groupId: offer.groupId,
        groupRev: offer.groupRev,
        tableText: offer.tableText,
        tableTextTruncated: offer.tableTextTruncated,
        timer: setTimeout(() => this.assembling.delete(offer.transferId), OFFER_ASSEMBLE_TIMEOUT)
      }
      this.assembling.set(offer.transferId, asm)
    }
    if (asm.peerId !== peerId) return
    if (asm.msgId !== offer.msgId) return
    if (
      asm.total !== offer.total ||
      asm.totalSize !== offer.totalSize ||
      asm.fileCount !== offer.fileCount ||
      asm.rootName !== offer.rootName ||
      asm.purpose !== offer.purpose ||
      asm.offerExpiresAt !== offer.expiresAt
    ) {
      return
    }
    if (asm.groupId !== offer.groupId || asm.groupRev !== offer.groupRev) return
    if (asm.tableText !== offer.tableText || asm.tableTextTruncated !== offer.tableTextTruncated) return
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
    const trustedTotalSize = plans.reduce((sum, plan) => sum + (plan.isDir ? 0 : plan.size), 0)
    if (trustedTotalSize !== asm.totalSize) {
      console.warn('[files] offer 声明大小与清单不一致，整体拒绝：', offer.transferId)
      void this.declineUnknown(peerId, offer.transferId)
      return
    }

    if (asm.purpose === 'update') {
      this.onUpdateOffer(peerId, offer, asm, plans, trustedTotalSize)
      return
    }

    if (asm.purpose === 'share-get') {
      this.onShareGetOffer(peerId, offer, asm, plans, trustedTotalSize)
      return
    }

    if (asm.purpose === 'share-put') {
      this.onSharePutOffer(peerId, offer, asm, plans, trustedTotalSize)
      return
    }

    // 图片/表情免确认条件复核（不信任发送方标记；群聊图片走 10MB 上限——决议 #33）
    const imageLimit = asm.groupId ? GROUP_IMG_AUTO_ACCEPT : IMG_AUTO_ACCEPT
    const inPurpose =
      (asm.purpose === 'image' || asm.purpose === 'sticker') &&
      asm.fileCount === 1 &&
      trustedTotalSize <= imageLimit &&
      plans.length === 1 &&
      !plans[0].isDir &&
      !plans[0].relPath.includes('/')
        ? asm.purpose
        : undefined
    const asImage = inPurpose !== undefined

    const convId = asm.groupId
      ? this.deps.convRepo.ensureGroup(asm.groupId)
      : this.deps.convRepo.ensureSingle(peerId)
    const msgId = asm.msgId ?? randomUUID()
    const fileRef: FileRefView = {
      transferId: offer.transferId,
      name: asm.rootName,
      size: trustedTotalSize,
      count: asm.fileCount,
      dir: plans.some((p) => p.relPath.includes('/')),
      ...(inPurpose === 'image' && asm.tableText
        ? {
            tableText: asm.tableText,
            ...(asm.tableTextTruncated ? { tableTextTruncated: true } : {})
          }
        : {})
    }
    const now = Date.now()
    const expiresAt =
      asm.purpose === undefined && asm.offerExpiresAt === undefined
        ? now + FILE_OFFER_TTL
        : asm.expiresAt
    const expired = expiresAt > 0 && now >= expiresAt
    this.deps.msgRepo.insert({
      id: msgId,
      convId,
      senderId: peerId,
      isMine: false,
      kind: inPurpose ?? 'file',
      content:
        inPurpose === 'sticker' ? '[表情]' : inPurpose === 'image' ? '[图片]' : `[文件] ${asm.rootName}`,
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
      files: JSON.stringify({
        name: asm.rootName,
        ...(expiresAt > 0 ? { plans } : {})
      } satisfies FilesBlob),
      status: expired ? 'expired' : 'offering',
      total: trustedTotalSize,
      ts: now,
      expiresAt
    })
    if (!expired) {
      this.incoming.set(offer.transferId, {
        peerId,
        msgId,
        plans,
        bytesDone: 0,
        expiresAt,
        queued: false,
        cancelRef: { canceled: false, socket: null }
      })
    }
    const msgRow = this.deps.msgRepo.get(msgId)
    if (msgRow) this.emit('message', msgRowToView(msgRow))
    this.emitConvs()
    this.emitTransfer(offer.transferId, true)
    this.scheduleExpiry()
    this.requestGroupMetaIfNeeded(peerId, asm.groupId, asm.groupRev)

    // 图片：通过阈值复核后免确认，立即拉进图片缓存（protocol §7.1）
    if (asImage) void this.accept(offer.transferId, this.deps.getImagesDir())
  }

  private onUpdateOffer(
    peerId: string,
    offer: FileCtlOffer,
    asm: AssemblingOffer,
    plans: IncomingFilePlan[],
    trustedTotalSize: number
  ): void {
    const plan = plans[0]
    if (
      asm.groupId ||
      asm.fileCount !== 1 ||
      plans.length !== 1 ||
      !plan ||
      plan.isDir ||
      plan.relPath.includes('/') ||
      plan.relPath !== asm.rootName ||
      trustedTotalSize <= 0 ||
      trustedTotalSize > UPDATE_PACKAGE_MAX_BYTES ||
      this.deps.authorizeUpdateOffer?.(peerId, asm.rootName, trustedTotalSize) !== true
    ) {
      void this.declineUnknown(peerId, offer.transferId)
      return
    }
    const msgId = `update:${offer.transferId}`
    this.deps.transferRepo.insert({
      transferId: offer.transferId,
      msgId,
      peerId,
      direction: 'in',
      files: JSON.stringify({ name: asm.rootName, purpose: 'update' } satisfies FilesBlob),
      status: 'offering',
      total: trustedTotalSize,
      ts: Date.now(),
      expiresAt: 0
    })
    this.incoming.set(offer.transferId, {
      peerId,
      msgId,
      plans,
      bytesDone: 0,
      expiresAt: 0,
      queued: false,
      cancelRef: { canceled: false, socket: null }
    })
    void this.accept(offer.transferId, this.updateDir())
  }

  /**
   * 共享文件柜下载到货（决议 #275）：只接受本机刚请求过的来源，自动 accept 落到指定目录。
   * 不入聊天流、不生成消息、不套领取期限——它是"当场去取"，取消了随时能再来。
   */
  private onShareGetOffer(
    peerId: string,
    offer: FileCtlOffer,
    asm: AssemblingOffer,
    plans: IncomingFilePlan[],
    trustedTotalSize: number
  ): void {
    const saveDir = asm.groupId || asm.msgId ? null : this.deps.authorizeShareDownload?.(peerId) ?? null
    if (!saveDir || plans.length === 0) {
      void this.declineUnknown(peerId, offer.transferId)
      return
    }
    const msgId = `share:${offer.transferId}`
    this.deps.transferRepo.insert({
      transferId: offer.transferId,
      msgId,
      peerId,
      direction: 'in',
      files: JSON.stringify({ name: asm.rootName, purpose: 'share-get' } satisfies FilesBlob),
      status: 'offering',
      total: trustedTotalSize,
      ts: Date.now(),
      expiresAt: 0
    })
    this.incoming.set(offer.transferId, {
      peerId,
      msgId,
      plans,
      bytesDone: 0,
      expiresAt: 0,
      queued: false,
      cancelRef: { canceled: false, socket: null }
    })
    void this.accept(offer.transferId, saveDir)
  }

  /**
   * 别人往本机文件柜传东西（决议 #272）：权限与总量复核在 ShareService，
   * 落点固定为共享根下以上传者命名的子目录；同样不入聊天流，完成后才插一条系统提示。
   */
  private onSharePutOffer(
    peerId: string,
    offer: FileCtlOffer,
    asm: AssemblingOffer,
    plans: IncomingFilePlan[],
    trustedTotalSize: number
  ): void {
    const dir =
      asm.groupId || asm.msgId
        ? null
        : this.deps.authorizeShareUpload?.(peerId, trustedTotalSize) ?? null
    if (!dir || plans.length === 0) {
      void this.declineUnknown(peerId, offer.transferId)
      return
    }
    const msgId = `share:${offer.transferId}`
    this.deps.transferRepo.insert({
      transferId: offer.transferId,
      msgId,
      peerId,
      direction: 'in',
      files: JSON.stringify({ name: asm.rootName, purpose: 'share-put' } satisfies FilesBlob),
      status: 'offering',
      total: trustedTotalSize,
      ts: Date.now(),
      expiresAt: 0
    })
    this.incoming.set(offer.transferId, {
      peerId,
      msgId,
      plans,
      bytesDone: 0,
      expiresAt: 0,
      queued: false,
      cancelRef: { canceled: false, socket: null }
    })
    void this.accept(offer.transferId, dir)
  }

  /**
   * 上传到货后的唯一提示（决议 #274）：在与上传者的私聊里插一条系统提示，
   * 会话冒泡并计未读，但不弹桌面通知（notifyIncoming 对 system 直接返回）。
   * 单次上传只汇总成一条，消息 ID 取 transferId 保证幂等。
   */
  private announceShareUpload(transferId: string, peerId: string, fileCount: number): void {
    const convId = this.deps.convRepo.ensureSingle(peerId)
    const name = this.deps.peerDisplayName?.(peerId) || ''
    const now = Date.now()
    const inserted = this.deps.msgRepo.insert({
      id: `share:${transferId}:uploaded`,
      convId,
      senderId: peerId,
      isMine: false,
      kind: 'system',
      ...systemMessage('share.uploaded', { actor: name ? { name } : { name: '', role: 'unknown' }, count: fileCount }, {
        transferId,
        name: '文件柜',
        size: 0,
        count: fileCount,
        dir: true
      }),
      ts: now,
      status: 'sent'
    })
    if (!inserted) return
    this.deps.convRepo.bump(convId, now)
    this.deps.convRepo.incUnread(convId)
    const row = this.deps.msgRepo.get(`share:${transferId}:uploaded`)
    if (row) this.emit('message', msgRowToView(row))
    this.emitConvs()
  }

  private requestGroupMetaIfNeeded(
    peerId: string,
    groupId: string | undefined,
    groupRev: number | undefined
  ): void {
    if (!groupId) return
    const meta = this.deps.groupRepo?.get(groupId)
    if (meta && groupRev !== undefined && groupRev <= meta.rev) return
    void this.deps.messenger.sendReliable(
      peerId,
      makeEnvelope<GroupPayload>(MSG_TYPES.group, this.deps.selfId, {
        op: 'need',
        groupId
      })
    )
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

  /** 启动时只恢复仍在普通文件领取期限内、且本地上下文完整的传输。 */
  private recoverTransfers(): void {
    const reset = this.deps.transferRepo.resetLegacyActive()
    if (reset > 0) console.warn(`[files] 启动自愈：${reset} 个旧版残留传输已置失败`)

    const now = Date.now()
    const activeManifestIds = new Set<string>()
    const manifestCache = new Map<string, Map<string, OutgoingFile>>()
    for (const row of this.deps.transferRepo.listRecoverable()) {
      const blob = parseFilesBlob(row.files)
      if (row.direction === 'out') {
        const msg = this.deps.msgRepo.get(row.msg_id)
        if (msg?.status === 'canceled' || msg?.status === 'recalled') {
          this.deps.transferRepo.updateStatus(row.transfer_id, 'canceled')
          this.deps.transferRepo.clearExpiry(row.transfer_id)
          continue
        }
        if (row.expires_at <= now) {
          this.deps.transferRepo.updateStatus(row.transfer_id, 'expired')
          continue
        }
        const manifest = this.deps.transferRepo.getOutgoingManifest(row.msg_id)
        if (!manifest || manifest.expires_at !== row.expires_at) {
          this.deps.transferRepo.updateStatus(row.transfer_id, 'failed')
          continue
        }
        let files: Map<string, OutgoingFile> | null | undefined = manifestCache.get(row.msg_id)
        if (!files) {
          files = parseOutgoingManifest(manifest.files)
          if (!files) {
            this.deps.transferRepo.updateStatus(row.transfer_id, 'failed')
            continue
          }
          manifestCache.set(row.msg_id, files)
        }
        this.outgoing.set(row.transfer_id, {
          peerId: row.peer_id,
          msgId: row.msg_id,
          files,
          totalSize: row.total,
          bytesDone: row.bytes_done,
          accepted: row.status === 'accepted',
          expiresAt: row.expires_at,
          acceptedAt: row.status === 'accepted' ? now : 0
        })
        if (
          msg &&
          (msg.status === 'sending' || (msg.status === 'failed' && row.status !== 'failed'))
        ) {
          this.deps.msgRepo.updateStatus(row.msg_id, 'sent')
        }
        activeManifestIds.add(row.msg_id)
        continue
      }

      const plans = parseIncomingPlans(blob.plans)
      if (!plans) {
        if (row.status !== 'canceled') {
          this.deps.transferRepo.updateStatus(
            row.transfer_id,
            row.expires_at <= now ? 'expired' : 'failed'
          )
        }
        continue
      }
      if (row.expires_at <= now) {
        this.deps.transferRepo.updateStatus(row.transfer_id, 'expired')
        continue
      }
      if (row.status === 'accepted') {
        // 上次进程中的 TCP 连接已经中断；期限内回到可继续状态。
        this.deps.transferRepo.updateStatus(row.transfer_id, 'failed')
      }
      this.incoming.set(row.transfer_id, {
        peerId: row.peer_id,
        msgId: row.msg_id,
        plans,
        bytesDone: row.bytes_done,
        expiresAt: row.expires_at,
        queued: false,
        cancelRef: { canceled: false, socket: null }
      })
    }

    for (const manifest of this.deps.transferRepo.listOutgoingManifests()) {
      if (!activeManifestIds.has(manifest.msg_id)) {
        this.deps.transferRepo.deleteOutgoingManifest(manifest.msg_id)
      }
    }
    this.scheduleExpiry()
  }

  private canServeOutgoing(transferId: string, out: OutgoingState): boolean {
    if (out.expiresAt <= 0 || Date.now() < out.expiresAt) return true
    if (this.server.isTransferActive(transferId)) return true
    return out.acceptedAt > 0 && Date.now() < out.acceptedAt + PULL_IDLE_TIMEOUT
  }

  private isExpired(row: { expires_at: number } | undefined): boolean {
    return !!row && row.expires_at > 0 && Date.now() >= row.expires_at
  }

  private expireTransferIfDue(transferId: string): void {
    const row = this.deps.transferRepo.get(transferId)
    if (!this.isExpired(row)) return
    if (row!.direction === 'out' && !this.outgoing.has(transferId)) return
    if (row!.direction === 'in' && !this.incoming.has(transferId)) return
    if (row!.status === 'accepted') {
      if (row!.direction === 'in' && this.incoming.has(transferId)) return
      const out = this.outgoing.get(transferId)
      if (out && this.canServeOutgoing(transferId, out)) return
    }
    if (
      row!.status === 'offering' ||
      row!.status === 'accepted' ||
      row!.status === 'failed' ||
      row!.status === 'canceled'
    ) {
      this.finish(transferId, 'expired')
    }
  }

  private expireDueTransfers(): void {
    this.expiryTimer = null
    const now = Date.now()
    for (const row of this.deps.transferRepo.listRecoverable()) {
      if (row.direction === 'out' && !this.outgoing.has(row.transfer_id)) continue
      if (row.direction === 'in' && !this.incoming.has(row.transfer_id)) continue
      if (row.expires_at > now) continue
      if (row.status === 'accepted') {
        if (row.direction === 'in' && this.incoming.has(row.transfer_id)) continue
        const out = this.outgoing.get(row.transfer_id)
        if (out && this.canServeOutgoing(row.transfer_id, out)) continue
      }
      this.finish(row.transfer_id, 'expired')
    }
    this.scheduleExpiry()
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    const now = Date.now()
    let next = Number.POSITIVE_INFINITY
    for (const row of this.deps.transferRepo.listRecoverable()) {
      if (row.direction === 'out' && !this.outgoing.has(row.transfer_id)) continue
      if (row.direction === 'in' && !this.incoming.has(row.transfer_id)) continue
      let due = row.expires_at
      if (row.status === 'accepted' && row.direction === 'in' && this.incoming.has(row.transfer_id)) {
        continue
      }
      if (row.status === 'accepted' && row.direction === 'out') {
        const out = this.outgoing.get(row.transfer_id)
        if (out && this.server.isTransferActive(row.transfer_id)) continue
        if (out?.acceptedAt) due = Math.max(due, out.acceptedAt + PULL_IDLE_TIMEOUT)
      }
      next = Math.min(next, due)
    }
    if (!Number.isFinite(next)) return
    this.expiryTimer = setTimeout(
      () => this.expireDueTransfers(),
      Math.max(1, Math.min(2_147_483_647, next - now))
    )
    this.expiryTimer.unref()
  }

  // ---------- 内部 ----------

  private finish(
    transferId: string,
    status: 'done' | 'declined' | 'canceled' | 'failed' | 'expired'
  ): void {
    const current = this.deps.transferRepo.get(transferId)
    if (!current) return
    if (current.status === 'expired' && status !== 'expired') return
    // 提示所需的文件数只在 incoming 上下文里，finish 末尾会清掉，先取出来
    const uploadedCount =
      status === 'done' && current.direction === 'in' && this.blobPurpose(current) === 'share-put'
        ? (this.incoming.get(transferId)?.plans.filter((p) => !p.isDir).length ?? 0)
        : 0
    // 本机已作废供流上下文的取消终态，不接受迟到 ACK / 数据面回调覆盖（决议 #236）。
    // 对端取消后 outgoing 仍保留，若数据其实已经完整送达，served 仍可按数据面结论收口。
    if (
      current.status === 'canceled' &&
      status !== 'canceled' &&
      status !== 'expired' &&
      !this.outgoing.has(transferId)
    ) {
      return
    }
    this.deps.transferRepo.updateStatus(transferId, status)
    const keepFailedOutgoing =
      status === 'failed' &&
      current.direction === 'out' &&
      current.expires_at > Date.now() &&
      this.outgoing.has(transferId)
    if (!keepFailedOutgoing) this.outgoing.delete(transferId)
    // failed 保留 incoming 供「继续」，canceled 保留供「重新下载」（决议 #211）；
    // 远端主动取消 / 撤回等终态由调用方显式 delete。
    if (status !== 'failed' && status !== 'canceled') this.incoming.delete(transferId)
    if (
      current.direction === 'out' &&
      ![...this.outgoing.values()].some((item) => item.msgId === current.msg_id)
    ) {
      this.deps.transferRepo.deleteOutgoingManifest(current.msg_id)
    }
    this.emitTransfer(transferId, true)
    this.lastEmit.delete(transferId)
    this.scheduleExpiry()
    if (uploadedCount > 0) this.announceShareUpload(transferId, current.peer_id, uploadedCount)
  }

  private blobPurpose(row: { files: string }): FilesBlob['purpose'] {
    try {
      return (JSON.parse(row.files) as FilesBlob).purpose
    } catch {
      return undefined
    }
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

  private discardIncomingContext(transferId: string): void {
    this.incoming.delete(transferId)
    this.updateBlob(transferId, { plans: undefined })
    this.clearTerminalExpiry(transferId)
    this.emitTransfer(transferId, true)
  }

  private clearTerminalExpiry(transferId: string): void {
    this.deps.transferRepo.clearExpiry(transferId)
    this.scheduleExpiry()
  }

  private markDirect(transferId: string, directPeerName: string): void {
    this.updateBlob(transferId, {
      direct: true,
      ...(directPeerName ? { directPeerName } : {})
    })
    this.emitTransfer(transferId, true)
  }

  private updateDir(): string {
    return this.deps.getUpdateDir?.() ?? join(tmpdir(), 'teahouse-updates')
  }

  private peerDirName(peerId: string): string {
    return sanitizeDirName(this.deps.peerDisplayName?.(peerId) || peerId)
  }

  private peerSupportsMediaRecall(peerId: string): boolean {
    const caps = this.deps.registry.get(peerId)?.profile.caps
    return Array.isArray(caps) && caps.includes(CAPS.mediaRecall)
  }

  private peerSupportsTableText(peerId: string): boolean {
    const caps = this.deps.registry.get(peerId)?.profile.caps
    return Array.isArray(caps) && caps.includes(CAPS.tableText)
  }

  private peerSupportsTransferWait(peerId: string): boolean {
    const caps = this.deps.registry.get(peerId)?.profile.caps
    return Array.isArray(caps) && caps.includes(CAPS.transferWait)
  }

  private defaultReceiveDir(peerId: string): string {
    return join(this.deps.getSaveDir(), this.peerDirName(peerId))
  }

  /** 节流 250ms 推卡片状态；force 用于状态切换（必达） */
  private emitTransfer(transferId: string, force: boolean): void {
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(transferId) ?? 0) < 250) return
    this.lastEmit.set(transferId, now)
    const view = this.transferView(transferId)
    if (view) {
      if (force) this.deps.diagnostic?.('transfer.state', { transferId, msgId: view.msgId, peerId: view.peerId,
        direction: view.direction, status: view.queued ? 'queued' : view.status, bytes: view.bytesDone, total: view.totalSize, count: view.fileCount })
      this.emit('transfer', view)
    }
  }

  private applyMsgStatus(msgId: string, status: MessageView['status']): void {
    const row = this.deps.msgRepo.get(msgId)
    if (!row) return
    if (row.status === 'recalled' && status !== 'recalled') return
    if (row.status === 'canceled' && status !== 'recalled') return
    // issue #3：'sent'（accept / 数据送达已确认）是成功终态，迟到的 offer-ACK 'failed' 不再覆盖
    if (row.status === 'sent' && status === 'failed') return
    this.deps.msgRepo.updateStatus(msgId, status)
    const event: MsgStatusEvent = { id: msgId, convId: row.conv_id, status }
    this.emit('status', event)
  }

  private emitConvs(): void {
    if (this.convsScheduled) return
    this.convsScheduled = true
    queueMicrotask(() => {
      this.convsScheduled = false
      this.emit('convs', this.deps.convRepo.list().map(convRowToView))
    })
  }
}

function parseFilesBlob(raw: string): FilesBlob {
  try {
    const parsed = JSON.parse(raw) as FilesBlob
    return parsed && typeof parsed === 'object' ? parsed : { name: '' }
  } catch {
    return { name: '' }
  }
}

function parseOutgoingManifest(raw: string): Map<string, OutgoingFile> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const files = new Map<string, OutgoingFile>()
    for (const item of parsed) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as OutgoingFile).fileId !== 'string' ||
        !(item as OutgoingFile).fileId ||
        typeof (item as OutgoingFile).absPath !== 'string' ||
        !(item as OutgoingFile).absPath ||
        !Number.isSafeInteger((item as OutgoingFile).size) ||
        (item as OutgoingFile).size < 0 ||
        files.has((item as OutgoingFile).fileId)
      ) {
        return null
      }
      const file = item as OutgoingFile
      files.set(file.fileId, { fileId: file.fileId, absPath: file.absPath, size: file.size })
    }
    return files
  } catch {
    return null
  }
}

function parseIncomingPlans(value: unknown): IncomingFilePlan[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const ids = new Set<string>()
  const plans: IncomingFilePlan[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const plan = item as IncomingFilePlan
    if (
      typeof plan.fileId !== 'string' ||
      !plan.fileId ||
      ids.has(plan.fileId) ||
      typeof plan.relPath !== 'string' ||
      sanitizeRelPath(plan.relPath) !== plan.relPath ||
      !Number.isSafeInteger(plan.size) ||
      plan.size < 0 ||
      (plan.isDir !== undefined && typeof plan.isDir !== 'boolean')
    ) {
      return null
    }
    ids.add(plan.fileId)
    plans.push({
      fileId: plan.fileId,
      relPath: plan.relPath,
      size: plan.size,
      ...(plan.isDir !== undefined ? { isDir: plan.isDir } : {})
    })
  }
  return plans
}

function messageKindForPurpose(purpose: FileCtlOffer['purpose']): 'file' | 'image' | 'sticker' {
  return purpose === 'image' || purpose === 'sticker' ? purpose : 'file'
}

function normalizeTableTextMeta(
  purpose: FileCtlOffer['purpose'],
  meta?: TableTextMeta
): TableTextMeta | undefined {
  if (purpose !== 'image' || !meta?.tableText) return undefined
  const truncated = truncateUtf8(meta.tableText, TABLE_TEXT_LIMIT_BYTES)
  return {
    tableText: truncated.text,
    ...(meta.tableTextTruncated || truncated.truncated ? { tableTextTruncated: true } : {})
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
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

function mediaTransferIds(row: MsgRow): string[] {
  if (row.kind !== 'file' && row.kind !== 'image') return []
  if (!row.file_ref) return []
  try {
    const ref = JSON.parse(row.file_ref) as FileRefView
    const ids = Array.isArray(ref.transferIds) && ref.transferIds.length > 0
      ? ref.transferIds
      : [ref.transferId]
    return ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

// eslint-disable-next-line no-control-regex
const BAD_DIR_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f/\\]+/g

function sanitizeDirName(name: string): string {
  const clean = name
    .replace(BAD_DIR_SEGMENT_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim()
  if (!clean || clean === '.' || clean === '..') return '未知节点'
  return clean
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
