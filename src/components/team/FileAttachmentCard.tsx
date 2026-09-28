import type { ReactNode } from 'react';
import { Button, Space, Tag, Tooltip } from 'antd';
import { FileCard } from '@ant-design/x';
import type { ConversationFile } from '../../lib/api';
import { api } from '../../lib/api';

/** 文件大小：列表里只需要一个量级，不需要精确到字节。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type FileCardPresetIcon =
  | 'default'
  | 'excel'
  | 'image'
  | 'markdown'
  | 'pdf'
  | 'ppt'
  | 'word'
  | 'zip'
  | 'video'
  | 'audio'
  | 'java'
  | 'javascript'
  | 'python';

/** 按类型后缀和文件名给 FileCard 挑预设图标：图标语义由官方卡片统一表达。 */
export function fileCardIcon(
  file: Pick<ConversationFile, 'originalName' | 'contentType'>,
): FileCardPresetIcon {
  const contentType = file.contentType.toLowerCase();
  const name = file.originalName.toLowerCase();

  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (contentType.includes('spreadsheet') || /\.(xlsx?|csv)$/.test(name)) return 'excel';
  if (contentType.includes('presentation') || /\.(pptx?|key)$/.test(name)) return 'ppt';
  if (contentType.includes('word') || /\.(docx?|pages)$/.test(name)) return 'word';
  if (contentType === 'application/zip' || /\.(zip|7z|rar|tar|gz)$/.test(name)) return 'zip';
  if (contentType.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac)$/.test(name)) return 'audio';
  if (contentType.startsWith('video/') || /\.(mp4|mov|webm|avi|mkv)$/.test(name)) return 'video';
  if (/\.(md|markdown)$/.test(name)) return 'markdown';
  if (name.endsWith('.java')) return 'java';
  if (name.endsWith('.js') || name.endsWith('.jsx')) return 'javascript';
  if (name.endsWith('.py')) return 'python';
  return 'default';
}

function statusDescription(file: ConversationFile): ReactNode {
  const items: ReactNode[] = [<span key="size">{formatBytes(file.sizeBytes)}</span>];
  if (file.status === 'processing') {
    items.push(
      <Tag key="processing" color="processing" style={{ marginInlineEnd: 0 }}>
        处理中…
      </Tag>,
    );
  }
  if (file.status === 'failed') {
    items.push(
      <Tooltip
        key="failed"
        title={file.extractionError ?? '内容没能提取出来，仍然可以下载原文件'}
      >
        <Tag color="error" style={{ marginInlineEnd: 0 }}>
          内容未索引
        </Tag>
      </Tooltip>,
    );
  }
  if (file.status === 'deleted') {
    items.push(
      <Tooltip key="deleted" title="这份文件已被删除，历史消息里的记录会保留">
        <Tag style={{ marginInlineEnd: 0 }}>已删除</Tag>
      </Tooltip>,
    );
  }
  return (
    <Space size={6} wrap>
      {items}
    </Space>
  );
}

interface FileAttachmentCardProps {
  file: ConversationFile;
  /** 紧凑模式：引用文件窗口这类列表用它。 */
  compact?: boolean;
  /** 覆盖右侧动作区（抽屉里放引用 / 存知识库 / 删除这类操作）。 */
  actions?: React.ReactNode;
}

/**
 * 一份会话文件的卡片（Ant Design X FileCard）。
 *
 * 已删除的文件也照样渲染（历史消息里那条附件发生过，不能凭空消失），
 * 只是不给可点的地址 —— 这正是软删除的意义：审计链不断。
 */
export function FileAttachmentCard({ file, compact = false, actions }: FileAttachmentCardProps) {
  const deleted = file.status === 'deleted';
  const url = api.conversationFileContentUrl(file.conversationId, file.id);
  const image = !deleted && file.contentType.startsWith('image/');

  const defaultActions =
    !compact && !deleted ? (
      <Space size={4} wrap>
        <Button size="small" type="link" href={url} target="_blank" rel="noreferrer">
          预览
        </Button>
        <Button
          size="small"
          type="link"
          href={api.conversationFileContentUrl(file.conversationId, file.id, { download: true })}
        >
          下载
        </Button>
      </Space>
    ) : null;

  return (
    <div className={`conversation-file-card${compact ? ' compact' : ''}`}>
      <FileCard
        name={deleted ? `${file.originalName}（已删除）` : file.originalName}
        byte={file.sizeBytes}
        size={compact ? 'small' : 'default'}
        type={image ? 'image' : 'file'}
        icon={fileCardIcon(file)}
        src={image ? url : undefined}
        loading={file.status === 'processing'}
        description={statusDescription(file)}
        style={{ width: '100%' }}
        onClick={() => {
          if (deleted) return;
          window.open(url, '_blank', 'noopener,noreferrer');
        }}
      />

      {(defaultActions || actions) && (
        <div className="conversation-file-actions">
          <Space size={4} wrap>
            {defaultActions}
            {actions}
          </Space>
        </div>
      )}
    </div>
  );
}
