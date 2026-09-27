import { useState } from 'react';
import { Avatar, Badge, Button, Space, Tag, Tooltip, Typography } from 'antd';
import { PaperClipOutlined, TeamOutlined } from '@ant-design/icons';
import type { Conversation, ConversationMemberState, Member } from '../../lib/api';
import { MemberManager } from './MemberManager';
import { isMemberDm, type MemberStatusLookup } from './constants';

interface ConversationHeaderProps {
  conversation: Conversation;
  /** 全部可用成员，供 Participants 抽屉挑「还没进房间的人」。 */
  allMembers: Member[];
  states: Record<string, ConversationMemberState>;
  memberStatus: MemberStatusLookup;
  /** 这个会话里共享了多少份文件，显示在 Shared 按钮上。 */
  fileCount: number;
  onConversationChanged: (conversation: Conversation) => void;
  onStateChanged: (state: ConversationMemberState) => void;
  onOpenFiles: () => void;
}

/**
 * 工作区头：标题 / 状态 / Lead / Jira / 成员。
 *
 * 不再显示「对话类型」：用户界面里只有 Task 工作区。
 */
export function ConversationHeader({
  conversation,
  allMembers,
  states,
  memberStatus,
  fileCount,
  onConversationChanged,
  onStateChanged,
  onOpenFiles,
  memberLabel,
}: ConversationHeaderProps & { memberLabel: (id: string) => string }) {
  const isDm = isMemberDm(conversation);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const leadName = conversation.leadMemberId ? memberLabel(conversation.leadMemberId) : null;

  return (
    <>
      <div className="conversation-header">
        <div className="conversation-header-main">
          <Space size={8} align="center">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {conversation.title}
            </Typography.Title>

            {!isDm && <Tag color={conversation.status === 'completed' ? 'success' : 'processing'}>{conversation.status}</Tag>}

            {conversation.externalWorkRef?.key && (
              <Tag color="cyan">{conversation.externalWorkRef.key}</Tag>
            )}
          </Space>

          <Typography.Text type="secondary">
            {isDm
              ? conversation.members.map((member) => member.name).join(' ↔ ')
              : [
                  leadName ? `Lead ${leadName}` : null,
                  `${conversation.members.length} members`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Typography.Text>
        </div>

        <Space>
          <Avatar.Group max={{ count: 5 }}>
            {conversation.members.map((member) => {
              const status = memberStatus(member.id);

              const dot =
                status.className === 'working'
                  ? 'processing'
                  : status.className === 'muted'
                    ? 'default'
                    : 'success';

              return (
                <Tooltip key={member.id} title={`${member.name} · ${status.label}`}>
                  <Badge dot status={dot}>
                    <Avatar>{member.name.slice(0, 1).toUpperCase()}</Avatar>
                  </Badge>
                </Tooltip>
              );
            })}
          </Avatar.Group>

          <Button icon={<PaperClipOutlined />} onClick={onOpenFiles}>
            Shared{fileCount > 0 ? ` ${fileCount}` : ''}
          </Button>

          {!isDm && (
            <Button icon={<TeamOutlined />} onClick={() => setParticipantsOpen(true)}>
              Participants
            </Button>
          )}
        </Space>
      </div>

      {!isDm && (
        <MemberManager
          open={participantsOpen}
          conversation={conversation}
          allMembers={allMembers}
          states={states}
          onConversationChanged={onConversationChanged}
          onStateChanged={onStateChanged}
          onClose={() => setParticipantsOpen(false)}
        />
      )}
    </>
  );
}
