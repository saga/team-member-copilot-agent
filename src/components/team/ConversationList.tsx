import { List, Tag } from 'antd';
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
 * Member 之间的私聊和用户单聊共用 `kind = 'direct'`，只显示 kind 会让两者
 * 在列表里长得一模一样 —— 一个是「我跟 Alice 说话」，一个是「Alice 和 Bob
 * 在说话」，用户一眼要能分清。
 */
function conversationTag(conversation: Conversation) {
  if (isMemberDm(conversation)) return <Tag color="purple">private</Tag>;
  if (conversation.kind === 'group') return <Tag color="blue">discussion</Tag>;
  if (conversation.kind === 'work') return <Tag color="gold">work</Tag>;
  return <Tag>direct</Tag>;
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

  function renderRow(conversation: Conversation) {
    return (
      <List.Item
        onClick={() => onSelect(conversation.id)}
        style={{
          cursor: 'pointer',
          background: conversation.id === selectedId ? '#e6f4ff' : undefined,
          borderRadius: 8,
          padding: '8px 12px',
        }}
      >
        <List.Item.Meta
          title={conversation.title}
          description={
            <>
              {conversationTag(conversation)}{' '}
              {conversation.members.map((m) => m.name).join(' · ')}
            </>
          }
        />
      </List.Item>
    );
  }

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
            <div key={group.title} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 11, color: '#999', padding: '6px 4px 2px' }}>
                {group.title}
              </div>
              <List size="small" dataSource={group.items} renderItem={renderRow} />
            </div>
          ),
      )}
    </div>
  );
}
