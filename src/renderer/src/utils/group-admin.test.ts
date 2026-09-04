import { describe, expect, it } from 'vitest'
import type { GroupView } from '../../../shared/ipc'
import {
  canRemoveGroupMember,
  canRenameGroup,
  canSetGroupAdmin,
  prepareGroupAdminPatch
} from './group-admin'

function group(overrides: Partial<GroupView> = {}): GroupView {
  return {
    groupId: 'group-1',
    name: '项目组',
    members: ['node-self', 'node-a'],
    rev: 1,
    amMember: true,
    creatorIp: '10.0.0.1',
    ownerId: 'node-self',
    adminIds: [],
    avatarHash: '',
    selfRole: 'owner',
    hasAdminPassword: false,
    adminHint: '',
    canManage: true,
    ...overrides,
    description: '',
    announce: ''
  }
}

describe('group admin helpers', () => {
  it('密码组没有输入密码时阻止管理操作', () => {
    const result = prepareGroupAdminPatch(
      group({ hasAdminPassword: true, canManage: false }),
      { kind: 'rename', name: '新群名' },
      '   '
    )

    expect(result).toEqual({ ok: false, reason: 'missing-password' })
  })

  it('密码组把显式输入的密码写入 group:update payload', () => {
    const result = prepareGroupAdminPatch(
      group({ hasAdminPassword: true, canManage: false, selfRole: 'member' }),
      { kind: 'rename', name: '新群名' },
      '  s3cret  '
    )

    expect(result).toEqual({
      ok: true,
      patch: { kind: 'rename', name: '新群名', adminPassword: 's3cret' }
    })
  })

  it('密码组设置或清空群简介与群公告时复用密码字段', () => {
    const passwordGroup = group({ hasAdminPassword: true, canManage: false, selfRole: 'member' })

    expect(
      prepareGroupAdminPatch(passwordGroup, { kind: 'set-description', description: '' }, '  s3cret  ')
    ).toEqual({
      ok: true,
      patch: { kind: 'set-description', description: '', adminPassword: 's3cret' }
    })
    expect(
      prepareGroupAdminPatch(passwordGroup, { kind: 'set-announce', announce: '新公告' }, '  s3cret  ')
    ).toEqual({
      ok: true,
      patch: { kind: 'set-announce', announce: '新公告', adminPassword: 's3cret' }
    })
  })

  it('群主或管理员在密码组内管理时不附带密码', () => {
    const result = prepareGroupAdminPatch(
      group({ hasAdminPassword: true }),
      { kind: 'remove', memberIds: ['node-a'] },
      ''
    )

    expect(result).toEqual({
      ok: true,
      patch: { kind: 'remove', memberIds: ['node-a'] }
    })
  })

  it('管理员和密码持有者只能移出普通成员', () => {
    const admin = group({
      ownerId: 'node-owner',
      adminIds: ['node-self', 'node-admin'],
      selfRole: 'admin',
      members: ['node-owner', 'node-self', 'node-admin', 'node-a']
    })
    expect(canRemoveGroupMember(admin, 'node-a', 'node-self')).toBe(true)
    expect(canRemoveGroupMember(admin, 'node-owner', 'node-self')).toBe(false)
    expect(canRemoveGroupMember(admin, 'node-admin', 'node-self')).toBe(false)

    const passwordMember = group({
      ownerId: 'node-owner',
      adminIds: ['node-admin'],
      selfRole: 'member',
      canManage: false,
      hasAdminPassword: true,
      members: ['node-owner', 'node-admin', 'node-self', 'node-a']
    })
    expect(canRemoveGroupMember(passwordMember, 'node-a', 'node-self')).toBe(true)
    expect(canRemoveGroupMember(passwordMember, 'node-admin', 'node-self')).toBe(false)
  })

  it('只有群主显示管理员任免入口，密码成员仍可显示改名入口', () => {
    expect(canSetGroupAdmin(group(), 'node-a')).toBe(true)
    expect(canSetGroupAdmin(group({ selfRole: 'admin' }), 'node-a')).toBe(false)
    expect(
      canRenameGroup(group({ selfRole: 'member', canManage: false, hasAdminPassword: true }))
    ).toBe(true)
  })

  it('只有群主或管理员才可设置群简介和群公告', () => {
    const owner = group({ selfRole: 'owner' })
    const admin = group({ selfRole: 'admin', ownerId: 'node-owner', adminIds: ['node-self'] })
    const passwordMember = group({
      selfRole: 'member',
      canManage: false,
      hasAdminPassword: true
    })
    const plainMember = group({ selfRole: 'member', canManage: false })

    expect(owner.canManage).toBe(true)
    expect(admin.canManage).toBe(true)
    expect(passwordMember.canManage).toBe(false)
    expect(plainMember.canManage).toBe(false)
  })
})
