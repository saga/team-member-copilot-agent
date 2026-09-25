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
  createdAt: string;
  updatedAt: string;
  members: Member[];
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderType: 'user' | 'member' | 'system';
  senderId: string;
  targetMemberId: string | null;
  replyToMessageId: string | null;
  content: string;
  executionId: string | null;
  createdAt: string;
}

export interface ExecutionRecord {
  id: string;
  conversationId: string;
  memberId: string;
  runtimeId: string | null;
  parentExecutionId: string | null;
  delegationPath: string[];
  kind: 'interactive' | 'member_delegate' | 'member_work';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt: string;
  response: string | null;
  error: string | null;
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

  /** 会话级 SSE：message.created / message.delta / execution.updated / delegation.* */
  eventsUrl(conversationId: string): string {
    return `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/events`;
  },
};
