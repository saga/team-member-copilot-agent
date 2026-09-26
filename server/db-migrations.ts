import type { DatabaseSync } from 'node:sqlite';

/**
 * 数据库只有一个 schema 形状，没有迁移链。
 *
 *   空库              → 建 SCHEMA_SQL
 *   user_version 相等  → 什么都不做
 *   其它              → 拒绝启动
 *
 * 改 schema 的流程就是「改 SCHEMA_SQL + 删掉本地库重建」。默认团队由
 * member template 在启动时重新 provision，不需要人工补数据。
 *
 * 不留 `migrateVxToVy()` 是有意的：迁移代码只在升级那一瞬间被走到，是日常
 * 测试永远不会覆盖的一小段路径。宁可在启动时明确报错，也不要维护一条没人
 * 验证的升级路径。
 */

/**
 * 当前形状的编号。它只回答一个问题：这个 build 能不能直接吃这个库。
 *
 * 程序不认识任何别的编号 —— 没有升级代码，认出来也无从下手。
 */
export const SCHEMA_VERSION = 11;

/**
 * 当前 schema 的完整定义，按最终形状写。
 *
 * 只有全新的库会执行它，没有历史行需要照顾，所以不需要「建表 + 一串
 * ALTER TABLE ADD COLUMN」那种演化写法。外键可以前向引用（SQLite 建表时
 * 不校验目标表是否存在），表与索引的顺序按可读性排。
 */
export const SCHEMA_SQL = `
CREATE TABLE member (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  -- 这个 Member 由哪份 member template provision 出来；手工创建的为 NULL。
  --
  -- 判据不能是 handle / name：那是用户随时会改的显示属性。改了 handle 之后
  -- 重启，按 handle 判断会认为默认 Member 不存在，于是又建一个 —— 团队里
  -- 出现两个架构师。
  seed_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_member_seed_key
  ON member(seed_key)
  WHERE seed_key IS NOT NULL;

-- ─────────────────────────────────────────────── Member Capabilities ──────
--
-- Member 的「能力组成」：它引用哪些 Skill / Knowledge / Tool Provider。
--
-- 这里存的是 Provider ID（稳定契约）+ selector（Provider 自己解释的选择子），
-- 不是实现。所以「本地 SQLite 资料库」换成「企业搜索服务」时，Member 这一行
-- 不用动 —— 换的是注册表里那个 ID 背后的实现。
--
-- 表形状刻意的三合一（一张表 + capability_type）而不是三张表：三类能力在存储
-- 这一层的形状完全一样，拆开只会让「列出这个 Member 的全部能力」变成三次查询
-- 加一次手工合并。
--
-- selector 用 '' 而不是 NULL：它参与主键，而 SQLite 把 NULL 视为互不相等 ——
-- 用 NULL 会让同一个 (member, type, provider) 能插进无限多行。

CREATE TABLE member_capability_binding (
  member_id TEXT NOT NULL,
  capability_type TEXT NOT NULL
    CHECK (capability_type IN ('skill', 'knowledge', 'tool')),
  provider_id TEXT NOT NULL,
  selector TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, capability_type, provider_id, selector),
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_member_capability_provider
  ON member_capability_binding(capability_type, provider_id);

CREATE INDEX idx_member_capability_member
  ON member_capability_binding(member_id);

-- ─────────────────────────────────────────────── Team 业务模型 v1 ─────
--
-- Team 是顶层协作边界：Membership / Project / WorkItem / Presence / Schedule
-- 都挂在它下面。当前部署只有一个 Team，但形状上带 team_id，为以后多 Team 留结构。
-- Project 只是工作组织单元，不做第二层 ACL；Assignment/Claim 是 work_item 的字段，
-- 不是独立的表。

CREATE TABLE team (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  -- Team 级实时事件的游标，语义与 conversation.event_sequence 相同（SSE replay）
  event_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Team 级实时事件：WorkItem / Schedule / Presence / Project / Membership 的
-- 状态变化先落库再广播。与 conversation_event 同一套纪律 —— 落库是 source of
-- truth，SSE 帧带 id: <sequence>，断线重连靠 Last-Event-ID 补发。
-- payload 是 JSON：这里是通知层，不是审计层（WorkItem 的审计在 work_item_event，
-- 列式可查询），消费方只需要「什么变了」然后决定刷哪块 UI。
CREATE TABLE team_event (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (team_id, sequence),
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_team_event_team_sequence
  ON team_event(team_id, sequence);

CREATE TABLE team_membership (
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('human', 'agent')),
  principal_id TEXT NOT NULL,
  -- Member.role 是职业角色（Architect），这里是 Team 权限角色（owner/admin/member），
  -- 两者绝不合并。
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, kind, principal_id),
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_team_membership_team
  ON team_membership(team_id, status);

CREATE INDEX idx_team_membership_principal
  ON team_membership(kind, principal_id, status);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_project_team_status
  ON project(team_id, status);

CREATE TABLE work_item (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (
      status IN (
        'todo',
        'in_progress',
        'blocked',
        'done',
        'cancelled'
      )
    ),
  assignee_kind TEXT
    CHECK (
      assignee_kind IS NULL
      OR assignee_kind IN ('human', 'agent')
    ),
  assignee_id TEXT,
  claimed_by_member_id TEXT,
  claimed_execution_id TEXT,
  claimed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (assignee_kind IS NULL AND assignee_id IS NULL)
    OR
    (assignee_kind IS NOT NULL AND assignee_id IS NOT NULL)
  ),
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id)
    REFERENCES project(id)
    ON DELETE SET NULL,
  FOREIGN KEY (claimed_by_member_id)
    REFERENCES member(id)
);

CREATE INDEX idx_work_item_team_status
  ON work_item(team_id, status);

CREATE INDEX idx_work_item_project_status
  ON work_item(project_id, status);

CREATE INDEX idx_work_item_assignee
  ON work_item(assignee_kind, assignee_id, status);

CREATE INDEX idx_work_item_claim
  ON work_item(claimed_by_member_id);

-- WorkItem 的审计流水：每次 mutation 一行。全部列式存储、不做 JSON 大字段 ——
-- 这个项目最看重可查询性：「谁在什么时候、用哪条 execution claim 了它」
-- 必须能直接 WHERE event_type + actor_kind 出来，而不是解析一堆 JSON。
-- from/to 成对出现：事后能还原任意时刻的完整状态。
CREATE TABLE work_item_event (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'created',
        'updated',
        'assigned',
        'unassigned',
        'claimed',
        'released',
        'status_changed'
      )
    ),
  actor_kind TEXT NOT NULL
    CHECK (actor_kind IN ('human', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  -- claimed 事件记录发起 claim 的那一轮 execution。
  execution_id TEXT,
  from_status TEXT,
  to_status TEXT,
  from_assignee_kind TEXT,
  from_assignee_id TEXT,
  to_assignee_kind TEXT,
  to_assignee_id TEXT,
  from_claimed_by_member_id TEXT,
  to_claimed_by_member_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE,
  FOREIGN KEY (work_item_id)
    REFERENCES work_item(id)
    ON DELETE CASCADE,
  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
);

CREATE INDEX idx_work_item_event_item
  ON work_item_event(work_item_id, created_at);

CREATE INDEX idx_work_item_event_team
  ON work_item_event(team_id, created_at);

-- Presence 只存可配置的 availability（available/away/paused），busy/offline 由系统
-- 按 active execution 与 lastSeen 计算，不落库，否则三边打架。
CREATE TABLE team_presence (
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('human', 'agent')),
  principal_id TEXT NOT NULL,
  availability TEXT NOT NULL DEFAULT 'available'
    CHECK (availability IN ('available', 'away', 'paused')),
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, kind, principal_id),
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE
);

-- Scheduler 只做 once + interval，不做 Calendar/RRULE。conversation_id 必填且
-- 限定 work 房间：Schedule 不自建 runtime，只进已有 Conversation 的执行链。
CREATE TABLE scheduled_wake (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  project_id TEXT,
  work_item_id TEXT,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('once', 'interval')),
  run_at TEXT NOT NULL,
  interval_seconds INTEGER,
  next_run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (
      status IN (
        'active',
        'paused',
        'completed',
        'cancelled'
      )
    ),
  last_fired_at TEXT,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (type = 'once' AND interval_seconds IS NULL)
    OR
    (type = 'interval' AND interval_seconds IS NOT NULL AND interval_seconds > 0)
  ),
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id)
    REFERENCES project(id)
    ON DELETE SET NULL,
  FOREIGN KEY (work_item_id)
    REFERENCES work_item(id)
    ON DELETE SET NULL
);

CREATE INDEX idx_scheduled_wake_due
  ON scheduled_wake(status, next_run_at);

CREATE INDEX idx_scheduled_wake_member
  ON scheduled_wake(member_id, status);

-- 幂等锚点：UNIQUE(schedule_id, scheduled_for) 保证 crash 后不会对同一时间点
-- 执行两遍。周期任务不补历史，只执行一次并跳到下一个 future slot。
CREATE TABLE scheduled_wake_run (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'running',
        'completed',
        'failed'
      )
    ),
  execution_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  error TEXT,
  UNIQUE (schedule_id, scheduled_for),
  FOREIGN KEY (schedule_id)
    REFERENCES scheduled_wake(id)
    ON DELETE CASCADE,
  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
);

CREATE INDEX idx_scheduled_wake_run_execution
  ON scheduled_wake_run(execution_id);

CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('direct', 'group', 'work')),
  -- group 房间一律为 NULL：收件人由 GroupDispatcher 按 @mention 决定。
  default_member_id TEXT,
  created_by TEXT NOT NULL,
  -- 会话内单调递增的两个游标：event 用于 SSE replay，message 用于 context checkpoint
  event_sequence INTEGER NOT NULL DEFAULT 0,
  message_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id)
    REFERENCES project(id)
    ON DELETE SET NULL,
  FOREIGN KEY (default_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE INDEX idx_conversation_team
  ON conversation(team_id, updated_at);

CREATE TABLE conversation_member (
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

CREATE TABLE conversation_member_state (
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
  -- 排队中的这次唤醒是被哪条消息、以什么原因触发的，与 pending_wake 同生共死。
  --
  -- 不落库的话，重启恢复只能拿「房间当前最大序号」+ 最宽松的 reason 去猜：
  -- 一次 "@bob 看下风险"（reason=mention, trigger=17）会被重放成
  -- reason=open_discussion、trigger=23，对着完全另一条消息重新判断要不要发言。
  pending_wake_trigger_sequence INTEGER,
  -- WakeReason 的取值由 domain.ts 定义。刻意不加 CHECK：SQLite 加 CHECK 只能
  -- 重建表，而取值集合在 TypeScript 侧已经是封闭联合，写入口只有 scheduler 一处。
  pending_wake_reason TEXT,
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

CREATE INDEX idx_conversation_member_state_wake
  ON conversation_member_state(conversation_id, wake_status);

CREATE TABLE conversation_message (
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
  -- 调用方为这条消息发的幂等键。同一次「发送」被重试（响应丢了、用户狂点）
  -- 时不会再落一条重复消息，也不会再派一次唤醒。
  --
  -- 允许为 NULL（服务端内部产生的消息、以及没有传幂等键的调用方），
  -- 而 SQLite 的 UNIQUE 索引把 NULL 视为互不相等，所以这些行天然不参与去重。
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (target_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE INDEX idx_message_conversation_created
  ON conversation_message(conversation_id, created_at);

CREATE UNIQUE INDEX idx_message_conversation_sequence
  ON conversation_message(conversation_id, message_sequence);

CREATE UNIQUE INDEX idx_message_client_request
  ON conversation_message(conversation_id, client_request_id);

CREATE TABLE conversation_event (
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

CREATE INDEX idx_conversation_event_replay
  ON conversation_event(conversation_id, sequence);

CREATE TABLE member_runtime (
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

CREATE TABLE execution (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  work_item_id TEXT,
  runtime_id TEXT,
  parent_execution_id TEXT,
  delegation_path TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL
    CHECK (kind IN ('interactive', 'member_delegate', 'member_work')),
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
  -- 这一轮最终判断了什么（发言 / 沉默）以及唤醒它的那条消息
  decision TEXT,
  trigger_message_sequence INTEGER,
  -- 为什么唤醒这个 Member（direct / mention / open_discussion / follow_up / schedule）。
  -- 落库是为了重启恢复时能忠实重放同一轮，而不是猜一个。
  wake_reason TEXT,
  -- 这一轮跑的时候，这个 Member 的配置长什么样。
  --
  -- 配置（system prompt / memory / skills / model / toolProfile）会随时间变，
  -- 而 execution 是「当时真的跑过一轮」的记录。没有这个快照，事后看两条
  -- execution 只能看到不同的行为，看不到不同的输入。
  config_snapshot TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id),
  FOREIGN KEY (work_item_id)
    REFERENCES work_item(id)
    ON DELETE SET NULL,
  FOREIGN KEY (runtime_id)
    REFERENCES member_runtime(id),
  FOREIGN KEY (parent_execution_id)
    REFERENCES execution(id),
  FOREIGN KEY (retry_of_execution_id)
    REFERENCES execution(id)
);

CREATE INDEX idx_execution_conversation_created
  ON execution(conversation_id, created_at);

CREATE INDEX idx_execution_parent
  ON execution(parent_execution_id);

CREATE INDEX idx_execution_status
  ON execution(status);

CREATE INDEX idx_execution_work_item
  ON execution(work_item_id);

-- ─────────────────────────────────────────────── Knowledge Base ───────────
--
-- 专业度分层里「知道什么」的部分：
--
--   Skill   = How（少量程序化方法论，进 session context）
--   KB      = What（大量事实资料，按需检索，永不全量进 prompt）
--   Memory  = Member 自己学到的动态事实
--
-- 这一组表是 **local.filesystem-knowledge 这个 Provider 的内部存储**，不是平台
-- 级的 Knowledge 模型：正文在磁盘上（<teamKnowledgeRoot>/<key> 与
-- <memberHomeRoot>/<id>/knowledge），这里只放元数据与 FTS 索引。
--
-- 因此「谁能看哪个库」不在这里表达 —— 那是 member_capability_binding 的事
-- （knowledge + provider_id + selector）。这里只表达「有哪些库、哪个 Member 拥有
-- 它」，两条 CHECK 把 scope 和属主绑死，不存在「team KB 却有属主」这种中间态。

CREATE TABLE knowledge_base (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL
    CHECK (scope IN ('team', 'personal')),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  member_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'team' AND member_id IS NULL)
    OR
    (scope = 'personal' AND member_id IS NOT NULL)
  ),
  UNIQUE (scope, key),
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE TABLE knowledge_document (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  title TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_uri TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (knowledge_base_id, relative_path),
  FOREIGN KEY (knowledge_base_id)
    REFERENCES knowledge_base(id)
    ON DELETE CASCADE
);

-- 全文检索。document_id UNINDEXED：命中后要 JOIN 回 knowledge_document 拿
-- 权限过滤用的 kb 归属，所以只在这里存 id。
CREATE VIRTUAL TABLE knowledge_document_fts
  USING fts5(document_id UNINDEXED, title, content);

CREATE INDEX idx_knowledge_document_kb
  ON knowledge_document(knowledge_base_id);
`;

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

export interface MigrationResult {
  /** 库里原本登记的编号；空库为 0 */
  from: number;
  to: number;
  /** 这次真的建了 schema（而不是「打开时已经是对的」） */
  created: boolean;
}

export function migrate(db: DatabaseSync): MigrationResult {
  const from = getUserVersion(db);

  if (from === SCHEMA_VERSION) {
    return { from, to: SCHEMA_VERSION, created: false };
  }

  if (from !== 0) {
    // 分开两句话指路：库比程序旧和库比程序新，安全动作完全相反。
    // 对着「程序比库旧」的场景说「删掉重建」会直接毁掉用户的数据。
    throw new Error(
      from > SCHEMA_VERSION
        ? `数据库 schema 是 ${from}，比本程序支持的 ${SCHEMA_VERSION} 新 —— ` +
          `说明当前跑的是更早的 build。换回较新的 build，或在别处复制一份库再动它。`
        : `数据库 schema 是 ${from}，本程序只认 ${SCHEMA_VERSION}，且没有升级代码。` +
          `删掉数据目录（默认 .data）重建即可 —— 默认 Member 会在启动时重新 provision。`,
    );
  }

  if (hasAnyTable(db)) {
    throw new Error(
      '数据库里有表但没有 user_version 登记，不是本程序建的库。' +
        '换一个空的 DATA_DIR，或确认这就是要用的库之后手工登记 user_version。',
    );
  }

  // 建表 + 登记版本必须同一个事务：中途失败留一个「有表但 version=0」的库，
  // 下次启动会走到上面那条分支，而它给出的建议是换目录 —— 明明重建就行。
  db.exec('BEGIN');
  try {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { from: 0, to: SCHEMA_VERSION, created: true };
}

function hasAnyTable(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`,
    )
    .get();
  return row !== undefined;
}
