import type { RefObject } from 'react';
import type { Conversation, ConversationMessage } from '../../lib/api';

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
  scrollRef: RefObject<HTMLDivElement | null>;
}

/**
 * 消息流。
 *
 * 三类内容按「谁说的」分色：user 靠右、member 靠左、system 居中偏灰。
 * 流式回复单独渲染成一条临时气泡（dashed 边框）而不是追加到已有消息上 ——
 * 它还没有 message_sequence，落库后会被 message.created 替换掉。
 */
export function ConversationMessages({
  conversation,
  messages,
  streaming,
  delegations,
  memberLabel,
  scrollRef,
}: ConversationMessagesProps) {
  const isGroup = conversation.kind === 'group';

  return (
    <div className="conversation-messages" ref={scrollRef}>
      {messages.length === 0 && (
        <p className="hint">
          {isGroup
            ? '收件人保持 Everyone 时不点名，消息会派给房间里所有可用成员，各自判断要不要发言（可以沉默）；要指名就选具体成员，或在正文里 @handle。'
            : `${conversation.members[0]?.name ?? '该成员'} 会用你自己的记忆、人格和工作区回答；它也可以用 ask_member 把子任务委派给其他成员。`}
        </p>
      )}

      {messages.map((message) => (
        <div key={message.id} className={`conversation-message ${message.senderType}`}>
          <div className="message-author">
            {message.senderType === 'member'
              ? memberLabel(message.senderId)
              : message.senderType === 'user'
                ? 'You'
                : 'System'}
          </div>
          <pre>{message.content}</pre>
        </div>
      ))}

      {Object.values(streaming).map((stream) => (
        <div
          key={stream.executionId}
          className="conversation-message member streaming"
          data-execution={stream.executionId}
        >
          <div className="message-author">{memberLabel(stream.memberId)}</div>
          <pre>{stream.content || '▍'}</pre>
        </div>
      ))}

      {delegations.length > 0 && (
        <div className="delegation-log">
          {delegations.map((item) => (
            <div key={item.executionId} className={`delegation-row ${item.status}`}>
              <span className="delegation-arrow">
                {memberLabel(item.fromMemberId)} → {memberLabel(item.targetMemberId)}
              </span>
              <span className="delegation-task">{item.task}</span>
              <span className="delegation-status">
                {item.status === 'running' ? '进行中' : item.status === 'done' ? '完成' : '失败'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
