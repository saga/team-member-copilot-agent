import { useState } from 'react';
import { Button, Dropdown, Space } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import { Sender } from '@ant-design/x';
import type { Conversation, ConversationFile } from '../../lib/api';
import { isMemberDm } from './constants';
import { FileChip } from './FileAttachmentCard';

interface MessageComposerProps {
  conversation: Conversation;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled: boolean;
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
 * 用户不需要知道「发给谁」：Task 工作区里消息只唤醒 Lead。
 *
 * Member 之间的私聊是只读的。服务端会 400，这里直接把输入框锁掉，
 * 别让人先打一段字再被拒。
 */
export function MessageComposer({
  conversation,
  value,
  onChange,
  onSend,
  busy,
  disabled,
  selectedFiles,
  onRemoveFile,
  onUploadFile,
  onOpenFilePicker,
}: MessageComposerProps) {
  const readOnly = isMemberDm(conversation);
  // 结束的工作区不再接受输入：blocked / waiting / running 仍然可以补充信息，
  // completed / cancelled 要做新工作就新建一个工作区。
  const finished = conversation.status === 'completed' || conversation.status === 'cancelled';
  const [dragging, setDragging] = useState(false);
  void conversation.externalWorkRef;
  const placeholder = readOnly
    ? '这是 Member 之间的私聊，你可以旁观，但不能替他们发言。'
    : finished
      ? '这项工作已完成，要继续做事请新建一个工作区。'
      : '补充需求、回答澄清问题或调整当前任务…';

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
        disabled={disabled || readOnly || finished}
        placeholder={placeholder}
        submitType="enter"
        prefix={
          <Space size={2} align="center">
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
