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
  /** 静音：dispatcher 不会唤醒它（@ 也唤不醒）。 */
  muted: boolean;
  updatedAt: string;
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
