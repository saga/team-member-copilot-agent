import { } from 'react';
import { Avatar, Badge, Button, Select, Space, Tag, Tooltip, Typography } from 'antd';
import type { Conversation, ConversationMemberState, Member } from '../../lib/api';
import { GroupMemberManager } from './GroupMemberManager';
import { EVERYONE, EVERYONE_LABEL, isMemberDm, type MemberStatusLookup } from './constants';

const { Title, Text } = Typography;

interface ConversationHeaderProps {
  conversation: Conversation;
  /** 全部可用成员，供成员管理面板挑「还没进房间的人」。 */
  allMembers: Member[];
  states: Record<string, ConversationMemberState>;
  memberStatus: MemberStatusLookup;

  /** group：Everyone（空串）或某个成员的 id；direct：房间里那唯一一个成员。 */
  recipientMemberId: string;
  onRecipientChange: (memberId: string) => void;
  onToggleMute: (memberId: string) => void;

  showMembers: boolean;
  onToggleMembers: () => void;
  onConversationChanged: (conversation: Conversation) => void;
  onStateChanged: (state: ConversationMemberState) => void;
}

/**
 * 会话头：成员头像组（含 wakeStatus / muted）+ 收件人选择器 + 成员管理面板。
 *
 * 收件人默认是 Everyone，而不是 `conversation.defaultMemberId` —— 后者是
 * 「这个房间默认归谁」，拿它当 group 的默认收件人会把多成员讨论降级成单人聊天。
 */
export function ConversationHeader({
  conversation,
  allMembers,
  states,
  memberStatus,
  recipientMemberId,
  onRecipientChange,
  onToggleMute,
  showMembers,
  onToggleMembers,
  onConversationChanged,
  onStateChanged,
}: ConversationHeaderProps) {
  const isGroup = conversation.kind === 'group';
  const isDm = isMemberDm(conversation);
  /**
   * 房间负责人。展示在标题行，因为它的作用**不是**「谁先回答」——
   * 日常仍然是轮流应答，它只在全员沉默时兜底。不解释的话，用户会以为
   * 设了负责人就等于把房间变成单人聊天。
   */
  const leadMember = conversation.members.find((member) => states[member.id]?.isLead);

  return (
    <>
      <div style={{ padding: '12px 18px 0' }}>
        <Space align="center" wrap>
          <Title level={4} style={{ margin: 0 }}>
            {conversation.title}
          </Title>
          <Tag color={conversation.kind === 'group' ? 'blue' : conversation.kind === 'work' ? 'gold' : 'default'}>
            {conversation.kind}
          </Tag>
          {conversation.externalWorkRef && (
            <Tag color="cyan">Jira: {conversation.externalWorkRef.key}</Tag>
          )}
          {leadMember && (
            <Tooltip title="日常仍然是轮流应答；只有当用户对房间说话、而整个房间都没接话时，由它兜底回答">
              <Tag color="gold">Lead: {leadMember.name}</Tag>
            </Tooltip>
          )}
        </Space>

        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Avatar.Group max={{ count: 8 }}>
            {conversation.members.map((member) => {
              const status = memberStatus(member.id);
              const dot = status.className === 'working' ? 'processing' : status.className === 'muted' ? 'default' : 'success';
              const lead = states[member.id]?.isLead ? ' · 负责人' : '';
              return (
                <Tooltip key={member.id} title={`${member.name} · ${status.label}${lead}（点击静音切换）`}>
                  <span onClick={isGroup ? () => onToggleMute(member.id) : undefined} style={{ cursor: isGroup ? 'pointer' : 'default' }}>
                    <Badge dot status={dot as 'processing' | 'default' | 'success'}>
                      <Avatar style={states[member.id]?.isLead ? { boxShadow: '0 0 0 2px #d4a017' } : undefined}>
                        {member.name.slice(0, 1).toUpperCase()}
                      </Avatar>
                    </Badge>
                  </span>
                </Tooltip>
              );
            })}
          </Avatar.Group>

          <Space>
            {isGroup && (
              <Button size="small" onClick={onToggleMembers}>
                Members
              </Button>
            )}
            {isGroup ? (
              <Select
                size="small"
                style={{ minWidth: 140 }}
                value={recipientMemberId}
                onChange={onRecipientChange}
                aria-label="选择这条消息的收件人"
                options={[
                  { value: EVERYONE, label: EVERYONE_LABEL },
                  ...conversation.members
                    .filter((member) => member.status === 'active')
                    .map((member) => ({ value: member.id, label: `@${member.handle}` })),
                ]}
              />
            ) : (
              <Text type="secondary">
                {isDm
                  ? conversation.members.map((member) => member.name).join(' ↔ ')
                  : conversation.members[0]
                    ? `To ${conversation.members[0].name}`
                    : 'No member'}
              </Text>
            )}
          </Space>
        </div>
      </div>

      {showMembers && isGroup && (
        <GroupMemberManager
          conversation={conversation}
          allMembers={allMembers}
          states={states}
          onConversationChanged={onConversationChanged}
          onStateChanged={onStateChanged}
          onClose={onToggleMembers}
        />
      )}
    </>
  );
}
