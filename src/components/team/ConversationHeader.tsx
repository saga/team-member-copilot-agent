import { useState } from 'react';
import { Avatar, Badge, Button, Space, Tag, Tooltip, Typography } from 'antd';
import { PaperClipOutlined, TeamOutlined } from '@ant-design/icons';
import type { Conversation, ConversationMemberState, Member } from '../../lib/api';
import { MemberManager } from './MemberManager';
import { CONVERSATION_STATUS_TEXT, describeConversationStatus, isMemberDm, type MemberStatusLookup } from './constants';

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
 * 紧凑 Header：两行，不抢正文空间。
 *
 *   标题 + Jira
 *   状态 + 进度 + Lead
 *
 * 右侧只有头像组 / Files / Participants。标题、状态、进度在 Task Inspector
 * 里不再重复 —— 那里只保留 Goal / Progress / Tasks。
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
  const { total, completed } = conversation.taskProgress;
  const progress = total > 0 ? `${completed}/${total}` : null;
  // 头像上的小圆点太隐蔽：谁在干活必须一眼看出来，不用 hover 才知道。
  const workingMembers = isDm
    ? []
    : conversation.members.filter((member) => memberStatus(member.id).className === 'working');

  const meta = isDm
    ? conversation.members.map((member) => member.name).join(' ↔ ')
    : [
        CONVERSATION_STATUS_TEXT[conversation.status] ?? conversation.status,
        progress,
        leadName ? `Lead ${leadName}` : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <>
      <div className="conversation-header">
        <div className="conversation-header-main">
          <Space size={8} align="center">
            <Typography.Title level={4} style={{ margin: 0 }} ellipsis>
              {conversation.title}
            </Typography.Title>
            {conversation.externalWorkRef?.key && (
              <Tag color="cyan">{conversation.externalWorkRef.key}</Tag>
            )}
            {workingMembers.map((member) => (
              <Tag key={member.id} color="processing">
                {member.name} 处理中…
              </Tag>
            ))}
          </Space>
          {!isDm && (
            <Tooltip title={describeConversationStatus(conversation)}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {meta}
              </Typography.Text>
            </Tooltip>
          )}
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
            Files{fileCount > 0 ? ` ${fileCount}` : ''}
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
