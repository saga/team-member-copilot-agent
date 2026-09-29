import type { RefObject } from 'react';
import { Avatar, Empty, Tag, Timeline } from 'antd';
import { Bubble } from '@ant-design/x';
import type { Conversation, ConversationMessage } from '../../lib/api';
import { MessageContent } from './MessageContent';

export interface StreamState {
  executionId: string;
  memberId: string;
  content: string;
}

export interface DelegationLog {
  executionId: string;
  fromMemberId: string;
  targetMemberId: string;
  task: string;
  status: 'running' | 'done' | 'error';
}

interface ActivityFeedProps {
  conversation: Conversation;
  messages: ConversationMessage[];
  /** executionId → 正在流式产出的半截内容。 */
  streaming: Record<string, StreamState>;
  delegations: DelegationLog[];
  /** executionId → 这一轮放行过的 MCP 工具（只展示“用过什么”）。 */
  mcpUsage: Record<string, Array<{ serverId: string; toolName: string }>>;
  /** 把 memberId 显示成名字。 */
  memberLabel: (memberId: string) => string;
  /** 把 taskId 显示成任务标题（Task 进展消息用）。 */
  taskLabel: (taskId: string | null) => string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}

/**
 * 工作进展流（Ant Design X Bubble）。
 *
 * 三类内容按角色分：user 靠右、member（ai）靠左、system 居中。
 * 流式回复单独渲染成一条 typing 气泡而不是追加到已有消息上 ——
 * 它还没有 message_sequence，落库后会被 message.created 替换掉。
 *
 * 附件跟消息一起渲染：附件是这条消息的一部分（「请评估这个方案」里的「这个」
 * 指的就是它），后置成一条独立的文件事件流会让人对不上是哪条消息在说它。
 *
 * 这里是「工作过程中发生了什么」，不是聊天：Member 消息头带上所属任务。
 */
/** 气泡头的时间：当天只显示时分，隔天前面加月/日。 */
function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function ActivityFeed({
  conversation,
  messages,
  streaming,
  delegations,
  mcpUsage,
  memberLabel,
  taskLabel,
  scrollRef,
}: ActivityFeedProps) {
  const mcpTags = (executionId: string | null) => {
    if (!executionId) return null;
    const used = mcpUsage[executionId] ?? [];
    if (used.length === 0) return null;
    return (
      <div className="activity-mcp-tags">
        {used.map((item) => (
          <Tag key={`${item.serverId}:${item.toolName}`} color="blue" style={{ marginInlineEnd: 0 }}>
            MCP · {item.serverId}/{item.toolName}
          </Tag>
        ))}
      </div>
    );
  };
  void conversation;
  if (messages.length === 0 && Object.keys(streaming).length === 0) {
    return (
      <div className="activity-scroll" ref={scrollRef}>
        <Empty description="说清楚要达成什么，Lead 会先确认目标再规划任务。整个工作过程都会记录在这里。" />
      </div>
    );
  }

  const items = [
    ...messages.map((message) => ({
      key: message.id,
      role: message.senderType === 'user' ? ('user' as const) : message.senderType === 'member' ? ('ai' as const) : ('system' as const),
      placement: (message.senderType === 'user' ? 'end' : 'start') as 'end' | 'start',
      content: (
        <>
          <MessageContent content={message.content} files={message.files} />
          {mcpTags(message.executionId)}
        </>
      ),
      header: [
        message.senderType === 'member'
          ? taskLabel(message.taskId)
            ? `${memberLabel(message.senderId)} · ${taskLabel(message.taskId)}`
            : memberLabel(message.senderId)
          : message.senderType === 'user'
            ? 'You'
            : 'System',
        formatMessageTime(message.createdAt),
      ]
        .filter(Boolean)
        .join(' · '),
      avatar:
        message.senderType === 'member' ? (
          <Avatar size="small">{memberLabel(message.senderId).slice(0, 1).toUpperCase()}</Avatar>
        ) : message.senderType === 'user' ? (
          <Avatar size="small" style={{ backgroundColor: '#1677ff' }}>
            你
          </Avatar>
        ) : undefined,
    })),
    ...Object.values(streaming).map((stream) => ({
      key: stream.executionId,
      role: 'ai' as const,
      placement: 'start' as const,
      content: (
        <>
          <MessageContent content={stream.content} streaming />
          {mcpTags(stream.executionId)}
        </>
      ),
      typing: { effect: 'typing' as const, step: 2, interval: 50 },
      header: memberLabel(stream.memberId),
      avatar: <Avatar size="small">{memberLabel(stream.memberId).slice(0, 1).toUpperCase()}</Avatar>,
    })),
  ];

  return (
    <div className="activity-scroll" ref={scrollRef}>
      <Bubble.List items={items} />
      {delegations.length > 0 && (
        <Timeline
          className="activity-delegations"
          items={delegations.map((item) => ({
            key: item.executionId,
            color: item.status === 'error' ? 'red' : item.status === 'running' ? 'blue' : 'green',
            children: (
              <>
                <strong>
                  {memberLabel(item.fromMemberId)} → {memberLabel(item.targetMemberId)}
                </strong>{' '}
                <span style={{ color: '#666' }}>{item.task}</span>{' '}
                <span style={{ color: '#999' }}>
                  {item.status === 'running' ? '进行中' : item.status === 'done' ? '完成' : '失败'}
                </span>
              </>
            ),
          }))}
        />
      )}
    </div>
  );
}
