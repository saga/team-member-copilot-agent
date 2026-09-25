import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Conversation,
  type ConversationMemberState,
  type ConversationMessage,
  type DelegationEvent,
  type DeltaEvent,
  type ExecutionRecord,
  type ExecutionStatus,
  type Member,
} from '../lib/api';
import { GroupCreator } from './team/GroupCreator';
import { GroupMemberManager } from './team/GroupMemberManager';

interface StreamState {
  executionId: string;
  memberId: string;
  content: string;
}

interface DelegationLog {
  executionId: string;
  fromMemberId: string;
  targetMemberId: string;
  task: string;
  status: 'running' | 'done' | 'error';
}

/** 还在推进中的 execution 状态；到了其它状态就说明这条 execution 已经收尾。 */
const ACTIVE_STATUSES: ExecutionStatus[] = ['queued', 'running', 'waiting_for_member'];

/** 收件人下拉里代表「不点名，交给 GroupDispatcher 决定唤醒谁」的哨兵值。 */
const EVERYONE = '';

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  queued: '排队中',
  running: '执行中',
  waiting_for_member: '等待其他 Member',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

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
  const [showNewMember, setShowNewMember] = useState(false);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('');
  const [showGroupCreator, setShowGroupCreator] = useState(false);
  const [showMemberManager, setShowMemberManager] = useState(false);

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
   * 成员在房间里的状态，用来渲染 ●idle / ●working / 🔇muted。
   *
   * muted 以服务端为准（它是 dispatcher 的真实输入）；wakeStatus 只覆盖
   * 「有唤醒在排队 / 在跑」；两者都没有但有活跃 execution 时兜底成 working，
   * 免得调度器状态和 UI 出现一瞬不一致。
   */
  function memberStatus(memberId: string): { className: string; label: string } {
    const state = conversationStates[memberId];
    if (state?.muted) return { className: 'muted', label: '🔇 muted' };

    const wake = state?.wakeStatus;
    if (wake === 'running' || wake === 'queued') return { className: 'working', label: '● working' };

    if (activeExecutions.some((execution) => execution.memberId === memberId)) {
      return { className: 'working', label: '● working' };
    }
    return { className: 'idle', label: '● idle' };
  }

  function applyStateChanged(state: ConversationMemberState) {
    setConversationStates((current) => ({ ...current, [state.memberId]: state }));
  }

  function applyConversationChanged(next: Conversation) {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === next.id ? next : conversation)),
    );
  }

  async function toggleMuted(memberId: string): Promise<void> {
    if (!conversationId) return;
    const muted = !conversationStates[memberId]?.muted;
    try {
      const result = await api.setMemberMuted(conversationId, memberId, muted);
      applyStateChanged(result.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
   * 拉房间里每个 Member 的房间状态（wakeStatus / muted）。
   *
   * 依赖 `messages.length` 而不是 `executions`：wake_status 由服务端调度器在
   * queued → running → idle 之间推进，而每条消息完成时都会新增一条 message
   * （skip 除外），这个节奏足够跟上手感，又不会每条 token 增量都去戳一次接口。
   * 静音切换走 local patch，不依赖这次刷新。
   */
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;
    void api
      .listConversationState(conversationId)
      .then((result) => {
        if (cancelled) return;
        setConversationStates(
          Object.fromEntries(result.states.map((state) => [state.memberId, state])),
        );
      })
      .catch(() => {
        // 状态只是展示增强，拿不到不该打断聊天
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, messages.length]);

  // 新消息 / 新增量 / runtime 状态变化时贴底
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight });
  }, [messages, streaming, delegations, executions]);

  async function createDirect(member: Member) {
    const existing = conversations.find(
      (item) => item.kind === 'direct' && item.members.some((m) => m.id === member.id),
    );
    if (existing) {
      setConversationId(existing.id);
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
    setConversationId(result.conversation.id);
  }

  async function createGroup(input: { title: string; memberIds: string[] }) {
    try {
      const result = await api.createConversation({
        kind: 'group',
        title: input.title,
        memberIds: input.memberIds,
      });
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      setConversationId(result.conversation.id);
      setShowGroupCreator(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function createMember() {
    const name = newMemberName.trim();
    const role = newMemberRole.trim();
    if (!name || !role) return;

    const result = await api.createMember({
      name,
      role,
      description: '',
      style: 'clear and concise',
      toolProfile: 'safe',
    });
    setMembers((current) => [...current, result.member]);
    setNewMemberName('');
    setNewMemberRole('');
    setShowNewMember(false);
    await createDirect(result.member);
  }

  async function send() {
    const content = input.trim();
    if (!content || !conversationId) return;

    setBusy(true);
    setError(null);
    setInput('');
    try {
      const result = await api.sendMessage(conversationId, {
        content,
        // Everyone（''）必须传 undefined：让服务端 GroupDispatcher 决定唤醒谁。
        // 传一个具体 memberId = 点名，等价于一次 @mention。
        targetMemberId: recipientMemberId || undefined,
      });
      // 202：消息已落库。乐观插入，SSE 到达时会按 id 去重。
      setMessages((current) => mergeMessages(current, [result.message]));

      // 房间里没人认领这些 @ —— 服务端刻意不广播，如实告诉用户。
      if (result.unresolvedMentions.length > 0) {
        setError(`没有匹配到这些成员：${result.unresolvedMentions.map((m) => `@${m}`).join(' ')}。消息没有派给任何人。`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setInput(content);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="team-layout">
      <aside className="team-sidebar">
        <div className="sidebar-section">
          <div className="sidebar-title">
            Team Members
            <button
              type="button"
              onClick={() => setShowNewMember((value) => !value)}
              aria-label="新建 Member"
            >
              +
            </button>
          </div>

          {showNewMember && (
            <div className="new-member">
              <input
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                placeholder="Member name"
              />
              <input
                value={newMemberRole}
                onChange={(e) => setNewMemberRole(e.target.value)}
                placeholder="Role"
              />
              <button type="button" onClick={() => void createMember()}>
                Create
              </button>
            </div>
          )}

          {members.length === 0 && <p className="sidebar-hint">还没有 Member，点 + 创建一个。</p>}

          {members.map((member) => (
            <button
              key={member.id}
              type="button"
              className="member-row"
              onClick={() => void createDirect(member)}
            >
              <strong>{member.name}</strong>
              <span>{member.role}</span>
            </button>
          ))}

          {showGroupCreator ? (
            <GroupCreator
              members={members}
              onCreate={createGroup}
              onCancel={() => setShowGroupCreator(false)}
            />
          ) : (
            <button
              type="button"
              className="group-button"
              onClick={() => {
                setShowNewMember(false);
                setShowGroupCreator(true);
              }}
            >
              + New Team
            </button>
          )}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-title">Conversations</div>
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={
                conversation.id === conversationId ? 'conversation-row selected' : 'conversation-row'
              }
              onClick={() => setConversationId(conversation.id)}
            >
              <strong>{conversation.title}</strong>
              <span>{conversation.kind}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="team-main">
        {!selectedConversation && <div className="empty-state">先选择一个 Team Member。</div>}

        {selectedConversation && (
          <>
            <header className="conversation-header">
              <div>
                <h2>{selectedConversation.title}</h2>
                <div className="member-chips">
                  {selectedConversation.members.map((member) => {
                    const status = memberStatus(member.id);
                    const className = `member-chip ${status.className}`;

                    // 静音只对 group 有意义：direct / work 房间的 dispatcher 路径
                    // 不看 muted，点它只会造成「UI 说静音了、其实照样回」的错觉。
                    if (selectedConversation.kind !== 'group') {
                      return (
                        <span key={member.id} className={className}>
                          <span className="member-chip-status">{status.label}</span>
                          @{member.handle}
                        </span>
                      );
                    }

                    return (
                      <button
                        key={member.id}
                        type="button"
                        className={className}
                        onClick={() => void toggleMuted(member.id)}
                        title={`${member.name} · ${status.label}（点击${status.className === 'muted' ? '取消静音' : '静音'}）`}
                      >
                        <span className="member-chip-status">{status.label}</span>
                        @{member.handle}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="header-actions">
                {selectedConversation.kind === 'group' && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setShowMemberManager((value) => !value)}
                  >
                    Members
                  </button>
                )}

                {selectedConversation.kind === 'group' ? (
                  <select
                    className="recipient-select"
                    value={recipientMemberId}
                    onChange={(e) => setRecipientMemberId(e.target.value)}
                    aria-label="选择这条消息的收件人"
                  >
                    <option value={EVERYONE}>Everyone</option>
                    {selectedConversation.members
                      .filter((member) => member.status === 'active')
                      .map((member) => (
                        <option key={member.id} value={member.id}>
                          @{member.handle}
                        </option>
                      ))}
                  </select>
                ) : (
                  <span className="recipient-static">
                    {selectedConversation.members[0]
                      ? `To ${selectedConversation.members[0].name}`
                      : 'No member'}
                  </span>
                )}
              </div>
            </header>

            {showMemberManager && selectedConversation.kind === 'group' && (
              <GroupMemberManager
                conversation={selectedConversation}
                allMembers={members}
                states={conversationStates}
                onConversationChanged={applyConversationChanged}
                onStateChanged={applyStateChanged}
                onClose={() => setShowMemberManager(false)}
              />
            )}

            {activeExecutions.length > 0 && (
              <div className="runtime-strip">
                {activeExecutions.map((execution) => (
                  <span key={execution.id} className={`runtime-chip ${execution.status}`}>
                    <span className="runtime-dot" />
                    {memberLabel(execution.memberId)} · {STATUS_LABEL[execution.status]}
                  </span>
                ))}
              </div>
            )}

            <div className="conversation-messages" ref={scrollRef}>
              {messages.length === 0 && (
                <p className="hint">
                  {selectedConversation.kind === 'group'
                    ? '收件人保持 Everyone 时不点名，消息会派给房间里所有可用成员，各自判断要不要发言（可以沉默）；要指名就选具体成员，或在正文里 @handle。'
                    : `${selectedConversation.members[0]?.name ?? '该成员'} 会用你自己的记忆、人格和工作区回答；它也可以用 ask_member 把子任务委派给其他成员。`}
                </p>
              )}

              {messages.map((message) => (
                <div key={message.id} className={`conversation-message ${message.senderType}`}>
                  <div className="message-author">
                    {message.senderType === 'member'
                      ? memberLabel(message.senderId)
                      : message.senderType === 'user'
                        ? 'You'
                        : 'System'}
                  </div>
                  <pre>{message.content}</pre>
                </div>
              ))}

              {Object.values(streaming).map((stream) => (
                <div
                  key={stream.executionId}
                  className="conversation-message member streaming"
                  data-execution={stream.executionId}
                >
                  <div className="message-author">{memberLabel(stream.memberId)}</div>
                  <pre>{stream.content || '▍'}</pre>
                </div>
              ))}

              {delegations.length > 0 && (
                <div className="delegation-log">
                  {delegations.map((item) => (
                    <div key={item.executionId} className={`delegation-row ${item.status}`}>
                      <span className="delegation-arrow">
                        {memberLabel(item.fromMemberId)} → {memberLabel(item.targetMemberId)}
                      </span>
                      <span className="delegation-task">{item.task}</span>
                      <span className="delegation-status">
                        {item.status === 'running' ? '进行中' : item.status === 'done' ? '完成' : '失败'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <div className="error">{error}</div>}

            <div className="conversation-composer">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  selectedConversation.kind === 'group'
                    ? '对团队说点什么…（Enter 发送 / Shift+Enter 换行；@handle 指名，或直接 @ 某人）'
                    : `给 ${selectedConversation.members[0]?.name ?? '成员'} 发消息…（Enter 发送 / Shift+Enter 换行）`
                }
                disabled={!conversationId}
              />
              <button type="button" onClick={() => void send()} disabled={busy || !input.trim()}>
                Send
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
