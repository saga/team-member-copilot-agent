import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Empty, Layout, Space, Tag } from 'antd';
import {
  api,
  type Conversation,
  type ConversationMemberState,
  type ConversationMemberStateChange,
  type ConversationMessage,
  type DelegationEvent,
  type DeltaEvent,
  type ExecutionRecord,
  type ExecutionStatus,
  type Member,
} from '../lib/api';
import { ConversationHeader } from './team/ConversationHeader';
import {
  ConversationMessages,
  type DelegationLog,
  type StreamState,
} from './team/ConversationMessages';
import { MessageComposer } from './team/MessageComposer';
import { MemberProfile } from './team/MemberProfile';
import { TeamSidebar } from './team/TeamSidebar';
import type { WorkDraft } from './team/WorkCreator';
import { ResizableSider } from './ResizableSider';
import { EVERYONE, type MemberStatus, type MemberStatusLookup } from './team/constants';

const { Content } = Layout;

/**
 * 左栏当前展开的是哪个「创建面板」。
 *
 * 用一个可空枚举而不是三个 boolean：三个 boolean 有 2³ 种组合，其中 5 种是
 * 「两个面板同时开着」这种无意义状态，只能靠在每个 toggle 里手工互相清除来维持
 * 不变量 —— 那种写法每加一个面板就要改所有旧的 handler，而且漏一处就会出现
 * 「点了 New Work，New Member 的表单还开着」。
 */
type CreatorKind = 'member' | 'group' | 'work' | null;

/** 还在推进中的 execution 状态；到了其它状态就说明这条 execution 已经收尾。 */
const ACTIVE_STATUSES: ExecutionStatus[] = ['queued', 'running', 'waiting_for_member'];

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  queued: '排队中',
  running: '执行中',
  waiting_for_member: '等待其他 Member',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/**
 * 生成一次发送的幂等键。
 *
 * `crypto.randomUUID` 只在安全上下文（https / localhost）可用，退回一个由
 * 时间戳与随机数拼出来的值。这个键只要求「在本机一次会话内不重复」——
 * 它不会被当成安全边界，只是让服务端能认出「这是同一次发送」。
 */
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `web-${crypto.randomUUID()}`;
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseEvent<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

/**
 * 按 id 去重、按 messageSequence 排序地合并消息。
 *
 * 三条来源会同时写 messages：SSE、GET /messages、POST /messages 的乐观插入。
 * 任何一个用「整体替换」或「无脑 append」都会在慢 API / 网络抖动 / SSE 重连时
 * 丢消息或乱序，所以统一走这个收敛函数。
 */
function mergeMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.messageSequence - b.messageSequence);
}

/**
 * Team UI 的容器：只持有「当前会话 / 当前成员 / 实时状态」，其余交给 team/* 子组件。
 *
 * 三条数据通道必须分清，混起来就会出现难查的不一致：
 *
 *   conversation_message  —— 大家都能看到的消息（SSE message.created）
 *   execution.updated     —— 谁在跑、跑到哪一步（runtime 状态条）
 *   conversation_member_state —— 每个成员在房间里的读游标 / 唤醒状态 / 静音
 */
export function TeamChat() {
  const [members, setMembers] = useState<Member[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streaming, setStreaming] = useState<Record<string, StreamState>>({});
  const [delegations, setDelegations] = useState<DelegationLog[]>([]);
  /** executionId → 最近一次 execution.updated，用来渲染 runtime 实时状态。 */
  const [executions, setExecutions] = useState<Record<string, ExecutionRecord>>({});
  /**
   * 收件人。**不是** conversation.defaultMemberId —— 那是「这个房间默认归谁」，
   * 用它当 group 的默认收件人会把多人共享讨论强制降级成单人聊天。
   *
   *   direct → 房间里唯一那个 Member
   *   group  → ''（Everyone），由服务端 GroupDispatcher 决定唤醒谁
   */
  const [recipientMemberId, setRecipientMemberId] = useState<string>(EVERYONE);
  const [conversationStates, setConversationStates] = useState<
    Record<string, ConversationMemberState>
  >({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 中性提示（蓝色 Alert）。和 error 分开是因为语义不同：error 是「刚才那件事
   * 失败了」，notice 是「事情做成了，但你得知道接下来会发生什么」——
   * 比如「Work 房间建好了，但没下指令，所以它还没开始跑」。
   * 用红色报这个会让人以为建房间失败了。
   */
  const [notice, setNotice] = useState<string | null>(null);
  /** 左栏展开中的创建面板；同一时刻至多一个。 */
  const [creator, setCreator] = useState<CreatorKind>(null);
  const [showMemberManager, setShowMemberManager] = useState(false);
  /**
   * 正在编辑档案的 Member。
   *
   * 刻意和「进入单聊」分开：member row 上 Chat / Edit 是两个独立动作。
   * 把二者塞进同一个 handler，会让「想改一下它的 system prompt」变成
   * 「顺手开了一个新会话」。
   */
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);

  // 子组件仍然收 boolean：只有左栏知道「面板是哪个」这件事，没必要把它扩散出去。
  const showNewMember = creator === 'member';
  const showGroupCreator = creator === 'group';
  const showWorkCreator = creator === 'work';

  /**
   * 上一次发送的幂等键。
   *
   * 只在「内容完全相同」时才复用：同一次发送的重试（响应丢了、用户又点了一次
   * Send）应该收敛成一条消息；而用户改了内容再发是一次新的发送，复用旧键会
   * 被服务端当成重试、把新内容默默丢掉。
   */
  const pendingSendRef = useRef<{ clientRequestId: string; content: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 供只依赖 conversationId 的 effect 读取最新 conversations，避免每次刷新都重连 SSE
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === conversationId) ?? null,
    [conversationId, conversations],
  );

  const memberById = useMemo(() => {
    const map = new Map<string, Member>();
    for (const member of members) map.set(member.id, member);
    return map;
  }, [members]);

  const editingMember = editingMemberId ? (memberById.get(editingMemberId) ?? null) : null;

  function memberLabel(id: string): string {
    return memberById.get(id)?.name ?? `${id.slice(0, 8)}…`;
  }

  /**
   * 每个 Member 当前最活跃的那条 execution。
   * 一个 Member 可能同时挂着几条（被多次委派），只展示最新的一条即可。
   */
  const activeExecutions = useMemo(() => {
    const byMember = new Map<string, ExecutionRecord>();
    for (const execution of Object.values(executions)) {
      if (!ACTIVE_STATUSES.includes(execution.status)) continue;
      const current = byMember.get(execution.memberId);
      if (!current || current.createdAt <= execution.createdAt) {
        byMember.set(execution.memberId, execution);
      }
    }
    return [...byMember.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [executions]);

  /**
   * 成员在房间里的状态，用来渲染 ●idle / ●working / 🔇muted。
   *
   * muted 以服务端为准（它是 dispatcher 的真实输入）；wakeStatus 覆盖「有唤醒
   * 在排队 / 在跑」；两者都没有但有活跃 execution 时兜底成 working，免得调度器
   * 状态和 UI 出现一瞬不一致。
   */
  const memberStatus: MemberStatusLookup = (memberId) => {
    const state = conversationStates[memberId];
    if (state?.muted) return { className: 'muted', label: '🔇 muted' };

    const wake = state?.wakeStatus;
    if (wake === 'running' || wake === 'queued') {
      return { className: 'working', label: '● working' };
    }
    if (activeExecutions.some((execution) => execution.memberId === memberId)) {
      return { className: 'working', label: '● working' };
    }
    return { className: 'idle', label: '● idle' } satisfies MemberStatus;
  };

  async function refresh() {
    const [membersResult, conversationsResult] = await Promise.all([
      api.listMembers(),
      api.listConversations(),
    ]);
    setMembers(membersResult.members);
    setConversations(conversationsResult.conversations);
    setConversationId((current) => current ?? conversationsResult.conversations[0]?.id ?? null);
  }

  useEffect(() => {
    void refresh().catch((e: unknown) => setError(String(e)));
    // 只在挂载时拉一次；后续创建走本地插入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开会话：拉历史 + 订阅 SSE
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setStreaming({});
      setDelegations([]);
      setExecutions({});
      return;
    }

    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    const activeId = conversationId;

    setMessages([]);
    setStreaming({});
    setDelegations([]);
    setExecutions({});
    setConversationStates({});
    setError(null);
    // 成员管理面板属于「当前房间」，切房间就收起，避免看起来像在管另一个 Team
    setShowMemberManager(false);

    if (conversation?.kind === 'group') {
      setRecipientMemberId(EVERYONE);
    } else {
      setRecipientMemberId(conversation?.members[0]?.id ?? EVERYONE);
    }

    void api
      .listMessages(activeId)
      .then((result) => {
        // 必须 merge 而不是 replace：SSE 和这个 GET 是并发的。
        // 如果 SSE 先推来一条新消息、GET 后返回，直接 setMessages(result.messages)
        // 会把那条新消息覆盖掉。
        setMessages((current) => mergeMessages(current, result.messages));

        setStreaming((current) => {
          // 历史里已经有 execution 的最终消息，就把对应的流式占位清掉
          const finished = new Set(
            result.messages.map((message) => message.executionId).filter(Boolean) as string[],
          );
          const next = { ...current };
          for (const executionId of finished) delete next[executionId];
          return next;
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    const source = new EventSource(api.eventsUrl(activeId));

    // 服务端在每次连接（含自动重连）建立后都会发一条 connected，
    // 说明断线期间的事件已经按 Last-Event-ID 补发完毕，可以清掉旧的错误提示。
    source.addEventListener('connected', () => {
      setError(null);
    });

    source.addEventListener('message.created', (event) => {
      const message = parseEvent<ConversationMessage>(event as MessageEvent);
      if (!message) return;

      setMessages((current) => mergeMessages(current, [message]));

      if (message.executionId) {
        const executionId = message.executionId;
        setStreaming((current) => {
          const next = { ...current };
          delete next[executionId];
          return next;
        });
      }
    });

    source.addEventListener('message.delta', (event) => {
      const data = parseEvent<DeltaEvent>(event as MessageEvent);
      if (!data) return;
      setStreaming((current) => ({
        ...current,
        [data.executionId]: {
          executionId: data.executionId,
          memberId: data.memberId,
          content: (current[data.executionId]?.content ?? '') + data.delta,
        },
      }));
    });

    source.addEventListener('execution.updated', (event) => {
      const data = parseEvent<ExecutionRecord>(event as MessageEvent);
      if (!data) return;

      setExecutions((current) => ({ ...current, [data.id]: data }));

      if (data.status === 'failed' && data.error) setError(data.error);
      if (data.status === 'interrupted') {
        setError('有 execution 因服务重启而中断，未被自动重跑（避免重复执行）。');
      }
      // 终态：清掉流式占位，避免残留一个永远转圈的半截回复
      if (!ACTIVE_STATUSES.includes(data.status)) {
        setStreaming((current) => {
          const next = { ...current };
          delete next[data.id];
          return next;
        });
      }
    });

    source.addEventListener('conversation_member_state.updated', (event) => {
      const change = parseEvent<ConversationMemberStateChange>(event as MessageEvent);
      if (!change) return;
      applyStateChanged(change);
    });

    source.addEventListener('delegation.started', (event) => {
      const data = parseEvent<DelegationEvent>(event as MessageEvent);
      const fromMemberId = data?.fromMemberId;
      const targetMemberId = data?.targetMemberId;
      if (!data || !fromMemberId || !targetMemberId) return;
      setDelegations((current) => [
        ...current,
        {
          executionId: data.executionId,
          fromMemberId,
          targetMemberId,
          task: data.task ?? '',
          status: 'running',
        },
      ]);
    });

    source.addEventListener('delegation.finished', (event) => {
      const data = parseEvent<DelegationEvent>(event as MessageEvent);
      if (!data) return;
      setDelegations((current) =>
        current.map((item) =>
          item.executionId === data.executionId
            ? { ...item, status: data.error ? 'error' : 'done' }
            : item,
        ),
      );
    });

    source.onerror = () => {
      // EventSource 会自动重连；不把它当成业务错误弹给用户
    };

    return () => {
      source.close();
    };
  }, [conversationId]);

  /**
   * 进入房间时拉一次全量状态（wakeStatus / muted / 读游标）。
   *
   * 只依赖 conversationId：之后的每一次变化都由
   * `conversation_member_state.updated` 事件推过来，不需要再靠「消息数变了」
   * 这种间接信号去猜 —— NO_REPLY / 排队 / 静音都不伴随新消息，
   * 靠消息数刷新会漏掉它们，而且会随每个 turn 都戳一次接口。
   */
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;
    void api
      .listConversationState(conversationId)
      .then((result) => {
        if (cancelled) return;
        for (const state of result.states) {
          applyStateChanged({ memberId: state.memberId, state });
        }
      })
      .catch(() => {
        // 状态只是展示增强，拿不到不该打断聊天
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // 新消息 / 新增量 / runtime 状态变化时贴底
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight });
  }, [messages, streaming, delegations, executions]);

  /**
   * 应用一条房间状态变化（来自 SSE 或一次静音切换的响应）。
   *
   * 带 `updatedAt` 守卫：SSE 回放是时间正序的，但**首次连接时的 GET /state**
   * 可能后到 —— 没有守卫的话，一个更旧的状态会盖掉更新的那条，UI 上表现成
   * 「刚变成 working 又跳回 idle」。
   */
  function applyStateChanged(change: ConversationMemberStateChange) {
    setConversationStates((current) => {
      const next = { ...current };
      const previous = next[change.memberId];

      if (!change.state) {
        // 状态消失 = 这个成员被移出房间
        delete next[change.memberId];
        return next;
      }
      if (previous && previous.updatedAt > change.state.updatedAt) return current;

      next[change.memberId] = change.state;
      return next;
    });
  }

  function applyConversationChanged(next: Conversation) {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === next.id ? next : conversation)),
    );
  }

  /**
   * Member 身份改完之后，两个地方都持有它的副本，必须一起更新：
   *   members                —— 侧栏、mention 解析、选择器
   *   conversation.members   —— header 的成员 chip、recipient 下拉
   * 漏掉后者会出现「名字改了但群里的 chip 还是旧的」。
   *
   * 归档的 Member 直接从侧栏移除（listMembers 只返回 active），但保留在
   * conversation roster 里 —— 那是历史事实。
   */
  function applyMemberSaved(next: Member) {
    setMembers((current) =>
      next.status === 'active'
        ? current.map((member) => (member.id === next.id ? next : member))
        : current.filter((member) => member.id !== next.id),
    );
    setConversations((current) =>
      current.map((conversation) => ({
        ...conversation,
        members: conversation.members.map((member) => (member.id === next.id ? next : member)),
      })),
    );
  }

  async function toggleMuted(memberId: string): Promise<void> {
    if (!conversationId) return;
    const muted = !conversationStates[memberId]?.muted;
    try {
      const result = await api.setMemberMuted(conversationId, memberId, muted);
      applyStateChanged({ memberId: result.state.memberId, state: result.state });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 切到另一个房间。
   *
   * notice 属于「刚刚建好的那个房间」，切走之后它就没有指代对象了 —— 但这个清理
   * 必须挂在**用户主动切房间**这个动作上，不能挂在「conversationId 变了」这个
   * effect 上：createWork 在建完房间之后紧接着 setNotice(...)，两者被 React 批到
   * 同一次渲染里，effect 随后执行就会把刚设好的提示擦掉。
   * （error 没有这个问题：它总是在一次 await 之后才被设置。）
   */
  function openConversation(id: string) {
    setNotice(null);
    setConversationId(id);
  }

  async function createDirect(member: Member) {
    // 必须限定「房间里只有这一个 Member」：Member 之间的私聊同样是 kind='direct'，
    // 只看 kind 的话，点 Alice 的 [Chat] 会一头撞进 Alice 和 Bob 的私聊。
    const existing = conversations.find(
      (item) =>
        item.kind === 'direct' &&
        item.members.length === 1 &&
        item.members[0].id === member.id,
    );
    if (existing) {
      openConversation(existing.id);
      return;
    }

    const result = await api.createConversation({
      kind: 'direct',
      title: member.name,
      memberIds: [member.id],
    });
    setConversations((current) => [
      result.conversation,
      ...current.filter((item) => item.id !== result.conversation.id),
    ]);
    openConversation(result.conversation.id);
  }

  /**
   * 新建 Team。**不传 defaultMemberId** —— 收件人集合是全部成员，
   * 由服务端 GroupDispatcher 决定每一轮唤醒谁。
   */
  async function createGroup(input: { title: string; memberIds: string[] }) {
    const result = await api.createConversation({
      kind: 'group',
      title: input.title,
      memberIds: input.memberIds,
    });
    setConversations((current) => [
      result.conversation,
      ...current.filter((item) => item.id !== result.conversation.id),
    ]);
    openConversation(result.conversation.id);
    setCreator(null);
  }

  /**
   * 新建 Work：建房间 + （可选）立刻下第一条指令。
   *
   * 顺序是「先建 → 再切过去 → 再发消息」，不是「先建 → 先发 → 再切」。
   * 切房间会触发打开会话的 effect，那个 effect 会清掉 error / notice；
   * 把发消息放在切之后，才能保证发送失败的提示**不会**被那次清理吃掉。
   * 这也顺带让房间立刻出现在界面上，而不是等消息发完才跳过去。
   *
   * 只建房间是合法用法（比如先开会话、晚点再下指令），但那时这个 Member 没有
   * 任何 execution，Current Work 会是空的 —— 这正好是最容易被误解成 bug 的地方，
   * 所以这里用一条 notice 把它说清楚，而不是让人对着空面板猜。
   */
  async function createWork(input: WorkDraft) {
    const result = await api.createConversation({
      kind: 'work',
      title: input.title,
      // work conversation 只允许恰好一个成员（服务端 assertConversationKindShape）
      memberIds: [input.memberId],
      externalWorkRef: input.jiraKey ? { provider: 'jira', key: input.jiraKey } : null,
    });
    const created = result.conversation;
    setConversations((current) => [
      created,
      ...current.filter((item) => item.id !== created.id),
    ]);
    openConversation(created.id);
    setCreator(null);

    if (!input.instruction) {
      setNotice(
        'Work 房间建好了，但还没有下指令 —— 这个 Member 没有开始执行，Current Work 里暂时看不到它。在下面发第一条消息就会开始。',
      );
      return;
    }

    try {
      const sent = await api.sendMessage(created.id, {
        content: input.instruction,
        // 房间里只有它一个；显式点名是为了让「这条指令给谁」不依赖 roster 顺序
        targetMemberId: input.memberId,
        clientRequestId: newRequestId(),
      });
      // 必须乐观插入：房间是先切过去的，那条 GET /messages 在发消息**之前**就
      // 返回了（当时房间里还没有消息）。不插的话，用户得等 SSE 或下次刷新才能
      // 看见自己刚下的指令 —— 而这条指令正是他刚刚亲手打的字。
      setMessages((current) => mergeMessages(current, [sent.message]));
    } catch (e) {
      // 房间已经建好了，别把它一起丢掉：把指令放回输入框，重发一次即可
      setInput(input.instruction);
      setError(
        `Work 房间已建好，但第一条指令没有发出去：${
          e instanceof Error ? e.message : String(e)
        }。指令已放回输入框，再点一次 Send 就行。`,
      );
    }
  }

  async function createMember(input: { name: string; role: string }): Promise<void> {
    const result = await api.createMember({
      name: input.name,
      role: input.role,
      description: '',
      style: 'clear and concise',
    });
    setMembers((current) => [...current, result.member]);
    setCreator(null);
    // 新建只拿到 name + role，personality / system prompt / model 还是空的。
    // 直接开一个单聊等于让一个空壳人格开始干活，所以先把档案页打开。
    setEditingMemberId(result.member.id);
  }

  async function send() {
    const content = input.trim();
    if (!content || !conversationId) return;

    // 同一条内容的重试复用同一个幂等键：双击、或者上一次响应丢了再点一次，
    // 都不会在房间里留下两条一样的消息。
    const pending = pendingSendRef.current;
    const clientRequestId =
      pending && pending.content === content ? pending.clientRequestId : newRequestId();
    pendingSendRef.current = { clientRequestId, content };

    setBusy(true);
    setError(null);
    // 「发第一条消息才会开始」这条提示在消息真的发出去之后就不成立了
    setNotice(null);
    setInput('');
    try {
      const result = await api.sendMessage(conversationId, {
        content,
        // Everyone（''）必须传 undefined：让服务端 GroupDispatcher 决定唤醒谁。
        // 传一个具体 memberId = 点名，等价于一次 @mention。
        targetMemberId: recipientMemberId || undefined,
        clientRequestId,
      });
      // 发出去了才清掉：失败时保留，好让「再点一次」变成一次真正的重试。
      pendingSendRef.current = null;
      // 202：消息已落库。乐观插入，SSE 到达时会按 id 去重。
      setMessages((current) => mergeMessages(current, [result.message]));

      // 房间里没人认领这些 @ —— 服务端刻意不广播，如实告诉用户。
      if (result.unresolvedMentions.length > 0) {
        setError(
          `没有匹配到这些成员：${result.unresolvedMentions
            .map((mention) => `@${mention}`)
            .join(' ')}。消息没有派给任何人。`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setInput(content);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout style={{ height: '100%' }}>
      <ResizableSider>
        <TeamSidebar
          members={members}
          conversations={conversations}
          selectedConversationId={conversationId}
          onSelectConversation={openConversation}
          showNewMember={showNewMember}
          onToggleNewMember={() =>
            setCreator((current) => (current === 'member' ? null : 'member'))
          }
          onCreateMember={createMember}
          onCancelNewMember={() => setCreator(null)}
          onChatMember={(member) => void createDirect(member)}
          onEditMember={(member) => setEditingMemberId(member.id)}
          showGroupCreator={showGroupCreator}
          onToggleGroupCreator={() => setCreator('group')}
          onCancelGroupCreator={() => setCreator(null)}
          onCreateGroup={createGroup}
          showWorkCreator={showWorkCreator}
          onToggleWorkCreator={() => setCreator('work')}
          onCancelWorkCreator={() => setCreator(null)}
          onCreateWork={createWork}
        />
      </ResizableSider>

      <Layout>
        {!selectedConversation && (
          <Content style={{ display: 'grid', placeItems: 'center', color: '#999' }}>
            <Empty description="先选择一个 Team Member" />
          </Content>
        )}

        {selectedConversation && (
          <Content style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <ConversationHeader
              conversation={selectedConversation}
              allMembers={members}
              states={conversationStates}
              memberStatus={memberStatus}
              recipientMemberId={recipientMemberId}
              onRecipientChange={setRecipientMemberId}
              onToggleMute={(memberId) => void toggleMuted(memberId)}
              showMembers={showMemberManager}
              onToggleMembers={() => setShowMemberManager((value) => !value)}
              onConversationChanged={applyConversationChanged}
              // 子组件只处理单个 state；状态「消失」只有 SSE 会带来，
              // 统一在边界上包成同一种变化对象。
              onStateChanged={(state) =>
                applyStateChanged({ memberId: state.memberId, state })
              }
            />

            {activeExecutions.length > 0 && (
              <Space wrap style={{ padding: '8px 18px 0' }}>
                {activeExecutions.map((execution) => (
                  <Tag
                    key={execution.id}
                    color={execution.status === 'waiting_for_member' ? 'warning' : 'processing'}
                  >
                    {memberLabel(execution.memberId)} · {STATUS_LABEL[execution.status]}
                  </Tag>
                ))}
              </Space>
            )}

            <ConversationMessages
              conversation={selectedConversation}
              messages={messages}
              streaming={streaming}
              delegations={delegations}
              memberLabel={memberLabel}
              scrollRef={scrollRef}
            />

            {notice && (
              <Alert
                type="info"
                showIcon
                closable
                onClose={() => setNotice(null)}
                message={notice}
                style={{ margin: '0 18px' }}
              />
            )}

            {error && (
              <Alert
                type="error"
                showIcon
                closable
                onClose={() => setError(null)}
                message={error}
                style={{ margin: '0 18px' }}
              />
            )}

            <MessageComposer
              conversation={selectedConversation}
              value={input}
              onChange={setInput}
              onSend={() => void send()}
              busy={busy}
              disabled={!conversationId}
            />
          </Content>
        )}
      </Layout>

      {editingMember && (
        <MemberProfile
          member={editingMember}
          onSaved={applyMemberSaved}
          onClose={() => setEditingMemberId(null)}
        />
      )}
    </Layout>
  );
}
