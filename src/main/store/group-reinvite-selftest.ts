import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { GroupsService } from '../services/groups'
import { GroupRepo } from './group-repo'
import { openDatabase } from './db'
import type { ConvRepo } from './conv-repo'
import type { MsgRepo } from './msg-repo'
import type { Messenger } from '../net/messenger'
import { makeEnvelope } from '../net/codec'
import { MSG_TYPES, type Envelope, type GroupPayload } from '../../shared/protocol'

/** #51：真实 SQLite 持久化离组快照，重启后接收重新邀请并再次重启确认。 */
export function verifyGroupReinvite(dir: string): void {
  class LocalMessenger extends EventEmitter {
    readonly sent: Array<{ peerId: string; env: Envelope }> = []
    async sendUserMessage(peerId: string, env: Envelope): Promise<'sent'> {
      this.sent.push({ peerId, env })
      return 'sent'
    }
    async sendReliable(peerId: string, env: Envelope): Promise<boolean> {
      this.sent.push({ peerId, env })
      return true
    }
  }
  const ownerDb = openDatabase(join(dir, 'reinvite-owner.db'))
  const memberPath = join(dir, 'reinvite-member.db')
  let memberDb = openDatabase(memberPath)
  function client(selfId: string, repo: GroupRepo) {
    const messenger = new LocalMessenger()
    const svc = new GroupsService({ selfId, groupRepo: repo,
      messenger: messenger as unknown as Messenger,
      // 本例验证群元数据的真实存储；会话/UI 和网络不在此自测范围内。
      convRepo: { ensureGroup: (id: string) => `group:${id}`, list: () => [] } as unknown as ConvRepo,
      msgRepo: { insert: () => false, get: () => undefined } as unknown as MsgRepo,
      getSelfIp: () => '127.0.0.1'
    })
    return { svc, messenger }
  }
  try {
    const ownerRepo = new GroupRepo(ownerDb)
    const owner = client('owner', ownerRepo)
    let member = client('member', new GroupRepo(memberDb))
    const deliver = (): void => {
      for (const item of owner.messenger.sent.splice(0)) {
        if (item.peerId === 'member') member.messenger.emit('incoming', item.env)
      }
    }
    const groupId = owner.svc.createGroup('原群名', ['member', 'other'])!.groupId
    deliver()
    owner.svc.updateGroup(groupId, { kind: 'remove', memberIds: ['member'] })
    deliver()
    assert.equal(member.svc.get(groupId)?.amMember, false)
    memberDb.close()
    memberDb = openDatabase(memberPath)
    member = client('member', new GroupRepo(memberDb))
    assert.equal(member.svc.get(groupId)?.amMember, false, '重启保留离组状态')
    owner.svc.updateGroup(groupId, { kind: 'rename', name: '离组期间改名' })
    owner.svc.updateGroup(groupId, { kind: 'set-avatar', avatarHash: 'a'.repeat(64) })
    owner.svc.updateGroup(groupId, { kind: 'invite', memberIds: ['member'] })
    deliver()
    assert.equal(member.svc.get(groupId)?.amMember, true)
    assert.deepEqual(new GroupRepo(memberDb).get(groupId), ownerRepo.get(groupId))
    memberDb.close()
    memberDb = openDatabase(memberPath)
    const persisted = new GroupRepo(memberDb)
    assert.deepEqual(persisted.get(groupId), ownerRepo.get(groupId), '再次重启保留采纳的完整快照')
    member = client('member', persisted)
    const local = persisted.get(groupId)!
    member.messenger.emit('incoming', makeEnvelope<GroupPayload>(MSG_TYPES.group, 'other', {
      op: 'info', group: { ...local, name: '越权改名', avatarHash: 'b'.repeat(64),
        updatedBy: 'other', rev: local.rev + 100, updatedTs: local.updatedTs + 1000 }
    }))
    assert.deepEqual(persisted.get(groupId), local, '大版本号不越过权限检查')
    console.log('[db-selftest] 群重新邀请累计快照及重启持久化 PASS')
  } finally {
    memberDb.close()
    ownerDb.close()
  }
}
