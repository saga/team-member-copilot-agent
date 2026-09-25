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
 *   3 — Team discussion：
 *         conversation_member_state（Member 在房间里的读游标 + 唤醒状态）
 *         execution.decision / trigger_message_sequence
 *   4 — Wake 可重放：
 *         conversation_member_state.pending_wake_trigger_sequence / pending_wake_reason
 *   5 — 数据正确性：
 *         conversation_message.client_request_id + UNIQUE(conversation_id, client_request_id)
 *         execution.config_snapshot
 *         group conversation 的 default_member_id 一律置 NULL
 *   6 — Member provisioning：
 *         member.seed_key + 部分唯一索引（WHERE seed_key IS NOT NULL）
 */

export const SCHEMA_VERSION = 6;

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

/**
 * v3 新增部分，被全新库和 v2→v3 迁移共用。
 *
 * 这里刻意只用 `CREATE TABLE` / `ALTER TABLE ADD COLUMN`：给 execution 加列不需要
 * 重建表，而重建表要处理 parent_execution_id / retry_of_execution_id 两个自引用外键，
 * 风险远大于收益。（加 CHECK 约束才必须重建，这次没有。）
 */
export const V3_ADDITIONS_SQL = `
CREATE TABLE IF NOT EXISTS conversation_member_state (
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  -- 这个 Member 已经读到房间的哪个位置
  last_seen_message_sequence INTEGER NOT NULL DEFAULT 0,
  -- 这个 Member 最后一次发言的序号
  last_replied_message_sequence INTEGER NOT NULL DEFAULT 0,
  wake_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (wake_status IN ('idle', 'queued', 'running', 'cooldown')),
  -- durable 的「有个唤醒信号还没处理完」标记，重启后靠它重新派 wake
  pending_wake INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, member_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_member_state_wake
  ON conversation_member_state(conversation_id, wake_status);

ALTER TABLE execution ADD COLUMN decision TEXT;

ALTER TABLE execution ADD COLUMN trigger_message_sequence INTEGER;

-- 为什么唤醒这个 Member（direct / mention / open_discussion / follow_up）。
-- 落库是为了重启恢复时能忠实重放同一轮，而不是猜一个。
ALTER TABLE execution ADD COLUMN wake_reason TEXT;
`;

/** v3 schema，全新库直接建这个。 */
export const V3_SCHEMA_SQL = `${V2_SCHEMA_SQL}\n${V3_ADDITIONS_SQL}`;

/**
 * v4 新增部分，被全新库和 v3→v4 迁移共用。
 *
 * 只加列，不重建表：conversation_member_state 被 conversation / member 两张表
 * 引用，重建的收益（给 reason 加 CHECK）远小于风险。
 */
export const V4_ADDITIONS_SQL = `
-- 排队中的这次唤醒是被哪条消息、以什么原因触发的，与 pending_wake 同生共死。
--
-- 不落库的话，重启恢复只能拿「房间当前最大序号」+ 最宽松的 reason 去猜：
-- 一次 "@bob 看下风险"（reason=mention, trigger=17）会被重放成
-- reason=open_discussion、trigger=23，对着完全另一条消息重新判断要不要发言。
ALTER TABLE conversation_member_state ADD COLUMN pending_wake_trigger_sequence INTEGER;

-- WakeReason 的取值由 domain.ts 定义。这里刻意不加 CHECK：SQLite 加 CHECK 只能
-- 重建表，而取值集合在 TypeScript 侧已经是封闭联合，写入口只有 scheduler 一处。
ALTER TABLE conversation_member_state ADD COLUMN pending_wake_reason TEXT;
`;

/** v4 schema，全新库直接建这个。 */
export const V4_SCHEMA_SQL = `${V3_SCHEMA_SQL}\n${V4_ADDITIONS_SQL}`;

/**
 * v5 新增部分，被全新库和 v4→v5 迁移共用。
 *
 * 同样只加列 / 加索引，不重建表：conversation_message 被 conversation 引用，
 * execution 还带着两个自引用外键，重建的收益远小于风险。
 */
export const V5_ADDITIONS_SQL = `
-- 调用方为这条消息发的幂等键。同一次「发送」被重试（响应丢了、用户狂点）
-- 时不会再落一条重复消息，也不会再派一次唤醒。
--
-- 允许为 NULL（服务端内部产生的消息、以及没有传幂等键的调用方），
-- 而 SQLite 的 UNIQUE 索引把 NULL 视为互不相等，所以这些行天然不参与去重。
ALTER TABLE conversation_message ADD COLUMN client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_client_request
  ON conversation_message(conversation_id, client_request_id);

-- 这一轮跑的时候，这个 Member 的配置长什么样。
--
-- 配置（system prompt / memory / skills / model / toolProfile）会随时间变，
-- 而 execution 是「当时真的跑过一轮」的记录。没有这个快照，事后看两条
-- execution 只能看到不同的行为，看不到不同的输入。
ALTER TABLE execution ADD COLUMN config_snapshot TEXT;
`;

/** v5 schema，全新库直接建这个。 */
export const V5_SCHEMA_SQL = `${V4_SCHEMA_SQL}\n${V5_ADDITIONS_SQL}`;

/**
 * v6 新增部分，被全新库和 v5→v6 迁移共用。
 *
 * 只加列 + 加索引，不重建表：member 被 conversation_member / member_runtime /
 * execution / conversation 四张表引用，重建的代价和 v1→v2 那次一样大。
 */
export const V6_ADDITIONS_SQL = `
-- 这个 Member 是由哪份 member template provision 出来的。
--
-- 判据不能是 handle / name：那是用户随时会改的显示属性。改了 handle 之后重启，
-- 按 handle 判断会认为默认 Member 不存在，于是又建一个 —— 团队里出现两个架构师。
--
-- 允许为 NULL（手工创建的 Member 没有模板来源），且是**部分**唯一索引：
-- 全局唯一索引会让所有手工创建的 NULL 行互相冲突。
ALTER TABLE member ADD COLUMN seed_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_seed_key
  ON member(seed_key)
  WHERE seed_key IS NOT NULL;
`;

/** v6 schema，全新库直接建这个。 */
export const V6_SCHEMA_SQL = `${V5_SCHEMA_SQL}\n${V6_ADDITIONS_SQL}`;

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

export function applySchemaV3(db: DatabaseSync): void {
  db.exec(V3_SCHEMA_SQL);
}

export function applySchemaV4(db: DatabaseSync): void {
  db.exec(V4_SCHEMA_SQL);
}

export function applySchemaV5(db: DatabaseSync): void {
  db.exec(V5_SCHEMA_SQL);
}

export function applySchemaV6(db: DatabaseSync): void {
  db.exec(V6_SCHEMA_SQL);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
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
      applySchemaV6(db);
      setUserVersion(db, SCHEMA_VERSION);
      return { from: 0, to: SCHEMA_VERSION, applied: ['create-schema-v6'], fresh: true };
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

  if (version < 3) {
    migrateV2ToV3(db);
    applied.push('v2-to-v3');
    version = 3;
    setUserVersion(db, 3);
  }

  if (version < 4) {
    migrateV3ToV4(db);
    applied.push('v3-to-v4');
    version = 4;
    setUserVersion(db, 4);
  }

  if (version < 5) {
    migrateV4ToV5(db);
    applied.push('v4-to-v5');
    version = 5;
    setUserVersion(db, 5);
  }

  if (version < 6) {
    migrateV5ToV6(db);
    applied.push('v5-to-v6');
    version = 6;
    setUserVersion(db, 6);
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

/**
 * v2 → v3：加 conversation_member_state + execution.decision / trigger_message_sequence。
 *
 * 不需要重建表（只加列、只加表），所以比 v1→v2 简单得多。
 */
function migrateV2ToV3(db: DatabaseSync): void {
  const updatedAt = new Date().toISOString();

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // ALTER 不幂等，用 table_info 兜一层，避免「迁移跑到一半被中断后重跑」时炸掉
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_member_state (
        conversation_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        last_seen_message_sequence INTEGER NOT NULL DEFAULT 0,
        last_replied_message_sequence INTEGER NOT NULL DEFAULT 0,
        wake_status TEXT NOT NULL DEFAULT 'idle'
          CHECK (wake_status IN ('idle', 'queued', 'running', 'cooldown')),
        pending_wake INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, member_id),
        FOREIGN KEY (conversation_id)
          REFERENCES conversation(id)
          ON DELETE CASCADE,
        FOREIGN KEY (member_id)
          REFERENCES member(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_member_state_wake
        ON conversation_member_state(conversation_id, wake_status);
    `);

    if (!hasColumn(db, 'execution', 'decision')) {
      db.exec(`ALTER TABLE execution ADD COLUMN decision TEXT;`);
    }
    if (!hasColumn(db, 'execution', 'trigger_message_sequence')) {
      db.exec(`ALTER TABLE execution ADD COLUMN trigger_message_sequence INTEGER;`);
    }
    if (!hasColumn(db, 'execution', 'wake_reason')) {
      db.exec(`ALTER TABLE execution ADD COLUMN wake_reason TEXT;`);
    }

    // 给现有 roster 里的每个 (conversation, member) 补一行状态。
    //
    // last_seen 直接推到该 conversation 的当前 message_sequence，而不是 0：
    // 否则升级后第一次收到新消息时，每个 Member 的「未读」都是整个历史，
    // 会被一次性灌进 prompt。（和 v1→v2 推 last_context_message_sequence 同一个理由。）
    db.prepare(
      `
      INSERT OR IGNORE INTO conversation_member_state (
        conversation_id,
        member_id,
        last_seen_message_sequence,
        last_replied_message_sequence,
        wake_status,
        pending_wake,
        muted,
        updated_at
      )
      SELECT
        cm.conversation_id,
        cm.member_id,
        COALESCE(c.message_sequence, 0),
        0,
        'idle',
        0,
        0,
        ?
      FROM conversation_member cm
      JOIN conversation c
        ON c.id = cm.conversation_id
      `,
    ).run(updatedAt);

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

/**
 * v3 → v4：给 conversation_member_state 补 pending wake 的元数据。
 *
 * 只加两列。已有行的值为 NULL —— 与 pending_wake = 0 语义一致（没在排队就没有
 * 触发信息）；万一升级时正好有 pending_wake = 1 的行，恢复逻辑会退回宽松解释
 * （见 conversation-member-service.findLostWakes）。
 */
function migrateV3ToV4(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'conversation_member_state', 'pending_wake_trigger_sequence')) {
      db.exec(
        `ALTER TABLE conversation_member_state ADD COLUMN pending_wake_trigger_sequence INTEGER;`,
      );
    }
    if (!hasColumn(db, 'conversation_member_state', 'pending_wake_reason')) {
      db.exec(`ALTER TABLE conversation_member_state ADD COLUMN pending_wake_reason TEXT;`);
    }

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

/**
 * v4 → v5：消息幂等键 + execution 配置快照 + group 的 default_member_id 归一。
 *
 * 三件事都只加列 / 加索引 / 改数据，不需要重建表：
 *
 *   client_request_id      UNIQUE(conversation_id, client_request_id) 是索引不是约束，
 *                          可以后补。已有行全是 NULL，而 NULL 在唯一索引里互不相等，
 *                          所以历史消息不会互相冲突。
 *   config_snapshot        历史 execution 没有这个值 —— 它记录的是「当时用的配置」，
 *                          事后补不出来，留 NULL 就是诚实的答案（读取时按 null 处理）。
 *   default_member_id      老数据里 group 房间可能带着一个默认成员。那个字段的语义是
 *                          「这个房间归谁」，对共享讨论没有意义，而且会诱导调用方把它
 *                          当成默认收件人 —— 那正是把 group 降级成单人聊天的成因。
 */
function migrateV4ToV5(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'conversation_message', 'client_request_id')) {
      db.exec(`ALTER TABLE conversation_message ADD COLUMN client_request_id TEXT;`);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_client_request
        ON conversation_message(conversation_id, client_request_id);
    `);

    if (!hasColumn(db, 'execution', 'config_snapshot')) {
      db.exec(`ALTER TABLE execution ADD COLUMN config_snapshot TEXT;`);
    }

    db.exec(`UPDATE conversation SET default_member_id = NULL WHERE kind = 'group';`);

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

/**
 * v5 → v6：Member 的 provisioning identity。
 *
 * 这里不需要 `PRAGMA foreign_keys = OFF` —— 那只在重建表时才必要，而这次
 * 只加一列加一个索引，不碰任何被引用的表的形状。
 *
 * 索引是**部分**索引（`WHERE seed_key IS NOT NULL`）：member 表上绝大多数行
 * 是手工创建的、`seed_key` 为 NULL，而 SQLite 的唯一索引把 NULL 视为互不相等
 * —— 全局唯一索引虽然也不会误判，但会为每一行 NULL 建一条索引项，白占空间，
 * 而且让「哪些行来自模板」这件事在 schema 里看不出来。
 */
function migrateV5ToV6(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'member', 'seed_key')) {
      db.exec(`ALTER TABLE member ADD COLUMN seed_key TEXT;`);
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_member_seed_key
        ON member(seed_key)
        WHERE seed_key IS NOT NULL;
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
