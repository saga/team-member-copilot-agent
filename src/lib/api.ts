const API_BASE = import.meta.env.VITE_API_BASE || '';

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`HTTP ${response.status}: ${text}`);
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
  toolProfile: 'safe' | 'coding';
  status: 'active' | 'archived';
}

export interface Conversation {
  id: string;
  title: string;
  kind: 'direct' | 'group' | 'work';
  defaultMemberId: string | null;
  createdBy: string;
  /** 会话内单调递增的 event 游标，等于 SSE 的 Last-Event-ID。 */
  eventSequence: number;
  /** 会话内单调递增的 message 游标。 */
  messageSequence: number;
  createdAt: string;
  updatedAt: string;
  members: Member[];
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  messageSequence: number;
  senderType: 'user' | 'member' | 'system';
  senderId: string;
  targetMemberId: string | null;
  replyToMessageId: string | null;
  content: string;
  executionId: string | null;
  createdAt: string;
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

export interface ExecutionRecord {
  id: string;
  conversationId: string;
  memberId: string;
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
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface Health {
  status: string;
  timestamp: string;
  /** idle = client 尚未建连的懒加载态，不是故障 */
  copilot: 'connected' | 'idle' | 'error';
  copilotError?: string;
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

export const api = {
  health(): Promise<Health> {
    return fetch(`${API_BASE}/api/health`).then(json<Health>);
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
    toolProfile?: 'safe' | 'coding';
  }): Promise<{ member: Member }> {
    return fetch(`${API_BASE}/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ member: Member }>);
  },

  listConversations(): Promise<{ conversations: Conversation[] }> {
    return fetch(`${API_BASE}/api/conversations`).then(
      json<{ conversations: Conversation[] }>,
    );
  },

  createConversation(input: {
    title?: string;
    kind?: 'direct' | 'group' | 'work';
    memberIds: string[];
    defaultMemberId?: string;
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

  sendMessage(
    conversationId: string,
    input: { content: string; targetMemberId?: string; replyToMessageId?: string },
  ): Promise<{ message: ConversationMessage; executionId: string }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ).then(json<{ message: ConversationMessage; executionId: string }>);
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

  /**
   * 会话级 SSE：message.created / message.delta / execution.updated / delegation.*
   *
   * 服务端会给 durable 事件带 `id: <sequence>`，浏览器断线重连时自动回传
   * Last-Event-ID，服务端据此补发断线期间的事件 —— 前端不需要自己记录水位。
   * `since` 只在首次连接（或想强制从头拉）时用。
   */
  eventsUrl(conversationId: string, since?: number): string {
    const base = `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/events`;
    return since && since > 0 ? `${base}?since=${since}` : base;
  },
};
