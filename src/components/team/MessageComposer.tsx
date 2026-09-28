import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Dropdown, Space } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import { FileCard, Sender } from '@ant-design/x';
import type { SenderRef } from '@ant-design/x/es/sender/interface';
import type { Conversation, ConversationFile, Member } from '../../lib/api';
import { isMemberDm } from './constants';
import { fileCardIcon, formatBytes } from './FileAttachmentCard';

/**
 * 光标前正在输入的 @token：`@` 起始下标 + 后面跟的查询串。
 * 只认行内刚打出来的那一段（@ 前面是开头或空白），已发出去的历史 @ 不管。
 */
function findMentionToken(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = /(^|[\s\(\[\{])@([A-Za-z0-9_\-\u4e00-\u9fa5]*)$/.exec(before);
  if (!match) return null;
  return { start: cursor - match[2].length - 1, query: match[2] };
}

function filterMentionMembers(members: Member[], query: string): Member[] {
  const q = query.toLowerCase();
  if (!q) return members;
  return members.filter(
    (member) =>
      member.handle.toLowerCase().includes(q) || member.name.toLowerCase().includes(q),
  );
}

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
 * Task 工作区的普通消息默认交给 Lead。
 *
 * 明确选择 `@Member` 后，服务端会直接唤醒被点名的 Member，
 * 不经过 Lead 转发。
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
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const senderRef = useRef<SenderRef | null>(null);
  void conversation.externalWorkRef;
  const placeholder = readOnly
    ? '这是 Member 之间的私聊，你可以旁观，但不能替他们发言。'
    : finished
      ? '这项工作已完成，要继续做事请新建一个工作区。'
      : '补充需求、回答澄清问题或调整当前任务…（@ 成员名）';

  const editable = !readOnly && !finished;

  /** 按当前光标位置重算 @ 补全，没有就是 null（关弹窗）。 */
  function refreshMention() {
    if (!editable) {
      setMention(null);
      return;
    }
    const el = senderRef.current?.inputElement as HTMLTextAreaElement | null | undefined;
    if (!el || typeof el.selectionStart !== 'number') {
      setMention(null);
      return;
    }
    setMention(findMentionToken(value, el.selectionStart));
  }

  // 打字和点鼠标挪光标都经过 textarea：直接监听，比 Sender 的回调可靠。
  useEffect(() => {
    const el = senderRef.current?.inputElement as unknown as HTMLElement | null;
    if (!el) return;
    const update = () => refreshMention();
    el.addEventListener('keyup', update);
    el.addEventListener('click', update);
    return () => {
      el.removeEventListener('keyup', update);
      el.removeEventListener('click', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, value, conversation.id]);
  // 切房间关弹窗；输入变化后下一帧按新光标重算。
  useEffect(() => {
    setMention(null);
  }, [conversation.id]);
  useEffect(() => {
    const timer = window.requestAnimationFrame(() => refreshMention());
    return () => window.cancelAnimationFrame(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  /** 选中成员：把 `@query` 换成 `@handle `，光标停在后面继续打字。 */
  function pickMention(member: Member) {
    if (!mention) return;
    const el = senderRef.current?.inputElement as unknown as HTMLTextAreaElement | null;
    const cursor = el && typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
    const next = `${value.slice(0, mention.start)}@${member.handle} ${value.slice(cursor)}`;
    const caret = mention.start + member.handle.length + 2;
    onChange(next);
    setMention(null);
    window.requestAnimationFrame(() => {
      const target = senderRef.current?.inputElement as unknown as HTMLTextAreaElement | null;
      target?.focus();
      target?.setSelectionRange(caret, caret);
    });
  }

  const mentionMembers = mention ? filterMentionMembers(conversation.members, mention.query) : [];

  return (
    <div
      className={`sender-bar${dragging ? ' dragging' : ''}`}
      style={{ position: 'relative' }}
      onDragOver={(event) => {
        if (!editable) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!editable) return;
        event.preventDefault();
        setDragging(false);
        for (const file of Array.from(event.dataTransfer.files)) onUploadFile(file);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && mention) setMention(null);
      }}
    >
      {selectedFiles.length > 0 && (
        <div className="composer-files">
          {selectedFiles.map((file) => (
            <div key={file.id} className="composer-file-card">
              <FileCard
                name={file.originalName}
                byte={file.sizeBytes}
                size="small"
                icon={fileCardIcon(file)}
                type={file.contentType.startsWith('image/') ? 'image' : 'file'}
                loading={file.status === 'processing'}
                description={file.status === 'processing' ? '处理中…' : formatBytes(file.sizeBytes)}
                style={{ width: '100%' }}
              />
              <Button
                type="text"
                size="small"
                className="composer-file-remove"
                aria-label={`移除 ${file.originalName}`}
                onClick={() => onRemoveFile(file.id)}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}

      {mention && mentionMembers.length > 0 && (
        <div className="mention-popup">
          {mentionMembers.map((member) => (
            <div
              key={member.id}
              className="mention-item"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickMention(member)}
            >
              <Avatar size="small">{member.name.slice(0, 1).toUpperCase()}</Avatar>
              <span className="mention-name">{member.name}</span>
              <span className="mention-handle">@{member.handle}</span>
            </div>
          ))}
        </div>
      )}

      <Sender
        ref={senderRef}
        value={value}
        onChange={onChange}
        onSubmit={() => onSend()}
        // 粘贴文件直接进同一条上传逻辑：拖入 / 粘贴 / 回形针三种入口不再各写一套。
        onPasteFile={(files) => {
          for (const file of Array.from(files)) onUploadFile(file);
        }}
        loading={busy}
        disabled={disabled || readOnly || finished}
        placeholder={placeholder}
        submitType="enter"
        autoSize={{ minRows: 2, maxRows: 8 }}
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
                        input.multiple = true;
                        input.onchange = () => {
                          for (const file of Array.from(input.files ?? [])) onUploadFile(file);
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
