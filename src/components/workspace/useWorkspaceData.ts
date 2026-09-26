import { useEffect, useMemo, useRef, useState } from 'react';
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
} from '../../lib/api';
import type { DelegationLog, StreamState } from '../team/ConversationMessages';
import { EVERYONE, type MemberStatus, type MemberStatusLookup } from '../team/constants';

/** 还在推进中的 execution 状态；到了其它状态就说明这条 execution 已经收尾。 */
export const ACTIVE_STATUSES: ExecutionStatus[] = ['queued', 'running', 'waiting_for_member'];

export const STATUS_LABEL: Record<ExecutionStatus, string> = {
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
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `web-${crypto.randomUUID()}`;
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 按 id 去重、按 messageSequence 排序地合并消息。
 *
 * 三条来源会同时写 messages：SSE、GET /messages、POST /messages 的乐观插入。
 * 任何一个用「整体替换」或「无脑 append」都会在慢 API / 网络抖动 / SSE 重连时
 * 丢消息或乱序，所以统一走这个收敛函数。
 */
export function mergeMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.messageSequence - b.messageSequence);
}

function parseEvent<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

export interface WorkspaceData {
  members: Member[];
  conversations: Conversation[];
  conversationId: string | null;
  selectedConversation: Conversation | null;
  messages: ConversationMessage[];
  streaming: Record<string, StreamState>;
  delegations: DelegationLog[];
  executions: Record<string, ExecutionRecord>;
  conversationStates: Record<string, ConversationMemberState>;
  recipientMemberId: string;
  setRecipientMemberId: (memberId: string) => void;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  memberById: Map<string, Member>;
  memberLabel: (id: string) => string;
  activeExecutions: ExecutionRecord[];
  memberStatus: MemberStatusLookup;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  refresh: () => Promise<void>;
  openConversation: (id: string) => void;
  /** 把刚建好的会话顶到列表前面（去重）。 */
  upsertConversation: (conversation: Conversation) => void;
  addMember: (member: Member) => void;
  appendMessages: (incoming: ConversationMessage[]) => void;
  applyStateChanged: (change: ConversationMemberStateChange) => void;
  applyConversationChanged: (next: Conversation) => void;
  applyMemberSaved: (next: Member) => void;
}

/**
 * Workspace 的数据层：成员 / 会话 / 消息 / SSE / execution / 房间状态。
 *
 * 只管「现在是什么样」，不管「用户想干什么」—— 后者在 useWorkspaceActions 里。
 * error 归调用方（Workspace 的红色 Alert），这里只通过 onError 回调报上去；
 * notice 归这里（它和选房间绑在一起：切房间就失效）。
 */
export function useWorkspaceData({ onError }: { onError: (message: string | null) => void }): WorkspaceData {
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
  /**
   * 中性提示（蓝色 Alert）。和 error 分开是因为语义不同：error 是「刚才那件事
   * 失败了」，notice 是「事情做成了，但你得知道接下来会发生什么」——
   * 比如「Work 房间建好了，但还没有下指令，所以它还没开始跑」。
   * 用红色报这个会让人以为建房间失败了。
   */
  const [notice, setNotice] = useState<string | null>(null);

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
   * 在排队 / 在跑」；两者都没有但有活跃 execution 时显示成 working，免得调度器
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
    void refresh().catch((e: unknown) => onError(String(e)));
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
    onError(null);

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
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));

    const source = new EventSource(api.eventsUrl(activeId));

    // 服务端在每次连接（含自动重连）建立后都会发一条 connected，
    // 说明断线期间的事件已经按 Last-Event-ID 补发完毕，可以清掉旧的错误提示。
    source.addEventListener('connected', () => {
      onError(null);
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

      if (data.status === 'failed' && data.error) onError(data.error);
      if (data.status === 'interrupted') {
        onError('有 execution 因服务重启而中断，未被自动重跑（避免重复执行）。');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function upsertConversation(conversation: Conversation) {
    setConversations((current) => [
      conversation,
      ...current.filter((item) => item.id !== conversation.id),
    ]);
  }

  function addMember(member: Member) {
    setMembers((current) => [...current, member]);
  }

  function appendMessages(incoming: ConversationMessage[]) {
    setMessages((current) => mergeMessages(current, incoming));
  }

  return {
    members,
    conversations,
    conversationId,
    selectedConversation,
    messages,
    streaming,
    delegations,
    executions,
    conversationStates,
    recipientMemberId,
    setRecipientMemberId,
    notice,
    setNotice,
    memberById,
    memberLabel,
    activeExecutions,
    memberStatus,
    scrollRef,
    refresh,
    openConversation,
    upsertConversation,
    addMember,
    appendMessages,
    applyStateChanged,
    applyConversationChanged,
    applyMemberSaved,
  };
}
