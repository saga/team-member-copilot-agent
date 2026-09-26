import { Button, List, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { Conversation, Member } from '../../lib/api';
import { GroupCreator } from './GroupCreator';
import { isMemberDm } from './constants';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  members: Member[];
  showCreator: boolean;
  onToggleCreator: () => void;
  onCancelCreator: () => void;
  onCreateGroup: (input: {
    title: string;
    memberIds: string[];
    externalWorkRef?: { provider?: 'jira'; key: string } | null;
  }) => Promise<void>;
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
  if (conversation.kind === 'group') return <Tag color="blue">group · {conversation.members.length}</Tag>;
  if (conversation.kind === 'work') return <Tag color="gold">work</Tag>;
  return <Tag>direct</Tag>;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  members,
  showCreator,
  onToggleCreator,
  onCancelCreator,
  onCreateGroup,
}: ConversationListProps) {
  return (
    <div>
      <List
        size="small"
        dataSource={conversations}
        locale={{ emptyText: '还没有会话。' }}
        renderItem={(conversation) => (
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
        )}
      />

      {showCreator ? (
        <GroupCreator members={members} onCreate={onCreateGroup} onCancel={onCancelCreator} />
      ) : (
        <Button
          type="dashed"
          block
          size="small"
          icon={<PlusOutlined />}
          onClick={onToggleCreator}
          style={{ marginTop: 8 }}
        >
          New Team
        </Button>
      )}
    </div>
  );
}
