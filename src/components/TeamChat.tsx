import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Conversation,
  type ConversationMessage,
  type DelegationEvent,
  type DeltaEvent,
  type ExecutionRecord,
  type Member,
} from '../lib/api';

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

function parseEvent<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

export function TeamChat() {
  const [members, setMembers] = useState<Member[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streaming, setStreaming] = useState<Record<string, StreamState>>({});
  const [delegations, setDelegations] = useState<DelegationLog[]>([]);
  const [targetMemberId, setTargetMemberId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewMember, setShowNewMember] = useState(false);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('');

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
      return;
    }

    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    const activeId = conversationId;

    setMessages([]);
    setStreaming({});
    setDelegations([]);
    setError(null);
    setTargetMemberId(conversation?.defaultMemberId ?? conversation?.members[0]?.id ?? '');

    void api
      .listMessages(activeId)
      .then((result) => {
        setMessages(result.messages);
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

    source.addEventListener('message.created', (event) => {
      const message = parseEvent<ConversationMessage>(event as MessageEvent);
      if (!message) return;

      setMessages((current) =>
        current.some((item) => item.id === message.id) ? current : [...current, message],
      );

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
      if (data.status === 'failed' && data.error) setError(data.error);
      if (data.status === 'failed' || data.status === 'cancelled') {
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

  // 新消息 / 新增量到达时贴底
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight });
  }, [messages, streaming, delegations]);

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
      defaultMemberId: member.id,
    });
    setConversations((current) => [
      result.conversation,
      ...current.filter((item) => item.id !== result.conversation.id),
    ]);
    setConversationId(result.conversation.id);
  }

  async function createGroup() {
    if (members.length < 2) {
      setError('至少需要 2 个 Member 才能创建 Team Conversation。');
      return;
    }
    const selected = members.slice(0, 3);
    const result = await api.createConversation({
      kind: 'group',
      title: 'Team Discussion',
      memberIds: selected.map((member) => member.id),
      defaultMemberId: selected[0].id,
    });
    setConversations((current) => [
      result.conversation,
      ...current.filter((item) => item.id !== result.conversation.id),
    ]);
    setConversationId(result.conversation.id);
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
        targetMemberId: targetMemberId || undefined,
      });
      // 202：消息已落库。乐观插入，SSE 到达时会按 id 去重。
      setMessages((current) =>
        current.some((item) => item.id === result.message.id)
          ? current
          : [...current, result.message],
      );
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

          <button type="button" className="group-button" onClick={() => void createGroup()}>
            + New Team Conversation
          </button>
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
                  {selectedConversation.members.map((member) => (
                    <span key={member.id} className="member-chip">
                      @{member.handle}
                    </span>
                  ))}
                </div>
              </div>
              <select
                value={targetMemberId}
                onChange={(e) => setTargetMemberId(e.target.value)}
                aria-label="选择要回应的 Member"
              >
                {selectedConversation.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    @{member.handle}
                  </option>
                ))}
              </select>
            </header>

            <div className="conversation-messages" ref={scrollRef}>
              {messages.length === 0 && (
                <p className="hint">
                  发一条消息，它会被路由到上面选中的 Member；该 Member 也可以用 ask_member 把子任务
                  委派给其他 Member。
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
                placeholder="Message the team... (Enter 发送 / Shift+Enter 换行)"
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
