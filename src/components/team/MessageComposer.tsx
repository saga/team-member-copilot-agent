import { useState } from 'react';
import { Button, Dropdown, Select, Space } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import { Sender } from '@ant-design/x';
import type { Conversation, ConversationFile } from '../../lib/api';
import { EVERYONE, isMemberDm } from './constants';
import { FileChip } from './FileAttachmentCard';

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
  /** 这条消息要带的文件（从 Shared Files 引用或刚上传的）。 */
  selectedFiles: ConversationFile[];
  onRemoveFile: (fileId: string) => void;
  onUploadFile: (file: File) => void;
  onOpenFilePicker: () => void;
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
 *
 * 文件（📎）与收件人选择器一样放在 prefix 里：它们都回答「这条消息怎么发」，
 * 而输入框回答「说什么」。选中的文件显示在输入框上方 —— 那是发送前最后一次
 * 让人看见「这条消息会带上什么」的位置。
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
  selectedFiles,
  onRemoveFile,
  onUploadFile,
  onOpenFilePicker,
}: MessageComposerProps) {
  const readOnly = isMemberDm(conversation);
  const [dragging, setDragging] = useState(false);
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
    <div
      className={`sender-bar${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => {
        if (readOnly) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (readOnly) return;
        event.preventDefault();
        setDragging(false);
        for (const file of Array.from(event.dataTransfer.files)) onUploadFile(file);
      }}
    >
      {selectedFiles.length > 0 && (
        <div className="composer-files">
          {selectedFiles.map((file) => (
            <FileChip key={file.id} file={file} onRemove={() => onRemoveFile(file.id)} />
          ))}
        </div>
      )}

      <Sender
        value={value}
        onChange={onChange}
        onSubmit={() => onSend()}
        loading={busy}
        disabled={disabled || readOnly}
        placeholder={placeholder}
        submitType="enter"
        prefix={
          <Space size={2} align="center">
            {conversation.kind === 'group' && (
              <Select
                size="small"
                variant="borderless"
                value={recipientMemberId}
                onChange={onRecipientChange}
                // 下拉宽度不能跟随触发器：prefix 里 borderless Select 很窄，
                // 跟随宽度会把 @handle 全部截成省略号。
                popupMatchSelectWidth={false}
                // 输入区在屏幕底部，弹出层固定向上、左缘与触发器对齐，
                // 避免自动翻转时左右跳动。
                placement="topLeft"
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
            )}

            {!readOnly && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'upload',
                      label: '从本机上传',
                      // 走隐藏的 input：antd Upload 在这里需要一个可见的 click 目标，
                      // 而 prefix 里只有一个回形针按钮。
                      onClick: () => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.onchange = () => {
                          const file = input.files?.[0];
                          if (file) onUploadFile(file);
                        };
                        input.click();
                      },
                    },
                    {
                      key: 'reference',
                      label: '引用会话里的文件',
                      onClick: onOpenFilePicker,
                    },
                  ],
                }}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<PaperClipOutlined />}
                  aria-label="添加文件"
                  disabled={disabled}
                />
              </Dropdown>
            )}
          </Space>
        }
      />
    </div>
  );
}
