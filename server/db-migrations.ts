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
export const SCHEMA_VERSION = 27;

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

-- ─────────────────────────────────────────────── Capability Scope ───────
--
-- 能力分三层，叠加生效：
--
--   global   全平台，所有 Agent 默认继承
--   team     某个 Team 内所有 Agent 继承
--   member   某个 Member 的专属增量能力
--
-- capability_scope 只记录 global/team 是否已经完成 provisioning。它存在是为了
-- 区分两件从 binding 上看不出区别的事：
--
--   1. 从来没有初始化过            → 应该灌默认值
--   2. 初始化过，但管理员明确清空了 → 不能再灌
--
-- 没有它的话，管理员把 global 清空后重启，服务又会把默认值补回来 ——
-- 「清空」这个操作变得无法表达。provisioning 用 INSERT OR IGNORE：写进去了
-- 才代表「这一次是我初始化的」，之后无论 binding 被改成什么样都不再重灌。

CREATE TABLE capability_scope (
  scope_type TEXT NOT NULL
    CHECK (scope_type IN ('global', 'team')),
  scope_id TEXT NOT NULL,
  -- 是哪一份 provisioning 配置种下了这一层（'capability.global.v1' 这种）。
  -- 便于将来「模板升级了要不要重灌」这件事有据可查，而不是靠猜。
  seed_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id)
);

-- ─────────────────────────────────────────────── Capability Binding ────
--
-- scope_type/scope_id 决定这条能力属于谁：
--
--   global / ''          → 全平台
--   team   / <team-id>   → 某个 Team
--   member / <member-id> → 某个 Member
--
-- capability_type 决定能力种类（skill / knowledge / tool）。
--
-- 一张表装三层，而不是三层各一张表：三者在存储这一层的形状完全一样，拆开只会
-- 让「解析这个 Member 的 effective 能力」变成三次查询加一次手工合并。scope 是
-- 一个**列**，不是一个**表**。
--
-- selector 用 '' 而不是 NULL：它参与主键，而 SQLite 把 NULL 视为互不相等 ——
-- 用 NULL 会让同一个 (scope, type, provider) 能插进无限多行。
--
-- scope_id 的 CHECK 把「global 没有 id、team/member 必须有 id」钉死在数据库上：
-- 一个 scope_id 为空的 team 行永远不会被任何查询命中，却会一直占着位置。

CREATE TABLE capability_binding (
  scope_type TEXT NOT NULL
    CHECK (scope_type IN ('global', 'team', 'member')),
  scope_id TEXT NOT NULL,
  capability_type TEXT NOT NULL
    CHECK (capability_type IN ('skill', 'knowledge', 'tool', 'mcp')),
  provider_id TEXT NOT NULL,
  selector TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,

  PRIMARY KEY (
    scope_type,
    scope_id,
    capability_type,
    provider_id,
    selector
  ),

  CHECK (
    (scope_type = 'global' AND scope_id = '')
    OR
    (scope_type IN ('team', 'member') AND length(trim(scope_id)) > 0)
  )
);

-- 按 scope 取「这一层存了什么」。effective 解析每次要查三遍（global/team/member），
-- 这个索引就是那三遍的入口。
CREATE INDEX idx_capability_binding_scope
  ON capability_binding(scope_type, scope_id);

-- 「谁绑定了这个 Provider」—— 管理界面与影响面分析用。
CREATE INDEX idx_capability_binding_provider
  ON capability_binding(capability_type, provider_id);

-- ─────────────────────────────────────────────── Team 业务模型 v1 ─────
--
-- Team 是顶层协作边界：Membership / Presence / Schedule / Conversation 都挂在
-- 它下面。当前部署只有一个 Team，但形状上带 team_id，为以后多 Team 留结构。

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

-- Team 级实时事件：Membership / Presence / Schedule / Member Activity 的
-- 状态变化先落库再广播。与 conversation_event 同一套纪律 —— 落库是 source of
-- truth，SSE 帧带 id: <sequence>，断线重连靠 Last-Event-ID 补发。
-- payload 是 JSON：这里是通知层，不是审计层，消费方只需要「什么变了」然后决定
-- 刷哪块 UI。业务工作（工单、状态、负责人、工作流）以 Jira 为准，不在这里复制。
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

-- MCP Server 定义（运行时 source of truth）。
--
-- config/mcp-servers.json 只是新库的 provisioning baseline：空库启动时读一次，
-- 之后增删改只走 /api/mcp（McpServerService），文件改了不会回头覆盖 ——
-- 和 capability templates 同一套「只读一次」纪律。
--
-- ── 凭证不进这张表 ────────────────────────────────────────────────────
--
-- headers_json / env_json 只允许**非敏感**配置（Accept 头、LOG_LEVEL 之类）。
-- 真正的 credential 只留一个指针 secret_ref（例如 "prod/jira/copilot"），
-- 值由 SecretProvider 在执行时从外部密钥库取（见 mcp/secret-provider.ts）。
--
-- 为什么不是「存了但读接口脱敏」：脱敏只挡住 API 这一条路。备份、WAL 副本、
-- 崩溃转储、sqlite3 file.db .dump 都不经过 API，一次 DB 泄露就等于一次凭证
-- 泄露。凭证留在进程外的密钥库里，DB 被完整拿走也换不到它。
CREATE TABLE mcp_server (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL
    CHECK (type IN ('local', 'http', 'sse')),
  url TEXT,
  headers_json TEXT NOT NULL DEFAULT '{}',
  command TEXT,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT,
  timeout INTEGER,
  tools_json TEXT NOT NULL DEFAULT '{}',
  version TEXT NOT NULL DEFAULT '1',
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  -- 密钥库里的引用名。NULL = 这个 server 不需要凭证。
  secret_ref TEXT,
  -- 界面提示：这个引用喂的是哪种认证（bearer / apiKey）。**不参与运行时拼装**
  -- —— 真正写哪个 header 由密钥库那一侧决定（见 mcp/secret-provider.ts）。
  -- 留着它是为了让编辑器能显示「配的是哪种认证」而不必去猜。
  auth_type TEXT
    CHECK (auth_type IN ('none', 'bearer', 'apiKey')),
  last_test_at TEXT,
  last_test_ok INTEGER
    CHECK (last_test_ok IN (0, 1)),
  last_test_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
    ON DELETE CASCADE
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
  -- 这间会话围绕哪条外部工作（JSON ExternalWorkRef：provider/externalId/key/url）。
  -- NULL = 不挂钩业务的普通会话。
  --
  -- 只存**引用**，不存工单内容：没有 title / status / assignee。业务事实在
  -- Jira，本地复制一份就开始腐烂 —— 而且腐烂得很安静，副本和真话长得一样。
  external_work_ref TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('task', 'direct')),
  -- 这次工作的总体目标，由 Lead 通过 plan_tasks 确认。
  objective TEXT NOT NULL DEFAULT '',
  -- 0 = 尚未正式确定 Goal；1+ = 当前 Goal revision
  goal_revision INTEGER NOT NULL DEFAULT 0,
  -- 当前负责澄清需求、维护任务整体状态的 Member.
  lead_member_id TEXT,
  status TEXT NOT NULL DEFAULT 'intake'
    CHECK (
      status IN (
        'intake',
        'waiting_user',
        'running',
        'blocked',
        'completed',
        'cancelled'
      )
    ),
  -- 已确认的业务 context（JSON TaskRequirements），不做几十个字段。
  requirements_json TEXT NOT NULL DEFAULT '{"facts":[],"assumptions":[],"constraints":[],"successCriteria":[]}',
  -- 还缺哪些必须由用户回答的信息（JSON string[]）。
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  -- 会话内单调递增的两个游标：event 用于 SSE replay，message 用于 context checkpoint
  event_sequence INTEGER NOT NULL DEFAULT 0,
  message_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE,
  FOREIGN KEY (lead_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

-- Goal 版本历史：只增不改。v1 写进去就永远是 v1；
-- “恢复 v1”也是生成内容相同的新版本，而不是动指针。
CREATE TABLE conversation_goal_revision (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  objective TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  changed_by_type TEXT NOT NULL
    CHECK (changed_by_type IN ('user', 'member', 'system')),
  changed_by_id TEXT NOT NULL,
  change_kind TEXT NOT NULL
    CHECK (
      change_kind IN (
        'initial',
        'clarification',
        'scope_change',
        'success_criteria_change',
        'correction'
      )
    ),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, revision),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_conversation_goal_revision
  ON conversation_goal_revision(conversation_id, revision);

CREATE INDEX idx_conversation_team
  ON conversation(team_id, updated_at);

-- 按外部工作的 key 反查「哪些房间围绕它」。webhook 进来时靠它定位受影响
-- 的房间，而不是把整个 Jira 拉一遍。
--
-- 表达式索引而不是再存一列 key：一列 key 就是同一个事实的第二个存放点，
-- 它和 external_work_ref 里的 key 迟早会不一致（改名、迁移、手改数据）。
CREATE INDEX idx_conversation_external_work_key
  ON conversation(json_extract(external_work_ref, '$.key'));

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
  -- reason=everyone、trigger=23，对着完全另一条消息重新判断要不要发言。
  pending_wake_trigger_sequence INTEGER,
  -- WakeReason 的取值由 domain.ts 定义。刻意不加 CHECK：SQLite 加 CHECK 只能
  -- 重建表，而取值集合在 TypeScript 侧已经是封闭联合，写入口只有 scheduler 一处。
  pending_wake_reason TEXT,
  -- 排队中的唤醒属于哪个 Task，NULL = Lead 处理用户输入。
  pending_wake_task_id TEXT,
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
  reply_to_message_id TEXT,
  -- 这条消息属于哪个 Task 的进展，NULL = 整个工作的通用消息。
  task_id TEXT,
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
  FOREIGN KEY (task_id)
    REFERENCES conversation_task(id)
    ON DELETE SET NULL
);

CREATE INDEX idx_message_conversation_created
  ON conversation_message(conversation_id, created_at);

CREATE INDEX idx_message_task
  ON conversation_message(task_id);

CREATE TABLE conversation_task (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_member_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'ready',
        'running',
        'blocked',
        'completed',
        'failed',
        'cancelled'
      )
    ),
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  blocker TEXT,
  current_execution_id TEXT,
  -- 这个任务锁定的模型档位。NULL = 跟执行人默认（Member 配什么用什么）。
  -- 只有 Lead 能在 plan/add 里定（'strong' 把某个复杂任务升级到 Strong 模型），
  -- update_task / reassign 改不到它 —— 执行人不能给自己升级。
  model_tier TEXT CHECK (model_tier IN ('cheap', 'standard', 'strong')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (assignee_member_id)
    REFERENCES member(id),
  FOREIGN KEY (current_execution_id)
    REFERENCES execution(id)
);

CREATE INDEX idx_conversation_task_conversation
  ON conversation_task(conversation_id, sort_order);

CREATE INDEX idx_conversation_task_status
  ON conversation_task(conversation_id, status);

CREATE INDEX idx_conversation_task_assignee
  ON conversation_task(assignee_member_id, status);

CREATE INDEX idx_conversation_task_revision
  ON conversation_task(conversation_id, goal_revision, sort_order);

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
  goal_revision INTEGER NOT NULL,
  -- 开始时快照的**引用**（取自 conversation）。execution 是历史事实：
  -- conversation 后来换了挂钩的工单，这条记录仍然知道当时在干哪条。
  external_work_ref TEXT,
  -- 开始时向外部系统取证的结果（JSON ExternalWorkSnapshot：ref/title/status/
  -- assignee/capturedAt）。
  --
  -- 和 config_snapshot 同一个思路：输入会变，而 execution 是「当时真的这样跑过
  -- 一轮」的记录。没有它，事后看两条 execution 只能看到行为不同，看不到
  -- 当时的业务上下文不同。
  --
  -- **它不是缓存**：没有任何读路径拿它当业务事实用。要看现在的状态，问 Jira。
  external_work_snapshot TEXT,
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
  -- 这次运行属于哪个 Task，NULL = Lead 处理用户输入。
  task_id TEXT,
  -- 这一轮最终判断了什么以及唤醒它的那条消息
  decision TEXT,
  trigger_message_sequence INTEGER,
  -- 为什么唤醒这个 Member（lead_message / lead_clarification / lead_recovery / goal_changed / user_mention / task_ready / schedule）。
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
  FOREIGN KEY (runtime_id)
    REFERENCES member_runtime(id),
  FOREIGN KEY (parent_execution_id)
    REFERENCES execution(id),
  FOREIGN KEY (retry_of_execution_id)
    REFERENCES execution(id),
  FOREIGN KEY (task_id)
    REFERENCES conversation_task(id)
);

CREATE INDEX idx_execution_conversation_created
  ON execution(conversation_id, created_at);

CREATE INDEX idx_execution_parent
  ON execution(parent_execution_id);

CREATE INDEX idx_execution_status
  ON execution(status);

CREATE INDEX idx_execution_task
  ON execution(task_id);

CREATE INDEX idx_execution_goal_revision
  ON execution(conversation_id, goal_revision);

CREATE INDEX idx_execution_external_work_key
  ON execution(json_extract(external_work_ref, '$.key'));

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
-- 因此「谁能看哪个库」不在这里表达 —— 那是 capability_binding 的事
-- （knowledge + provider_id + selector，在 global/team/member 任一层）。这里只
-- 表达「有哪些库、哪个 Member 拥有它」，两条 CHECK 把 scope 和属主绑死，
-- 不存在「team KB 却有属主」这种中间态。

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

-- ───────────────────────────────────────── Conversation File ────────────
--
-- 聊天里的文件。它和上面 knowledge_document 是**两种东西**：
--
--   conversation_file   ACL = conversation membership，随聊天存续
--   knowledge_document  ACL = capability binding，长期复用
--
-- 所以这里没有「上传自动进知识库」这条路径：一份文件要变成长期资料，必须由人
-- 显式 promote。否则在 A 讨论里传的机密评审稿会顺着 knowledge search 流到没参与
-- 这场讨论的 Member 手里 —— 权限边界是聊天参与者，不是「谁有 knowledge 能力」。
--
-- 文件正文在 <conversationFileRoot>/<conversationId>/files/<fileId>/ 下，这里只
-- 存元数据与提取出的文本。跟 knowledge 一样，storage_path 存相对路径，便于整
-- 个 data 目录搬家。

CREATE TABLE conversation_file (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,

  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,

  -- 相对 <conversationFileRoot> 的路径，不是绝对路径。
  storage_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,

  -- processing：正文已落盘，提取/索引还没跑完。进程在这中间挂掉时，启动的
  -- recoverProcessing() 会把它们重新跑一遍，而不是永远停在 processing。
  status TEXT NOT NULL
    CHECK (status IN ('processing', 'ready', 'failed', 'deleted')),

  extracted_text TEXT,
  extraction_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- 同一个房间里同内容同文件名的重复上传收敛成一行：用户重试、浏览器重发、
  -- 同一个文件被两个人先后拖进来，都不该在 Shared Files 里出现两份。
  UNIQUE (conversation_id, content_hash, original_name),

  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_conversation_file_conversation
  ON conversation_file(conversation_id);

CREATE INDEX idx_conversation_file_hash
  ON conversation_file(content_hash);

CREATE INDEX idx_conversation_file_status
  ON conversation_file(status);

-- 附件关系：一条消息挂了哪些文件。
--
-- relation_type 区分「这条消息传的」和「这条消息引用的」——
-- 前者是文件第一次出现的地方，后者是「接着上次那份继续聊」。审计上这两件事
-- 含义完全不同：删掉文件后，attachment 那条消息说明「它从哪来的」，
-- reference 那条说明「谁在什么时候还在用它」。
--
-- 删除是软删除（status='deleted'），关系行一直留着，历史消息里的附件卡片因此
-- 不会凭空消失；只有在整条会话被物理删除时，这里的 CASCADE 才真正生效。
CREATE TABLE conversation_message_file (
  message_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  relation_type TEXT NOT NULL
    CHECK (relation_type IN ('attachment', 'reference')),
  position INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (message_id, file_id),

  FOREIGN KEY (message_id)
    REFERENCES conversation_message(id)
    ON DELETE CASCADE,
  FOREIGN KEY (file_id)
    REFERENCES conversation_file(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_message_file_file
  ON conversation_message_file(file_id);

-- 提取出的文本索引（只有文本类文件会进来；PDF / Office / 图片在这一版不进 FTS，
-- 它们只作为原文件 attachment 交给模型）。
CREATE VIRTUAL TABLE conversation_file_fts
  USING fts5(file_id UNINDEXED, title, content);

-- ============================================================ 授权与审计链
--
-- 下面五组表补的是「能力 ≠ 授权」这半边：Capability 只回答「能不能调 jira_search」，
-- 不回答「能看哪些 issue」（Data Entitlement）、「这笔外部写入该不该发生」
-- （Policy → Approval → Command）、「事后能不能证明发生过」（Audit）、
-- 「多副本下谁在跑这一轮」（Worker Lease）。
--
-- 它们全部是**只增不改**的旁路：没有它们服务照跑（默认拒绝），有了它们才
-- 谈得上授权链与合规证据。

-- ------------------------------------------------------ Data Entitlement
--
-- 一条记录 = 「某个 Team（可选某个 Member）在某类资源上被允许做哪些动作」。
-- 查询时按 (team_id, provider_id, resource_type) 取候选，再按 member_id 收窄：
-- member_id IS NULL 的行是 Team 级基线，所有 Member 都吃到。
--
-- resource_pattern 保留给「按前缀授权」（repo:team-*）这种将来才需要的能力，
-- 当前 check() 只按 resource_type 判，pattern 不参与 —— 留着它是因为补列比
-- 补表便宜，而这一层一旦上线就会有存量数据。
CREATE TABLE data_entitlement (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  member_id TEXT,
  provider_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_pattern TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (team_id)
    REFERENCES team(id)
    ON DELETE CASCADE,

  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_data_entitlement_lookup
  ON data_entitlement(
    team_id,
    member_id,
    provider_id,
    resource_type,
    active
  );

-- ------------------------------------------------------------ Audit chain
--
-- policy_decision_audit 是「谁批的」，tool_execution_audit 是「批了之后真的
-- 调了什么」。两张表刻意分开：一次拒绝（deny）只有前者，一次放行两者都有，
-- 而「拒绝了什么」恰恰是合规审计里最常被问的那一类。
--
-- 两者都不是 ConversationEvent 的替代品：事件流是 UI / SSE / replay，
-- 这两张表是**事后证据**，不参与任何读路径的展示。
CREATE TABLE policy_decision_audit (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (
      decision IN (
        'allow',
        'deny',
        'approval_required'
      )
    ),
  reason TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,

  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_policy_decision_execution
  ON policy_decision_audit(execution_id);

-- args_redacted_json 存的是**脱敏后**的参数（token / password 等替换成
-- [REDACTED]），args_hash 存原文的 sha256。两者都要：前者让人看得懂这次调用
-- 想干什么，后者让「参数有没有被改过」可验证 —— 只存 hash 没法排查，
-- 只存明文等于把凭证又写进了一张新表。
CREATE TABLE tool_execution_audit (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,

  tool_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  implementation TEXT NOT NULL,

  args_hash TEXT NOT NULL,
  args_redacted_json TEXT,

  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),

  policy_decision_id TEXT,
  entitlement_id TEXT,

  started_at TEXT NOT NULL,
  ended_at TEXT,

  result_hash TEXT,
  error TEXT,

  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
    ON DELETE CASCADE,

  FOREIGN KEY (policy_decision_id)
    REFERENCES policy_decision_audit(id)
);

CREATE INDEX idx_tool_execution_audit_execution
  ON tool_execution_audit(execution_id, started_at);

-- ------------------------------------------------------- Command / Approval
--
-- Command 是「真正要执行的业务动作」的唯一落点：Agent 不再直接打外部 REST，
-- 而是先落一条 Command，再由 CommandService 走 Entitlement → Policy →
-- Approval → Executor。这样「模型想干什么」和「系统真的干了什么」之间有
-- 一条可回放、可幂等的记录。
--
-- idempotency_key 唯一：同一轮 execution 里重试同一次评论，拿回的是同一条
-- Command，不会在 Jira 上留两条一样的评论。
CREATE TABLE command (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,

  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('agent', 'human')),
  actor_id TEXT NOT NULL,

  action TEXT NOT NULL,
  target TEXT NOT NULL,

  args_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,

  resource_version TEXT,

  policy_decision_id TEXT,
  approval_id TEXT,

  status TEXT NOT NULL
    CHECK (
      status IN (
        'requested',
        'policy_pending',
        'approved',
        'ready',
        'executing',
        'completed',
        'failed',
        'rejected',
        'cancelled',
        'expired'
      )
    ),

  created_at TEXT NOT NULL,
  executed_at TEXT,
  result_hash TEXT,

  FOREIGN KEY (execution_id)
    REFERENCES execution(id)
    ON DELETE CASCADE,

  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,

  FOREIGN KEY (member_id)
    REFERENCES member(id)
);

CREATE INDEX idx_command_execution
  ON command(execution_id, created_at);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (
      decision IN (
        'pending',
        'approved',
        'rejected',
        'expired'
      )
    ),
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,

  FOREIGN KEY (command_id)
    REFERENCES command(id)
    ON DELETE CASCADE
);

-- ------------------------------------------------------------ Worker Lease
--
-- 多副本部署下「谁在跑这一轮」的唯一仲裁点。单进程时这张表是空的，
-- 不影响任何现有路径。
--
-- 语义是**租约**不是锁：lease_expires_at 过了就自动可抢，所以进程崩溃
-- 不需要任何人来解锁 —— 这正是它比「进程内 inFlight Set」强的地方，
-- 后者在进程消失时连「曾经有人在跑」都留不下来。
CREATE TABLE worker_lease (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,

  lease_owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,

  PRIMARY KEY (
    resource_type,
    resource_id
  )
);
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
