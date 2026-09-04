import type DatabaseT from 'better-sqlite3'
import { isAvatarHash, type GroupMeta } from '../../shared/protocol'

// 群元数据存储（§7.4）：rev 单调递增，冲突按 (rev, updatedTs) 取大——LWW 尽力而为一致性

interface GroupRow {
  group_id: string
  name: string
  members: string
  rev: number
  updated_by: string
  updated_ts: number
  creator_ip?: string
  creator_id?: string
  owner_id?: string
  admin_ids?: string
  avatar_hash?: string
  admin_secret_hash?: string
  admin_hint?: string
  description?: string
  announce?: string
}

function parseMembers(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((m): m is string => typeof m === 'string' && m.length > 0)
      : []
  } catch {
    return []
  }
}

function inferOwnerId(
  members: string[],
  ownerId: string | undefined,
  creatorId: string | undefined,
  updatedBy: string | undefined
): string {
  for (const candidate of [ownerId, creatorId, updatedBy]) {
    if (candidate && members.includes(candidate)) return candidate
  }
  return members[0] ?? ''
}

function rowToMeta(row: GroupRow): GroupMeta {
  const members = [...new Set(parseMembers(row.members))]
  const ownerId = inferOwnerId(members, row.owner_id, row.creator_id, row.updated_by)
  const adminIds = [...new Set(parseMembers(row.admin_ids))].filter(
    (id) => id !== ownerId && members.includes(id)
  )
  return {
    groupId: row.group_id,
    name: row.name,
    members,
    rev: row.rev,
    updatedBy: row.updated_by,
    updatedTs: row.updated_ts,
    creatorIp: row.creator_ip ?? '',
    creatorId: row.creator_id ?? '',
    ownerId,
    adminIds,
    avatarHash: isAvatarHash(row.avatar_hash) ? row.avatar_hash : '',
    adminSecretHash: row.admin_secret_hash ?? '',
    adminHint: row.admin_hint ?? '',
    description: row.description ?? '',
    announce: row.announce ?? ''
  }
}

function normalizeMeta(meta: GroupMeta): GroupMeta {
  const members = [...new Set(meta.members)].filter((id) => id.length > 0)
  const ownerId = inferOwnerId(members, meta.ownerId, meta.creatorId, meta.updatedBy)
  return {
    ...meta,
    name: meta.name.slice(0, 64),
    members,
    creatorIp: meta.creatorIp ?? '',
    creatorId: meta.creatorId ?? '',
    ownerId,
    adminIds: [...new Set(meta.adminIds ?? [])].filter(
      (id) => id !== ownerId && members.includes(id)
    ),
    avatarHash: isAvatarHash(meta.avatarHash) ? meta.avatarHash : '',
    adminSecretHash: meta.adminSecretHash ?? '',
    adminHint: meta.adminSecretHash ? (meta.adminHint ?? '').slice(0, 40) : '',
    description: (meta.description ?? '').slice(0, 200),
    announce: (meta.announce ?? '').slice(0, 1024)
  }
}

export class GroupRepo {
  private readonly upsertStmt: DatabaseT.Statement
  private readonly getStmt: DatabaseT.Statement
  private readonly listStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO groups (
        group_id, name, members, rev, updated_by, updated_ts,
        creator_ip, creator_id, owner_id, admin_ids, avatar_hash, admin_secret_hash, admin_hint, description, announce
      )
      VALUES (
        @groupId, @name, @members, @rev, @updatedBy, @updatedTs,
        @creatorIp, @creatorId, @ownerId, @adminIds, @avatarHash, @adminSecretHash, @adminHint, @description, @announce
      )
      ON CONFLICT(group_id) DO UPDATE SET
        name = excluded.name, members = excluded.members, rev = excluded.rev,
        updated_by = excluded.updated_by, updated_ts = excluded.updated_ts,
        creator_ip = excluded.creator_ip, creator_id = excluded.creator_id,
        owner_id = excluded.owner_id, admin_ids = excluded.admin_ids,
        avatar_hash = excluded.avatar_hash,
        admin_secret_hash = excluded.admin_secret_hash,
        admin_hint = excluded.admin_hint,
        description = excluded.description,
        announce = excluded.announce
    `)
    this.getStmt = db.prepare('SELECT * FROM groups WHERE group_id = ?')
    this.listStmt = db.prepare('SELECT * FROM groups ORDER BY updated_ts DESC')
  }

  save(meta: GroupMeta): void {
    const normalized = normalizeMeta(meta)
    this.upsertStmt.run({
      ...normalized,
      members: JSON.stringify(normalized.members),
      adminIds: JSON.stringify(normalized.adminIds)
    })
  }

  get(groupId: string): GroupMeta | undefined {
    const row = this.getStmt.get(groupId) as GroupRow | undefined
    return row ? rowToMeta(row) : undefined
  }

  list(): GroupMeta[] {
    return (this.listStmt.all() as GroupRow[]).map(rowToMeta)
  }

  /** 远端元数据按 LWW 合并；返回是否采纳 */
  applyRemote(meta: GroupMeta): boolean {
    const local = this.get(meta.groupId)
    if (
      local &&
      (meta.rev < local.rev || (meta.rev === local.rev && meta.updatedTs <= local.updatedTs))
    ) {
      return false
    }
    this.save(meta)
    return true
  }
}
