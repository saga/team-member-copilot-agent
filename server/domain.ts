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
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
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
