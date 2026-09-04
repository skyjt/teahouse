// 数据库自测：经 ELECTRON_RUN_AS_NODE 在 Electron 内置 Node 16.17 上执行，
// 验证 better-sqlite3 对 Electron 22 ABI 真实可用（npm run test:db）。
// 用 node:assert 而非 vitest —— vitest 跑在开发机新版 Node 上，加载不了 Electron ABI 的原生模块。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './db'
import { MIGRATIONS, applyMigrations } from './migrations'
import { PeersRepo } from './peers-repo'
import { ConvRepo } from './conv-repo'
import { MsgRepo } from './msg-repo'
import { QueueRepo } from './queue-repo'
import { DedupRepo } from './dedup-repo'
import { TransferRepo } from './transfer-repo'
import { GroupRepo } from './group-repo'
import { StickerRepo } from './sticker-repo'
import { ShareGrantsRepo } from './share-grants-repo'
import { toFtsQuery, toFtsTokens } from './fts'
import { SearchService } from '../services/search'
import { PorterService } from '../services/porter'
import { PeerRegistry } from '../net/peer-registry'
import type { PeerRecord } from '../net/peer-registry'
import { LIMITS } from '../../shared/protocol'
import { readZip, writeStoreZip } from '../util/zip-store'

function makePeer(name: string, rev = 1): PeerRecord {
  return {
    profile: {
      nodeId: `node-${name}`,
      nick: name,
      company: '某某科技',
      dept: '研发部',
      team: '后端组',
      avatar: -1,
      profileRev: rev,
      host: `${name}-pc`,
      platform: 'win',
      tcpPort: 17879,
      ver: '0.1.0',
      caps: ['grp1']
    },
    ip: '10.0.0.8',
    udpPort: 17878,
    lastSeen: Date.now(),
    online: true
  }
}

function avatarWebp(): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8 ', 12, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes[23] = 0x9d
  bytes[24] = 0x01
  bytes[25] = 0x2a
  bytes.writeUInt16LE(192, 26)
  bytes.writeUInt16LE(192, 28)
  return bytes
}

const dir = mkdtempSync(join(tmpdir(), 'pantry-dbtest-'))
const db = openDatabase(join(dir, 'chat.db'))

try {
  console.log(`[db-selftest] runtime node=${process.versions.node} abi=${process.versions.modules}`)

  // 1. 迁移就位
  assert.equal(db.pragma('user_version', { simple: true }), 16, '迁移版本应为 16')
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal', '应为 WAL 模式')
  const messageIndexes = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
  )
  assert.equal(messageIndexes.has('idx_messages_seq'), true, 'messages(seq) 索引应存在')
  assert.equal(messageIndexes.has('idx_messages_conv_seq'), true, 'messages(conv_id, seq) 索引应存在')
  const transferIndexes = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transfers'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
  )
  assert.equal(transferIndexes.has('idx_transfers_expiry'), true, '传输截止时间索引应存在')

  const legacyDbPath = join(dir, 'legacy-v10.db')
  const legacyDb = new Database(legacyDbPath)
  for (let index = 0; index < 10; index += 1) legacyDb.exec(MIGRATIONS[index])
  legacyDb.pragma('user_version = 10')
  legacyDb.prepare(
    `INSERT INTO groups (
       group_id, name, members, rev, updated_by, updated_ts,
       creator_ip, creator_id, admin_secret_hash, admin_hint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'g-v10',
    '旧群',
    JSON.stringify(['node-member', 'node-creator']),
    2,
    'node-member',
    1000,
    '10.0.0.1',
    'node-creator',
    '',
    ''
  )
  applyMigrations(legacyDb)
  assert.equal(legacyDb.pragma('user_version', { simple: true }), 16, 'v10 数据库应迁移至 v16')
  const migratedGroup = new GroupRepo(legacyDb).get('g-v10')
  assert.equal(migratedGroup?.ownerId, 'node-creator', '旧群优先以仍在群内的创建者作为群主')
  assert.deepEqual(migratedGroup?.adminIds, [], '旧群管理员默认应为空')
  legacyDb.close()

  const legacyV11 = new Database(join(dir, 'legacy-v11.db'))
  for (let index = 0; index < 11; index += 1) legacyV11.exec(MIGRATIONS[index])
  legacyV11.pragma('user_version = 11')
  applyMigrations(legacyV11)
  assert.equal(legacyV11.pragma('user_version', { simple: true }), 16, 'v11 数据库应迁移至 v16')
  const peerColumns = legacyV11.pragma('table_info(peers)') as Array<{ name: string }>
  const groupColumns = legacyV11.pragma('table_info(groups)') as Array<{ name: string }>
  assert.equal(peerColumns.some((column) => column.name === 'avatar_hash'), true)
  assert.equal(groupColumns.some((column) => column.name === 'avatar_hash'), true)
  legacyV11.close()

  const legacyV12 = new Database(join(dir, 'legacy-v12.db'))
  for (let index = 0; index < 12; index += 1) legacyV12.exec(MIGRATIONS[index])
  legacyV12.pragma('user_version = 12')
  legacyV12.prepare(
    `INSERT INTO transfers
     (transfer_id, msg_id, peer_id, direction, files, status, bytes_done, total, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('legacy-transfer', 'legacy-message', 'node-bob', 'out', '{}', 'offering', 0, 10, 1)
  applyMigrations(legacyV12)
  assert.equal(legacyV12.pragma('user_version', { simple: true }), 16, 'v12 数据库应迁移至 v16')
  const legacyTransfer = legacyV12
    .prepare('SELECT expires_at FROM transfers WHERE transfer_id = ?')
    .get('legacy-transfer') as { expires_at: number }
  assert.equal(legacyTransfer.expires_at, 0, '旧传输默认无可恢复领取期限')
  assert.equal(
    (legacyV12.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outgoing_file_manifests'").get() as { name?: string } | undefined)?.name,
    'outgoing_file_manifests',
    'v13 应创建出站源文件清单表'
  )
  legacyV12.close()

  // v13 → v14：共享文件柜按人例外表（决议 #271/#277），老库升级后不得带任何既有例外
  const legacyV13 = new Database(join(dir, 'legacy-v13.db'))
  for (let index = 0; index < 13; index += 1) legacyV13.exec(MIGRATIONS[index])
  legacyV13.pragma('user_version = 13')
  applyMigrations(legacyV13)
  assert.equal(legacyV13.pragma('user_version', { simple: true }), 16, 'v13 数据库应迁移至 v16')
  const v14Grants = new ShareGrantsRepo(legacyV13)
  assert.equal(v14Grants.list().length, 0, '升级到 v14 不得凭空产生例外')
  legacyV13.close()

  // 2. 联系人 upsert / 载入往返
  const repo = new PeersRepo(db)
  repo.upsertMany([makePeer('alice'), makePeer('bob')])
  let loaded = repo.loadAll()
  assert.equal(loaded.length, 2)
  assert.equal(loaded.every((p) => p.online === false), true, '载入应一律离线态')

  // 3. 资料更新覆盖、first_seen/remark 不被覆盖
  const firstSeenBefore = (
    db.prepare('SELECT first_seen FROM peers WHERE node_id = ?').get('node-alice') as {
      first_seen: number
    }
  ).first_seen
  db.prepare('UPDATE peers SET remark = ? WHERE node_id = ?').run('备注-爱丽丝', 'node-alice')
  const updated = makePeer('alice', 2)
  updated.profile.nick = 'alice-改名'
  const avatarBytes = avatarWebp()
  const avatarHash = createHash('sha256').update(avatarBytes).digest('hex')
  updated.profile.avatarHash = avatarHash
  repo.upsertMany([updated])
  loaded = repo.loadAll()
  const alice = loaded.find((p) => p.profile.nodeId === 'node-alice')
  assert.equal(alice?.profile.nick, 'alice-改名')
  assert.equal(alice?.profile.profileRev, 2)
  assert.equal(alice?.profile.avatarHash, avatarHash, '联系人头像哈希应往返')
  const rowAfter = db
    .prepare('SELECT first_seen, remark FROM peers WHERE node_id = ?')
    .get('node-alice') as { first_seen: number; remark: string }
  assert.equal(rowAfter.first_seen, firstSeenBefore, 'first_seen 只写一次')
  assert.equal(rowAfter.remark, '备注-爱丽丝', 'remark 是本地资产，upsert 不得覆盖')

  // 4. FTS 中文按字检索往返
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, conv_id, sender_id, is_mine, kind, content, ts, seq, status)
    VALUES (?, ?, ?, 1, 'text', ?, ?, ?, 'sent')
  `)
  const insertFts = db.prepare('INSERT INTO messages_fts (msg_id, text) VALUES (?, ?)')
  const texts = ['需求文档v3发我一下', '今晚一起吃饭吗', '文档已经发你邮箱了']
  texts.forEach((text, i) => {
    const id = `msg-${i}`
    insertMsg.run(id, 'conv-1', 'node-alice', text, Date.now(), i)
    insertFts.run(id, toFtsTokens(text))
  })
  const hits = db
    .prepare('SELECT msg_id FROM messages_fts WHERE messages_fts MATCH ?')
    .all(toFtsQuery('文档')) as Array<{ msg_id: string }>
  assert.deepEqual(
    hits.map((h) => h.msg_id).sort(),
    ['msg-0', 'msg-2'],
    '「文档」应命中两条'
  )
  const none = db
    .prepare('SELECT msg_id FROM messages_fts WHERE messages_fts MATCH ?')
    .all(toFtsQuery('文邮')) as unknown[]
  assert.equal(none.length, 0, '非连续字不得命中（短语匹配）')

  // 5. 会话/消息 repo 往返
  const convRepo = new ConvRepo(db)
  const msgRepo = new MsgRepo(db)
  const convId = convRepo.ensureSingle('node-bob')
  assert.equal(convId, 'single:node-bob')
  convRepo.ensureSingle('node-bob') // 幂等
  assert.equal(
    msgRepo.insert({
      id: 'm-1',
      convId,
      senderId: 'me',
      isMine: true,
      kind: 'text',
      content: '第一条消息',
      ts: 1000,
      status: 'sending'
    }),
    true
  )
  assert.equal(
    msgRepo.insert({
      id: 'm-1',
      convId,
      senderId: 'me',
      isMine: true,
      kind: 'text',
      content: '重复插入',
      ts: 1000,
      status: 'sending'
    }),
    false,
    '消息主键幂等'
  )
  msgRepo.insert({
    id: 'm-2',
    convId,
    senderId: 'node-bob',
    isMine: false,
    kind: 'text',
    content: '回你一条',
    ts: 2000,
    status: 'sent'
  })
  convRepo.bump(convId, 2000)
  convRepo.incUnread(convId)
  // 验证群聊引用回复的 reply_to 字段往返（决议 #reply）
  const quotedMsg = msgRepo.get('m-1')
  assert.equal(quotedMsg?.reply_to, null, '无引用消息的 reply_to 应为 null')
  msgRepo.insert({
    id: 'm-reply',
    convId: 'group:g-1',
    senderId: 'me',
    isMine: true,
    kind: 'text',
    content: '我回复你',
    ts: 3000,
    status: 'sent',
    replyTo: 'm-1'
  })
  const rowWithQuote = msgRepo.get('m-reply')
  assert.equal(rowWithQuote?.reply_to, 'm-1', 'reply_to 列应存储引用消息ID')
  const { msgRowToView } = require('./msg-repo')
  const viewWithQuote = msgRowToView(rowWithQuote!)
  assert.equal(viewWithQuote.replyTo, 'm-1')
  const conv = convRepo.get(convId)
  assert.equal(conv?.unread, 1)
  assert.equal(conv?.preview, '回你一条', '会话摘要应为最新一条')
  assert.deepEqual(
    msgRepo.page(convId, null, 10).map((m) => m.id),
    ['m-1', 'm-2'],
    '分页按时间升序'
  )
  msgRepo.updateStatus('m-1', 'sent')
  assert.equal(msgRepo.get('m-1')?.status, 'sent')
  assert.equal(msgRepo.recall('m-1'), true, '撤回应更新原消息')
  assert.equal(msgRepo.get('m-1')?.status, 'recalled')
  assert.equal(msgRepo.get('m-1')?.content, '', '撤回后原正文不再保留在消息行')
  const recalledHits = db
    .prepare('SELECT msg_id FROM messages_fts WHERE messages_fts MATCH ?')
    .all(toFtsQuery('第一条')) as unknown[]
  assert.equal(recalledHits.length, 0, '撤回后原正文不得继续被 FTS 搜到')
  convRepo.markRead(convId)
  assert.equal(convRepo.get(convId)?.unread, 0)

  // 5b. 移除聊天：deleteByConv 删除会话全部消息 + 全文索引（决议 #125）
  const delConvId = convRepo.ensureSingle('node-del')
  msgRepo.insert({
    id: 'm-del-1',
    convId: delConvId,
    senderId: 'node-del',
    isMine: false,
    kind: 'text',
    content: '待删除的机密内容',
    ts: 3000,
    status: 'sent'
  })
  assert.equal(msgRepo.page(delConvId, null, 10).length, 1, '删除前应有一条消息')
  const delHitsBefore = db
    .prepare('SELECT msg_id FROM messages_fts WHERE messages_fts MATCH ?')
    .all(toFtsQuery('机密')) as unknown[]
  assert.equal(delHitsBefore.length, 1, '删除前正文应能被 FTS 搜到')
  msgRepo.deleteByConv(delConvId)
  assert.equal(msgRepo.page(delConvId, null, 10).length, 0, 'deleteByConv 后消息应清空')
  const delHitsAfter = db
    .prepare('SELECT msg_id FROM messages_fts WHERE messages_fts MATCH ?')
    .all(toFtsQuery('机密')) as unknown[]
  assert.equal(delHitsAfter.length, 0, 'deleteByConv 后全文索引应一并清除')

  // 6. 补发队列与去重
  const queueRepo = new QueueRepo(db)
  queueRepo.enqueue('q-1', 'node-bob', '{"x":1}', Date.now() - 8 * 24 * 3_600_000) // 已过期
  queueRepo.enqueue('q-2', 'node-bob', '{"x":2}', Date.now())
  queueRepo.enqueue('q-2', 'node-carol', '{"x":2}', Date.now()) // 群消息：同 msgId 不同收件人
  assert.deepEqual(
    queueRepo.prune(7 * 24 * 3_600_000, 200),
    [{ msgId: 'q-1', peerId: 'node-bob' }],
    '过期条目被裁剪'
  )
  assert.deepEqual(
    queueRepo.listByPeer('node-bob').map((i) => i.msgId),
    ['q-2']
  )
  queueRepo.remove('q-2', 'node-bob')
  assert.equal(queueRepo.listByPeer('node-bob').length, 0)
  assert.equal(queueRepo.listByPeer('node-carol').length, 1, '复合键：另一收件人不受影响')
  queueRepo.remove('q-2', 'node-carol')

  const dedupRepo = new DedupRepo(db)
  dedupRepo.add('d-1', Date.now() - 25 * 3_600_000)
  dedupRepo.add('d-2', Date.now())
  assert.equal(dedupRepo.has('d-1'), true)
  dedupRepo.prune(24 * 3_600_000)
  assert.equal(dedupRepo.has('d-1'), false, '过期去重记录被清理')
  assert.equal(dedupRepo.has('d-2'), true)

  // 7. 启动自愈：残留"发送中"复位为失败（决议 #22）
  msgRepo.insert({
    id: 'm-3',
    convId,
    senderId: 'me',
    isMine: true,
    kind: 'text',
    content: '没发完就崩了',
    ts: 3000,
    status: 'sending'
  })
  assert.equal(msgRepo.resetStaleSending(), 1)
  assert.equal(msgRepo.get('m-3')?.status, 'failed')

  // 8. 传输记录
  const transferRepo = new TransferRepo(db)
  transferRepo.insert({
    transferId: 't-1',
    msgId: 'm-1',
    peerId: 'node-bob',
    direction: 'in',
    files: '{"name":"设计稿.zip"}',
    status: 'offering',
    total: 1024,
    ts: Date.now(),
    expiresAt: Date.now() + 86_400_000
  })
  transferRepo.updateStatus('t-1', 'accepted')
  transferRepo.updateProgress('t-1', 512)
  transferRepo.updateFiles('t-1', '{"name":"设计稿.zip","savedPath":"/tmp/x"}')
  const t = transferRepo.get('t-1')
  assert.equal(t?.status, 'accepted')
  assert.equal(t?.bytes_done, 512)
  assert.ok(t?.files.includes('savedPath'))
  assert.equal(transferRepo.listRecoverable().some((row) => row.transfer_id === 't-1'), true)
  assert.equal(transferRepo.resetLegacyActive(), 0, '带领取期限的活动传输保留给服务层恢复')
  transferRepo.saveOutgoingManifest(
    'm-1',
    JSON.stringify([{ fileId: 'f-1', absPath: '/tmp/design.zip', size: 1024 }]),
    transferRepo.get('t-1')!.expires_at
  )
  assert.equal(transferRepo.getOutgoingManifest('m-1')?.msg_id, 'm-1')
  assert.equal(transferRepo.listOutgoingManifests().length, 1)
  transferRepo.deleteOutgoingManifest('m-1')
  assert.equal(transferRepo.getOutgoingManifest('m-1'), undefined)
  transferRepo.updateStatus('t-1', 'done')
  transferRepo.clearExpiry('t-1')
  assert.equal(transferRepo.get('t-1')?.expires_at, 0, '终态传输应释放截止调度')

  // 「最近有人放进来」（决议 #283）：只认入站已完成的 share-put，purpose 存在 files JSON 里，不新增列
  transferRepo.insert({
    transferId: 't-put',
    msgId: 'share:t-put',
    peerId: 'node-carol',
    direction: 'in',
    files: '{"name":"外发资料","purpose":"share-put"}',
    status: 'done',
    total: 4096,
    ts: Date.now() + 1
  })
  transferRepo.insert({
    transferId: 't-get',
    msgId: 'share:t-get',
    peerId: 'node-carol',
    direction: 'in',
    files: '{"name":"方案.pdf","purpose":"share-get"}',
    status: 'done',
    total: 512,
    ts: Date.now() + 2
  })
  const sharePut = transferRepo.listSharePutIncoming(10)
  assert.equal(sharePut.length, 1, '只有别人上传进来的那一条算「最近有人放进来」')
  assert.equal(sharePut[0].transfer_id, 't-put')

  transferRepo.insert({
    transferId: 't-legacy',
    msgId: 'm-1',
    peerId: 'node-bob',
    direction: 'out',
    files: '{}',
    status: 'offering',
    total: 1,
    ts: Date.now()
  })
  assert.equal(transferRepo.resetLegacyActive(), 1, '无期限旧活动传输启动置失败')
  assert.equal(transferRepo.get('t-legacy')?.status, 'failed')

  // 9. 全局搜索：聊天记录聚合 + 文件命中 + 上下文窗口
  const registry = new PeerRegistry('node-self')
  registry.seed([makePeer('alice')])
  const searchSvc = new SearchService(db, registry)
  msgRepo.insert({
    id: 'm-f1',
    convId,
    senderId: 'node-bob',
    isMine: false,
    kind: 'file',
    content: '[文件] 需求文档v3.docx',
    ts: 4000,
    status: 'sent'
  })
  msgRepo.insert({
    id: 'm-img-search',
    convId,
    senderId: 'node-bob',
    isMine: false,
    kind: 'image',
    content: '[图片]',
    fileRef: JSON.stringify({
      transferId: 't-img-search',
      name: '截图-会议.png',
      size: 2048,
      count: 1,
      dir: false
    }),
    ts: 5000,
    status: 'sent'
  })
  msgRepo.insert({
    id: 'm-pk-search',
    convId,
    senderId: 'node-bob',
    isMine: false,
    kind: 'pk',
    content: '[PK] 骰子',
    fileRef: JSON.stringify({ game: 'dice', result: 6 }),
    ts: 6000,
    status: 'sent'
  })
  const sr = searchSvc.query('文档')
  assert.ok(sr.messageGroups.length >= 1, '聊天记录应有聚合命中')
  assert.equal(sr.messageGroups[0].convId, 'conv-1', '命中应来自含「文档」的会话')
  assert.ok(sr.files.some((f) => f.name === '需求文档v3.docx'), '文件名应命中')
  assert.equal(searchSvc.query('alice').peers.length, 1, '联系人按昵称命中')
  assert.equal(searchSvc.query('   ').messageGroups.length, 0, '空查询返回空')
  assert.ok(
    searchSvc.conversation({ convId, query: '回你', kind: 'all' }).some((h) => h.msgId === 'm-2'),
    '会话内搜索应命中文本消息'
  )
  assert.ok(
    searchSvc.conversation({ convId, query: '', kind: 'file' }).some((h) => h.msgId === 'm-f1'),
    '会话内文件筛选应列出文件消息'
  )
  const imageHits = searchSvc.conversation({ convId, query: '会议', kind: 'image' })
  assert.ok(
    imageHits.some((h) => h.msgId === 'm-img-search'),
    '会话内图片搜索应匹配 file_ref 文件名'
  )
  assert.equal(
    imageHits.find((h) => h.msgId === 'm-img-search')?.fileRef?.transferId,
    't-img-search',
    '会话内图片搜索应返回缩略图所需的 transferId'
  )
  assert.deepEqual(
    searchSvc
      .conversation({ convId, query: '', kind: 'all', limit: 2 })
      .map((h) => h.msgId),
    ['m-pk-search', 'm-img-search'],
    '会话内搜索无关键词时应返回当前会话最近记录'
  )
  assert.deepEqual(
    searchSvc
      .conversation({ convId, query: 'PK', kind: 'all', limit: 1 })
      .map((h) => h.snippet),
    ['[PK] 骰子'],
    '会话内 PK 搜索只展示安全摘要'
  )
  assert.deepEqual(
    searchSvc
      .conversation({ convId, query: '6', kind: 'all' })
      .filter((h) => h.msgId === 'm-pk-search')
      .map((h) => h.msgId),
    [],
    '会话内 PK 搜索不应匹配 file_ref 里的真实点数'
  )
  assert.deepEqual(
    searchSvc
      .conversation({ convId, query: '', kind: 'all', fromTs: 4500, toTs: 5500 })
      .map((h) => h.msgId),
    ['m-img-search'],
    '会话内日期筛选应限定时间范围'
  )

  const ctx = msgRepo.around(convId, 2, 25)
  assert.ok(ctx.some((m) => m.id === 'm-2'), '上下文窗口应包含目标')

  // 10. 群元数据 LWW 与群会话
  const groupRepo = new GroupRepo(db)
  const meta = {
    groupId: 'g-1',
    name: '项目组',
    members: ['node-self', 'node-bob'],
    rev: 1,
    updatedBy: 'node-self',
    updatedTs: 1000,
    creatorIp: '10.0.0.8',
    creatorId: 'node-self',
    ownerId: 'node-self',
    adminIds: ['node-bob'],
    avatarHash,
    adminSecretHash: 'a'.repeat(64),
    adminHint: '项目代号',
    description: '导出简介',
    announce: '导出公告'
  }
  groupRepo.save(meta)
  const largeGroupMembers = Array.from({ length: 120 }, (_item, i) => `node-large-${i}`)
  const largeGroupMeta = {
    groupId: 'g-large',
    name: '大讨论组',
    members: ['node-self', ...largeGroupMembers],
    rev: 1,
    updatedBy: 'node-self',
    updatedTs: 1002,
    creatorIp: '10.0.0.8',
    creatorId: 'node-self',
    ownerId: 'node-self',
    adminIds: [],
    adminSecretHash: '',
    adminHint: '',
    description: '',
    announce: ''
  }
  groupRepo.save(largeGroupMeta)
  assert.equal(
    groupRepo.applyRemote({ ...meta, name: '过期改名', updatedTs: 999 }),
    false,
    'LWW：同 rev 更旧的 updatedTs 拒绝'
  )
  assert.equal(
    groupRepo.applyRemote({ ...meta, rev: 2, name: '新名', updatedTs: 1001 }),
    true,
    'LWW：更高 rev 采纳'
  )
  assert.equal(groupRepo.get('g-1')?.name, '新名')
  assert.equal(groupRepo.get('g-1')?.avatarHash, avatarHash, '群头像哈希应往返')
  const longDescription = '简'.repeat(LIMITS.groupDescription + 5)
  const longAnnounce = '告'.repeat(LIMITS.groupAnnounce + 5)
  db.prepare('UPDATE groups SET description = ?, announce = ? WHERE group_id = ?').run(
    longDescription,
    longAnnounce,
    'g-1'
  )
  assert.equal(convRepo.ensureGroup('g-1'), 'group:g-1')
  assert.equal(convRepo.get('group:g-1')?.type, 'group')

  // 11. 表情包
  const stickerRepo = new StickerRepo(db)
  stickerRepo.insert('s-1', '/tmp/s-1.webp', 512, 384, false)
  stickerRepo.insert('s-2', '/tmp/s-2.gif', 200, 200, true)
  assert.equal(stickerRepo.list().length, 2)
  assert.equal(stickerRepo.list()[0].id, 's-2', '最新收藏在前')
  assert.equal(stickerRepo.remove('s-1'), '/tmp/s-1.webp', '删除返回路径供清理文件')
  assert.equal(stickerRepo.list().length, 1)

  // 11.5 共享文件柜按人例外（决议 #271/#277）：写入、改档、删行往返
  const grantsRepo = new ShareGrantsRepo(db)
  assert.equal(grantsRepo.list().length, 0, '初始应无例外')
  grantsRepo.set('node-alice', 'write', 2000)
  grantsRepo.set('node-bob', 'off', 1000)
  assert.equal(grantsRepo.list().length, 2)
  assert.equal(grantsRepo.list()[0].nodeId, 'node-alice', '最近改动的例外在前')
  assert.equal(grantsRepo.loadAll().get('node-alice'), 'write')
  grantsRepo.set('node-alice', 'read', 3000)
  assert.equal(grantsRepo.loadAll().get('node-alice'), 'read', '同一联系人改档应覆盖而非新增')
  assert.equal(grantsRepo.list().length, 2)
  grantsRepo.set('node-bob', null)
  assert.equal(grantsRepo.loadAll().has('node-bob'), false, '传 null 应删行=恢复跟随默认')
  assert.equal(grantsRepo.list().length, 1)
  db.prepare('INSERT INTO share_grants (node_id, mode, updated_ts) VALUES (?, ?, ?)').run(
    'node-broken',
    'nonsense',
    4000
  )
  assert.equal(grantsRepo.loadAll().has('node-broken'), false, '损坏档位按无例外忽略')
  assert.equal(grantsRepo.list().length, 1, '损坏行不进例外列表')
  db.prepare('DELETE FROM share_grants').run()

  // 12. 迁移备份包：消息库 + 群/表情/传输元数据 + 图片/表情媒体
  const imagePath = join(dir, 'image.webp')
  const stickerPath = join(dir, 'sticker.webp')
  writeFileSync(imagePath, Buffer.from('image-bytes'))
  writeFileSync(stickerPath, Buffer.from('sticker-bytes'))
  msgRepo.insert({
    id: 'm-img',
    convId,
    senderId: 'node-self',
    isMine: true,
    kind: 'image',
    content: '[图片]',
    fileRef: JSON.stringify({ transferId: 't-img', name: 'image.webp', size: 11, count: 1, dir: false }),
    ts: 5000,
    status: 'sent'
  })
  transferRepo.insert({
    transferId: 't-img',
    msgId: 'm-img',
    peerId: 'node-bob',
    direction: 'out',
    files: JSON.stringify({ name: 'image.webp', savedPath: imagePath }),
    status: 'done',
    total: 11,
    ts: 5000
  })
  stickerRepo.insert('s-media', stickerPath, 64, 64, false)

  const backupPath = join(dir, 'pantry.pantry-bak')
  const exportAvatarDir = join(dir, 'avatars-export')
  mkdirSync(exportAvatarDir, { recursive: true })
  writeFileSync(join(exportAvatarDir, `${avatarHash}.webp`), avatarBytes)
  new PorterService(
    db,
    'node-self',
    '我',
    join(dir, 'restore-src'),
    [dir],
    exportAvatarDir,
    avatarHash
  ).export(
    'backup',
    backupPath
  )
  const exportedGroups = readZip(backupPath).get('groups.jsonl')?.toString('utf8') ?? ''
  const exportedGroup = exportedGroups
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { groupId: string; description?: string; announce?: string })
    .find((group) => group.groupId === 'g-1')
  assert.equal(
    exportedGroup?.description,
    longDescription.slice(0, LIMITS.groupDescription),
    '备份导出应携带并截断群简介'
  )
  assert.equal(
    exportedGroup?.announce,
    longAnnounce.slice(0, LIMITS.groupAnnounce),
    '备份导出应携带并截断群公告'
  )
  const db2 = openDatabase(join(dir, 'imported.db'))
  try {
    const originalPrepare = db2.prepare.bind(db2)
    let maxSeqPrepareCount = 0
    const instrumentedDb = new Proxy(db2 as object, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('COALESCE(MAX(seq)')) maxSeqPrepareCount += 1
            return originalPrepare(sql)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as typeof db2
    const restoredAvatarDir = join(dir, 'avatars-restored')
    const result = new PorterService(
      instrumentedDb,
      'node-new',
      '新我',
      join(dir, 'restored'),
      [],
      restoredAvatarDir
    ).importBackup(backupPath)
    assert.equal(maxSeqPrepareCount, 1, '备份导入应只 prepare 一次 MAX(seq) 取号语句')
    assert.equal(result.profileAvatarHash, avatarHash, '备份中的本机头像引用应恢复')
    assert.ok(result.imported >= 1, '备份导入应至少带入新增图片消息')
    const importedMsg = db2.prepare('SELECT * FROM messages WHERE id = ?').get('m-img') as {
      sender_id: string
      is_mine: number
    }
    assert.equal(importedMsg.sender_id, 'node-new', '旧机器的我应映射为新机器身份')
    assert.equal(importedMsg.is_mine, 1)
    const importedTransfer = db2
      .prepare('SELECT files FROM transfers WHERE transfer_id = ?')
      .get('t-img') as { files: string }
    const restoredPath = JSON.parse(importedTransfer.files).savedPath as string
    assert.ok(restoredPath && restoredPath !== imagePath, '媒体应恢复到新用户数据目录')
    assert.equal(existsSync(restoredPath), true, '恢复后的图片媒体文件应存在')
    const importedSticker = db2.prepare('SELECT path FROM stickers WHERE id = ?').get('s-media') as {
      path: string
    }
    assert.equal(existsSync(importedSticker.path), true, '恢复后的表情媒体文件应存在')
    const importedGroup = new GroupRepo(db2).get('g-1')
    assert.equal(importedGroup?.name, '新名')
    assert.equal(importedGroup?.creatorIp, '10.0.0.8')
    assert.equal(importedGroup?.creatorId, 'node-new')
    assert.equal(importedGroup?.ownerId, 'node-new')
    assert.deepEqual(importedGroup?.adminIds, ['node-bob'])
    assert.equal(importedGroup?.adminSecretHash, 'a'.repeat(64))
    assert.equal(importedGroup?.adminHint, '项目代号')
    assert.equal(importedGroup?.avatarHash, avatarHash)
    assert.equal(importedGroup?.description, longDescription.slice(0, LIMITS.groupDescription))
    assert.equal(importedGroup?.announce, longAnnounce.slice(0, LIMITS.groupAnnounce))
    assert.equal(
      existsSync(join(restoredAvatarDir, `${avatarHash}.webp`)),
      true,
      '备份引用的头像文件应恢复到受管目录'
    )
    const importedLargeGroup = new GroupRepo(db2).get('g-large')
    assert.equal(importedLargeGroup?.members.length, 121, '备份导入不得截断 120 人大群成员表')
    assert.ok(importedLargeGroup?.members.includes('node-new'), '旧机器的我应映射进大群成员表')
  } finally {
    db2.close()
  }

  const externalPath = join(dir, 'external-secret.webp')
  writeFileSync(externalPath, Buffer.from('do-not-import-by-path'))
  const badBackupPath = join(dir, 'bad-paths.pantry-bak')
  const badJsonl = (rows: unknown[]): Buffer =>
    Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  writeStoreZip(badBackupPath, [
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          formatVer: 1,
          exportedAt: Date.now(),
          exportedBy: 'node-old',
          nick: '旧我',
          counts: { conversations: 1, messages: 1, peers: 0, groups: 3, stickers: 1, transfers: 1, media: 0 }
        }),
        'utf8'
      )
    },
    {
      name: 'conversations.jsonl',
      data: badJsonl([{ id: 'single:node-old', type: 'single', peerId: 'node-old', lastTs: 6000 }])
    },
    {
      name: 'messages.jsonl',
      data: badJsonl([
        {
          id: 'm-bad',
          convId: 'single:node-old',
          senderId: 'node-old',
          isMine: true,
          kind: 'image',
          content: '[图片]',
          fileRef: JSON.stringify({ transferId: 't-bad', name: 'bad.webp', size: 1, count: 1, dir: false }),
          ts: 6000,
          status: 'sent'
        }
      ])
    },
    { name: 'peers.jsonl', data: badJsonl([]) },
    {
      name: 'groups.jsonl',
      data: badJsonl([
        {
          groupId: 'g-legacy-backup',
          name: '旧备份群',
          members: ['node-old', 'node-bob'],
          rev: 1,
          updatedBy: 'node-old',
          updatedTs: 6000,
          creatorId: 'node-old',
          creatorIp: '10.0.0.8',
          adminSecretHash: '',
          adminHint: ''
        },
        {
          groupId: 'g-new-backup',
          name: '首次导入群',
          members: ['node-old', 'node-bob'],
          rev: 1,
          updatedBy: 'node-old',
          updatedTs: 6001,
          creatorId: 'node-old',
          creatorIp: '10.0.0.8',
          adminSecretHash: '',
          adminHint: ''
        },
        {
          groupId: 'g-long-backup',
          name: '长度截断群',
          members: ['node-old', 'node-bob'],
          rev: 1,
          updatedBy: 'node-old',
          updatedTs: 6002,
          creatorId: 'node-old',
          creatorIp: '10.0.0.8',
          adminSecretHash: '',
          adminHint: '',
          description: longDescription,
          announce: longAnnounce
        }
      ])
    },
    {
      name: 'stickers.jsonl',
      data: badJsonl([{ id: 's-bad', path: externalPath, w: 64, h: 64, animated: 0, sort: 0, added: 6000 }])
    },
    {
      name: 'transfers.jsonl',
      data: badJsonl([
        {
          transferId: 't-bad',
          msgId: 'm-bad',
          peerId: 'node-old',
          direction: 'out',
          files: JSON.stringify({ name: 'bad.webp', savedPath: externalPath }),
          status: 'done',
          bytesDone: 1,
          total: 1,
          ts: 6000
        }
      ])
    }
  ])
  const db3 = openDatabase(join(dir, 'bad-imported.db'))
  try {
    new GroupRepo(db3).save({
      groupId: 'g-legacy-backup',
      name: '本地已有群',
      members: ['node-new', 'node-bob'],
      rev: 1,
      updatedBy: 'node-new',
      updatedTs: 5000,
      creatorIp: '10.0.0.8',
      creatorId: 'node-new',
      ownerId: 'node-new',
      adminIds: [],
      adminSecretHash: '',
      adminHint: '',
      description: '本地简介',
      announce: '本地公告'
    })
    new PorterService(db3, 'node-new', '新我', join(dir, 'bad-restored')).importBackup(badBackupPath)
    const importedBadTransfer = db3
      .prepare('SELECT files FROM transfers WHERE transfer_id = ?')
      .get('t-bad') as { files: string }
    assert.equal(JSON.parse(importedBadTransfer.files).savedPath, undefined, '无归档媒体时不得保留外部传输路径')
    const badSticker = db3.prepare('SELECT path FROM stickers WHERE id = ?').get('s-bad')
    assert.equal(badSticker, undefined, '无归档媒体时不得导入外部表情路径')
    const importedLegacyGroup = new GroupRepo(db3).get('g-legacy-backup')
    assert.equal(importedLegacyGroup?.ownerId, 'node-new', '旧备份缺角色字段时应映射并推导群主')
    assert.deepEqual(importedLegacyGroup?.adminIds, [], '旧备份缺角色字段时管理员应为空')
    assert.equal(importedLegacyGroup?.avatarHash, '', '旧备份缺头像字段时应使用默认群头像')
    assert.equal(importedLegacyGroup?.description, '本地简介', '旧备份缺简介字段时应保留本地值')
    assert.equal(importedLegacyGroup?.announce, '本地公告', '旧备份缺公告字段时应保留本地值')
    const importedNewGroup = new GroupRepo(db3).get('g-new-backup')
    assert.equal(importedNewGroup?.description, '', '首次导入旧备份缺简介字段时应默认为空串')
    assert.equal(importedNewGroup?.announce, '', '首次导入旧备份缺公告字段时应默认为空串')
    const importedLongGroup = new GroupRepo(db3).get('g-long-backup')
    assert.equal(importedLongGroup?.description, longDescription.slice(0, LIMITS.groupDescription))
    assert.equal(importedLongGroup?.announce, longAnnounce.slice(0, LIMITS.groupAnnounce))
  } finally {
    db3.close()
  }

  const bulkBackupPath = join(dir, 'bulk-import.pantry-bak')
  const bulkMessageCount = 20_000
  writeStoreZip(bulkBackupPath, [
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          formatVer: 1,
          exportedAt: Date.now(),
          exportedBy: 'node-old',
          nick: '旧我',
          counts: {
            conversations: 1,
            messages: bulkMessageCount,
            peers: 0,
            groups: 0,
            stickers: 0,
            transfers: 0,
            media: 0
          }
        }),
        'utf8'
      )
    },
    {
      name: 'conversations.jsonl',
      data: badJsonl([{ id: 'single:node-peer', type: 'single', peerId: 'node-peer', lastTs: 7000 }])
    },
    {
      name: 'messages.jsonl',
      data: badJsonl(
        Array.from({ length: bulkMessageCount }, (_item, i) => ({
          id: `bulk-${i}`,
          convId: 'single:node-peer',
          senderId: 'node-peer',
          isMine: false,
          kind: 'text',
          content: `批量导入消息 ${i}`,
          fileRef: null,
          ts: 7000 + i,
          status: 'sent'
        }))
      )
    },
    { name: 'peers.jsonl', data: badJsonl([]) },
    { name: 'groups.jsonl', data: badJsonl([]) },
    { name: 'stickers.jsonl', data: badJsonl([]) },
    { name: 'transfers.jsonl', data: badJsonl([]) }
  ])
  const db4 = openDatabase(join(dir, 'bulk-imported.db'))
  try {
    const start = Date.now()
    const bulkResult = new PorterService(db4, 'node-new', '新我', join(dir, 'bulk-restored')).importBackup(
      bulkBackupPath
    )
    const elapsed = Date.now() - start
    console.log(`[db-selftest] porter bulk import ${bulkMessageCount} messages: ${elapsed}ms`)
    assert.equal(bulkResult.imported, bulkMessageCount, '批量备份导入应完整带入 2 万条消息')
  } finally {
    db4.close()
  }

  console.log('[db-selftest] PASS —— 迁移/联系人/会话消息/队列去重/传输/搜索/porter/中文FTS 全部通过')
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}
