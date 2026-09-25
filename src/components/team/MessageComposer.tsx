import type { Conversation } from '../../lib/api';

interface MessageComposerProps {
  conversation: Conversation;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled: boolean;
}

/**
 * 输入区。
 *
 * Enter 发送 / Shift+Enter 换行：Enter 必须 preventDefault，否则会在 textarea
 * 里插入一个换行再发送两条。
 *
 * 占位文案按房间类型分开 —— group 里「发给谁」和 direct 里完全不同，
 * 用同一句会让用户以为自己在跟一个人说话。
 */
export function MessageComposer({
  conversation,
  value,
  onChange,
  onSend,
  busy,
  disabled,
}: MessageComposerProps) {
  const placeholder =
    conversation.kind === 'group'
      ? '对团队说点什么…（Enter 发送 / Shift+Enter 换行；@handle 指名）'
      : `给 ${conversation.members[0]?.name ?? '成员'} 发消息…（Enter 发送 / Shift+Enter 换行）`;

  return (
    <div className="conversation-composer">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button type="button" onClick={onSend} disabled={busy || !value.trim()}>
        Send
      </button>
    </div>
  );
}
