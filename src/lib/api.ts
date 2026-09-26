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
 * Member 对某个能力 Provider 的一次引用。
 *
 * 存的是 Provider ID（稳定契约）+ selector，不是实现 —— 所以换掉本地资料库的
 * 实现时这里不变。`selector` 的含义由 Provider 定义（knowledge 用 KB key 或
 * `$personal`；skill / tool 通常为空）。
 */
export interface CapabilityBinding {
  providerId: string;
  selector?: string;
}

export interface MemberCapabilities {
  skills: CapabilityBinding[];
  knowledge: CapabilityBinding[];
  tools: CapabilityBinding[];
}

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

export interface CurrentActivity {
  executionId: string;
  conversationId: string;
  conversationTitle: string;
  memberId: string;
  memberName: string;
  jiraIssueKey: string | null;
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
  projectId: string | null;
  workItemId: string | null;
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

export interface Conversation {
  id: string;
  teamId: string;
  /** 这间会话围绕哪张 Jira 工单。业务状态在 Jira，这里只是引用。 */
  jiraIssueKey: string | null;
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
  /** 发送时带的幂等键；null = 这条消息不参与去重。 */
  clientRequestId: string | null;
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

/**
 * 这一轮开跑那一刻，Member 的配置长什么样。
 *
 * 配置会随时间变，而 execution 是「当时真的这样跑过一轮」的记录。有它才能回答
 * 「为什么这条和那条行为不同」，尤其是 retry —— 同一份 prompt 在今天重跑，
 * 用的可能已经是另一个人格、另一份记忆。
 *
 * 只存指纹不存全文：system prompt 和 memory 都能从 member + 磁盘重算。
 */
export interface ExecutionConfigSnapshot {
  memberRevision: string;
  model: string;
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
  workItemId: string | null;
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

/**
 * 为什么唤醒这个 Member。确定性规则的产物（见 server/group-dispatcher.ts），
 * 不是 LLM routing：
 *   direct          1:1 房间，或请求里显式指定了 targetMemberId
 *   mention         消息里 @ 了它
 *   open_discussion 用户没 @ 任何人，让房间成员自行判断要不要发言
 *   follow_up       另一个 Member 发言后顺带被唤醒（受 autoWakeRounds 限制）
 */
export type WakeReason = 'direct' | 'mention' | 'open_discussion' | 'follow_up' | 'schedule';

/** 一条消息唤醒了哪个 Member、为什么。 */
export interface WakePlan {
  memberId: string;
  reason: WakeReason;
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
   * Member 的能力组成。
   *
   * 和 `/api/members/:id/skills` 是两件事：那个回答「磁盘上装了哪些 skill」
   * （内容投放），这个回答「启用了哪些能力来源」。界面上必须分开显示 ——
   * 否则会出现「装了一个 skill 却不知道谁在用它」。
   */
  getMemberCapabilities(id: string): Promise<{ capabilities: MemberCapabilities }> {
    return fetch(`${API_BASE}/api/capabilities/members/${encodeURIComponent(id)}`).then(
      json<{ capabilities: MemberCapabilities }>,
    );
  },

  updateMemberCapabilities(
    id: string,
    input: MemberCapabilities,
  ): Promise<{ capabilities: MemberCapabilities }> {
    return fetch(`${API_BASE}/api/capabilities/members/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<{ capabilities: MemberCapabilities }>);
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
    kind?: 'direct' | 'group' | 'work';
    memberIds: string[];
    defaultMemberId?: string;
    projectId?: string | null;
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
    input: {
      content: string;
      targetMemberId?: string;
      replyToMessageId?: string;
      /** 幂等键：同一次发送重试（响应丢了、双击）不会变成两条消息。 */
      clientRequestId?: string;
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
    projectId?: string | null;
    workItemId?: string | null;
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
   * Team 级 SSE：work_item / schedule / presence / project / membership 的变更。
   * 机制与 conversations.eventsUrl 相同（Last-Event-ID 补发）。
   */
  teamEventsUrl(since?: number): string {
    const base = `${API_BASE}/api/team/events`;
    return since && since > 0 ? `${base}?since=${since}` : base;
  },
};
