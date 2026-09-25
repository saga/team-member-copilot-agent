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

/**
 * 一条消息唤醒了哪个 Member、为什么。
 *
 * 确定性规则的产物（见 server/group-dispatcher.ts），不是 LLM routing：
 *   direct          1:1 房间，或请求里显式指定了 targetMemberId
 *   mention         消息里 @ 了它
 *   open_discussion 用户没 @ 任何人，让房间成员自行判断要不要发言
 *   follow_up       另一个 Member 发言后顺带被唤醒（受 autoWakeRounds 限制）
 */
export interface WakePlan {
  memberId: string;
  reason: 'direct' | 'mention' | 'open_discussion' | 'follow_up';
  triggerSequence: number;
}

/**
 * POST /messages 的结果。
 *
 * 刻意**没有**单个 executionId：group 房间的一条消息可以唤醒多个 Member，
 * 各自产生一条 execution，一个字段表达不了。谁被唤醒了看 `wakes`，
 * 每条 execution 的进展通过 SSE 的 `execution.updated` 到达。
 */
export interface SendMessageResult {
  message: ConversationMessage;
  wakes: WakePlan[];
  /** 消息里 @ 了但不属于这个房间的名字；非空时服务端刻意**不**广播给全员。 */
  unresolvedMentions: string[];
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
  muted: boolean;
  updatedAt: string;
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
      toolProfile?: 'safe' | 'coding';
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
   * Member 的长期记忆全文。
   *
   * 刻意不是「给 prompt 用的截断版」：编辑器拿到截断内容再整体保存，
   * 会把被截掉的前半段永久丢掉。
   */
  getMemberMemory(memberId: string): Promise<{ content: string }> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/memory`).then(
      json<{ content: string }>,
    );
  },

  /** 整体覆盖；返回归一化后真正落盘的内容。 */
  replaceMemberMemory(memberId: string, content: string): Promise<{ content: string }> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then(json<{ content: string }>);
  },

  listMemberSkills(memberId: string): Promise<{ skills: MemberSkill[] }> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/skills`).then(
      json<{ skills: MemberSkill[] }>,
    );
  },

  /**
   * 上传 zip 安装一个 skill。
   *
   * 直接把 File 当 body（raw），不走 multipart —— 只有一个文件，
   * 多一层 parser 只会多一个依赖和一个临时目录。文件名走 query。
   */
  uploadMemberSkill(memberId: string, file: File): Promise<{ skill: MemberSkill }> {
    return fetch(
      `${API_BASE}/api/members/${encodeURIComponent(memberId)}/skills?filename=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/zip' },
        body: file,
      },
    ).then(json<{ skill: MemberSkill }>);
  },

  deleteMemberSkill(memberId: string, name: string): Promise<{ skills: MemberSkill[] }> {
    return fetch(
      `${API_BASE}/api/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(name)}`,
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

  /** 静音后 dispatcher 不会唤醒它 —— @ 也唤不醒。 */
  setMemberMuted(
    conversationId: string,
    memberId: string,
    muted: boolean,
  ): Promise<{ state: ConversationMemberState }> {
    return fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(
        conversationId,
      )}/members/${encodeURIComponent(memberId)}/state`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted }),
      },
    ).then(json<{ state: ConversationMemberState }>);
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
   * 202：消息已落库、对方已入队，对方的回复通过那个房间的 SSE 推。
   * 房间不存在时会自动建立 —— 调用方不需要「先开房间再发消息」两段式。
   */
  sendDirectMessage(
    memberId: string,
    input: { toMemberId: string; content: string },
  ): Promise<SendMessageResult & { conversation: Conversation; peer: Member }> {
    return fetch(`${API_BASE}/api/members/${encodeURIComponent(memberId)}/direct-messages`, {
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

  /**
   * 发一条消息。202：消息已落库、唤醒已入队，结果通过 SSE 推。
   *
   * `targetMemberId` 只在 UI 明确点名时传（direct 房间自动就是那一个成员）。
   * group 房间的「Everyone」必须传 undefined —— 由服务端 GroupDispatcher
   * 决定唤醒谁。前端替服务端挑一个成员会把共享讨论降级成单人聊天。
   */
  sendMessage(
    conversationId: string,
    input: { content: string; targetMemberId?: string; replyToMessageId?: string },
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
