const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * 把非 2xx 响应变成 Error。
 *
 * 服务端的错误体统一是 `{ error: string }`，而这句文案是后端**故意**写给用户看的
 * （「Member 还有未完成的工作（1 条未结束的 execution），不能归档」这种）。
 * 直接 `response.text()` 会把整段 JSON 连同花括号一起塞进 UI，读的人还要自己
 * 从语法里把话抠出来。所以先试 JSON，取不到才退回原文。
 */
async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const raw = await response.text().catch(() => response.statusText);
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
    } catch {
      // 不是 JSON（代理返回的 HTML 错误页之类），保留原文
    }
    // 状态码挂在 error 上：调用方需要区分「409 版本冲突，重新加载再试」
    // 和「400 我填错了」—— 前者动作是刷新，后者动作是改输入。
    // 从文案里认出 409 是脆的，服务端改一个字就失效。
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json() as Promise<T>;
}

export interface Member {
  id: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  style: string;
  systemPrompt: string;
  model: string | null;
  status: 'active' | 'archived';
  /**
   * 非空表示这个 Member 由 `config/member-templates` 里的某份模板 provision。
   *
   * 只读：它是 provisioning identity，不是业务身份。UI 只用来显示来源
   * （改了名字之后还能看出「这个人最初是哪份模板建出来的」），
   * 服务端也刻意不允许通过 create / update 设置它。
   */
  seedKey: string | null;
}

/**
 * 能力目录里的一行 Skill：这一层装了什么、开没开。
 *
 * id 形如 `skill.security-review`（目录名即身份）。上传即安装，
 * 勾选即启用 —— 管理员不需要知道它落在哪个磁盘目录。
 */
export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

/** 能力目录里的一行 Knowledge：真实的资料库，不是 providerId。 */
export interface CatalogKnowledge {
  id: string;
  name: string;
  description: string;
  scope: 'team' | 'personal';
  documentCount: number;
  enabled: boolean;
}

/**
 * 能力目录里的一行 Action：真实的单个工具。
 *
 * `id` 就是运行时工具名（`ask_member`），配置与执行共用同一个名字。
 * 知识检索工具不在这里出现 —— 选了资料库就自动有检索入口。
 */
export interface CatalogTool {
  id: string;
  displayName: string;
  group: string;
  description: string;
  risk: string;
  requiresHostAccess: boolean;
  /** true = 每次调用要过 Policy 审批。 */
  needsApproval: boolean;
  enabled: boolean;
  /** false = 选了也用不了（部署没放行），看 unavailableReason。 */
  available: boolean;
  unavailableReason?: string;
}

/** 从上层继承来的能力（只读）：这个 Member 自动拥有的部分。 */
export interface CatalogInheritedRef {
  id: string;
  name: string;
  from: 'company' | 'team';
}

/**
 * 一个 MCP Server 及其工具开关。连接信息（url / headers / command）
 * 永远不到前端：这里只回答「有哪些 server、每个有哪些工具、开没开」。
 */
export interface CatalogMcpServer {
  /** `mcp.<serverId>`。 */
  id: string;
  name: string;
  description: string;
  /** 开关（MCP Servers 页的状态）。关掉时下面工具不可选，本轮也解析不到。 */
  serverEnabled: boolean;
  tools: Array<{
    /** `mcp.<serverId>.<toolName>`。 */
    id: string;
    name: string;
    risk: string;
    needsApproval: boolean;
    enabled: boolean;
  }>;
  enabled: boolean;
}

/**
 * 某一层的能力目录。
 *
 * skills / knowledge / tools / mcp 只描述**这一层自己的选择**；
 * member 层的 `inherited` 额外回答「上面两层给了什么」。
 */
export interface ScopeCatalog {
  scope: 'global' | 'team' | 'member';
  skills: CatalogSkill[];
  knowledge: CatalogKnowledge[];
  tools: CatalogTool[];
  mcp: CatalogMcpServer[];
  inherited?: {
    skills: CatalogInheritedRef[];
    knowledge: CatalogInheritedRef[];
    tools: CatalogInheritedRef[];
    mcp: CatalogInheritedRef[];
  };
}

/** 三个目录层，对应公司 / 团队 / 个人。 */
export type CatalogScope = 'global' | 'team' | 'member';

/**
 * MCP Server（管理面读到的形状）。
 *
 * 凭证的值永远拿不到，而且**根本不在这个系统里**：`secretRef` 是密钥库里的
 * 条目名（不是秘密，可以回显），`secretConfigured` 只回答配没配，`envKeys`
 * 只给变量名。tools 是定义里声明的工具（手工维护），不是在线发现的。
 */
export interface McpServer {
  id: string;
  name: string;
  description: string;
  type: 'http' | 'sse' | 'local';
  url: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  timeout: number | null;
  version: string;
  authType: 'none' | 'bearer' | 'apiKey';
  secretConfigured: boolean;
  /** 密钥库里的引用名。回显它才能确认「指的是哪一条」；值在服务端解析。 */
  secretRef: string | null;
  envKeys: string[];
  tools: Array<{ name: string; risk: string }>;
  enabled: boolean;
  /** 上次可达性检查的结论：unknown = 没测过，connected / error 都是当时那一刻。 */
  status: 'unknown' | 'connected' | 'error';
  updatedAt: string;
}

export interface McpServerInput {
  id: string;
  displayName: string;
  description?: string;
  type: 'http' | 'sse' | 'local';
  url?: string;
  /**
   * 密钥库里的引用名（例如 `prod/jira/copilot`）。**不是**凭证值本身。
   *
   * 省略 = 保持现状；空串 = 显式清掉引用（这是唯一能取消凭证的方式）。
   * 值只活在密钥库里，本系统任何接口都不接受它 —— 那正是这条改动的目的。
   */
  secretRef?: string;
  /** 认证方式提示（界面用）。不参与服务端的 header 拼装。 */
  authType?: 'none' | 'bearer' | 'apiKey';
  command?: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
  tools: Array<{ name: string; risk: string }>;
  version?: string;
  enabled?: boolean;
}

/** skill 内容投放的三个 scope。 */
export type SkillScope = 'global' | 'team' | 'member';

export interface Team {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMembership {
  teamId: string;
  kind: 'human' | 'agent';
  principalId: string;
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'inactive';
  joinedAt: string;
  updatedAt: string;
}

/**
 * 对一条外部工作（Jira 工单）的引用。**只有引用，没有工单内容** ——
 * 标题/状态/负责人在 Jira，本地不复制。
 */
export interface ExternalWorkRef {
  provider: 'jira';
  /** Provider 侧的不可变 id（Jira：issue id）。 */
  externalId: string;
  /** 人读的 key（Jira：ABC-123）。会随项目改名而变。 */
  key: string;
  /** 深链。null = 还没问过 Provider。 */
  url: string | null;
}

export interface CurrentActivity {
  executionId: string;
  conversationId: string;
  conversationTitle: string;
  memberId: string;
  memberName: string;
  externalWorkRef: ExternalWorkRef | null;
  kind: string;
  status: string;
  startedAt: string | null;
}

export interface TeamPresence {
  teamId: string;
  kind: 'human' | 'agent';
  principalId: string;
  availability: 'available' | 'away' | 'paused';
  lastSeenAt: string;
  updatedAt: string;
}

export type TeamEventType =
  | 'member.activity.changed'
  | 'schedule.changed'
  | 'presence.changed'
  | 'external_work.changed'
  | 'membership.changed';

/**
 * Team 级实时事件（server TeamEventService 的镜像）。
 * payload 是变化后的业务对象；消费方通常只需要按 type 刷新对应的列表。
 */
export interface StoredTeamEvent {
  id: string;
  teamId: string;
  sequence: number;
  type: TeamEventType;
  data: unknown;
  createdAt: string;
}

export interface ScheduledWake {
  id: string;
  teamId: string;
  memberId: string;
  conversationId: string;
  prompt: string;
  type: 'once' | 'interval';
  runAt: string;
  intervalSeconds: number | null;
  nextRunAt: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  lastFiredAt: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ConversationStatus =
  | 'intake'
  | 'waiting_user'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export interface TaskRequirementFact {
  key: string;
  value: string;
  source: 'user' | 'jira' | 'knowledge' | 'conversation' | 'agent';
  confirmed: boolean;
}

export interface TaskRequirements {
  facts: TaskRequirementFact[];
  assumptions: string[];
  constraints: string[];
  successCriteria: string[];
}

export interface Conversation {
  id: string;
  teamId: string;
  /** 这间会话围绕哪条外部工作（Jira 工单）。业务状态在 Jira，这里只是引用。 */
  externalWorkRef: ExternalWorkRef | null;
  title: string;
  kind: 'task' | 'direct';
  /** 这次工作的总体目标。 */
  objective: string;
  /** 0 = 还没有正式确定 Goal；1+ = 当前 Goal Revision。 */
  goalRevision: number;
  /** 当前负责澄清需求、维护任务整体状态的 Member。 */
  leadMemberId: string | null;
  status: ConversationStatus;
  /** 已确认的业务 context。 */
  requirements: TaskRequirements;
  /** 当前还缺哪些必须由用户回答的信息。 */
  openQuestions: string[];
  createdBy: string;
  /** 会话内单调递增的 event 游标，等于 SSE 的 Last-Event-ID。 */
  eventSequence: number;
  /** 会话内单调递增的 message 游标。 */
  messageSequence: number;
  createdAt: string;
  updatedAt: string;
  members: Member[];
  /** 任务进度聚合（total / completed），侧栏直接显示，不再每个工作区调一次 Task API。 */
  taskProgress: { total: number; completed: number };
}

export type ConversationTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Task 锁定的模型档位（Lead 在 plan/add 里定）；null = 跟执行人默认。 */
export type TaskModelTier = 'cheap' | 'standard' | 'strong';

export interface GoalRevision {
  id: string;
  conversationId: string;
  revision: number;
  objective: string;
  requirements: TaskRequirements;
  changedByType: 'user' | 'member' | 'system';
  changedById: string;
  changeKind:
    | 'initial'
    | 'clarification'
    | 'scope_change'
    | 'success_criteria_change'
    | 'correction';
  reason: string;
  createdAt: string;
}

export interface ConversationTask {
  id: string;
  conversationId: string;
  goalRevision: number;
  title: string;
  description: string;
  assigneeMemberId: string;
  status: ConversationTaskStatus;
  dependencies: string[];
  acceptanceCriteria: string[];
  result: string | null;
  blocker: string | null;
  currentExecutionId: string | null;
  modelTier: TaskModelTier | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type ConversationFileStatus = 'processing' | 'ready' | 'failed' | 'deleted';

/**
 * 会话里的一份文件。
 *
 * 没有正文字段：提取出的文本可能到 50 万字符量级，跟着消息列表一起返回会把
 * 响应撑爆。看内容走预览（新窗口打开 content 接口）。
 */
export interface ConversationFile {
  id: string;
  conversationId: string;
  teamId: string;
  uploadedBy: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  status: ConversationFileStatus;
  storagePath: string;
  contentHash: string;
  /** 提取失败的原因（status='failed' 才有）。 */
  extractionError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  messageSequence: number;
  senderType: 'user' | 'member' | 'system';
  senderId: string;
  replyToMessageId: string | null;
  /** 这条消息属于哪个 Task 的进展，null = 整个工作的通用消息。 */
  taskId: string | null;
  /** 发送时带的幂等键；null = 这条消息不参与去重。 */
  clientRequestId: string | null;
  content: string;
  executionId: string | null;
  /** 这条消息带 / 引用的文件（服务端批量装配，前端不再逐个查）。 */
  files: ConversationFile[];
  createdAt: string;
}

/**
 * 两个 Member 之间的私聊。
 *
 * 房间在库里就是「roster 恰好两个人的 direct conversation」—— 和「用户 ↔ 单个
 * Member」共用同一个 kind，靠成员数区分。所以判断某个 direct 房间是不是私聊，
 * 必须看 `members.length === 2`，不能只看 kind。
 */
export interface MemberDirectMessage {
  conversation: Conversation;
  /** 对话的另一方。 */
  peer: Member;
  lastMessage: ConversationMessage | null;
  /** 从这个 Member 的视角看，还没读到的消息数。 */
  unread: number;
}

export type ExecutionStatus =
  | 'queued'
  | 'running'
  /** 正在等另一个 Member 的 runtime 完成（ask_member 进行中）。 */
  | 'waiting_for_member'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** 进程重启时还停在 running / waiting_for_member，未自动重跑。 */
  | 'interrupted';

/**
 * 这一轮开跑那一刻，Member 的配置长什么样。
 *
 * 配置会随时间变，而 execution 是「当时真的这样跑过一轮」的记录。有它才能回答
 * 「为什么这条和那条行为不同」，尤其是 retry —— 同一份 prompt 在今天重跑，
 * 用的可能已经是另一个人格、另一份记忆。
 *
 * 只存指纹不存全文：system prompt 和 memory 都能从 member + 磁盘重算。
 */
/** 某一轮为什么用这个模型：`lead:planning` 之类，或 `member:task`。 */
export type ModelPurpose =
  | `lead:${'planning' | 'clarification' | 'recovery' | 'synthesis' | 'routine'}`
  | 'member:task'
  | 'member:delegation';

export interface ExecutionConfigSnapshot {
  memberRevision: string;
  model: string;
  /** 为什么选这个模型（老数据没有）。 */
  modelPurpose?: ModelPurpose;
  /** 当时授权判定的 Policy 版本（老数据没有）。 */
  policyRevision?: string;
  systemPromptHash: string;
  memoryHash: string;
  /** 这一轮实际生效的能力组成（Provider ID + 版本 + 工具集）的 sha256。 */
  capabilityManifestHash: string;
  hostToolsEnabled: boolean;
}

export interface ExecutionRecord {
  id: string;
  conversationId: string;
  memberId: string;
  /** 这次运行属于哪个 Task，null = Lead 处理用户输入。 */
  taskId: string | null;
  /** 开始时快照的引用（取自 conversation），历史事实不随后续改动漂移。 */
  externalWorkRef: ExternalWorkRef | null;
  /** 开跑那一刻向 Jira 取证的结果。null = 没挂业务 / 取证失败 / 未配置。 */
  externalWorkSnapshot: {
    ref: ExternalWorkRef;
    title: string;
    status: string | null;
    assignee: string | null;
    capturedAt: string;
  } | null;
  runtimeId: string | null;
  parentExecutionId: string | null;
  delegationPath: string[];
  kind: 'interactive' | 'member_delegate' | 'member_work';
  status: ExecutionStatus;
  prompt: string;
  response: string | null;
  error: string | null;
  waitingForRuntimeId: string | null;
  retryOfExecutionId: string | null;
  /** 开跑那一刻的配置；历史数据为 null。 */
  configSnapshot: ExecutionConfigSnapshot | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

// -------------------------------------------------------------- Command 层
//
// Command 是「真正要执行的业务动作」的唯一落点：Agent 不直接打外部 REST，
// 而是先落一条 Command，再走 Entitlement → Policy → Approval → Executor。
// 默认 Policy 对一切 external-write 返回「要人批」，所以界面要能看见并放行它们。

export type CommandStatus =
  | 'requested'
  | 'policy_pending'
  | 'approved'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  /**
   * 外部结果**未知**：请求发出去了，但没能确认对方有没有处理（超时 / 连接重置
   * / 5xx）。它**不是**终态，对账会把它收敛成 completed 或 failed。
   *
   * 和 failed 分开是必须的 —— failed 的意思是「确认没发生」（可以重试），
   * 而 unknown 的意思是「可能已经发生」（重试就是重复副作用）。
   */
  | 'unknown'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface CommandRecord {
  id: string;
  executionId: string;
  conversationId: string;
  memberId: string;
  actorType: 'agent' | 'human';
  actorId: string;
  action: string;
  target: string;
  /** 参数原文的 sha256 —— 「有没有被改过」可验证。 */
  argsHash: string;
  /**
   * 冻结的规范化参数。执行时用的就是这一份，不是调用方再传一遍的。
   * 审批界面显示它 —— 人批的必须是他当时看见的东西。
   */
  args: Record<string, unknown>;
  idempotencyKey: string;
  /**
   * 这一笔**外部业务动作**的身份（UNIQUE）。它刻意不是 executionId：retry 会
   * 铸出一条新的 execution，而「同一笔 Jira 评论」不能因此变成两笔。
   * 对账拿它去外部系统问「这笔到底做了没有」。
   */
  operationId: string;
  resourceVersion: string | null;
  policyDecisionId: string | null;
  approvalId: string | null;
  status: CommandStatus;
  createdAt: string;
  executedAt: string | null;
  resultHash: string | null;
}

export interface ApprovalRecord {
  id: string;
  commandId: string;
  requestedByType: 'agent' | 'human';
  requestedById: string;
  decision: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type CommandAuditEvent =
  | 'requested'
  | 'policy_decided'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'failed'
  /** 外部结果未知。与 failed 是两个结论，动作相反（见 CommandStatus）。 */
  | 'unknown';

export interface CommandAuditRecord {
  id: string;
  commandId: string;
  executionId: string;
  event: CommandAuditEvent;
  actorType: 'agent' | 'human' | 'system';
  actorId: string;
  detail: string | null;
  createdAt: string;
}

/** 一次**尝试**的结果。这里记的是「这次调用怎么了」，不是业务决策。 */
export type CommandAttemptStatus = 'running' | 'succeeded' | 'failed' | 'unknown';

/**
 * Command 的一次执行尝试。
 *
 * 单独一张表而不是在 command 上加几列：「一笔业务动作」和「一次尝试」不是同一个
 * 东西。Command 可以先 timeout（unknown，可能已写）再被对账确认（succeeded）——
 * 只留一行的话，第一段的「我们不知道发生过什么」会被第二段覆盖掉，而它恰恰
 * 解释了为什么这里多了一次外部查询、以及为什么当时不能简单地重试。
 */
export interface CommandAttemptRecord {
  id: string;
  commandId: string;
  /** 从 1 开始，同一 Command 内单调递增。 */
  attemptNo: number;
  operationId: string;
  status: CommandAttemptStatus;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  resultHash: string | null;
}

/** 对账的结论。`unknown` 是**合法**结论：对账也可能问不出来。 */
export interface ExternalOperationOutcome {
  status: 'completed' | 'failed' | 'unknown';
  detail?: string | null;
}

export interface CommandDetail {
  command: CommandRecord;
  approval: ApprovalRecord | null;
  /** 生命周期事件。command 行上只有**当前**状态，过程在这里。 */
  audit: CommandAuditRecord[];
  /**
   * 每一次真正打出去的尝试。`unknown` 时它是唯一能回答「试了几次、哪一次
   * 结果不明」的地方 —— 只显示一句「结果未知」是没法排查的。
   */
  attempts: CommandAttemptRecord[];
}

/** 对账返回：新的 Command 详情 + 这一次对账的结论。 */
export interface CommandReconcileResult extends CommandDetail {
  outcome: ExternalOperationOutcome;
}

export interface PolicyDecisionAuditRecord {
  id: string;
  executionId: string;
  toolName: string;
  policyRevision: string;
  decision: 'allow' | 'deny' | 'approval_required';
  reason: string;
  inputHash: string;
  createdAt: string;
}

export interface ToolExecutionAuditRecord {
  id: string;
  executionId: string;
  toolName: string;
  providerId: string;
  implementation: string;
  allowed: boolean;
  policyDecisionId: string | null;
  entitlementId: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

/** 一次 execution 的完整证据链（三张表合起来才是完整答案）。 */
export interface ExecutionAuditBundle {
  executionId: string;
  policyDecisions: PolicyDecisionAuditRecord[];
  toolExecutions: ToolExecutionAuditRecord[];
  commands: CommandAuditRecord[];
}

/**
 * 为什么唤醒这个 Member。确定性规则的产物，不是 LLM routing：
 *   lead_bootstrap     新工作区创建后的自动首轮 Lead 唤醒
 *   lead_message       用户发普通消息，唤醒 Lead
 *   lead_clarification 用户回答了澄清问题，唤醒 Lead 继续推进
 *   lead_recovery      Task 失败/阻塞，唤醒 Lead 做整体判断
 *   goal_changed       Goal 改版本，唤醒 Lead 重新规划
 *   user_mention       用户明确 @ 某个 Member，直接唤醒这个 Member
 *   member_message     Member 私聊消息，唤醒对端
 *   task_ready         Task 依赖满足，唤醒执行人
 *   schedule           定时唤醒
 */
export type WakeReason =
  | 'lead_bootstrap'
  | 'lead_message'
  | 'lead_clarification'
  | 'lead_recovery'
  | 'goal_changed'
  | 'user_mention'
  | 'member_message'
  | 'task_ready'
  | 'schedule';

/** 一条消息唤醒了哪个 Member、为什么。 */
export interface WakePlan {
  memberId: string;
  reason: WakeReason;
  taskId: string | null;
  triggerSequence: number | null;
}

/**
 * POST /messages 的结果。
 *
 * Task 工作区里一条用户消息只唤醒 Lead，`wakes` 最多一项。
 * 每条 execution 的进展通过 SSE 的 `execution.updated` 到达。
 */
export interface SendMessageResult {
  message: ConversationMessage;
  wakes: WakePlan[];
  /**
   * 命中了幂等键：返回的是**已经存在的**那条消息，`wakes` 因此必为空
   * （当时的唤醒早就发生过了）。
   */
  deduplicated: boolean;
}

/**
 * 某 Member 在某 Conversation 里的房间状态。
 *
 * 和 MemberRuntime 是两件事：这一层回答「它在房间里看到哪里了、要不要被唤醒」。
 */
export interface ConversationMemberState {
  conversationId: string;
  memberId: string;
  lastSeenMessageSequence: number;
  lastRepliedMessageSequence: number;
  wakeStatus: 'idle' | 'queued' | 'running' | 'cooldown';
  pendingWake: boolean;
  /**
   * 排队中那次唤醒是被哪条消息、以什么原因触发的；没有排队时为 null。
   *
   * 它和 pendingWake 同生共死：只显示「有个唤醒在排队」而不知道它为什么排队，
   * 排查起来只能靠猜。
   */
  pendingWakeTriggerSequence: number | null;
  pendingWakeReason: WakeReason | null;
  muted: boolean;
  updatedAt: string;
}

/**
 * `conversation_member_state.updated` 事件的 payload。
 *
 * 做成 `{ memberId, state }` 而不是直接发 state：状态**消失**也是一次变化
 * （成员被移出房间），而「消失」表达不出一个 ConversationMemberState。
 */
export interface ConversationMemberStateChange {
  memberId: string;
  /** null = 这个 Member 在这个房间里的状态已经不存在。 */
  state: ConversationMemberState | null;
}

/**
 * Member 的长期记忆全文 + 版本。
 *
 * `version` 是全文的 sha256，不是 schema 版本：记忆没有字段级结构，
 * 能表达「这份内容和我上次读到的是不是同一份」的最小信息就是它自己的指纹。
 */
export interface MemberMemory {
  content: string;
  version: string;
}

/** Member 自己的 skill（`.data/members/<id>/skills/<name>`）。 */
export interface MemberSkill {
  name: string;
  description: string;
  fileCount: number;
  updatedAt: string;
}

export interface Health {
  status: string;
  timestamp: string;
  /** idle = client 尚未建连的懒加载态，不是故障 */
  copilot: 'connected' | 'idle' | 'error';
  copilotError?: string;
}

/** 模型档位：strong 只给 Lead，standard / cheap 给普通 Task。 */
export type ModelTier = 'strong' | 'standard' | 'cheap';

/** 一个可用模型及其强度：数字越大越强。 */
export interface ModelDefinition {
  id: string;
  strength: number;
  tier: ModelTier;
}

/**
 * 模型策略（服务端是唯一真相源）。
 *
 * Lead 默认用 `lead.standard`，规划 / 澄清 / 恢复 / 综合时升级到
 * `lead.strong`；普通 Task 只能从 `members` 里选，未选则用
 * `defaultMemberModel`。`members` 里永远没有 Strong 模型。
 */
export interface ModelPolicy {
  lead: {
    strong: ModelDefinition;
    standard: ModelDefinition;
  };
  members: ModelDefinition[];
  defaultMemberModel: string;
}

export interface DelegationEvent {
  executionId: string;
  parentExecutionId?: string;
  fromMemberId?: string;
  targetMemberId?: string;
  task?: string;
  reason?: string | null;
  error?: string;
}

export interface DeltaEvent {
  executionId: string;
  memberId: string;
  delta: string;
}

/**
 * 某次 MCP 工具调用被放行。语义是「放行」，不是「执行完成」
 * （引擎没有跑完回调）—— 只回答「这一轮用了哪个 MCP」，不做审计与计费。
 */
export interface McpToolCallEvent {
  executionId: string;
  memberId: string;
  serverId: string;
  toolName: string;
}

/**
 * scope → skill 接口路径。
 *
 * member 那一层刻意是复数 `members`：它需要一个 id，形状是
 * `/api/capabilities/skills/members/<memberId>`，而 global / team 是单段的。
 * 把这条映射收在一个函数里，是因为「三个 scope 只有一个是复数」这种不一致
 * 一旦散落在三个方法里，改一处漏两处。
 */
function scopedSkillPath(scope: SkillScope, memberId?: string): string {
  if (scope !== 'member') return `/api/capabilities/skills/${scope}`;
  return `/api/capabilities/skills/members/${encodeURIComponent(memberId ?? '')}`;
}

export const api = {
  health(): Promise<Health> {
    return fetch(`${API_BASE}/api/health`).then(json<Health>);
  },

  /** 模型策略：Member 编辑器与 Task 创建窗口的下拉选项从这里来。 */
  getModelPolicy(): Promise<{ policy: ModelPolicy }> {
    return fetch(`${API_BASE}/api/models`).then(json<{ policy: ModelPolicy }>);
  },

  listMembers(): Promise<{ members: Member[] }> {
    return fetch(`${API_BASE}/api/members`).then(json<{ members: Member[] }>);
  },

  createMember(input: {
    name: string;
    handle?: string;
    role: string;
    description?: string;
    style?: string;
    systemPrompt?: string;
    model?: string;
  }): Promise<{ member: Member }> {
    return fetch(`${API_BASE}/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ member: Member }>);
  },

  /**
   * 局部更新。字段省略 = 不改；`model: null` 是**显式清空**（回落默认模型），
   * 所以这里不能用 `?? ` 合并，服务端按 `!== undefined` 判断。
   */
  updateMember(
    id: string,
    input: {
      name?: string;
      handle?: string;
      role?: string;
      description?: string;
      style?: string;
      systemPrompt?: string;
      model?: string | null;
      status?: 'active' | 'archived';
    },
  ): Promise<{ member: Member }> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ member: Member }>);
  },

  /**
   * 某一层的能力目录：装了什么、开着什么。
   *
   * 和 skill 文件接口是两件事：那个回答「磁盘上有什么压缩包」，
   * 这个回答「这一层启用了什么」。上传 skill 后这里会多出一行
   * 且自动勾选 —— 安装与启用是同一个流程。
   */
  getCapabilityCatalog(
    scope: CatalogScope,
    memberId?: string,
  ): Promise<{ teamId: string; catalog: ScopeCatalog }> {
    const query =
      scope === 'member' && memberId
        ? `?scope=member&memberId=${encodeURIComponent(memberId)}`
        : `?scope=${scope}`;
    return fetch(`${API_BASE}/api/capabilities/catalog${query}`).then(
      json<{ teamId: string; catalog: ScopeCatalog }>,
    );
  },

  /**
   * 全量替换某一层的选择：用户语言的 ID 数组，不含 providerId / selector。
   *
   * 空数组 = 这一类全关。member 层清空 = 退回团队基线，
   * 不是变成什么都不会的人。
   */
  updateCapabilityCatalog(input: {
    scope: CatalogScope;
    memberId?: string;
    skills: string[];
    knowledge: string[];
    tools: string[];
    mcp: string[];
  }): Promise<{ teamId: string; catalog: ScopeCatalog }> {
    return fetch(`${API_BASE}/api/capabilities/catalog`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ teamId: string; catalog: ScopeCatalog }>);
  },

  /**
   * Member 的长期记忆全文。
   *
   * 刻意不是「给 prompt 用的截断版」：编辑器拿到截断内容再整体保存，
   * 会把被截掉的前半段永久丢掉。
   *
   * `version` 是全文的 sha256，保存时原样带回去 —— 这个文件同时被 Agent 的
   * remember_member 写入，没有版本校验的全文覆盖会把中间那次写入吃掉。
   */
  getMemberMemory(memberId: string): Promise<MemberMemory> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/memory`).then(
      json<MemberMemory>,
    );
  },

  /**
   * 整体覆盖；返回归一化后真正落盘的内容与新版本。
   *
   * 版本不匹配时服务端返回 409 且**不写盘**，错误文案会说明原因。
   */
  replaceMemberMemory(
    memberId: string,
    content: string,
    expectedVersion?: string,
  ): Promise<MemberMemory> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(expectedVersion ? { content, expectedVersion } : { content }),
    }).then(json<MemberMemory>);
  },

  /**
   * 这个 Member 在某一个 Team 的上下文全文。teamId 省略 = 当前默认 Team。
   *
   * 与全局记忆同一套语义（全文 + sha256 版本 + 409），只是落盘位置不同：
   * `.data/members/<id>/teams/<teamId>/MEMORY.md`。
   */
  getMemberTeamContext(memberId: string, teamId?: string): Promise<MemberMemory> {
    const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
    return fetch(
      `${API_BASE}/api/members/${encodeURIComponent(memberId)}/team-context${query}`,
    ).then(json<MemberMemory>);
  },

  replaceMemberTeamContext(
    memberId: string,
    content: string,
    expectedVersion?: string,
    teamId?: string,
  ): Promise<MemberMemory> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/team-context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        expectedVersion || teamId
          ? { content, ...(expectedVersion ? { expectedVersion } : {}), ...(teamId ? { teamId } : {}) }
          : { content },
      ),
    }).then(json<MemberMemory>);
  },

  /**
   * Member 视角的历史：参与过的 conversation（按最后活动倒序）与所属 Team。
   * Member Profile 的 Recent activity 只读这两条，不建新表。
   */
  listMemberConversations(memberId: string): Promise<{ conversations: Conversation[] }> {
    return fetch(
      `${API_BASE}/api/members/${encodeURIComponent(memberId)}/conversations`,
    ).then(json<{ conversations: Conversation[] }>);
  },

  listMemberTeams(memberId: string): Promise<{ teams: Team[] }> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/teams`).then(
      json<{ teams: Team[] }>,
    );
  },

  listScopedSkills(scope: SkillScope, memberId?: string): Promise<{ skills: MemberSkill[] }> {
    return fetch(`${API_BASE}${scopedSkillPath(scope, memberId)}`).then(
      json<{ skills: MemberSkill[] }>,
    );
  },

  /**
   * 上传 zip 安装一个 skill。
   *
   * 直接把 File 当 body（raw），不走 multipart —— 只有一个文件，
   * 多一层 parser 只会多一个依赖和一个临时目录。文件名走 query。
   */
  uploadScopedSkill(
    scope: SkillScope,
    file: File,
    memberId?: string,
  ): Promise<{ skill: MemberSkill }> {
    return fetch(
      `${API_BASE}${scopedSkillPath(scope, memberId)}?filename=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/zip' },
        body: file,
      },
    ).then(json<{ skill: MemberSkill }>);
  },

  deleteScopedSkill(
    scope: SkillScope,
    name: string,
    memberId?: string,
  ): Promise<{ skills: MemberSkill[] }> {
    return fetch(
      `${API_BASE}${scopedSkillPath(scope, memberId)}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ).then(json<{ skills: MemberSkill[] }>);
  },

  /** 房间里每个 Member 的读游标 / 唤醒状态 / 是否静音。 */
  listConversationState(
    conversationId: string,
  ): Promise<{ states: ConversationMemberState[] }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/state`,
    ).then(json<{ states: ConversationMemberState[] }>);
  },

  /**
   * 改 Member 在房间里的静音状态。静音后 dispatcher 不会唤醒它 —— @ 也唤不醒。
   */
  setMemberState(
    conversationId: string,
    memberId: string,
    patch: { muted: boolean },
  ): Promise<{ state: ConversationMemberState }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(
        conversationId,
      )}/members/${encodeURIComponent(memberId)}/state`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ).then(json<{ state: ConversationMemberState }>);
  },

  /** 静音后 dispatcher 不会唤醒它 —— @ 也唤不醒。 */
  setMemberMuted(
    conversationId: string,
    memberId: string,
    muted: boolean,
  ): Promise<{ state: ConversationMemberState }> {
    return api.setMemberState(conversationId, memberId, { muted });
  },

  /**
   * 这个 Member 参与的全部私聊。
   *
   * 和「用户 ↔ Member 单聊」是两个东西：那个是 `kind === 'direct'` 且
   * `members.length === 1`，这个是 `members.length === 2`。
   */
  listDirectMessages(memberId: string): Promise<{ conversations: MemberDirectMessage[] }> {
    return fetch(
      `${API_BASE}/api/members/${encodeURIComponent(memberId)}/direct-messages`,
    ).then(json<{ conversations: MemberDirectMessage[] }>);
  },

  /**
   * 以这个 Member 的身份给另一个 Member 发一条私聊消息。
   *
   * 走 Internal API：`memberId` 在这里是「我代表谁」，不是「我在看谁」，
   * 服务端会按 INTERNAL_API_TOKEN 校验（未配置则只在单机原型下放行）。
   *
   * 202：消息已落库、对方已入队，对方的回复通过那个房间的 SSE 推。
   * 房间不存在时会自动建立 —— 调用方不需要「先开房间再发消息」两段式。
   */
  sendDirectMessage(
    memberId: string,
    input: { toMemberId: string; content: string },
  ): Promise<SendMessageResult & { conversation: Conversation; peer: Member }> {
    return fetch(`${API_BASE}/api/internal/members/${encodeURIComponent(memberId)}/direct-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<SendMessageResult & { conversation: Conversation; peer: Member }>);
  },

  listConversations(): Promise<{ conversations: Conversation[] }> {
    return fetch(`${API_BASE}/api/conversations`).then(
      json<{ conversations: Conversation[] }>,
    );
  },

  createConversation(input: {
    title?: string;
    kind?: 'task' | 'direct';
    memberIds: string[];
    leadMemberId?: string;
    /** 围绕哪条外部工作。只传引用，工单内容在 Jira。 */
    externalWorkRef?: { provider?: 'jira'; key: string; externalId?: string | null } | null;
  }): Promise<{ conversation: Conversation }> {
    return fetch(`${API_BASE}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ conversation: Conversation }>);
  },

  listMessages(conversationId: string): Promise<{ messages: ConversationMessage[] }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    ).then(json<{ messages: ConversationMessage[] }>);
  },

  // ------------------------------------------------ Conversation Files

  listConversationFiles(conversationId: string): Promise<{ files: ConversationFile[] }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/files`,
    ).then(json<{ files: ConversationFile[] }>);
  },

  /**
   * 上传一份文件。
   *
   * raw body + 文件名走 query（服务端约定），而不是 multipart：一次一个文件，
   * multipart 只会多一层解析和临时目录。Content-Type 用浏览器给的那个，服务端
   * 不做白名单（附件本来就可能是任何类型）。
   */
  uploadConversationFile(
    conversationId: string,
    file: File,
  ): Promise<{ file: ConversationFile }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/files` +
        `?filename=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    ).then(json<{ file: ConversationFile }>);
  },

  deleteConversationFile(
    conversationId: string,
    fileId: string,
  ): Promise<{ file: ConversationFile }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/files/` +
        encodeURIComponent(fileId),
      { method: 'DELETE' },
    ).then(json<{ file: ConversationFile }>);
  },

  /** 在会话内搜文件内容（只有文本类文件进了索引）。 */
  searchConversationFiles(
    conversationId: string,
    query: string,
  ): Promise<{ hits: Array<{ fileId: string; title: string; snippet: string }> }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/files/search` +
        `?q=${encodeURIComponent(query)}`,
    ).then(json<{ hits: Array<{ fileId: string; title: string; snippet: string }> }>);
  },

  /** 把会话文件存进团队知识库（需要 admin/owner）。 */
  promoteConversationFile(
    conversationId: string,
    fileId: string,
    input: { knowledgeBaseId: string; title?: string },
  ): Promise<{ document: { id: string; relativePath: string; title: string } }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/files/` +
        `${encodeURIComponent(fileId)}/promote`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ).then(json<{ document: { id: string; relativePath: string; title: string } }>);
  },

  /**
   * 团队知识库列表。只用于「把聊天文件存进知识库」时选目标 ——
   * 知识库本身的管理（建库、写文档）不在这套界面里。
   */
  listTeamKnowledgeBases(): Promise<{
    knowledgeBases: Array<{ id: string; key: string; name: string; description: string }>;
  }> {
    return fetch(`${API_BASE}/api/knowledge/team`).then(
      json<{ knowledgeBases: Array<{ id: string; key: string; name: string; description: string }> }>,
    );
  },

  /** 文件正文地址（预览 / 下载）。取内容时服务端会重新校验它属于这个会话。 */
  conversationFileContentUrl(
    conversationId: string,
    fileId: string,
    options?: { download?: boolean },
  ): string {
    const base =
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/files/` +
      `${encodeURIComponent(fileId)}/content`;
    return options?.download ? `${base}?download=1` : base;
  },

  /**
   * conversation 的 execution 列表（创建时间正序）。
   * 客户端按 `parentExecutionId` 自己组执行树。
   */
  listExecutions(
    conversationId: string,
    limit = 200,
  ): Promise<{ executions: ExecutionRecord[] }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/executions?limit=${limit}`,
    ).then(json<{ executions: ExecutionRecord[] }>);
  },

  getExecution(executionId: string): Promise<{ execution: ExecutionRecord }> {
    return fetch(`${API_BASE}/api/executions/${encodeURIComponent(executionId)}`).then(
      json<{ execution: ExecutionRecord }>,
    );
  },

  /**
   * retry 生成一条新的 execution（`retryOfExecutionId` 指回原记录），
   * 原记录保持不变。返回 202 + 新 execution。
   */
  retryExecution(
    executionId: string,
  ): Promise<{ executionId: string; execution: ExecutionRecord }> {
    return fetch(`${API_BASE}/api/executions/${encodeURIComponent(executionId)}/retry`, {
      method: 'POST',
    }).then(json<{ executionId: string; execution: ExecutionRecord }>);
  },

  /**
   * cancel 会等引擎真的停下来才返回，返回的是**最终状态**。
   * 409 = 与当前状态冲突（已结束 / waiting_for_member 暂不支持取消）。
   */
  cancelExecution(executionId: string): Promise<{ execution: ExecutionRecord }> {
    return fetch(`${API_BASE}/api/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: 'POST',
    }).then(json<{ execution: ExecutionRecord }>);
  },

  /**
   * MCP Server 定义的增删改查 + 可达性检查。
   *
   * 这是「系统里有哪些 MCP」（连接层）。「谁可以用其中哪些工具」在
   * Capabilities 里配（授权层），Task 里不需要选 —— 自动用已授权的。
   */
  listMcpServers(): Promise<{ servers: McpServer[] }> {
    return fetch(`${API_BASE}/api/mcp/servers`).then(json<{ servers: McpServer[] }>);
  },

  createMcpServer(input: McpServerInput): Promise<{ server: McpServer }> {
    return fetch(`${API_BASE}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ server: McpServer }>);
  },

  updateMcpServer(id: string, input: McpServerInput): Promise<{ server: McpServer }> {
    return fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ server: McpServer }>);
  },

  deleteMcpServer(id: string): Promise<{ deleted: string }> {
    return fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then(json<{ deleted: string }>);
  },

  /**
   * 可达性检查，不是 MCP 握手、不发现工具。
   * http/sse 只确认有 HTTP 响应；local 只确认 command 找得到，不执行。
   */
  testMcpServer(id: string): Promise<{ ok: boolean; detail: string; server: McpServer }> {
    return fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }).then(json<{ ok: boolean; detail: string; server: McpServer }>);
  },

  /**
   * 用户在 UI 上改 Goal：生成新版本，旧计划失效，Lead 重新规划。
   * 和 Lead 在 turn 里调 update_goal 工具走同一条服务端链。
   */
  updateConversationGoal(
    conversationId: string,
    input: {
      objective: string;
      reason?: string;
      changeKind?:
        | 'clarification'
        | 'scope_change'
        | 'success_criteria_change'
        | 'correction';
    },
  ): Promise<{ conversation: Conversation; revision: GoalRevision }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/goal`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ).then(
      json<{ conversation: Conversation; revision: GoalRevision }>,
    );
  },

  getConversationGoalHistory(
    conversationId: string,
  ): Promise<{ revisions: GoalRevision[] }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(
        conversationId,
      )}/goal/history`,
    ).then(json<{ revisions: GoalRevision[] }>);
  },

  /**
   * 发一条消息。202：消息已落库、Lead 已唤醒，结果通过 SSE 推。
   *
   * 用户不需要知道「发给谁」：Task 工作区里用户消息只唤醒 Lead。
   */
  sendMessage(
    conversationId: string,
    input: {
      content: string;
      replyToMessageId?: string;
      /** 幂等键：同一次发送重试（响应丢了、双击）不会变成两条消息。 */
      clientRequestId?: string;
      /** 这条消息带 / 引用的会话文件（attachment 还是 reference 由服务端判断）。 */
      fileIds?: string[];
    },
  ): Promise<SendMessageResult> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ).then(json<SendMessageResult>);
  },

  addMemberToConversation(
    conversationId: string,
    memberId: string,
  ): Promise<{ conversation: Conversation }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/members`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId }),
      },
    ).then(json<{ conversation: Conversation }>);
  },

  removeMemberFromConversation(
    conversationId: string,
    memberId: string,
  ): Promise<{ conversation: Conversation }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(
        conversationId,
      )}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    ).then(json<{ conversation: Conversation }>);
  },

  /** 这个工作区的任务列表。 */
  listTasks(conversationId: string): Promise<{ tasks: ConversationTask[] }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/tasks`,
    ).then(json<{ tasks: ConversationTask[] }>);
  },

  getTask(taskId: string): Promise<{ task: ConversationTask }> {
    return fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}`).then(
      json<{ task: ConversationTask }>,
    );
  },

  /** 重试：failed / blocked / cancelled → ready。 */
  retryTask(taskId: string): Promise<{ task: ConversationTask }> {
    return fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
    }).then(json<{ task: ConversationTask }>);
  },

  cancelTask(taskId: string): Promise<{ task: ConversationTask }> {
    return fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
    }).then(json<{ task: ConversationTask }>);
  },

  /**
   * 会话级 SSE：message.created / message.delta / execution.updated /
   * task.updated / conversation.updated / delegation.*
   *
   * 服务端会给 durable 事件带 `id: <sequence>`，浏览器断线重连时自动回传
   * Last-Event-ID，服务端据此补发断线期间的事件 —— 前端不需要自己记录水位。
   * `since` 只在首次连接（或想强制从头拉）时用。
   */
  eventsUrl(conversationId: string, since?: number): string {
    const base = `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/events`;
    return since && since > 0 ? `${base}?since=${since}` : base;
  },

  getTeam(): Promise<{ team: Team }> {
    return fetch(`${API_BASE}/api/team`).then(json<{ team: Team }>);
  },

  listCurrentActivity(): Promise<{ activity: CurrentActivity[] }> {
    return fetch(`${API_BASE}/api/team/activity`).then(json<{ activity: CurrentActivity[] }>);
  },

  listPresence(): Promise<{ presence: TeamPresence[] }> {
    return fetch(`${API_BASE}/api/team/presence`).then(json<{ presence: TeamPresence[] }>);
  },

  setPresence(kind: 'human' | 'agent', id: string, availability: 'available' | 'away' | 'paused'): Promise<{ presence: TeamPresence }> {
    return fetch(`${API_BASE}/api/team/presence/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ availability }),
    }).then(json<{ presence: TeamPresence }>);
  },

  listSchedules(): Promise<{ schedules: ScheduledWake[] }> {
    return fetch(`${API_BASE}/api/team/schedules`).then(json<{ schedules: ScheduledWake[] }>);
  },

  createSchedule(input: {
    memberId: string;
    conversationId: string;
    prompt: string;
    type: 'once' | 'interval';
    runAt: string;
    intervalSeconds?: number | null;
  }): Promise<{ schedule: ScheduledWake }> {
    return fetch(`${API_BASE}/api/team/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ schedule: ScheduledWake }>);
  },

  /** 三个动作比一个通用的 PATCH status 清楚：按钮即语义。 */
  pauseSchedule(id: string): Promise<{ schedule: ScheduledWake }> {
    return this.scheduleAction(id, 'pause');
  },

  resumeSchedule(id: string): Promise<{ schedule: ScheduledWake }> {
    return this.scheduleAction(id, 'resume');
  },

  cancelSchedule(id: string): Promise<{ schedule: ScheduledWake }> {
    return this.scheduleAction(id, 'cancel');
  },

  scheduleAction(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<{ schedule: ScheduledWake }> {
    return fetch(
      `${API_BASE}/api/team/schedules/${encodeURIComponent(id)}/${action}`,
      { method: 'POST' },
    ).then(json<{ schedule: ScheduledWake }>);
  },

  /**
   * Team 级 SSE：member.activity / schedule / presence / external_work /
   * membership 的变更。机制与 conversations.eventsUrl 相同（Last-Event-ID 补发）。
   */
  teamEventsUrl(since?: number): string {
    const base = `${API_BASE}/api/team/events`;
    return since && since > 0 ? `${base}?since=${since}` : base;
  },

  // ------------------------------------------------------ Command / Approval
  //
  // 外部写入的控制面。默认 Policy 把一切 external-write 停在 policy_pending，
  // 这几个接口是唯一的放行出口。

  /**
   * 审批收件箱：待审批的 Command（跨房间，服务端按可见性过滤）。
   *
   * 按状态而不是按 execution 列 —— 审批人关心的是「有什么在等我批」，
   * 不是「某一轮里有什么」。
   */
  listCommandsByStatus(status: CommandStatus): Promise<{ commands: CommandRecord[] }> {
    return fetch(`${API_BASE}/api/commands?status=${encodeURIComponent(status)}`).then(
      json<{ commands: CommandRecord[] }>,
    );
  },

  /** 某一轮 execution 里的全部业务动作。 */
  listCommandsForExecution(executionId: string): Promise<{ commands: CommandRecord[] }> {
    return fetch(`${API_BASE}/api/commands?executionId=${encodeURIComponent(executionId)}`).then(
      json<{ commands: CommandRecord[] }>,
    );
  },

  /** 单条 Command：连同审批与生命周期事件。 */
  getCommand(id: string): Promise<CommandDetail> {
    return fetch(`${API_BASE}/api/commands/${encodeURIComponent(id)}`).then(json<CommandDetail>);
  },

  /**
   * 审批通过。`execute` 默认 true（批准即执行）—— 让它停在 approved 等一个
   * 不存在的第二个动作，等于批准之后还要再点一次「执行」，而没人会去找那个按钮。
   */
  approveCommand(id: string, options?: { execute?: boolean }): Promise<CommandDetail> {
    return fetch(`${API_BASE}/api/commands/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ execute: options?.execute ?? true }),
    }).then(json<CommandDetail>);
  },

  rejectCommand(id: string): Promise<CommandDetail> {
    return fetch(`${API_BASE}/api/commands/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then(json<CommandDetail>);
  },

  executeCommand(id: string): Promise<CommandDetail> {
    return fetch(`${API_BASE}/api/commands/${encodeURIComponent(id)}/execute`, {
      method: 'POST',
    }).then(json<CommandDetail>);
  },

  /**
   * 对账一条**结果未知**的 Command。
   *
   * 这是 `unknown` 唯一的出路：它不能重试（可能已经生效），也不能批准（早就
   * 执行过）。返回的 `outcome.status` 可能是 `unknown` —— 那说明对账自己也没
   * 读到，Command 状态不变，这是正常结果而不是错误。
   */
  reconcileCommand(id: string): Promise<CommandReconcileResult> {
    return fetch(`${API_BASE}/api/commands/${encodeURIComponent(id)}/reconcile`, {
      method: 'POST',
    }).then(json<CommandReconcileResult>);
  },

  // ---------------------------------------------------------------- 审计
  //
  // 一次 execution 的完整证据链：工具层判定 / 工具层执行 / 业务动作。

  getExecutionAudit(executionId: string): Promise<ExecutionAuditBundle> {
    return fetch(`${API_BASE}/api/audit/executions/${encodeURIComponent(executionId)}`).then(
      json<ExecutionAuditBundle>,
    );
  },

  /**
   * 导出地址（不是 fetch）：交给浏览器下载，文件名由服务端给。
   * 走 <a download> 而不是先 fetch 再造 Blob —— 后者会把整份 JSON 在内存里
   * 多存一份，而审计导出本来就可能不小。
   */
  executionAuditExportUrl(executionId: string): string {
    return `${API_BASE}/api/audit/executions/${encodeURIComponent(executionId)}/export`;
  },
};
