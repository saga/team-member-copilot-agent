import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Tag, Typography } from 'antd';
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
 *
 * 布局不用 antd List：它的 actions 与 Meta 在窄侧栏里互相挤压，
 * 长名字/长 role 会被折成一行一个词。这里用显式 flex + minWidth:0 + ellipsis，
 * 保证任何宽度下都是「头像 | 三行文本」的稳定结构。
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

      {members.length === 0 && (
        <Typography.Text type="secondary">还没有 Member，点上面创建一个。</Typography.Text>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {members.map((member) => {
          const availability = presence[member.id]?.availability ?? 'available';
          return (
            <div
              key={member.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '8px 0',
                borderBottom: '1px solid #f0f0f0',
              }}
            >
              <Badge dot status={AVAILABILITY_DOT[availability] ?? 'success'} title={availability}>
                <Avatar style={{ flexShrink: 0 }}>{member.name.slice(0, 1).toUpperCase()}</Avatar>
              </Badge>

              {/* minWidth: 0 是关键：flex 子项默认 min-width:auto，ellipsis 不会生效 */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>
                    {member.name}
                  </Typography.Text>
                  <Tag
                    color={availability === 'paused' ? 'default' : 'success'}
                    style={{ flexShrink: 0, marginInlineEnd: 0 }}
                  >
                    {availability}
                  </Tag>
                  {member.status !== 'active' && <Tag color="error">archived</Tag>}
                </div>

                <Typography.Text type="secondary" ellipsis style={{ display: 'block' }}>
                  @{member.handle} · {member.role}
                </Typography.Text>

                <div style={{ marginTop: 2 }}>
                  <Button
                    type="link"
                    size="small"
                    icon={<MessageOutlined />}
                    onClick={() => onChat(member)}
                  >
                    Chat
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    icon={<SettingOutlined />}
                    onClick={() => onEdit(member)}
                  >
                    Edit
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
