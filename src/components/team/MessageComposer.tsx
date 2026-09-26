import { Select } from 'antd';
import { Sender } from '@ant-design/x';
import type { Conversation } from '../../lib/api';
import { EVERYONE, isMemberDm } from './constants';

interface MessageComposerProps {
  conversation: Conversation;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled: boolean;
  /** group：这条消息发给谁（Everyone 空串 / 某个成员 id）。Header 不管这个。 */
  recipientMemberId: string;
  onRecipientChange: (memberId: string) => void;
}

/**
 * 输入区（Ant Design X Sender）。
 *
 * Enter 发送 / Shift+Enter 换行由 Sender 处理。
 *
 * 占位文案按房间类型分开 —— group 里「发给谁」和 direct 里完全不同，
 * 用同一句会让用户以为自己在跟一个人说话。Work 也要单独一句：它虽然也是
 * 一对一，但「给这个人发消息」和「围绕一张工单给这个人下指令」不是一回事，
 * 后者才是这个房间存在的理由。
 *
 * Member 之间的私聊是只读的：那句话里两个 Member 是主角，用户插进去会掉进
 * dispatcher 的「非 group」分支去取 active[0]，唤醒谁取决于 roster 顺序。
 * 服务端会 400，这里直接把输入框锁掉，别让人先打一段字再被拒。
 */
export function MessageComposer({
  conversation,
  value,
  onChange,
  onSend,
  busy,
  disabled,
  recipientMemberId,
  onRecipientChange,
}: MessageComposerProps) {
  const readOnly = isMemberDm(conversation);
  const memberName = conversation.members[0]?.name ?? '成员';
  const workLabel = conversation.externalWorkRef?.key ?? conversation.title;
  const placeholder = readOnly
    ? '这是 Member 之间的私聊，你可以旁观，但不能替他们发言。'
    : conversation.kind === 'group'
      ? '对讨论说点什么… 使用 @handle 指定成员'
      : conversation.kind === 'work'
        ? `围绕 ${workLabel} 给 ${memberName} 下指令…`
        : `给 ${memberName} 发消息…`;

  return (
    <div className="sender-bar">
      <Sender
        value={value}
        onChange={onChange}
        onSubmit={() => onSend()}
        loading={busy}
        disabled={disabled || readOnly}
        placeholder={placeholder}
        submitType="enter"
        prefix={
          conversation.kind === 'group' ? (
            <Select
              size="small"
              variant="borderless"
              value={recipientMemberId}
              onChange={onRecipientChange}
              options={[
                {
                  value: EVERYONE,
                  label: 'Everyone',
                },
                ...conversation.members
                  .filter((member) => member.status === 'active')
                  .map((member) => ({
                    value: member.id,
                    label: `@${member.handle}`,
                  })),
              ]}
            />
          ) : undefined
        }
      />
    </div>
  );
}
