import type DatabaseT from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { DataExportOptions, DataImportResult, ExportFormat } from '../../shared/ipc'
import { GROUP_MAX_MEMBERS, LIMITS, isAvatarHash } from '../../shared/protocol'
import { parsePkRef, pkResultText, pkTitle } from '../../shared/pk'
import { toFtsTokens } from '../store/fts'
import { isPathInsideAny } from '../util/path-policy'
import { readZip, writeStoreZip, type ZipEntry } from '../util/zip-store'
import { avatarHashOf, isValidAvatarBytes } from './avatar-store'

interface MessageDump {
  id: string
  convId: string
  senderId: string
  isMine: boolean
  kind: string
  content: string
  fileRef: string | null
  ts: number
  status: string
}

interface ConvDump {
  id: string
  type: string
  peerId: string
  lastTs: number
  unread?: number
  pinned?: number
  muted?: number
  mentioned?: number
}

interface PeerDump {
  nodeId: string
  nick: string
  remark: string
  company: string
  dept: string
  team: string
  avatar: number
  avatarHash?: string
  host: string
  platform: string
  ip: string
  udpPort: number
  tcpPort: number
  profileRev: number
  caps: string
  ver: string
  firstSeen: number
  lastSeen: number
}

interface Manifest {
  formatVer: 1
  exportedAt: number
  exportedBy: string
  nick: string
  avatarHash?: string
  counts: {
    conversations: number
    messages: number
    peers: number
    groups: number
    stickers: number
    transfers: number
    media: number
  }
}

interface GroupDump {
  groupId: string
  name: string
  members: string[]
  rev: number
  updatedBy: string
  updatedTs: number
  creatorIp?: string
  creatorId?: string
  ownerId?: string
  adminIds?: string[]
  avatarHash?: string
  adminSecretHash?: string
  adminHint?: string
  description?: string
  announce?: string
}

interface StickerDump {
  id: string
  path: string
  w: number
  h: number
  animated: number
  sort: number
  added: number
  archivePath?: string
}

interface TransferDump {
  transferId: string
  msgId: string
  peerId: string
  direction: string
  files: string
  status: string
  bytesDone: number
  total: number
  ts: number
  expiresAt?: number
  archivePath?: string
}

interface FilesBlob {
  name?: string
  savedPath?: string
}

interface ImportStatements {
  peerUpsert: DatabaseT.Statement
  groupUpsert: DatabaseT.Statement
  groupGet: DatabaseT.Statement
  convUpsert: DatabaseT.Statement
  transferInsert: DatabaseT.Statement
  stickerInsert: DatabaseT.Statement
  messageExists: DatabaseT.Statement
  messageInsert: DatabaseT.Statement
  messageFtsInsert: DatabaseT.Statement
  convBump: DatabaseT.Statement
  maxMessageSeq: DatabaseT.Statement
}

export class PorterService {
  constructor(
    private readonly db: DatabaseT.Database,
    private readonly selfId: string,
    private readonly nick: string,
    private readonly mediaDir: string,
    private readonly extraMediaRoots: string[] = [],
    private readonly avatarDir = '',
    private readonly selfAvatarHash = ''
  ) {}

  private managedMediaRoots(): string[] {
    return [this.mediaDir, ...this.extraMediaRoots]
  }

  export(format: ExportFormat, path: string, options?: DataExportOptions): void {
    if (format === 'backup') {
      this.exportBackup(path, options)
      return
    }
    const messages = this.messages(options)
    writeFileSync(path, format === 'html' ? this.renderHtml(messages) : this.renderText(messages))
  }

  importBackup(path: string): DataImportResult {
    const entries = readZip(path)
    const manifest = this.parseJson<Manifest>(entries.get('manifest.json'))
    if (!manifest || manifest.formatVer !== 1 || !manifest.exportedBy) {
      throw new Error('bad-backup:manifest')
    }
    const convs = this.parseJsonl<ConvDump>(entries.get('conversations.jsonl'))
    const peers = this.parseJsonl<PeerDump>(entries.get('peers.jsonl'))
    const messages = this.parseJsonl<MessageDump>(entries.get('messages.jsonl'))
    const groups = this.parseJsonl<GroupDump>(entries.get('groups.jsonl'))
    const stickers = this.parseJsonl<StickerDump>(entries.get('stickers.jsonl'))
    const transfers = this.parseJsonl<TransferDump>(entries.get('transfers.jsonl'))
    this.restoreAvatars(entries, this.avatarHashes(peers, groups, manifest.avatarHash))
    const statements = this.prepareImportStatements()
    let nextSeq =
      ((statements.maxMessageSeq.get() as { seq?: number } | undefined)?.seq ?? 0) + 1

    const tx = this.db.transaction(() => {
      for (const peer of peers) this.importPeer(peer, statements)
      for (const group of groups) this.importGroup(group, manifest.exportedBy, statements)
      for (const conv of convs) this.importConv(conv, manifest.exportedBy, statements)
      for (const transfer of transfers) this.importTransfer(transfer, entries, manifest.exportedBy, statements)
      for (const sticker of stickers) this.importSticker(sticker, entries, statements)
      let imported = 0
      let skipped = 0
      for (const msg of messages) {
        if (this.importMessage(msg, manifest.exportedBy, statements, nextSeq)) {
          imported += 1
          nextSeq += 1
        } else {
          skipped += 1
        }
      }
      return { imported, skipped }
    })
    const result = tx() as DataImportResult
    if (
      isAvatarHash(manifest.avatarHash) &&
      this.avatarDir &&
      existingFile(join(this.avatarDir, `${manifest.avatarHash}.webp`))
    ) {
      result.profileAvatarHash = manifest.avatarHash
    }
    return result
  }

  private exportBackup(path: string, options?: DataExportOptions): void {
    const conversations = this.conversations(options)
    const messages = this.messages(options)
    const peers = this.peers()
    const groups = this.groups()
    const stickers = this.stickers()
    const transfers = this.transfers(messages)
    const avatarHashes = this.avatarHashes(peers, groups, this.selfAvatarHash)
    const mediaEntries = new Set(transfers.filter((t) => t.archivePath).map((t) => t.archivePath as string))
    for (const sticker of stickers) {
      if (sticker.archivePath) mediaEntries.add(sticker.archivePath)
    }
    for (const hash of avatarHashes) {
      if (this.avatarEntry(hash)) mediaEntries.add(`media/avatars/${hash}.webp`)
    }
    const manifest: Manifest = {
      formatVer: 1,
      exportedAt: Date.now(),
      exportedBy: this.selfId,
      nick: this.nick,
      ...(isAvatarHash(this.selfAvatarHash) ? { avatarHash: this.selfAvatarHash } : {}),
      counts: {
        conversations: conversations.length,
        messages: messages.length,
        peers: peers.length,
        groups: groups.length,
        stickers: stickers.length,
        transfers: transfers.length,
        media: mediaEntries.size
      }
    }
    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: 'conversations.jsonl', data: Buffer.from(jsonl(conversations), 'utf8') },
      { name: 'messages.jsonl', data: Buffer.from(jsonl(messages), 'utf8') },
      { name: 'peers.jsonl', data: Buffer.from(jsonl(peers), 'utf8') },
      { name: 'groups.jsonl', data: Buffer.from(jsonl(groups), 'utf8') },
      { name: 'stickers.jsonl', data: Buffer.from(jsonl(stickers), 'utf8') },
      { name: 'transfers.jsonl', data: Buffer.from(jsonl(transfers), 'utf8') }
    ]
    for (const transfer of transfers) {
      if (transfer.archivePath) this.addMediaEntry(entries, transfer.archivePath, savedPathOf(transfer.files))
    }
    for (const sticker of stickers) {
      if (sticker.archivePath) this.addMediaEntry(entries, sticker.archivePath, sticker.path)
    }
    for (const hash of avatarHashes) {
      const entry = this.avatarEntry(hash)
      if (entry) entries.push(entry)
    }
    writeStoreZip(path, entries)
  }

  private conversations(options?: DataExportOptions): ConvDump[] {
    const where = options?.convId ? 'WHERE id = ?' : ''
    const params = options?.convId ? [options.convId] : []
    return this.db
      .prepare(
        `SELECT id, type, peer_or_group_id AS peerId, last_ts AS lastTs,
                unread, pinned, muted, mentioned
         FROM conversations ${where} ORDER BY last_ts ASC`
      )
      .all(...params) as ConvDump[]
  }

  private messages(options?: DataExportOptions): MessageDump[] {
    const { clause, params } = messageWhere(options)
    const rows = this.db
      .prepare(
        `SELECT id, conv_id AS convId, sender_id AS senderId, is_mine AS isMine, kind,
                content, file_ref AS fileRef, ts, status
         FROM messages ${clause} ORDER BY seq ASC`
      )
      .all(...params) as Array<Omit<MessageDump, 'isMine'> & { isMine: number }>
    return rows.map((row) => ({ ...row, isMine: row.isMine !== 0 }))
  }

  private peers(): PeerDump[] {
    return this.db
      .prepare(
        `SELECT node_id AS nodeId, nick, COALESCE(remark, '') AS remark, company, dept, team,
                avatar, avatar_hash AS avatarHash, host, platform, ip,
                udp_port AS udpPort, tcp_port AS tcpPort,
                profile_rev AS profileRev, caps, ver, first_seen AS firstSeen, last_seen AS lastSeen
         FROM peers ORDER BY last_seen ASC`
      )
      .all() as PeerDump[]
  }

  private groups(): GroupDump[] {
    const rows = this.db
      .prepare(
        `SELECT group_id AS groupId, name, members, rev, updated_by AS updatedBy,
                updated_ts AS updatedTs, creator_ip AS creatorIp,
                creator_id AS creatorId,
                owner_id AS ownerId, admin_ids AS adminIds, avatar_hash AS avatarHash,
                admin_secret_hash AS adminSecretHash, admin_hint AS adminHint,
                description, announce
         FROM groups ORDER BY updated_ts ASC`
      )
      .all() as Array<Omit<GroupDump, 'members' | 'adminIds'> & { members: string; adminIds: string }>
    return rows.map((row) => {
      const members = [...new Set(parseStringArray(row.members))]
      const ownerId = [row.ownerId, row.creatorId, row.updatedBy].find(
        (id): id is string => typeof id === 'string' && members.includes(id)
      ) ?? members[0] ?? ''
      return {
        ...row,
        members,
        ownerId,
        adminIds: [...new Set(parseStringArray(row.adminIds))].filter(
          (id) => id !== ownerId && members.includes(id)
        ),
        description:
          typeof row.description === 'string'
            ? row.description.trim().slice(0, LIMITS.groupDescription)
            : '',
        announce:
          typeof row.announce === 'string'
            ? row.announce.trim().slice(0, LIMITS.groupAnnounce)
            : ''
      }
    })
  }

  private stickers(): StickerDump[] {
    const rows = this.db
      .prepare(
        `SELECT id, path, w, h, animated, sort, added
         FROM stickers ORDER BY sort ASC, added ASC`
      )
      .all() as StickerDump[]
    return rows.map((row) => {
      const archivePath = existingFile(row.path) && this.isManagedMediaPath(row.path)
        ? `media/stickers/${safeName(row.id)}${extname(row.path) || '.bin'}`
        : undefined
      return { ...row, archivePath }
    })
  }

  private transfers(messages: MessageDump[]): TransferDump[] {
    const mediaTransferIds = new Set(
      messages
        .filter((msg) => msg.kind === 'image' || msg.kind === 'sticker')
        .map((msg) => transferIdOf(msg.fileRef))
        .filter((id): id is string => !!id)
    )
    const rows = this.db
      .prepare(
        `SELECT transfer_id AS transferId, msg_id AS msgId, peer_id AS peerId,
                direction, files, status, bytes_done AS bytesDone, total, ts,
                expires_at AS expiresAt
         FROM transfers ORDER BY ts ASC`
      )
      .all() as TransferDump[]
    return rows.map((row) => {
      const savedPath = savedPathOf(row.files)
      const archivePath =
        mediaTransferIds.has(row.transferId) &&
        existingFile(savedPath) &&
        this.isManagedMediaPath(savedPath)
          ? `media/transfers/${safeName(row.transferId)}${extname(savedPath) || '.bin'}`
          : undefined
      return { ...row, archivePath }
    })
  }

  private prepareImportStatements(): ImportStatements {
    return {
      peerUpsert: this.db.prepare(
        `INSERT INTO peers
         (node_id, nick, remark, company, dept, team, avatar, avatar_hash, host, platform, ip,
          udp_port, tcp_port, profile_rev, caps, ver, first_seen, last_seen)
         VALUES (@nodeId, @nick, @remark, @company, @dept, @team, @avatar, @avatarHash, @host, @platform, @ip,
                 @udpPort, @tcpPort, @profileRev, @caps, @ver, @firstSeen, @lastSeen)
         ON CONFLICT(node_id) DO UPDATE SET
           nick = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.nick ELSE peers.nick END,
           company = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.company ELSE peers.company END,
           dept = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.dept ELSE peers.dept END,
           team = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.team ELSE peers.team END,
           avatar = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.avatar ELSE peers.avatar END,
           avatar_hash = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.avatar_hash ELSE peers.avatar_hash END,
           host = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.host ELSE peers.host END,
           platform = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.platform ELSE peers.platform END,
           ip = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.ip ELSE peers.ip END,
           udp_port = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.udp_port ELSE peers.udp_port END,
           tcp_port = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.tcp_port ELSE peers.tcp_port END,
           profile_rev = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.profile_rev ELSE peers.profile_rev END,
           caps = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.caps ELSE peers.caps END,
           ver = CASE WHEN excluded.last_seen >= peers.last_seen THEN excluded.ver ELSE peers.ver END,
           first_seen = MIN(peers.first_seen, excluded.first_seen),
           last_seen = MAX(peers.last_seen, excluded.last_seen)`
      ),
      groupUpsert: this.db.prepare(
        `INSERT INTO groups (
           group_id, name, members, rev, updated_by, updated_ts,
           creator_ip, creator_id, owner_id, admin_ids, avatar_hash, admin_secret_hash, admin_hint,
           description, announce
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           name = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.name ELSE groups.name END,
           members = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.members ELSE groups.members END,
           rev = MAX(groups.rev, excluded.rev),
           updated_by = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.updated_by ELSE groups.updated_by END,
           updated_ts = MAX(groups.updated_ts, excluded.updated_ts),
           creator_ip = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.creator_ip ELSE groups.creator_ip END,
           creator_id = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.creator_id ELSE groups.creator_id END,
           owner_id = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.owner_id ELSE groups.owner_id END,
           admin_ids = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.admin_ids ELSE groups.admin_ids END,
           avatar_hash = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.avatar_hash ELSE groups.avatar_hash END,
           admin_secret_hash = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.admin_secret_hash ELSE groups.admin_secret_hash END,
           admin_hint = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.admin_hint ELSE groups.admin_hint END,
           description = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.description ELSE groups.description END,
           announce = CASE
             WHEN excluded.rev > groups.rev OR (excluded.rev = groups.rev AND excluded.updated_ts >= groups.updated_ts)
             THEN excluded.announce ELSE groups.announce END`
      ),
      groupGet: this.db.prepare('SELECT description, announce FROM groups WHERE group_id = ?'),
      convUpsert: this.db.prepare(
        `INSERT INTO conversations (id, type, peer_or_group_id, last_ts, pinned, muted, mentioned)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_ts = MAX(conversations.last_ts, excluded.last_ts),
           pinned = MAX(conversations.pinned, excluded.pinned),
           muted = MAX(conversations.muted, excluded.muted),
           mentioned = MAX(conversations.mentioned, excluded.mentioned)`
      ),
      transferInsert: this.db.prepare(
        `INSERT OR IGNORE INTO transfers
         (transfer_id, msg_id, peer_id, direction, files, status, bytes_done, total, ts, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      stickerInsert: this.db.prepare(
        `INSERT OR IGNORE INTO stickers (id, path, w, h, animated, sort, added)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      messageExists: this.db.prepare('SELECT 1 FROM messages WHERE id = ?'),
      messageInsert: this.db.prepare(
        `INSERT INTO messages (id, conv_id, sender_id, is_mine, kind, content, file_ref, ts, seq, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      messageFtsInsert: this.db.prepare('INSERT INTO messages_fts (msg_id, text) VALUES (?, ?)'),
      convBump: this.db.prepare('UPDATE conversations SET last_ts = MAX(last_ts, ?) WHERE id = ?'),
      maxMessageSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages')
    }
  }

  private importPeer(peer: PeerDump, statements: ImportStatements): void {
    if (!peer.nodeId || peer.nodeId === this.selfId) return
    statements.peerUpsert.run({
      ...peer,
      avatarHash: isAvatarHash(peer.avatarHash) ? peer.avatarHash : ''
    })
  }

  private importGroup(group: GroupDump, exportedBy: string, statements: ImportStatements): void {
    if (!group.groupId || !group.name) return
    const members = group.members.map((id) => (id === exportedBy ? this.selfId : id))
    const updatedBy = group.updatedBy === exportedBy ? this.selfId : group.updatedBy
    const creatorId = group.creatorId === exportedBy ? this.selfId : group.creatorId
    const normalizedMembers = [...new Set(members)].filter((id) => id.length > 0).slice(0, GROUP_MAX_MEMBERS)
    const importedOwnerId = group.ownerId === exportedBy ? this.selfId : group.ownerId
    const ownerId = [importedOwnerId, creatorId, updatedBy].find(
      (id): id is string => typeof id === 'string' && normalizedMembers.includes(id)
    ) ?? normalizedMembers[0] ?? ''
    const adminIds = [...new Set((group.adminIds ?? []).map((id) =>
      id === exportedBy ? this.selfId : id
    ))].filter((id) => id !== ownerId && normalizedMembers.includes(id))
    const adminSecretHash =
      typeof group.adminSecretHash === 'string' ? group.adminSecretHash.slice(0, 64) : ''
    const adminHint =
      adminSecretHash && typeof group.adminHint === 'string' ? group.adminHint.slice(0, 40) : ''
    const local = statements.groupGet.get(group.groupId) as
      | { description?: unknown; announce?: unknown }
      | undefined
    const description =
      typeof group.description === 'string'
        ? group.description.trim().slice(0, LIMITS.groupDescription)
        : typeof local?.description === 'string'
          ? local.description.trim().slice(0, LIMITS.groupDescription)
          : ''
    const announce =
      typeof group.announce === 'string'
        ? group.announce.trim().slice(0, LIMITS.groupAnnounce)
        : typeof local?.announce === 'string'
          ? local.announce.trim().slice(0, LIMITS.groupAnnounce)
          : ''
    statements.groupUpsert.run(
      group.groupId,
      group.name.slice(0, 64),
      JSON.stringify(normalizedMembers),
      Number.isInteger(group.rev) ? group.rev : 1,
      updatedBy,
      Number.isInteger(group.updatedTs) ? group.updatedTs : Date.now(),
      typeof group.creatorIp === 'string' ? group.creatorIp.slice(0, 45) : '',
      typeof creatorId === 'string' ? creatorId.slice(0, 64) : updatedBy,
      ownerId,
      JSON.stringify(adminIds),
      isAvatarHash(group.avatarHash) ? group.avatarHash : '',
      adminSecretHash,
      adminHint,
      description,
      announce
    )
  }

  private importConv(conv: ConvDump, exportedBy: string, statements: ImportStatements): void {
    const peerId = conv.peerId === exportedBy ? this.selfId : conv.peerId
    const id = conv.id === `single:${exportedBy}` ? `single:${this.selfId}` : conv.id
    statements.convUpsert.run(
      id,
      conv.type === 'group' ? 'group' : 'single',
      peerId,
      conv.lastTs,
      conv.pinned ? 1 : 0,
      conv.muted ? 1 : 0,
      conv.mentioned ? 1 : 0
    )
  }

  private importTransfer(
    transfer: TransferDump,
    entries: Map<string, Buffer>,
    exportedBy: string,
    statements: ImportStatements
  ): void {
    if (!transfer.transferId || !transfer.msgId) return
    const restored = transfer.archivePath
      ? this.restoreMedia(entries, transfer.archivePath, `transfer-${transfer.transferId}`)
      : null
    const files = rewriteFilesBlob(transfer.files, restored)
    const peerId = transfer.peerId === exportedBy ? this.selfId : transfer.peerId
    statements.transferInsert.run(
      transfer.transferId,
      transfer.msgId,
      peerId,
      transfer.direction === 'in' ? 'in' : 'out',
      files,
      normalizeTransferStatus(transfer.status),
      clampInt(transfer.bytesDone, 0),
      clampInt(transfer.total, 0),
      clampInt(transfer.ts, Date.now()),
      clampInt(transfer.expiresAt, 0)
    )
  }

  private importSticker(sticker: StickerDump, entries: Map<string, Buffer>, statements: ImportStatements): void {
    if (!sticker.id) return
    const restored = sticker.archivePath
      ? this.restoreMedia(entries, sticker.archivePath, `sticker-${sticker.id}`)
      : null
    const path = restored ?? ''
    if (!path) return
    statements.stickerInsert.run(
      sticker.id,
      path,
      clampInt(sticker.w, 0),
      clampInt(sticker.h, 0),
      sticker.animated ? 1 : 0,
      clampInt(sticker.sort, 0),
      clampInt(sticker.added, Date.now())
    )
  }

  private importMessage(
    msg: MessageDump,
    exportedBy: string,
    statements: ImportStatements,
    seq: number
  ): boolean {
    if (!msg.id || !msg.convId) return false
    const exists = statements.messageExists.get(msg.id)
    if (exists) return false
    const senderId = msg.senderId === exportedBy ? this.selfId : msg.senderId
    const convId = msg.convId === `single:${exportedBy}` ? `single:${this.selfId}` : msg.convId
    const isMine = senderId === this.selfId || msg.isMine
    const kind = normalizeKind(msg.kind)
    statements.messageInsert.run(
      msg.id,
      convId,
      senderId,
      isMine ? 1 : 0,
      kind,
      msg.content ?? '',
      msg.fileRef ?? null,
      msg.ts,
      seq,
      msg.status === 'recalled' ? 'recalled' : msg.status === 'canceled' ? 'canceled' : 'sent'
    )
    const tokens = kind === 'system' ? '' : toFtsTokens(msg.content ?? '')
    if (tokens) statements.messageFtsInsert.run(msg.id, tokens)
    statements.convBump.run(msg.ts, convId)
    return true
  }

  private addMediaEntry(entries: ZipEntry[], archivePath: string, sourcePath: string | null): void {
    if (!sourcePath || !existingFile(sourcePath)) return
    if (!this.isManagedMediaPath(sourcePath)) return
    if (entries.some((entry) => entry.name === archivePath)) return
    entries.push({ name: archivePath, data: readFileSync(sourcePath) })
  }

  private avatarHashes(
    peers: PeerDump[],
    groups: GroupDump[],
    additional?: string
  ): string[] {
    return [...new Set([
      ...peers.map((peer) => peer.avatarHash),
      ...groups.map((group) => group.avatarHash),
      additional
    ].filter(isAvatarHash))]
  }

  private avatarEntry(hash: string): ZipEntry | null {
    if (!this.avatarDir || !isAvatarHash(hash)) return null
    const path = join(this.avatarDir, `${hash}.webp`)
    if (!existingFile(path)) return null
    try {
      const data = readFileSync(path)
      if (!isValidAvatarBytes(data) || avatarHashOf(data) !== hash) return null
      return { name: `media/avatars/${hash}.webp`, data }
    } catch {
      return null
    }
  }

  private restoreAvatars(entries: Map<string, Buffer>, hashes: string[]): void {
    if (!this.avatarDir) return
    mkdirSync(this.avatarDir, { recursive: true })
    for (const hash of hashes) {
      const data = entries.get(`media/avatars/${hash}.webp`)
      if (!data || !isValidAvatarBytes(data) || avatarHashOf(data) !== hash) continue
      const target = join(this.avatarDir, `${hash}.webp`)
      try {
        if (existsSync(target)) {
          const current = readFileSync(target)
          if (isValidAvatarBytes(current) && avatarHashOf(current) === hash) continue
          unlinkSync(target)
        }
        const temporary = join(this.avatarDir, `${hash}.${randomUUID()}.tmp`)
        writeFileSync(temporary, data, { flag: 'wx' })
        renameSync(temporary, target)
      } catch {
        // 单个头像损坏或写入失败不阻断聊天记录导入。
      }
    }
  }

  private isManagedMediaPath(path: string | null): path is string {
    return typeof path === 'string' && path.length > 0 && isPathInsideAny(path, this.managedMediaRoots())
  }

  private restoreMedia(
    entries: Map<string, Buffer>,
    archivePath: string,
    prefix: string
  ): string | null {
    const data = entries.get(archivePath)
    if (!data) return null
    mkdirSync(this.mediaDir, { recursive: true })
    const ext = extname(archivePath) || '.bin'
    const out = join(this.mediaDir, `${safeName(prefix)}-${randomUUID()}${ext}`)
    writeFileSync(out, data)
    return out
  }

  private parseJson<T>(buf: Buffer | undefined): T | null {
    if (!buf) return null
    try {
      return JSON.parse(buf.toString('utf8')) as T
    } catch {
      return null
    }
  }

  private parseJsonl<T>(buf: Buffer | undefined): T[] {
    if (!buf) return []
    return buf
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T)
  }

  private renderText(messages: MessageDump[]): string {
    return messages
      .map((msg) => `${new Date(msg.ts).toLocaleString('zh-CN')} ${msg.isMine ? '我' : msg.senderId}: ${messageLabel(msg)}`)
      .join('\n')
  }

  private renderHtml(messages: MessageDump[]): string {
    const title = `茶话间导出-${new Date().toLocaleString('zh-CN')}`
    const rows = messages
      .map(
        (msg) =>
          `<p><time>${escapeHtml(new Date(msg.ts).toLocaleString('zh-CN'))}</time> <b>${escapeHtml(
            msg.isMine ? '我' : msg.senderId
          )}</b>: ${escapeHtml(messageLabel(msg))}</p>`
      )
      .join('\n')
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
      title
    )}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;line-height:1.6;max-width:920px;margin:32px auto;color:#1a1a1a}time{color:#777;font-size:12px}p{border-bottom:1px solid #eee;padding:8px 0;white-space:pre-wrap}</style></head><body><h1>${escapeHtml(
      title
    )}</h1>${rows}</body></html>`
  }
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

function normalizeKind(kind: string): string {
  return kind === 'file' || kind === 'image' || kind === 'sticker' || kind === 'system' || kind === 'pk'
    ? kind
    : 'text'
}

function normalizeTransferStatus(status: string): string {
  return status === 'offering' ||
    status === 'accepted' ||
    status === 'done' ||
    status === 'declined' ||
    status === 'canceled' ||
    status === 'failed' ||
    status === 'expired'
    ? status
    : 'done'
}

function clampInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function transferIdOf(raw: string | null): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { transferId?: unknown }
    return typeof parsed.transferId === 'string' && parsed.transferId ? parsed.transferId : null
  } catch {
    return null
  }
}

function parseFilesBlob(raw: string): FilesBlob {
  try {
    const parsed = JSON.parse(raw) as FilesBlob
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function savedPathOf(raw: string): string | null {
  const blob = parseFilesBlob(raw)
  return typeof blob.savedPath === 'string' && blob.savedPath ? blob.savedPath : null
}

function rewriteFilesBlob(raw: string, restoredPath: string | null): string {
  const blob = parseFilesBlob(raw)
  if (restoredPath) {
    blob.savedPath = restoredPath
  } else {
    delete blob.savedPath
  }
  return JSON.stringify(blob)
}

function messageWhere(options?: DataExportOptions): { clause: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (options?.convId) {
    where.push('conv_id = ?')
    params.push(options.convId)
  }
  if (typeof options?.fromTs === 'number') {
    where.push('ts >= ?')
    params.push(options.fromTs)
  }
  if (typeof options?.toTs === 'number') {
    where.push('ts <= ?')
    params.push(options.toTs)
  }
  return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params }
}

function existingFile(path: string | null | undefined): path is string {
  return typeof path === 'string' && path.length > 0 && existsSync(path)
}

function safeName(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'media'
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function fileLabel(msg: MessageDump): string {
  if (!msg.fileRef) return msg.content
  try {
    const ref = JSON.parse(msg.fileRef) as { name?: string }
    return `[文件] ${basename(ref.name ?? '')}`
  } catch {
    return msg.content
  }
}

function messageLabel(msg: MessageDump): string {
  if (msg.kind === 'pk') {
    const ref = parsePkRef(msg.fileRef)
    return ref ? `${pkTitle(ref.game)}：${pkResultText(ref)}` : msg.content
  }
  return msg.content || fileLabel(msg)
}
