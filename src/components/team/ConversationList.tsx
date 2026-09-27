import type { Conversation } from '../../lib/api';
import { CONVERSATION_STATUS_TEXT } from './constants';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  /** 按标题与成员名过滤；空串 = 不过滤。 */
  search?: string;
}

/**
 * 副标题：进度 + 成员 + Jira。
 */
function rowMeta(conversation: Conversation) {
  const names = conversation.members.map((m) => m.name).join(' · ');
  const key = conversation.externalWorkRef?.key;
  const progress =
    conversation.taskProgress.total > 0
      ? `${conversation.taskProgress.completed}/${conversation.taskProgress.total}`
      : null;
  return [progress, key, names].filter(Boolean).join(' · ');
}

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  blocked: 1,
  waiting_user: 2,
  intake: 3,
  completed: 4,
  cancelled: 5,
};

/**
 * 工作区列表：只有一个 Tasks 分区，按状态排序。
 */
export function ConversationList({ conversations, selectedId, onSelect, search }: ConversationListProps) {
  const query = (search ?? '').trim().toLowerCase();
  const visible = query
    ? conversations.filter((conversation) => {
        const haystack = [
          conversation.title,
          ...conversation.members.map((m) => `${m.name} ${m.handle} ${m.role}`),
          conversation.externalWorkRef?.key ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      })
    : conversations;

  const tasks = visible
    .filter((c) => c.kind === 'task')
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  return (
    <div>
      {visible.length === 0 && (
        <div style={{ color: '#999', fontSize: 12, padding: '4px 0 8px' }}>
          {query ? '没有匹配的工作。' : '还没有工作。'}
        </div>
      )}
      {tasks.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="conversation-group-title">Tasks</div>
          {tasks.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversation-item${conversation.id === selectedId ? ' selected' : ''}`}
              onClick={() => onSelect(conversation.id)}
            >
              <div className="conversation-item-title">
                <span className="conversation-item-name">{conversation.title}</span>
                <span className="conversation-item-badge">
                  {CONVERSATION_STATUS_TEXT[conversation.status] ?? conversation.status}
                </span>
              </div>
              <div className="conversation-item-meta">{rowMeta(conversation)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
