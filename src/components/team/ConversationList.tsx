import type { Conversation } from '../../lib/api';
import { isMemberDm } from './constants';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  /** 按标题与成员名过滤；空串 = 不过滤。 */
  search?: string;
}

/**
 * 副标题。
 *
 * 分区头（Discussions / Work / Direct）已经说明了会话类型，行内不再重复一个
 * 类型 Tag —— 同一个信息出现两次时，大的那个只会和标题抢视觉。唯一保留的
 * 标记是「成员私聊」：direct 分区里既有「我跟 TA」也有「他们俩」，这个区别
 * 分区头表达不了，而它决定用户能不能发言。
 */
function rowMeta(conversation: Conversation) {
  const names = conversation.members.map((m) => m.name).join(' · ');
  const key = conversation.externalWorkRef?.key;
  return key ? `${key} · ${names}` : names;
}

/**
 * Conversations 分区：Discussions / Work / Direct。
 *
 * 三组是会话的三种用途，不是过滤器。创建入口不在这里 —— New discussion /
 * New work 是 Sidebar 底部的按钮，打开挂在 Workspace 根部的 Modal；
 * 单聊入口是 Team 管理面每一行的 Open chat。
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

  const groups: Array<{ title: string; items: Conversation[] }> = [
    { title: 'Discussions', items: visible.filter((c) => c.kind === 'group') },
    { title: 'Work', items: visible.filter((c) => c.kind === 'work') },
    { title: 'Direct', items: visible.filter((c) => c.kind === 'direct') },
  ];

  return (
    <div>
      {visible.length === 0 && (
        <div style={{ color: '#999', fontSize: 12, padding: '4px 0 8px' }}>
          {query ? '没有匹配的会话。' : '还没有会话。'}
        </div>
      )}
      {groups.map(
        (group) =>
          group.items.length > 0 && (
            <div key={group.title} style={{ marginBottom: 8 }}>
              <div className="conversation-group-title">{group.title}</div>
              {group.items.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`conversation-item${conversation.id === selectedId ? ' selected' : ''}`}
                  onClick={() => onSelect(conversation.id)}
                >
                  <div className="conversation-item-title">
                    <span className="conversation-item-name">{conversation.title}</span>
                    {isMemberDm(conversation) && (
                      <span className="conversation-item-badge">成员私聊</span>
                    )}
                  </div>
                  <div className="conversation-item-meta">{rowMeta(conversation)}</div>
                </div>
              ))}
            </div>
          ),
      )}
    </div>
  );
}
