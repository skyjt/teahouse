import type DatabaseT from 'better-sqlite3'

// 库表迁移：PRAGMA user_version 递增（tech-design §5）。
// 只追加新迁移，永不修改已发布的旧迁移。本文件只引类型，不引驱动运行时。

export const MIGRATIONS: ReadonlyArray<string> = [
  // v1：发现层 + 消息层地基
  `
  CREATE TABLE peers (
    node_id     TEXT PRIMARY KEY,
    nick        TEXT NOT NULL,
    remark      TEXT,                -- 本地备注名（F-DISC-9），不入协议
    company     TEXT NOT NULL DEFAULT '',
    dept        TEXT NOT NULL DEFAULT '',
    team        TEXT NOT NULL DEFAULT '',
    avatar      INTEGER NOT NULL DEFAULT -1,
    host        TEXT NOT NULL DEFAULT '',
    platform    TEXT NOT NULL DEFAULT 'linux',
    ip          TEXT NOT NULL DEFAULT '',
    udp_port    INTEGER NOT NULL DEFAULT 0,
    tcp_port    INTEGER NOT NULL DEFAULT 0,
    profile_rev INTEGER NOT NULL DEFAULT 0,
    caps        TEXT NOT NULL DEFAULT '[]',
    ver         TEXT NOT NULL DEFAULT '',
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );
  CREATE INDEX idx_peers_last_seen ON peers(last_seen);

  CREATE TABLE conversations (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL,            -- 'single' | 'group'
    peer_or_group_id TEXT NOT NULL,
    last_ts          INTEGER NOT NULL DEFAULT 0,
    unread           INTEGER NOT NULL DEFAULT 0,
    pinned           INTEGER NOT NULL DEFAULT 0,
    muted            INTEGER NOT NULL DEFAULT 0,
    draft            TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX idx_conv_target ON conversations(type, peer_or_group_id);

  CREATE TABLE messages (
    id        TEXT PRIMARY KEY,                -- 协议 msgId，全局唯一（去重/撤回/补发的锚点）
    conv_id   TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    is_mine   INTEGER NOT NULL,
    kind      TEXT NOT NULL,                   -- text | image | sticker | group-text ...
    content   TEXT NOT NULL DEFAULT '',
    file_ref  TEXT,                            -- JSON
    ts        INTEGER NOT NULL,
    seq       INTEGER NOT NULL,                -- 本地单调递增，时钟漂移兜底排序
    status    TEXT NOT NULL                    -- sending | sent | queued | failed | recalled
  );
  CREATE INDEX idx_messages_conv ON messages(conv_id, ts, seq);

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    msg_id UNINDEXED,
    text                                        -- 入库时中文已按字预切（store/fts.ts）
  );

  CREATE TABLE send_queue (
    msg_id   TEXT PRIMARY KEY,
    peer_id  TEXT NOT NULL,
    envelope TEXT NOT NULL,                     -- 完整信封 JSON，上线后原样补发
    created  INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_queue_peer ON send_queue(peer_id, created);

  CREATE TABLE dedup (
    msg_id  TEXT PRIMARY KEY,
    recv_ts INTEGER NOT NULL
  );
  CREATE INDEX idx_dedup_ts ON dedup(recv_ts);
  `,

  // v2：文件传输记录（v0.2）
  `
  CREATE TABLE transfers (
    transfer_id TEXT PRIMARY KEY,
    msg_id      TEXT NOT NULL,
    peer_id     TEXT NOT NULL,
    direction   TEXT NOT NULL,              -- 'in' | 'out'
    files       TEXT NOT NULL DEFAULT '{}', -- 服务层 JSON：{name, savedPath?}
    status      TEXT NOT NULL,              -- offering|accepted|done|declined|canceled|failed
    bytes_done  INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX idx_transfers_status ON transfers(status);
  `,

  // v3：补发队列改复合主键（群消息同一 msgId 给多个收件人各排一条，§7.4）
  `
  CREATE TABLE send_queue_v2 (
    msg_id   TEXT NOT NULL,
    peer_id  TEXT NOT NULL,
    envelope TEXT NOT NULL,
    created  INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (msg_id, peer_id)
  );
  INSERT INTO send_queue_v2 (msg_id, peer_id, envelope, created, attempts)
    SELECT msg_id, peer_id, envelope, created, attempts FROM send_queue;
  DROP TABLE send_queue;
  ALTER TABLE send_queue_v2 RENAME TO send_queue;
  CREATE INDEX idx_queue_peer ON send_queue(peer_id, created);
  `,

  // v4：讨论组元数据（§7.4）
  `
  CREATE TABLE groups (
    group_id   TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    members    TEXT NOT NULL DEFAULT '[]',  -- JSON: nodeId[]
    rev        INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_ts INTEGER NOT NULL DEFAULT 0
  );
  `,

  // v5：自定义表情包（F-MSG-7）
  `
  CREATE TABLE stickers (
    id       TEXT PRIMARY KEY,
    path     TEXT NOT NULL,
    w        INTEGER NOT NULL DEFAULT 0,
    h        INTEGER NOT NULL DEFAULT 0,
    animated INTEGER NOT NULL DEFAULT 0,
    sort     INTEGER NOT NULL DEFAULT 0,
    added    INTEGER NOT NULL
  );
  `,

  // v6：群内 @ 本地会话标记（打开会话即清除）
  `
  ALTER TABLE conversations ADD COLUMN mentioned INTEGER NOT NULL DEFAULT 0;
  `,

  // v7：讨论组管理门槛（决议 #27）：创建 IP + 管理密码摘要
  `
  ALTER TABLE groups ADD COLUMN creator_ip TEXT NOT NULL DEFAULT '';
  ALTER TABLE groups ADD COLUMN admin_secret_hash TEXT NOT NULL DEFAULT '';
  `,

  // v8：讨论组管理密码提示（决议 #30）：仅展示，不参与鉴权
  `
  ALTER TABLE groups ADD COLUMN admin_hint TEXT NOT NULL DEFAULT '';
  `,

  // v9：无密码群多网卡管理校验（决议 #113）：记录创建者 nodeId
  `
  ALTER TABLE groups ADD COLUMN creator_id TEXT NOT NULL DEFAULT '';
  UPDATE groups
    SET creator_id = updated_by
    WHERE admin_secret_hash = '' AND creator_id = '' AND updated_by <> '';
  `,

  // v10：消息 seq 索引（决议 #200 / OPT-5）：MAX(seq) 取号与按 seq 分页/预览不再全表扫
  `
  CREATE INDEX idx_messages_seq ON messages(seq);
  CREATE INDEX idx_messages_conv_seq ON messages(conv_id, seq);
  `,

  // v11：讨论组显式群主/管理员角色（决议 #241）
  `
  ALTER TABLE groups ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE groups ADD COLUMN admin_ids TEXT NOT NULL DEFAULT '[]';
  `,

  // v12：自定义用户/群头像内容哈希（决议 #243）
  `
  ALTER TABLE peers ADD COLUMN avatar_hash TEXT NOT NULL DEFAULT '';
  ALTER TABLE groups ADD COLUMN avatar_hash TEXT NOT NULL DEFAULT '';
  `,

  // v13：普通文件 24 小时领取期限与可重启恢复的出站源清单（决议 #263）
  `
  ALTER TABLE transfers ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_transfers_expiry ON transfers(expires_at, status);

  CREATE TABLE outgoing_file_manifests (
    msg_id     TEXT PRIMARY KEY,
    files      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,

  // v14：共享文件柜按联系人例外（决议 #271/#277）
  // 只存与默认档不同的例外；恢复"跟随默认"即删行。共享根与默认档在 config.json，不入库。
  `
  CREATE TABLE share_grants (
    node_id    TEXT PRIMARY KEY,
    mode       TEXT NOT NULL,              -- 'off' | 'read' | 'write'
    updated_ts INTEGER NOT NULL
  );
  `,

  // v15：群聊引用回复（群消息可选携带被引用消息 id）
  `
  ALTER TABLE messages ADD COLUMN reply_to TEXT;
  `,

  // v16：群简介与群公告（群主、管理员或正确密码持有者可设置）
  `
  ALTER TABLE groups ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE groups ADD COLUMN announce TEXT NOT NULL DEFAULT '';
  `
]

export function applyMigrations(db: DatabaseT.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
