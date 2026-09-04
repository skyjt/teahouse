import { describe, expect, it } from 'vitest'
import { decode, decodeTcpEnvelopeObject, encode, makeEnvelope } from './codec'
import {
  AVATAR_MAX_BYTES,
  GROUP_IMG_AUTO_ACCEPT,
  GROUP_MAX_MEMBERS,
  LIMITS,
  MSG_TYPES,
  TABLE_TEXT_LIMIT_BYTES,
  UDP_MAX_INBOUND,
  type AvatarPayload,
  type FileCtlOffer,
  type FileCtlPayload,
  type GroupPayload,
  type MsgPayload,
  type Profile,
  type ProfilePayload,
  type ScanRangesPayload,
  type SharePayload,
  type UpdateReqPayload
} from '../../shared/protocol'

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    nodeId: 'node-aaaa',
    nick: '张三',
    company: '某某科技',
    dept: '研发部',
    team: '后端组',
    avatar: -1,
    profileRev: 1,
    host: 'zhangsan-pc',
    platform: 'mac',
    tcpPort: 17879,
    ver: '0.1.0',
    caps: [],
    ...overrides
  }
}

describe('codec', () => {
  it('entry 报文编解码往返', () => {
    const env = makeEnvelope<ProfilePayload>(MSG_TYPES.entry, 'node-aaaa', {
      profile: makeProfile()
    })
    const result = decode(encode(env))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.known).toBe(true)
    expect(result.env.type).toBe('entry')
    expect(result.env.from).toBe('node-aaaa')
    expect((result.env.payload as ProfilePayload).profile.nick).toBe('张三')
  })

  it('资料头像哈希可选，非法哈希拒收', () => {
    const hash = 'a'.repeat(64)
    const withAvatar = makeEnvelope<ProfilePayload>(MSG_TYPES.entry, 'node-aaaa', {
      profile: makeProfile({ avatarHash: hash, caps: ['av1'] })
    })
    expect(decode(encode(withAvatar))).toMatchObject({ ok: true, known: true })
    expect(
      decode(
        encode(
          makeEnvelope<ProfilePayload>(MSG_TYPES.entry, 'node-aaaa', {
            profile: makeProfile({ avatarHash: '../avatar.webp' })
          })
        )
      )
    ).toEqual({ ok: false, reason: 'bad-payload:entry' })
  })

  it('昵称首字显式背景色头像编号可编解码', () => {
    const env = makeEnvelope<ProfilePayload>(MSG_TYPES.profile, 'node-aaaa', {
      profile: makeProfile({ avatar: 209 })
    })
    const result = decode(encode(env))
    expect(result).toMatchObject({ ok: true, known: true })
    if (result.ok && result.known) {
      expect((result.env.payload as ProfilePayload).profile.avatar).toBe(209)
    }
    const invalid = makeEnvelope<ProfilePayload>(MSG_TYPES.profile, 'node-aaaa', {
      profile: makeProfile({ avatar: 210 })
    })
    expect(decode(encode(invalid))).toEqual({ ok: false, reason: 'bad-payload:profile' })
  })

  it('avatar 请求与响应执行哈希、base64 和大小白名单校验', () => {
    const hash = 'b'.repeat(64)
    const get = makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-aaaa', {
      op: 'get',
      hash,
      groupId: 'group-1'
    })
    expect(decodeTcpEnvelopeObject(get)).toMatchObject({ ok: true, known: true })

    const data = makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-aaaa', {
      op: 'data',
      hash,
      bytesBase64: Buffer.from('avatar').toString('base64')
    })
    expect(decodeTcpEnvelopeObject(data)).toMatchObject({ ok: true, known: true })

    const miss = makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-aaaa', {
      op: 'miss',
      hash,
      groupId: 'group-1'
    })
    expect(decodeTcpEnvelopeObject(miss)).toMatchObject({ ok: true, known: true })

    for (const payload of [
      { op: 'get', hash: 'bad' },
      { op: 'data', hash, bytesBase64: '***=' },
      { op: 'data', hash, bytesBase64: Buffer.alloc(AVATAR_MAX_BYTES + 1).toString('base64') },
      { op: 'get', hash, extra: true },
      { op: 'miss', hash: 'bad' },
      { op: 'miss', hash, bytesBase64: 'AAAA' }
    ]) {
      expect(
        decodeTcpEnvelopeObject(makeEnvelope(MSG_TYPES.avatar, 'node-aaaa', payload))
      ).toEqual({ ok: false, reason: 'bad-payload:avatar' })
    }
  })

  it('update 自更新请求报文：合法往返 + 坏报文白名单拒绝', () => {
    const ok = decode(
      encode(
        makeEnvelope<UpdateReqPayload>(MSG_TYPES.update, 'node-aaaa', {
          op: 'req',
          platform: 'linux',
          arch: 'arm64'
        })
      )
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.known).toBe(true)
      expect((ok.env.payload as UpdateReqPayload).platform).toBe('linux')
      expect((ok.env.payload as UpdateReqPayload).arch).toBe('arm64')
    }
    const winIa32 = decode(
      encode(makeEnvelope(MSG_TYPES.update, 'node-aaaa', { op: 'req', platform: 'win', arch: 'ia32' }))
    )
    expect(winIa32.ok).toBe(true)
    // op 非 req / platform 非法 / arch 非法 / 缺字段 → 丢弃
    expect(decode(encode(makeEnvelope(MSG_TYPES.update, 'n', { op: 'x', platform: 'win' }))).ok).toBe(false)
    expect(decode(encode(makeEnvelope(MSG_TYPES.update, 'n', { op: 'req', platform: 'bad' }))).ok).toBe(false)
    expect(decode(encode(makeEnvelope(MSG_TYPES.update, 'n', { op: 'req', platform: 'linux', arch: 'riscv64' }))).ok).toBe(false)
    expect(decode(encode(makeEnvelope(MSG_TYPES.update, 'n', { op: 'req' }))).ok).toBe(false)
  })

  it('未知类型：信封合法即接受，标记 known=false（向前兼容）', () => {
    const env = makeEnvelope('future-fancy-type', 'node-aaaa', { anything: 1 })
    const result = decode(encode(env))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.known).toBe(false)
  })

  it('坏 JSON 拒收', () => {
    const result = decode(Buffer.from('{{{not json', 'utf8'))
    expect(result).toEqual({ ok: false, reason: 'bad-json' })
  })

  it('协议版本不符拒收', () => {
    const env = { ...makeEnvelope(MSG_TYPES.exit, 'node-aaaa', {}), v: 99 }
    const result = decode(Buffer.from(JSON.stringify(env), 'utf8'))
    expect(result).toEqual({ ok: false, reason: 'version' })
  })

  it('超长报文拒收', () => {
    const result = decode(Buffer.alloc(UDP_MAX_INBOUND + 1, 0x20))
    expect(result).toEqual({ ok: false, reason: 'oversize' })
  })

  it('entry 载荷昵称超长拒收（字段白名单校验）', () => {
    const env = makeEnvelope<ProfilePayload>(MSG_TYPES.entry, 'node-aaaa', {
      profile: makeProfile({ nick: '超'.repeat(33) })
    })
    const result = decode(encode(env))
    expect(result).toEqual({ ok: false, reason: 'bad-payload:entry' })
  })

  it('presence 载荷非法（负 seq）拒收', () => {
    const env = makeEnvelope(MSG_TYPES.presence, 'node-aaaa', { seq: -1, profileRev: 1 })
    const result = decode(encode(env))
    expect(result).toEqual({ ok: false, reason: 'bad-payload:presence' })
  })

  it('group-text mentions 白名单校验', () => {
    const ok = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'group-text',
      text: 'hi @alice',
      groupId: 'group-1',
      groupRev: 1,
      mentions: ['node-alice']
    })
    expect(decode(encode(ok))).toMatchObject({ ok: true, known: true })

    const tooMany = makeEnvelope(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'group-text',
      text: 'hi',
      groupId: 'group-1',
      groupRev: 1,
      mentions: Array.from({ length: GROUP_MAX_MEMBERS + 1 }, (_, i) => `node-${i}`)
    })
    expect(decode(encode(tooMany))).toEqual({ ok: false, reason: 'bad-payload:msg' })

    const badId = makeEnvelope(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'group-text',
      text: 'hi',
      groupId: 'group-1',
      groupRev: 1,
      mentions: ['']
    })
    expect(decode(encode(badId))).toEqual({ ok: false, reason: 'bad-payload:msg' })
  })

  it('group-text replyTo 只允许 id 字段，拒绝 senderName/text 等不可信字段', () => {
    const ok = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'group-text',
      text: '回复你',
      groupId: 'group-1',
      groupRev: 1,
      replyTo: 'msg-source'
    })
    expect(decode(encode(ok))).toMatchObject({ ok: true, known: true })

    // 带 senderName / text 的伪造报文应被拒绝（决议 #reply）
    const fake = makeEnvelope(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'group-text',
      text: '冒充回复',
      groupId: 'group-1',
      groupRev: 1,
      replyTo: { id: 'msg-source', senderName: '管理员', text: '原始消息内容' }
    })
    expect(decode(encode(fake))).toEqual({ ok: false, reason: 'bad-payload:msg' })

    // replyTo 为空字符串
    const emptyId = makeEnvelope(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'group-text',
      text: 'hi',
      groupId: 'group-1',
      groupRev: 1,
      replyTo: ''
    })
    expect(decode(encode(emptyId))).toMatchObject({ ok: true, known: true })
  })

  it('recall 消息要求 targetId，群聊撤回要求 groupRev 配套', () => {
    const ok = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'recall',
      targetId: 'msg-target',
      groupId: 'group-1',
      groupRev: 2
    })
    expect(decode(encode(ok))).toMatchObject({ ok: true, known: true })

    const missingTarget = makeEnvelope(MSG_TYPES.msg, 'node-aaaa', { kind: 'recall' })
    expect(decode(encode(missingTarget))).toEqual({
      ok: false,
      reason: 'bad-payload:msg'
    })

    const missingRev = makeEnvelope(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'recall',
      targetId: 'msg-target',
      groupId: 'group-1'
    })
    expect(decode(encode(missingRev))).toEqual({ ok: false, reason: 'bad-payload:msg' })
  })

  it('nudge 是无正文的私聊即时动作，不能带补发标记', () => {
    const ok = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-aaaa', { kind: 'nudge' })
    expect(decode(encode(ok))).toMatchObject({ ok: true, known: true })

    const resend = makeEnvelope(MSG_TYPES.msg, 'node-aaaa', { kind: 'nudge', resend: true })
    expect(decode(encode(resend))).toEqual({ ok: false, reason: 'bad-payload:msg' })
  })

  it('pk 只接受匹配玩法的结果，且不允许补发标记', () => {
    const dice = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'pk',
      game: 'dice',
      result: 6
    })
    expect(decode(encode(dice))).toMatchObject({ ok: true, known: true })

    const rps = makeEnvelope<MsgPayload>(MSG_TYPES.msg, 'node-aaaa', {
      kind: 'pk',
      game: 'rps',
      result: 'rock',
      groupId: 'group-1',
      groupRev: 1
    })
    expect(decode(encode(rps))).toMatchObject({ ok: true, known: true })

    expect(
      decode(encode(makeEnvelope(MSG_TYPES.msg, 'node-aaaa', { kind: 'pk', game: 'dice', result: 7 })))
    ).toEqual({ ok: false, reason: 'bad-payload:msg' })
    expect(
      decode(
        encode(makeEnvelope(MSG_TYPES.msg, 'node-aaaa', { kind: 'pk', game: 'rps', result: 'rock', resend: true }))
      )
    ).toEqual({ ok: false, reason: 'bad-payload:msg' })
  })

  it('scan-ranges 只接受受控 CIDR 列表', () => {
    const ok = makeEnvelope<ScanRangesPayload>(MSG_TYPES.scanRanges, 'node-aaaa', {
      ranges: [{ cidr: '10.1.2.0/24', addedAt: Date.now() }]
    })
    expect(decode(encode(ok))).toMatchObject({ ok: true, known: true })

    const tooLarge = makeEnvelope<ScanRangesPayload>(MSG_TYPES.scanRanges, 'node-aaaa', {
      ranges: [{ cidr: '10.0.0.0/16', addedAt: Date.now() }]
    })
    expect(decode(encode(tooLarge))).toEqual({
      ok: false,
      reason: 'bad-payload:scan-ranges'
    })

    const missingTime = makeEnvelope(MSG_TYPES.scanRanges, 'node-aaaa', {
      ranges: [{ cidr: '10.1.2.0/24' }]
    })
    expect(decode(encode(missingTime))).toEqual({
      ok: false,
      reason: 'bad-payload:scan-ranges'
    })
  })

  it('group.info 校验群角色字段，旧包缺角色/简介/公告字段仍兼容', () => {
    const group = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-aaaa', 'node-bbbb'],
      rev: 1,
      updatedBy: 'node-aaaa',
      updatedTs: Date.now(),
      creatorIp: '10.0.0.1',
      creatorId: 'node-aaaa',
      ownerId: 'node-aaaa',
      adminIds: ['node-bbbb'],
      avatarHash: 'c'.repeat(64),
      adminSecretHash: '',
      adminHint: '',
      description: '',
      announce: ''
    }
    const ok = makeEnvelope<GroupPayload>(MSG_TYPES.group, 'node-aaaa', {
      op: 'info',
      group
    })
    expect(decode(encode(ok))).toMatchObject({ ok: true, known: true })

    const legacy = makeEnvelope(MSG_TYPES.group, 'node-aaaa', {
      op: 'info',
      group: {
        ...group,
        creatorId: undefined,
        ownerId: undefined,
        adminIds: undefined,
        avatarHash: undefined,
        description: undefined,
        announce: undefined
      }
    })
    expect(decode(encode(legacy))).toMatchObject({ ok: true, known: true })

    for (const invalidTextGroup of [
      { ...group, description: 1 },
      { ...group, announce: null }
    ]) {
      const invalid = makeEnvelope(MSG_TYPES.group, 'node-aaaa', {
        op: 'info',
        group: invalidTextGroup
      })
      expect(decode(encode(invalid))).toEqual({
        ok: false,
        reason: 'bad-payload:group'
      })
    }

    const badCreator = makeEnvelope(MSG_TYPES.group, 'node-aaaa', {
      op: 'info',
      group: { ...group, creatorId: 'x'.repeat(65) }
    })
    expect(decode(encode(badCreator))).toEqual({
      ok: false,
      reason: 'bad-payload:group'
    })

    for (const invalidGroup of [
      { ...group, adminIds: undefined },
      { ...group, adminIds: ['node-bbbb', 'node-bbbb'] },
      { ...group, adminIds: ['node-missing'] },
      { ...group, adminIds: ['node-aaaa'] },
      { ...group, ownerId: 'node-missing' },
      { ...group, avatarHash: 'invalid' }
    ]) {
      const invalid = makeEnvelope(MSG_TYPES.group, 'node-aaaa', {
        op: 'info',
        group: invalidGroup
      })
      expect(decode(encode(invalid))).toEqual({
        ok: false,
        reason: 'bad-payload:group'
      })
    }

    // 群简介/群公告字段长度校验
    const tooLongDesc = makeEnvelope(MSG_TYPES.group, 'node-0', {
      op: 'info',
      group: { ...group, description: '界'.repeat(LIMITS.groupDescription + 1) }
    })
    expect(decodeTcpEnvelopeObject(tooLongDesc)).toEqual({
      ok: false,
      reason: 'bad-payload:group'
    })

    const tooLongAnnounce = makeEnvelope(MSG_TYPES.group, 'node-0', {
      op: 'info',
      group: { ...group, announce: '告'.repeat(LIMITS.groupAnnounce + 1) }
    })
    expect(decodeTcpEnvelopeObject(tooLongAnnounce)).toEqual({
      ok: false,
      reason: 'bad-payload:group'
    })

    // description / announce 为空字符串仍合法（旧端兼容）
    const emptyStrings = makeEnvelope(MSG_TYPES.group, 'node-0', {
      op: 'info',
      group: { ...group, description: '', announce: '' }
    })
    expect(decodeTcpEnvelopeObject(emptyStrings)).toMatchObject({ ok: true, known: true })

    const members = Array.from({ length: GROUP_MAX_MEMBERS }, (_item, i) => `node-${i}`)
    const maxGroup = makeEnvelope(MSG_TYPES.group, 'node-0', {
      op: 'info',
      group: {
        ...group,
        members,
        ownerId: 'node-0',
        adminIds: members.slice(1),
        updatedBy: 'node-0'
      }
    })
    expect(decodeTcpEnvelopeObject(maxGroup)).toMatchObject({ ok: true, known: true })

    const overLimit = makeEnvelope(MSG_TYPES.group, 'node-0', {
      op: 'info',
      group: {
        ...group,
        members: [...members, 'node-over'],
        ownerId: 'node-0',
        adminIds: [],
        updatedBy: 'node-0'
      }
    })
    expect(decodeTcpEnvelopeObject(overLimit)).toEqual({
      ok: false,
      reason: 'bad-payload:group'
    })
  })

  it('file-ctl 群聊媒体 offer 要求 groupId/groupRev 成对出现', () => {
    const ok = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-1',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'a.png', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'a.png',
      purpose: 'image',
      groupId: 'group-1',
      groupRev: 2
    })
    expect(decode(encode(ok))).toMatchObject({ ok: true, known: true })

    const missingRev = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-1',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'a.png', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'a.png',
      groupId: 'group-1'
    })
    expect(decode(encode(missingRev))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })

    const oversizedGroupImage = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-1',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'a.png', size: GROUP_IMG_AUTO_ACCEPT + 1 }],
      totalSize: GROUP_IMG_AUTO_ACCEPT + 1,
      fileCount: 1,
      rootName: 'a.png',
      purpose: 'image',
      groupId: 'group-1',
      groupRev: 2
    })
    expect(decode(encode(oversizedGroupImage))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })
  })

  it('file-ctl 普通文件接受领取截止时间，并拒绝媒体通道或非法时间携带', () => {
    const base: FileCtlOffer = {
      op: 'offer',
      transferId: 'transfer-expiry',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'a.zip', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'a.zip'
    }
    const ordinary = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      ...base,
      expiresAt: Date.now() + 86_400_000
    })
    expect(decode(encode(ordinary))).toMatchObject({ ok: true, known: true })

    const legacy = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', base)
    expect(decode(encode(legacy))).toMatchObject({ ok: true, known: true })

    for (const payload of [
      { ...base, expiresAt: 0 },
      { ...base, expiresAt: 1.5 },
      { ...base, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, expiresAt: Date.now() + 86_400_000, purpose: 'image' }
    ]) {
      expect(
        decode(encode(makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', payload)))
      ).toEqual({ ok: false, reason: 'bad-payload:file-ctl' })
    }
  })

  it('file-ctl 媒体 offer 接受受控 msgId，并拒绝非法 msgId', () => {
    const withMsgId = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-media-1',
      msgId: 'msg-media-1',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'a.png', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'a.png',
      purpose: 'image'
    } as FileCtlPayload)
    expect(decode(encode(withMsgId))).toMatchObject({ ok: true, known: true })

    const badMsgId = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-media-2',
      msgId: 'x'.repeat(65),
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'a.png', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'a.png',
      purpose: 'image'
    } as FileCtlPayload)
    expect(decode(encode(badMsgId))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })
  })

  it('file-ctl 表格图片 offer 只允许单图携带受限 tableText', () => {
    const withTableText = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-table-1',
      msgId: 'msg-table-1',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'table.png', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'table.png',
      purpose: 'image',
      tableText: '姓名\t分数\n张三\t100',
      tableTextTruncated: true
    })
    expect(decode(encode(withTableText))).toMatchObject({ ok: true, known: true })

    const withoutTextHasFlag = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-table-2',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'table.png', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'table.png',
      purpose: 'image',
      tableTextTruncated: true
    })
    expect(decode(encode(withoutTextHasFlag))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })

    const onFileOffer = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-table-3',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'table.txt', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'table.txt',
      tableText: 'a\tb'
    })
    expect(decode(encode(onFileOffer))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })

    const tooLong = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-table-4',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'table.png', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: 'table.png',
      purpose: 'image',
      tableText: '表'.repeat(TABLE_TEXT_LIMIT_BYTES + 1)
    })
    expect(decodeTcpEnvelopeObject(tooLong)).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })
  })

  it('file-ctl 更新包 offer 允许 purpose=update 且不套用群聊图片上限', () => {
    const updateOffer = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-update-1',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'Teahouse-0.28.0-linux-x64.deb', size: GROUP_IMG_AUTO_ACCEPT + 1 }],
      totalSize: GROUP_IMG_AUTO_ACCEPT + 1,
      fileCount: 1,
      rootName: 'Teahouse-0.28.0-linux-x64.deb',
      purpose: 'update'
    })
    expect(decode(encode(updateOffer))).toMatchObject({ ok: true, known: true })

    const oversized = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-update-oversized',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'Teahouse-0.28.0-linux-amd64.deb', size: 512 * 1024 * 1024 + 1 }],
      totalSize: 512 * 1024 * 1024 + 1,
      fileCount: 1,
      rootName: 'Teahouse-0.28.0-linux-amd64.deb',
      purpose: 'update'
    })
    expect(decode(encode(oversized))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })

    const badPurpose = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-update-2',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'x.bin', size: 1 }],
      totalSize: 1,
      fileCount: 1,
      rootName: 'x.bin',
      purpose: 'installer'
    })
    expect(decode(encode(badPurpose))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })

    const groupedUpdate = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'offer',
      transferId: 'transfer-update-3',
      seq: 1,
      total: 1,
      files: [{ fileId: 'file-1', path: 'x.deb', size: 1 }],
      totalSize: 1,
      fileCount: 1,
      rootName: 'x.deb',
      purpose: 'update',
      groupId: 'group-1',
      groupRev: 1
    })
    expect(decode(encode(groupedUpdate))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })
  })

  it('file-ctl 直接发送控制帧只需要 transferId', () => {
    const direct = makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'direct',
      transferId: 'transfer-direct-1'
    })
    expect(decode(encode(direct))).toMatchObject({ ok: true, known: true })

    const missingId = makeEnvelope(MSG_TYPES.fileCtl, 'node-aaaa', {
      op: 'direct'
    })
    expect(decode(encode(missingId))).toEqual({
      ok: false,
      reason: 'bad-payload:file-ctl'
    })
  })

  it('缺 payload 拒收', () => {
    const raw = { v: 1, type: 'exit', id: 'x', from: 'node-aaaa', ts: Date.now() }
    const result = decode(Buffer.from(JSON.stringify(raw), 'utf8'))
    expect(result).toEqual({ ok: false, reason: 'no-payload' })
  })
})

describe('codec · 共享文件柜报文（§8.2，决议 #275）', () => {
  function roundTrip(payload: unknown): ReturnType<typeof decode> {
    return decode(encode(makeEnvelope(MSG_TYPES.share, 'node-alice', payload)))
  }

  it('合法的 list / list-ok / get / deny 通过', () => {
    expect(
      roundTrip({ op: 'list', reqId: 'r1', path: '设计稿/2026', offset: 0 } satisfies SharePayload).ok
    ).toBe(true)
    expect(roundTrip({ op: 'list', reqId: 'r1', path: '', offset: 200 } satisfies SharePayload).ok).toBe(true)
    expect(
      roundTrip({
        op: 'list-ok',
        reqId: 'r1',
        path: '',
        perm: 'read',
        snapshotId: 's1',
        offset: 0,
        total: 1,
        truncated: false,
        entries: [{ name: '封面.psd', size: 10, isDir: false, mtime: 1 }]
      } satisfies SharePayload).ok
    ).toBe(true)
    expect(roundTrip({ op: 'get', reqId: 'r1', paths: ['a/b.txt'] } satisfies SharePayload).ok).toBe(true)
    expect(roundTrip({ op: 'deny', reqId: 'r1', reason: 'busy' } satisfies SharePayload).ok).toBe(true)
  })

  it('路径穿越、绝对路径与盘符一律拒收', () => {
    for (const path of ['../etc', 'a/../b', '/etc/passwd', 'C:/Windows', 'a\\b', 'a//b', 'a/']) {
      expect(roundTrip({ op: 'list', reqId: 'r', path, offset: 0 })).toEqual({
        ok: false,
        reason: 'bad-payload:share'
      })
    }
    expect(roundTrip({ op: 'get', reqId: 'r', paths: ['ok.txt', '../坏.txt'] })).toEqual({
      ok: false,
      reason: 'bad-payload:share'
    })
  })

  it('get 不接受空路径（等价于整取共享根，绕过逐条校验）', () => {
    expect(roundTrip({ op: 'get', reqId: 'r', paths: [''] })).toEqual({
      ok: false,
      reason: 'bad-payload:share'
    })
    expect(roundTrip({ op: 'get', reqId: 'r', paths: [] })).toEqual({
      ok: false,
      reason: 'bad-payload:share'
    })
  })

  it('list-ok 的条目名不得含分隔符，权限与原因码必须是枚举值', () => {
    const base = {
      op: 'list-ok',
      reqId: 'r',
      path: '',
      perm: 'read',
      snapshotId: 's',
      offset: 0,
      total: 1,
      truncated: false
    }
    expect(roundTrip({ ...base, entries: [{ name: 'a/b', size: 1, isDir: false, mtime: 1 }] }).ok).toBe(false)
    expect(roundTrip({ ...base, entries: [{ name: '..', size: 1, isDir: false, mtime: 1 }] }).ok).toBe(false)
    expect(roundTrip({ ...base, perm: 'off', entries: [] }).ok).toBe(false)
    expect(roundTrip({ ...base, entries: [{ name: 'a', size: -1, isDir: false, mtime: 1 }] }).ok).toBe(false)
    expect(roundTrip({ op: 'deny', reqId: 'r', reason: '随便编的' }).ok).toBe(false)
  })

  it('未知 op 与多余字段拒收', () => {
    expect(roundTrip({ op: 'delete', reqId: 'r', path: 'a' }).ok).toBe(false)
    expect(roundTrip({ op: 'list', reqId: 'r', path: '', offset: 0, extra: 1 }).ok).toBe(false)
  })

  it('share-get / share-put offer 不得带群上下文或聊天消息锚点', () => {
    const offer: FileCtlOffer = {
      op: 'offer',
      transferId: 't1',
      seq: 1,
      total: 1,
      files: [{ fileId: 'f1', path: '资料.zip', size: 10 }],
      totalSize: 10,
      fileCount: 1,
      rootName: '资料.zip',
      purpose: 'share-get'
    }
    expect(decode(encode(makeEnvelope(MSG_TYPES.fileCtl, 'node-alice', offer))).ok).toBe(true)
    expect(
      decode(
        encode(makeEnvelope(MSG_TYPES.fileCtl, 'node-alice', { ...offer, msgId: 'm1' }))
      ).ok
    ).toBe(false)
    expect(
      decode(
        encode(
          makeEnvelope(MSG_TYPES.fileCtl, 'node-alice', {
            ...offer,
            purpose: 'share-put',
            groupId: 'g1',
            groupRev: 1
          })
        )
      ).ok
    ).toBe(false)
  })
})
