import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, List, Tag } from 'antd';
import { MessageOutlined, SettingOutlined, UserAddOutlined } from '@ant-design/icons';
import { api, type Member, type TeamPresence } from '../../lib/api';
import { NewMemberForm } from './NewMemberForm';

interface MemberListProps {
  members: Member[];
  showNewMember: boolean;
  onToggleNewMember: () => void;
  onCreateMember: (input: { name: string; role: string }) => Promise<void>;
  onCancelNewMember: () => void;
  onChat: (member: Member) => void;
  onEdit: (member: Member) => void;
}

const AVAILABILITY_DOT: Record<string, 'success' | 'warning' | 'default' | 'error'> = {
  available: 'success',
  away: 'warning',
  paused: 'default',
  busy: 'processing' as unknown as 'success',
  offline: 'error',
};

/**
 * 侧栏的 Team Members。
 *
 * 每一行是两个独立动作：
 *   Chat —— 打开/复用这个 Member 的 1:1 房间
 *   Edit —— 打开档案页（人格 / 记忆 / skill）
 *
 * 合成一个 handler 会把「改一下它的 system prompt」变成「顺手开了个新会话」。
 */
export function MemberList({
  members,
  showNewMember,
  onToggleNewMember,
  onCreateMember,
  onCancelNewMember,
  onChat,
  onEdit,
}: MemberListProps) {
  // Team presence：只读显示，不替换房间内的 working/muted。
  const [presence, setPresence] = useState<Record<string, TeamPresence>>({});
  useEffect(() => {
    api
      .listPresence()
      .then((result) => {
        const map: Record<string, TeamPresence> = {};
        for (const item of result.presence) {
          if (item.kind === 'agent') map[item.principalId] = item;
        }
        setPresence(map);
      })
      .catch(() => {});
  }, [members.length]);

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Button
          type="dashed"
          block
          size="small"
          icon={<UserAddOutlined />}
          onClick={onToggleNewMember}
        >
          {showNewMember ? '取消' : '新建 Member'}
        </Button>
      </div>

      {showNewMember && <NewMemberForm onCreate={onCreateMember} onCancel={onCancelNewMember} />}

      <List
        size="small"
        dataSource={members}
        locale={{ emptyText: '还没有 Member，点上面创建一个。' }}
        renderItem={(member) => {
          const availability = presence[member.id]?.availability ?? 'available';
          return (
            <List.Item
              actions={[
                <Button
                  key="chat"
                  type="link"
                  size="small"
                  icon={<MessageOutlined />}
                  onClick={() => onChat(member)}
                >
                  Chat
                </Button>,
                <Button
                  key="edit"
                  type="link"
                  size="small"
                  icon={<SettingOutlined />}
                  onClick={() => onEdit(member)}
                >
                  Edit
                </Button>,
              ]}
            >
              <List.Item.Meta
                avatar={
                  <Badge
                    dot
                    status={AVAILABILITY_DOT[availability] ?? 'success'}
                    title={availability}
                  >
                    <Avatar>{member.name.slice(0, 1).toUpperCase()}</Avatar>
                  </Badge>
                }
                title={
                  <>
                    {member.name}{' '}
                    <Tag color={availability === 'paused' ? 'default' : 'success'}>
                      {availability}
                    </Tag>
                    {member.status !== 'active' && <Tag color="error">archived</Tag>}
                  </>
                }
                description={`@${member.handle} · ${member.role}`}
              />
            </List.Item>
          );
        }}
      />
    </div>
  );
}
