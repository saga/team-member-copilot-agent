/**
 * 业务对象定义。这一层只描述「是什么」，不含存储和运行时细节。
 *
 * 关键边界（不要混）：
 *   Member          = 业务上的长期 AI 同事（跨 conversation 稳定）
 *   Conversation    = 聊天/协作空间
 *   MemberRuntime   = 某 Member 在某 Conversation 中的运行实例
 *   CopilotSession  = Runtime 的执行引擎状态（内部实现细节）
 *   Execution       = 一次实际工作
 */

export type MemberStatus = 'active' | 'archived';

export type ToolProfile = 'safe' | 'coding';

// ------------------------------------------------------------- Knowledge Base

export type KnowledgeBaseScope = 'team' | 'personal';

export interface KnowledgeBase {
  id: string;
  scope: KnowledgeBaseScope;
  /** 稳定的目录名 / 引用名。team KB 全局唯一；personal KB 固定为 member-<memberId>。 */
  key: string;
  name: string;
  description: string;
  /** personal KB 的属主；team KB 为 null。 */
  memberId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  /** 相对 KB 根目录的路径，也是 (kb, path) 唯一键。 */
  relativePath: string;
  /** 全文 sha256 —— 磁盘同步靠它跳过没变过的文件。 */
  contentHash: string;
  sourceUri: string | null;
  updatedAt: string;
}

export interface KnowledgeSearchHit {
  documentId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  scope: KnowledgeBaseScope;
  title: string;
  snippet: string;
  /** 稳定的引用标记，格式 [KB:<key>/<documentId>]。 */
  citation: string;
  sourceUri: string | null;
}

/** 某 Member 视角下能看到的 KB。检索 ACL 与 prompt 里的清单共用这一个查询。 */
export interface MemberKnowledgeProfile {
  teamKnowledgeBases: KnowledgeBase[];
  personalKnowledgeBases: KnowledgeBase[];
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
  toolProfile: ToolProfile;
  status: MemberStatus;
  /**
   * 非空表示这个 Member 最初由 member template provision。
   *
   * 这是 provisioning identity，不是业务身份 —— 它的唯一用途是回答
   * 「这份模板是不是已经落地过了」，所以它必须不可编辑：`name` / `handle`
   * 都是用户随时会改的显示属性，拿它们做判据会在「改了名再重启」时
   * 又建出一个同名 Member。
   */
  seedKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConversationKind = 'direct' | 'group' | 'work';

export interface Conversation {
  id: string;
  title: string;
  kind: ConversationKind;
  defaultMemberId: string | null;
  createdBy: string;
  /** 会话内单调递增的 event 游标，用于 SSE replay。 */
  eventSequence: number;
  /** 会话内单调递增的 message 游标，用于 runtime context checkpoint。 */
  messageSequence: number;
  createdAt: string;
  updatedAt: string;
  members: Member[];
}

export type MessageSenderType = 'user' | 'member' | 'system';

export interface ConversationMessage {
  id: string;
  conversationId: string;
  /** 会话内单调递增且唯一。 */
  messageSequence: number;
  senderType: MessageSenderType;
  senderId: string;
  targetMemberId: string | null;
  replyToMessageId: string | null;
  /**
   * 调用方为这次「发送」提供的幂等键（可以带前缀，比如 `web-<uuid>`）。
   *
   * 唯一性由 `UNIQUE(conversation_id, client_request_id)` 保证：同一个键第二次
   * 到达时不会再落一条消息，也不会再派一次唤醒，而是把第一条原样返回。为 null
   * 表示这条消息不参与去重（服务端内部产生的消息、以及没带键的调用方）。
   */
  clientRequestId: string | null;
  content: string;
  executionId: string | null;
  createdAt: string;
}

export type ExecutionKind = 'interactive' | 'member_delegate' | 'member_work';

/**
 * 一轮 turn 的性质，决定 prompt 里给 Member 的指令。
 *
 *   direct     —— 1:1 房间，用户在跟你说话，必须回答
 *   discussion —— group 房间的共享讨论，可以判断「我不该发言」
 *   delegation —— ask_member 派来的明确子任务，必须交付结果
 */
export type TurnMode = 'direct' | 'discussion' | 'delegation';

/**
 * 为什么唤醒这个 Member。确定性规则产出，不经过 LLM 路由。
 *
 *   direct          1:1 房间（或请求里显式指定 targetMemberId）
 *   mention         消息里 @ 了它
 *   open_discussion 用户没 @ 任何人，让房间里的成员自行判断要不要发言
 *   follow_up       另一个 Member 发言后，没被 @ 的成员被顺带唤醒（受 autoWakeRounds 限制）
 *
 * direct / mention 必须回答；open_discussion / follow_up 允许 <NO_REPLY>。
 */
export type WakeReason = 'direct' | 'mention' | 'open_discussion' | 'follow_up';

/**
 * Member 的一次 turn 的产出。
 *
 * `skip` 不是错误 —— Team Member 和普通 chatbot 最大的区别之一就是它可以说
 * 「我没有新信息，不重复别人的结论」。所以「不发言」是**成功**的一种结果。
 */
export type ExecutionDecision = 'reply' | 'skip';

export type ExecutionStatus =
  | 'queued'
  | 'running'
  /** 正在等另一个 Member 的 runtime 完成（ask_member 进行中）。 */
  | 'waiting_for_member'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /**
   * 进程重启时发现这条 execution 还停在 running / waiting_for_member。
   * 保守处理：不自动重跑 —— Copilot session 可能已经执行完工具但没来得及落库，
   * 自动重跑会造成重复执行。要重做必须显式 retry，并生成新的 execution。
   */
  | 'interrupted';

/**
 * 一轮 execution 开跑那一刻，这个 Member 的配置快照。
 *
 * 为什么需要它：Member 的配置（system prompt / memory / skills / model /
 * toolProfile）是**会变的**，而 execution 是「当时真的这样跑过一轮」的记录。
 * 没有快照，事后只能看到两条 execution 行为不同，看不到它们的输入不同 ——
 * 尤其是 retry：同一份 prompt 在今天重跑，用的已经是另一个人格、另一份记忆。
 *
 * `memberRevision` 用 `member.updated_at`：它是这个 Member 身份字段的写序号，
 * 换过任何一个人格字段都会变。
 */
export interface ExecutionConfigSnapshot {
  memberRevision: string;
  model: string;
  toolProfile: ToolProfile;
  /** system prompt 全文的 sha256（不存全文：它可以从 member + memory 重算）。 */
  systemPromptHash: string;
  /** 长期记忆内容的 sha256。Agent 在 turn 里写记忆会让它变化。 */
  memoryHash: string;
  /** 已安装 skill 清单的 sha256（名字 + 各自 SKILL.md 的 mtime）。 */
  skillManifestHash: string;
  /** 部署层是否放行宿主工具。它决定 availableTools 的真实形状。 */
  hostToolsEnabled: boolean;
}

export interface ExecutionRecord {
  id: string;
  conversationId: string;
  memberId: string;
  runtimeId: string | null;
  parentExecutionId: string | null;
  /** 从根到当前的 Member 链，用来防 A→B→C→A 和无限深链。 */
  delegationPath: string[];
  kind: ExecutionKind;
  status: ExecutionStatus;
  prompt: string;
  response: string | null;
  error: string | null;
  /** 当前在等哪个 runtime（delegation deadlock 检测用）。 */
  waitingForRuntimeId: string | null;
  /** retry 生成的新 execution 会指回被 retry 的那条。 */
  retryOfExecutionId: string | null;
  /**
   * 这一轮的结果是发言还是保持沉默。`skip` 是一条**成功**的 execution ——
   * 它只是没有产生 message。null = 还没跑完 / 跑失败了。
   */
  decision: ExecutionDecision | null;
  /**
   * 哪条 conversation message 触发了这一轮。
   *
   * 不能再用 `message.execution_id` 来标记「触发消息」了：一条消息可以唤醒多个
   * Member，各自产生一条 execution，一个外键装不下。delegation 没有触发消息，为 null。
   */
  triggerMessageSequence: number | null;
  /** 为什么唤醒这个 Member。落库是为了重启恢复时忠实重放同一轮。 */
  wakeReason: WakeReason | null;
  /** 开跑那一刻这个 Member 的配置。历史数据为 null（当时没有记录）。 */
  configSnapshot: ExecutionConfigSnapshot | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export type WakeStatus = 'idle' | 'queued' | 'running' | 'cooldown';

/**
 * 某 Member 在某 Conversation 里的**房间状态**。
 *
 * 和 MemberRuntime 是两件不同的事，一定不要混：
 *
 *   MemberRuntime            「这个 Member 的 Agent 怎么运行」
 *                             copilotSessionId / workspacePath / lastContextMessageSequence
 *   ConversationMemberState  「这个 Member 在房间里看到哪里了、要不要被唤醒」
 *                             lastSeenMessageSequence / wakeStatus / pendingWake / muted
 *
 * `lastContextMessageSequence` 是「已经注入过 Copilot session 的水位」，
 * `lastSeenMessageSequence` 是「这个 Member 已经读过房间到哪里」。两者会分叉：
 * Member 读完了但选择不发言（skip）时，lastSeen 前进而 checkpoint 不动。
 */
export interface ConversationMemberState {
  conversationId: string;
  memberId: string;
  /** 这个 Member 已经读到房间的哪个位置（用于 inbox / 未读判断）。 */
  lastSeenMessageSequence: number;
  /** 这个 Member 最后一次发言的序号。 */
  lastRepliedMessageSequence: number;
  wakeStatus: WakeStatus;
  /**
   * 有唤醒信号还没被处理。durable 的「有个 wake 丢了」提示：
   * 进程在排队期间挂掉时，RecoveryService 靠它把 wake 重新派出去。
   */
  pendingWake: boolean;
  /**
   * 排队中那次唤醒是被哪条消息、以什么原因触发的。没有排队时为 null。
   *
   * 和 `pendingWake` 一起落库是**必须的**：只记住「有人被唤醒过」，恢复时就只能
   * 拿房间当前水位 + 最宽松的 reason 去猜，重放出来的是另一轮 —— 一次显式
   * @mention 会被降级成「顺带看看」，而且对着的是另一条消息。
   */
  pendingWakeTriggerSequence: number | null;
  pendingWakeReason: WakeReason | null;
  /** 静音：dispatcher 不会唤醒它（@ 也唤不醒）。 */
  muted: boolean;
  updatedAt: string;
}

/**
 * 一次还没被处理完的唤醒：谁、在哪个房间、因为哪条消息、为什么。
 *
 * 它是 scheduler 的入队单位，也是落库的重放单位 —— 两个用途共用同一个形状，
 * 这样「恢复出来的那一轮」与「当时那一轮」在结构上不可能不一致。
 */
export interface PendingWake {
  conversationId: string;
  memberId: string;
  reason: WakeReason;
  triggerSequence: number;
}

/**
 * 房间状态的一条变化通知（`conversation_member_state.updated` 事件的 payload）。
 *
 * 做成 `{ memberId, state }` 而不是直接发 state 本身：状态**消失**也是一次
 * 变化（成员被移出房间），而「消失」表达不出一个 ConversationMemberState。
 * 用 null 表示它，比再发明一个 event type 干净。
 */
export interface ConversationMemberStateChange {
  memberId: string;
  /** null = 这个 Member 在这个房间里的状态已经不存在。 */
  state: ConversationMemberState | null;
}

export interface MemberRuntime {
  id: string;
  conversationId: string;
  memberId: string;
  /** Copilot SDK 的稳定 sessionId，resumeSession() 靠它恢复引擎状态。 */
  copilotSessionId: string;
  workspacePath: string;
  status: 'idle' | 'running' | 'error';
  /**
   * 当前持有该 runtime 的 execution（runtime 单写者记录）。
   * 进程内互斥由 TeamService 的 per-runtime 锁保证；这个字段是持久化视图，
   * 也是重启恢复时判断「谁在跑」的依据。
   */
  activeExecutionId: string | null;
  /**
   * 已注入过 Copilot session 的 shared message 水位线。
   * 下一轮只注入 message_sequence > 该值的消息，避免与 session history 重复。
   */
  lastContextMessageSequence: number;
  lastUsedAt: string | null;
}

export type ConversationEventType =
  | 'message.created'
  | 'message.delta'
  | 'execution.updated'
  /**
   * 某个 Member 在房间里的状态变了（读游标 / 唤醒状态 / 静音）。
   *
   * durable 事件，和别的状态一样先落库再广播：前端靠它把 ●idle / ●working /
   * 🔇muted 实时化，而不是轮询。只依赖 message.created 是不够的 —— NO_REPLY /
   * pending / mute 这些变化都不伴随新消息。
   */
  | 'conversation_member_state.updated'
  | 'delegation.started'
  | 'delegation.finished';

/** 内部广播用的轻量事件（尚未落库）。 */
export interface ConversationEvent {
  type: ConversationEventType;
  data: unknown;
}

/**
 * 落库后的 durable event。
 *
 * `message.delta` 是 token 级高频事件，不落库（否则 DB 会被写爆），
 * 因此它的 `id` / `sequence` 为 null，SSE 帧也不带 `id:` 字段 —— 浏览器
 * 因而不会推进 Last-Event-ID，重连时无需 replay 它。丢失的增量文本由
 * durable 的 `message.created`（携带完整内容）收敛。
 */
export interface StoredConversationEvent {
  id: string | null;
  conversationId: string;
  sequence: number | null;
  type: ConversationEventType;
  data: unknown;
  createdAt: string;
}
