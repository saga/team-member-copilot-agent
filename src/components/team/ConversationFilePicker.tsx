import { useState } from 'react';
import { Button, Empty, Modal, Space, Upload } from 'antd';
import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import type { ConversationFile } from '../../lib/api';
import { FileAttachmentCard } from './FileAttachmentCard';

interface ConversationFilePickerProps {
  open: boolean;
  files: ConversationFile[];
  /** 已经被选中的文件 id，用来显示勾选态（可以重复点，不会重复添加）。 */
  selectedIds: string[];
  busy?: boolean;
  onSelect: (file: ConversationFile) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
}

/**
 * 「引用会话里已有的文件」。
 *
 * 它只回答一件事：**这个房间里已经有哪些文件**。选中的文件进 composer 变成
 * chip，随下一条消息一起发出去 —— 不是选中即发送。文件是上下文，消息才是指令，
 * 两者分开才说得清「这一轮到底在问什么」。
 */
export function ConversationFilePicker({
  open,
  files,
  selectedIds,
  busy,
  onSelect,
  onUpload,
  onClose,
}: ConversationFilePickerProps) {
  const [query, setQuery] = useState('');
  const visible = files.filter((file) =>
    file.originalName.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Modal open={open} title="引用这个会话里的文件" onCancel={onClose} footer={null} width={560}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <input
          className="conversation-file-search"
          placeholder="按文件名筛选"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {visible.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={files.length === 0 ? '这个会话还没有文件。' : '没有匹配的文件。'}
          />
        ) : (
          <div className="conversation-file-list">
            {visible.map((file) => {
              const selected = selectedIds.includes(file.id);
              return (
                <FileAttachmentCard
                  key={file.id}
                  file={file}
                  compact
                  actions={
                    <Button
                      size="small"
                      type={selected ? 'default' : 'primary'}
                      ghost={!selected}
                      disabled={selected || file.status === 'deleted'}
                      onClick={() => onSelect(file)}
                    >
                      {selected ? '已引用' : '引用'}
                    </Button>
                  }
                />
              );
            })}
          </div>
        )}

        <Upload
          accept="*"
          showUploadList={false}
          disabled={busy}
          beforeUpload={(file) => {
            onUpload(file);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />} loading={busy}>
            上传新文件
          </Button>
        </Upload>

        <div style={{ color: '#999', fontSize: 12 }}>
          <PaperClipOutlined /> 只能引用这个会话里的文件。别的会话的文件在这里看不到，也不能带过来。
        </div>
      </Space>
    </Modal>
  );
}
