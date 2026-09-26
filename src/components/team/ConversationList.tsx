import { Button, List, Space, Tag } from 'antd';
import { ProjectOutlined, TeamOutlined } from '@ant-design/icons';
import type { Conversation, Member } from '../../lib/api';
import { GroupCreator } from './GroupCreator';
import { WorkCreator, type WorkDraft } from './WorkCreator';
import { isMemberDm } from './constants';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  members: Member[];
  /** 按标题与成员名过滤；空串 = 不过滤。 */
  search?: string;
  showCreator: boolean;
  onToggleCreator: () => void;
  onCancelCreator: () => void;
  onCreateGroup: (input: {
    title: string;
    memberIds: string[];
    externalWorkRef?: { provider?: 'jira'; key: string } | null;
  }) => Promise<void>;

  showWorkCreator: boolean;
  onToggleWorkCreator: () => void;
  onCancelWorkCreator: () => void;
  onCreateWork: (input: WorkDraft) => Promise<void>;
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

/**
 * Conversations 分区。
 *
 * 两个创建入口并排/堆叠在这里，而不是把 Work 塞进 Current Work：Current Work 是
 * 「现在谁在跑」，是**结果**；Work 是「给谁挂一张工单」，是**输入**。把入口放进
 * 结果面板会让人以为「建一个 Work 就会出现在 Current Work 里」—— 而它不会，
 * 除非那个 Member 真的开始执行。
 *
 * 没有单独的「New Direct」：单聊入口就是 Members 里每一行的 Chat 按钮 ——
 * 它复用已存在的 direct 房间（找不到才建），比在这里再放一个需要先选人的
 * 入口更不容易建出重复房间。
 */
export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  members,
  search,
  showCreator,
  onToggleCreator,
  onCancelCreator,
  onCreateGroup,
  showWorkCreator,
  onToggleWorkCreator,
  onCancelWorkCreator,
  onCreateWork,
}: ConversationListProps) {
  // 三组是会话的三种用途，不是过滤器：讨论 / 工作 / 单聊各归各的，
  // 成员管理、Current Work、Schedules 都不在这里。
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
    { title: 'Team discussions', items: visible.filter((c) => c.kind === 'group') },
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

      {showCreator ? (
        <GroupCreator members={members} onCreate={onCreateGroup} onCancel={onCancelCreator} />
      ) : showWorkCreator ? (
        <WorkCreator members={members} onCreate={onCreateWork} onCancel={onCancelWorkCreator} />
      ) : (
        // 竖排而不是并排：左栏最窄 240px，两个带图标的按钮并排会把
        // 「New Team」折成两行。竖排在任何宽度下都是稳定的一行一个。
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={8}>
          <Button type="dashed" block size="small" icon={<TeamOutlined />} onClick={onToggleCreator}>
            New Team
          </Button>
          <Button
            type="dashed"
            block
            size="small"
            icon={<ProjectOutlined />}
            onClick={onToggleWorkCreator}
          >
            New Work
          </Button>
        </Space>
      )}
    </div>
  );
}
