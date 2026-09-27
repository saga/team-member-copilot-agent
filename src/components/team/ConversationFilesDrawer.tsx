import { useEffect, useState } from 'react';
import { Button, Drawer, Empty, Modal, Popconfirm, Select, Space, Spin, Tag, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { ConversationFile } from '../../lib/api';
import { api } from '../../lib/api';
import { FileAttachmentCard } from './FileAttachmentCard';

interface ConversationFilesDrawerProps {
  open: boolean;
  conversationId: string;
  files: ConversationFile[];
  busy?: boolean;
  onUseInChat: (file: ConversationFile) => void;
  onUpload: (file: File) => void;
  onDelete: (file: ConversationFile) => void;
  onClose: () => void;
}

/**
 * Shared Files：这个会话里共享了哪些文件。
 *
 * 它和 Capabilities 里的 Knowledge 页签是**两个问题**，刻意不合并：
 *
 *   Shared Files —— 这场对话里有什么（ACL = 会话成员，随聊天存续）
 *   Knowledge    —— 这个 Member 被授权能看哪些长期资料（ACL = 能力绑定）
 *
 * 混成一个界面，用户就会以为「上传到聊天」等于「进了公司知识库」，
 * 而这两件事中间隔着一个显式动作（保存到知识库）。
 */
export function ConversationFilesDrawer({
  open,
  conversationId,
  files,
  busy,
  onUseInChat,
  onUpload,
  onDelete,
  onClose,
}: ConversationFilesDrawerProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ fileId: string; title: string; snippet: string }> | null>(
    null,
  );
  const [searching, setSearching] = useState(false);

  const [promoteTarget, setPromoteTarget] = useState<ConversationFile | null>(null);
  const [bases, setBases] = useState<Array<{ id: string; key: string; name: string }>>([]);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 上一次保存成功的说明。
   *
   * 保存成功之后弹窗直接关掉，不给一句反馈的话，用户看到的就是「点了一下，
   * 什么都没发生」—— 而这件事的结果（这份文本从此长期可搜）是他必须知道的。
   * 存在这个会话里，切走抽屉时清掉。
   */
  const [saved, setSaved] = useState<string | null>(null);

  // 关掉抽屉时把内容搜索清掉：留着下次打开会显示上一个会话的搜索结果。
  useEffect(() => {
    if (open) return;
    setQuery('');
    setHits(null);
    setError(null);
    setSaved(null);
  }, [open]);

  // 知识库列表只在真的要保存时才拉 —— 大多数人不点这个按钮。
  useEffect(() => {
    if (!promoteTarget) return;
    void api
      .listTeamKnowledgeBases()
      .then((result) => {
        setBases(result.knowledgeBases);
        setBaseId(result.knowledgeBases[0]?.id ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [promoteTarget]);

  async function runSearch(): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const result = await api.searchConversationFiles(conversationId, trimmed);
      setHits(result.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function promote(): Promise<void> {
    if (!promoteTarget || !baseId) return;
    // 目标名字在 await 之后可能已经不可读（弹窗已关），先取出来
    const fileName = promoteTarget.originalName;
    const targetName = bases.find((base) => base.id === baseId)?.name ?? '知识库';
    setPromoting(true);
    setError(null);
    setSaved(null);
    try {
      await api.promoteConversationFile(conversationId, promoteTarget.id, { knowledgeBaseId: baseId });
      setPromoteTarget(null);
      setSaved(`「${fileName}」的文本已经存进「${targetName}」，有权限的成员现在就能搜到它。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPromoting(false);
    }
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title="Shared files"
        width={460}
        extra={
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
              上传
            </Button>
          </Upload>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          {error && <div style={{ color: '#a00', fontSize: 12 }}>{error}</div>}
          {saved && <div style={{ color: '#389e0d', fontSize: 12 }}>{saved}</div>}

          <Space.Compact style={{ width: '100%' }}>
            <input
              className="conversation-file-search"
              placeholder="搜文件内容（只有文本类文件可搜）"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch();
              }}
            />
            <Button onClick={() => void runSearch()} loading={searching}>
              搜索
            </Button>
          </Space.Compact>

          {hits !== null && (
            <div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
                {hits.length === 0 ? '没有搜到内容。' : `搜到 ${hits.length} 处：`}
              </div>
              {hits.map((hit) => (
                <div key={hit.fileId} className="conversation-file-hit">
                  <strong>{hit.title}</strong>
                  {/* 纯文本渲染：片段来自上传文件的内容，React 的默认转义就是
                      这里需要的全部防御；片段本身不带标记（服务端不给 FTS 加
                      <b>，因为同一份文本还要给模型读）。 */}
                  <div>{hit.snippet}</div>
                </div>
              ))}
            </div>
          )}

          {files.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="这个会话还没有文件。上传一个，或者把文件拖进输入框。"
            />
          ) : (
            <div className="conversation-file-list">
              {files.map((file) => (
                <FileAttachmentCard
                  key={file.id}
                  file={file}
                  actions={
                    <Space direction="vertical" size={2} align="end">
                      <Button size="small" onClick={() => onUseInChat(file)}>
                        在会话中引用
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        onClick={() => {
                          setPromoteTarget(file);
                        }}
                      >
                        存进知识库
                      </Button>
                      <Popconfirm
                        title="删除这份文件？"
                        description="历史消息里的附件记录会保留，但这个文件不再出现在这里，也不能再被引用。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => onDelete(file)}
                      >
                        <Button size="small" type="text" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  }
                />
              ))}
            </div>
          )}
        </Space>
      </Drawer>

      <Modal
        open={promoteTarget !== null}
        title="存进团队知识库"
        okText="保存"
        cancelText="取消"
        confirmLoading={promoting}
        okButtonProps={{ disabled: !baseId }}
        onOk={() => void promote()}
        onCancel={() => setPromoteTarget(null)}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <div>
            把 <strong>{promoteTarget?.originalName}</strong> 的文本内容写进下面的知识库。
            保存之后，有权限的成员就能长期搜到它 —— 这与会话本身是否还在无关。
          </div>
          {bases.length === 0 ? (
            <Spin size="small" />
          ) : (
            <Select
              style={{ width: '100%' }}
              value={baseId ?? undefined}
              onChange={setBaseId}
              options={bases.map((base) => ({ value: base.id, label: `${base.name}（${base.key}）` }))}
            />
          )}
          <div style={{ color: '#999', fontSize: 12 }}>
            只有提取出文本的文件能存（当前支持文本类）。图片 / PDF 仍然只能留在这个会话里。
            <Tag style={{ marginLeft: 4 }}>需要 admin 权限</Tag>
          </div>
        </Space>
      </Modal>
    </>
  );
}
