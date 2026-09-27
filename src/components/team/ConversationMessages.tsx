import type { RefObject } from 'react';
import { Avatar, Empty, Timeline } from 'antd';
import { Bubble } from '@ant-design/x';
import type { Conversation, ConversationMessage } from '../../lib/api';
import { FileAttachmentCard } from './FileAttachmentCard';

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

interface ConversationMessagesProps {
  conversation: Conversation;
  messages: ConversationMessage[];
  /** executionId → 正在流式产出的半截内容。 */
  streaming: Record<string, StreamState>;
  delegations: DelegationLog[];
  /** 把 memberId 显示成名字。 */
  memberLabel: (memberId: string) => string;
  /** 把 taskId 显示成任务标题（Task 进展消息用）。 */
  taskLabel: (taskId: string | null) => string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}

/**
 * 消息流（Ant Design X Bubble）。
 *
 * 三类内容按角色分：user 靠右、member（ai）靠左、system 居中。
 * 流式回复单独渲染成一条 typing 气泡而不是追加到已有消息上 ——
 * 它还没有 message_sequence，落库后会被 message.created 替换掉。
 *
 * 附件跟消息一起渲染：附件是这条消息的一部分（「请评估这个方案」里的「这个」
 * 指的就是它），后置成一条独立的文件事件流会让人对不上是哪条消息在说它。
 */
export function ConversationMessages({
  conversation,
  messages,
  streaming,
  delegations,
  memberLabel,
  taskLabel,
  scrollRef,
}: ConversationMessagesProps) {
  void conversation;
  if (messages.length === 0 && Object.keys(streaming).length === 0) {
    return (
      <div className="chat-scroll" ref={scrollRef}>
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
          {taskLabel(message.taskId) && (
            <div style={{ fontSize: 12, color: '#999', marginBottom: 2 }}>
              Task：{taskLabel(message.taskId)}
            </div>
          )}
          {message.content}
          {message.files.length > 0 && (
            <div className="message-files">
              {message.files.map((file) => (
                <FileAttachmentCard key={file.id} file={file} compact />
              ))}
            </div>
          )}
        </>
      ),
      header:
        message.senderType === 'member'
          ? memberLabel(message.senderId)
          : message.senderType === 'user'
            ? 'You'
            : 'System',
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
      content: stream.content || '▍',
      typing: { effect: 'typing' as const, step: 2, interval: 50 },
      header: memberLabel(stream.memberId),
      avatar: <Avatar size="small">{memberLabel(stream.memberId).slice(0, 1).toUpperCase()}</Avatar>,
    })),
  ];

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <Bubble.List items={items} />
      {delegations.length > 0 && (
        <Timeline
          style={{ marginTop: 16 }}
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
