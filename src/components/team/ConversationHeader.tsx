import { useState } from 'react';
import { Avatar, Badge, Button, Space, Tag, Tooltip, Typography } from 'antd';
import { PaperClipOutlined, TeamOutlined } from '@ant-design/icons';
import type { Conversation, ConversationMemberState, Member } from '../../lib/api';
import { GroupMemberManager } from './GroupMemberManager';
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
 * 会话头：只负责「识别房间」与「这个房间有哪些共享物」。
 *
 *   Title / kind / Jira / avatars / Shared / Participants
 *
 * 「这条消息发给谁」是 MessageComposer 的事（输入框前缀的选择器），
 * 静音/移人/加人是 Participants 抽屉的事。Avatar 只显示人 + 状态，
 * 点击不再静音 —— 误触一次就把 Agent  ban 掉是最差的交互。
 *
 * Shared 放在这里而不是塞进第二列：文件的归属是**这个会话**，它的入口就该和
 * 会话标题在同一行；放进侧栏会让人以为是全局资料，而它只对房间里的人可见。
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
}: ConversationHeaderProps) {
  const isGroup = conversation.kind === 'group';
  const isDm = isMemberDm(conversation);
  const [participantsOpen, setParticipantsOpen] = useState(false);

  return (
    <>
      <div className="conversation-header">
        <div className="conversation-header-main">
          <Space size={8} align="center">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {conversation.title}
            </Typography.Title>

            {conversation.kind === 'work' && <Tag color="gold">Work</Tag>}
            {conversation.kind === 'group' && <Tag color="blue">discussion</Tag>}

            {conversation.externalWorkRef?.key && (
              <Tag color="cyan">{conversation.externalWorkRef.key}</Tag>
            )}
          </Space>

          <Typography.Text type="secondary">
            {isDm
              ? conversation.members.map((member) => member.name).join(' ↔ ')
              : isGroup
                ? `${conversation.members.length} participants`
                : (conversation.members[0]?.name ?? '')}
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

          {isGroup && (
            <Button icon={<TeamOutlined />} onClick={() => setParticipantsOpen(true)}>
              Participants
            </Button>
          )}
        </Space>
      </div>

      {isGroup && (
        <GroupMemberManager
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
