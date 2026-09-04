import type { GroupPatch, GroupView } from '../../../shared/ipc'

export type GroupAdminAction =
  | { kind: 'rename'; name: string }
  | { kind: 'remove'; memberIds: string[] }
  | { kind: 'set-description'; description: string }
  | { kind: 'set-announce'; announce: string }

export type GroupAdminPatchResult =
  | { ok: true; patch: GroupPatch }
  | { ok: false; reason: 'missing-password' | 'not-allowed' }

export function prepareGroupAdminPatch(
  group: GroupView,
  action: GroupAdminAction,
  rawPassword: string
): GroupAdminPatchResult {
  if (group.canManage) return { ok: true, patch: action }
  if (!group.hasAdminPassword) return { ok: false, reason: 'not-allowed' }

  const adminPassword = rawPassword.trim()
  if (!adminPassword) return { ok: false, reason: 'missing-password' }
  return { ok: true, patch: { ...action, adminPassword } }
}

export function canRenameGroup(group: GroupView): boolean {
  return group.amMember && (group.canManage || group.hasAdminPassword)
}

export function canRemoveGroupMember(
  group: GroupView,
  memberId: string,
  selfId: string
): boolean {
  if (!group.amMember || memberId === selfId || memberId === group.ownerId) return false
  const targetIsAdmin = group.adminIds.includes(memberId)
  if (group.selfRole === 'owner') return true
  if (targetIsAdmin) return false
  return group.selfRole === 'admin' || group.hasAdminPassword
}

export function canSetGroupAdmin(group: GroupView, memberId: string): boolean {
  return (
    group.amMember &&
    group.selfRole === 'owner' &&
    memberId !== group.ownerId &&
    group.members.includes(memberId)
  )
}
