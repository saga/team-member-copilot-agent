import { PaperClipOutlined } from '@ant-design/icons';
import { Mermaid, Sources } from '@ant-design/x';
import { XMarkdown } from '@ant-design/x-markdown';
import type { ConversationFile } from '../../lib/api';
import { api } from '../../lib/api';
import { formatBytes } from './FileAttachmentCard';

interface MessageContentProps {
  content: string;
  files?: ConversationFile[];
  streaming?: boolean;
}

/**
 * ```mermaid 围栏在解析后是 pre > code[data-lang=mermaid]，不是 <mermaid>
 * 标签 —— 所以拦截点是 code 分量（官方 demo 也是这个写法），按 lang 分流。
 */
function CodeBlock({
  className,
  children,
  lang,
  block,
  streamStatus,
}: {
  className?: string;
  children?: React.ReactNode;
  lang?: string;
  block?: boolean;
  streamStatus?: 'loading' | 'done';
}) {
  if (block === true && lang === 'mermaid') {
    const text = Array.isArray(children)
      ? children.filter((part): part is string => typeof part === 'string').join('')
      : typeof children === 'string'
        ? children
        : null;
    // 流式中途的 mermaid 文本是不完整的，直接画会闪错 —— 先当普通代码，
    // 落定后再画图。
    if (text !== null && streamStatus !== 'loading') {
      return <Mermaid>{text.trimEnd()}</Mermaid>;
    }
  }
  return <code className={className}>{children}</code>;
}

const MARKDOWN_COMPONENTS = {
  code: CodeBlock,
};

function fileStatus(file: ConversationFile): string {
  switch (file.status) {
    case 'processing':
      return '处理中';
    case 'failed':
      return '内容未索引';
    case 'deleted':
      return '已删除';
    default:
      return '可用';
  }
}

/**
 * 一条消息的正文：Markdown 渲染 + 附件收进引用来源。
 *
 * 附件是这条消息的一部分（「请评估这个方案」里的「这个」指的就是它），
 * 所以不单独渲染文件卡 —— 收进 Sources 当引用来源，气泡里只剩正文。
 */
export function MessageContent({ content, files = [], streaming = false }: MessageContentProps) {
  const sources = files.map((file) => ({
    key: file.id,
    title: file.originalName,
    // 已删除的文件没有可点的地址：只留名字和状态，不给死链接。
    ...(file.status === 'deleted'
      ? {}
      : { url: api.conversationFileContentUrl(file.conversationId, file.id) }),
    icon: <PaperClipOutlined />,
    description: `${formatBytes(file.sizeBytes)} · ${fileStatus(file)}`,
  }));

  return (
    <div className="activity-message-content">
      <div className="activity-markdown">
        <XMarkdown
          content={content || ' '}
          components={MARKDOWN_COMPONENTS}
          streaming={
            streaming ? { hasNextChunk: true, enableAnimation: false, tail: true } : undefined
          }
        />
      </div>

      {sources.length > 0 && (
        <div className="message-sources">
          <Sources title={`引用来源 · ${sources.length}`} items={sources} defaultExpanded={false} />
        </div>
      )}
    </div>
  );
}
