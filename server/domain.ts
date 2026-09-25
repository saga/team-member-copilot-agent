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
  createdAt: string;
  updatedAt: string;
  members: Member[];
}

export type MessageSenderType = 'user' | 'member' | 'system';

export interface ConversationMessage {
  id: string;
  conversationId: string;
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
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  lastUsedAt: string | null;
}

export type ConversationEventType =
  | 'message.created'
  | 'message.delta'
  | 'execution.updated'
  | 'delegation.started'
  | 'delegation.finished';

export interface ConversationEvent {
  type: ConversationEventType;
  data: unknown;
}
