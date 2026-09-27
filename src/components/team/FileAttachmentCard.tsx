import { FileImageOutlined, FilePdfOutlined, FileTextOutlined, PaperClipOutlined } from '@ant-design/icons';
import { Button, Space, Tag, Tooltip } from 'antd';
import type { ConversationFile } from '../../lib/api';
import { api } from '../../lib/api';

/** 文件大小：列表里只需要一个量级，不需要精确到字节。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(file: ConversationFile) {
  if (file.contentType.startsWith('image/')) return <FileImageOutlined />;
  if (file.contentType === 'application/pdf') return <FilePdfOutlined />;
  return <FileTextOutlined />;
}

interface FileAttachmentCardProps {
  file: ConversationFile;
  /** 紧凑模式：composer 里的 chip 和抽屉里的列表用它。 */
  compact?: boolean;
  /** 覆盖右侧动作区（抽屉里放 Use / Save 这类操作）。 */
  actions?: React.ReactNode;
}

/**
 * 一份会话文件的卡片：图标 + 名字 + 大小 + 处理状态。
 *
 * 已删除的文件也照样渲染（历史消息里那条附件发生过，不能凭空消失），只是把
 * 名字划掉并说清楚「已删除」—— 这正是软删除的意义：审计链不断。
 */
export function FileAttachmentCard({ file, compact = false, actions }: FileAttachmentCardProps) {
  const deleted = file.status === 'deleted';
  const url = api.conversationFileContentUrl(file.conversationId, file.id);

  return (
    <div className={`conversation-file-card${compact ? ' compact' : ''}`}>
      <span className="conversation-file-icon">{iconFor(file)}</span>

      <div className="conversation-file-body">
        <div className="conversation-file-name">
          {deleted ? (
            <Tooltip title="这份文件已被删除，历史消息里的记录会保留">
              <span style={{ textDecoration: 'line-through', color: '#999' }}>
                {file.originalName}
              </span>
            </Tooltip>
          ) : (
            <a href={url} target="_blank" rel="noreferrer">
              {file.originalName}
            </a>
          )}
        </div>

        <div className="conversation-file-meta">
          <span>{formatBytes(file.sizeBytes)}</span>
          {file.status === 'processing' && <Tag style={{ marginInlineEnd: 0 }}>处理中…</Tag>}
          {file.status === 'failed' && (
            <Tooltip title={file.extractionError ?? '内容没能提取出来，仍然可以下载原文件'}>
              <Tag color="error" style={{ marginInlineEnd: 0 }}>
                内容未索引
              </Tag>
            </Tooltip>
          )}
          {deleted && <Tag style={{ marginInlineEnd: 0 }}>已删除</Tag>}
        </div>

        {!compact && !deleted && (
          <Space size={4} style={{ marginTop: 6 }}>
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              预览
            </Button>
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              href={api.conversationFileContentUrl(file.conversationId, file.id, { download: true })}
            >
              下载
            </Button>
          </Space>
        )}
      </div>

      {actions && <div className="conversation-file-actions">{actions}</div>}
    </div>
  );
}

/** composer 上的文件 chip：只有名字 + 去掉。 */
export function FileChip({
  file,
  onRemove,
}: {
  file: ConversationFile;
  onRemove?: () => void;
}) {
  return (
    <span className="composer-file-chip">
      <PaperClipOutlined />
      <span className="composer-file-chip-name">{file.originalName}</span>
      {onRemove && (
        <button type="button" className="composer-file-chip-remove" onClick={onRemove} aria-label="移除">
          ×
        </button>
      )}
    </span>
  );
}
