import type { DatabaseSync } from 'node:sqlite';

/**
 * 用 `PRAGMA user_version` 做 schema 版本管理，不引入 ORM / migration framework。
 *
 * 版本历史：
 *   1 — 初版（member / conversation / conversation_member / conversation_message /
 *       member_runtime / execution），由旧的 `CREATE TABLE IF NOT EXISTS` 建立，
 *       当时没有写 user_version。
 *   2 — Runtime reliability：
 *         conversation.event_sequence / message_sequence
 *         conversation_message.message_sequence
 *         member_runtime.active_execution_id / last_context_message_sequence
 *         execution.waiting_for_runtime_id / retry_of_execution_id
 *         execution.status 增加 waiting_for_member / interrupted
 *         conversation_event（durable event + SSE replay）
 */

export const SCHEMA_VERSION = 2;

/**
 * v1 schema。生产路径不会再创建它，保留的原因有两个：
 *  - 迁移逻辑的起点（旧库就是长这样）
 *  - 迁移测试用它构造旧库 fixture
 */
export const V1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  tool_profile TEXT NOT NULL DEFAULT 'safe'
    CHECK (tool_profile IN ('safe', 'coding')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('direct', 'group', 'work')),
  default_member_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (default_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_member (
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, member_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL
    CHECK (sender_type IN ('user', 'member', 'system')),
  sender_id TEXT NOT NULL,
  target_member_id TEXT,
  reply_to_message_id TEXT,
  content TEXT NOT NULL,
  execution_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (target_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_message_conversation_created
  ON conversation_message(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS member_runtime (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  copilot_session_id TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'error')),
  last_used_at TEXT,
  UNIQUE (conversation_id, member_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  runtime_id TEXT,
  parent_execution_id TEXT,
  delegation_path TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'interactive',
        'member_delegate',
        'member_work'
      )
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled'
      )
    ),
  prompt TEXT NOT NULL,
  response TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id),
  FOREIGN KEY (runtime_id)
    REFERENCES member_runtime(id),
  FOREIGN KEY (parent_execution_id)
    REFERENCES execution(id)
);

CREATE INDEX IF NOT EXISTS idx_execution_conversation_created
  ON execution(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_execution_parent
  ON execution(parent_execution_id);
`;

/** v2 schema，全新库直接建这个。 */
export const V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  tool_profile TEXT NOT NULL DEFAULT 'safe'
    CHECK (tool_profile IN ('safe', 'coding')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('direct', 'group', 'work')),
  default_member_id TEXT,
  created_by TEXT NOT NULL,
  -- 会话内单调递增的两个游标：event 用于 SSE replay，message 用于 context checkpoint
  event_sequence INTEGER NOT NULL DEFAULT 0,
  message_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (default_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_member (
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, member_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  -- 会话内单调递增，MemberRuntime.last_context_message_sequence 靠它做增量上下文
  message_sequence INTEGER NOT NULL,
  sender_type TEXT NOT NULL
    CHECK (sender_type IN ('user', 'member', 'system')),
  sender_id TEXT NOT NULL,
  target_member_id TEXT,
  reply_to_message_id TEXT,
  content TEXT NOT NULL,
  execution_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (target_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_conversation_sequence
  ON conversation_message(conversation_id, message_sequence);

CREATE INDEX IF NOT EXISTS idx_message_conversation_created
  ON conversation_message(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS member_runtime (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  copilot_session_id TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'error')),
  -- 当前持有该 runtime 的 execution（单写者记录）。软引用：
  -- 不建 FK，避免与 execution.runtime_id 形成循环外键。
  active_execution_id TEXT,
  -- 已注入过 Copilot session 的 shared message 水位线
  last_context_message_sequence INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  UNIQUE (conversation_id, member_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  runtime_id TEXT,
  parent_execution_id TEXT,
  delegation_path TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'interactive',
        'member_delegate',
        'member_work'
      )
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'running',
        'waiting_for_member',
        'completed',
        'failed',
        'cancelled',
        'interrupted'
      )
    ),
  prompt TEXT NOT NULL,
  response TEXT,
  error TEXT,
  -- 正在等待哪个 runtime 完成（delegation deadlock 检测用）。软引用，不建 FK。
  waiting_for_runtime_id TEXT,
  -- retry 会生成新 execution 并指回被 retry 的那条，审计链不断
  retry_of_execution_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id),
  FOREIGN KEY (runtime_id)
    REFERENCES member_runtime(id),
  FOREIGN KEY (parent_execution_id)
    REFERENCES execution(id),
  FOREIGN KEY (retry_of_execution_id)
    REFERENCES execution(id)
);

CREATE INDEX IF NOT EXISTS idx_execution_conversation_created
  ON execution(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_execution_parent
  ON execution(parent_execution_id);

CREATE INDEX IF NOT EXISTS idx_execution_status
  ON execution(status);

-- durable event：DB 是 source of truth，SSE 只是投递手段
CREATE TABLE IF NOT EXISTS conversation_event (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_event_replay
  ON conversation_event(conversation_id, sequence);
`;

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

function setUserVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`非法的 schema version：${version}`);
  }
  // PRAGMA 不接受绑定参数，version 是内部整数，直接拼接是安全的
  db.exec(`PRAGMA user_version = ${version}`);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

export function applySchemaV1(db: DatabaseSync): void {
  db.exec(V1_SCHEMA_SQL);
}

export function applySchemaV2(db: DatabaseSync): void {
  db.exec(V2_SCHEMA_SQL);
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
  /** 全新库（不是升级），调用方可以据此打日志区分 */
  fresh: boolean;
}

/**
 * 幂等迁移。
 *
 * version = 0 且已存在 member 表 → 是旧代码用 CREATE TABLE IF NOT EXISTS 建出来的库，
 * 当作 v1 处理，而不是当成全新库重建（否则用户已有的 .data/team-member.db 会炸）。
 */
export function migrate(db: DatabaseSync): MigrationResult {
  const applied: string[] = [];
  let version = getUserVersion(db);

  if (version === 0) {
    if (hasTable(db, 'member')) {
      // 旧库没有写过 user_version，补登记为 v1
      version = 1;
      setUserVersion(db, 1);
    } else {
      applySchemaV2(db);
      setUserVersion(db, SCHEMA_VERSION);
      return { from: 0, to: SCHEMA_VERSION, applied: ['create-schema-v2'], fresh: true };
    }
  }

  if (version > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema version ${version} 高于本程序支持的 ${SCHEMA_VERSION}，拒绝启动以免损坏数据`,
    );
  }

  const from = version;

  if (version < 2) {
    migrateV1ToV2(db);
    applied.push('v1-to-v2');
    version = 2;
    setUserVersion(db, 2);
  }

  return { from, to: version, applied, fresh: false };
}

/**
 * v1 → v2。
 *
 * execution 需要改 status 的 CHECK 约束，而 SQLite 不支持 ALTER CHECK，
 * 所以按官方 12 步流程重建表；重建期间必须关掉 foreign_keys
 * （该 PRAGMA 在事务内无效，所以要在 BEGIN 之前设）。
 */
function migrateV1ToV2(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      ALTER TABLE conversation ADD COLUMN event_sequence INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation ADD COLUMN message_sequence INTEGER NOT NULL DEFAULT 0;
    `);

    db.exec(`
      ALTER TABLE conversation_message ADD COLUMN message_sequence INTEGER NOT NULL DEFAULT 0;
    `);
    // 按 (created_at, rowid) 给历史消息补 1..N 的会话内序号
    db.exec(`
      UPDATE conversation_message
      SET message_sequence = (
        SELECT COUNT(*)
        FROM conversation_message AS older
        WHERE older.conversation_id = conversation_message.conversation_id
          AND (
            older.created_at < conversation_message.created_at
            OR (
              older.created_at = conversation_message.created_at
              AND older.rowid <= conversation_message.rowid
            )
          )
      );
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_conversation_sequence
        ON conversation_message(conversation_id, message_sequence);
    `);
    // 让计数器追上历史消息，否则下一条消息会撞 UNIQUE
    db.exec(`
      UPDATE conversation
      SET message_sequence = COALESCE(
        (
          SELECT MAX(message_sequence)
          FROM conversation_message m
          WHERE m.conversation_id = conversation.id
        ),
        0
      );
    `);

    db.exec(`
      ALTER TABLE member_runtime ADD COLUMN active_execution_id TEXT;
      ALTER TABLE member_runtime ADD COLUMN last_context_message_sequence INTEGER NOT NULL DEFAULT 0;
    `);
    // 已有 runtime 的 Copilot session 里其实已经有历史（旧实现每轮都注入最近 24 条），
    // 把水位线推到当前最大序号，避免升级后立刻重复注入一次全量上下文。
    db.exec(`
      UPDATE member_runtime
      SET last_context_message_sequence = COALESCE(
        (
          SELECT MAX(message_sequence)
          FROM conversation_message m
          WHERE m.conversation_id = member_runtime.conversation_id
        ),
        0
      );
    `);

    db.exec(`
      CREATE TABLE execution_v2 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        runtime_id TEXT,
        parent_execution_id TEXT,
        delegation_path TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL
          CHECK (
            kind IN (
              'interactive',
              'member_delegate',
              'member_work'
            )
          ),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (
            status IN (
              'queued',
              'running',
              'waiting_for_member',
              'completed',
              'failed',
              'cancelled',
              'interrupted'
            )
          ),
        prompt TEXT NOT NULL,
        response TEXT,
        error TEXT,
        waiting_for_runtime_id TEXT,
        retry_of_execution_id TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id)
          REFERENCES conversation(id)
          ON DELETE CASCADE,
        FOREIGN KEY (member_id)
          REFERENCES member(id),
        FOREIGN KEY (runtime_id)
          REFERENCES member_runtime(id),
        FOREIGN KEY (parent_execution_id)
          REFERENCES execution(id),
        FOREIGN KEY (retry_of_execution_id)
          REFERENCES execution(id)
      );

      INSERT INTO execution_v2 (
        id,
        conversation_id,
        member_id,
        runtime_id,
        parent_execution_id,
        delegation_path,
        kind,
        status,
        prompt,
        response,
        error,
        waiting_for_runtime_id,
        retry_of_execution_id,
        started_at,
        ended_at,
        created_at
      )
      SELECT
        id,
        conversation_id,
        member_id,
        runtime_id,
        parent_execution_id,
        delegation_path,
        kind,
        status,
        prompt,
        response,
        error,
        NULL,
        NULL,
        started_at,
        ended_at,
        created_at
      FROM execution;

      DROP TABLE execution;
      ALTER TABLE execution_v2 RENAME TO execution;

      CREATE INDEX IF NOT EXISTS idx_execution_conversation_created
        ON execution(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_execution_parent
        ON execution(parent_execution_id);
      CREATE INDEX IF NOT EXISTS idx_execution_status
        ON execution(status);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_event (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (conversation_id, sequence),
        FOREIGN KEY (conversation_id)
          REFERENCES conversation(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_event_replay
        ON conversation_event(conversation_id, sequence);
    `);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `迁移后外键校验失败（${violations.length} 条），已回滚：${JSON.stringify(violations.slice(0, 5))}`,
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
