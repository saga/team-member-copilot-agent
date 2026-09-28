import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api, type McpServer, type McpServerInput } from '../../lib/api';
import { McpServerEditor } from './McpServerEditor';

/** 认证展示行：只说类型和「引用指向哪条」，凭证的值根本不在本系统里。 */
function authLabel(server: McpServer): string {
  if (server.authType === 'none') return 'Authentication: None';
  const kind = server.authType === 'bearer' ? 'Bearer token' : 'API Key';
  if (!server.secretConfigured) return `Authentication: ${kind}（未配置引用）`;
  return `Authentication: ${kind} · ${server.secretRef ?? '（引用已配置）'}`;
}

/**
 * MCP Servers 管理页：系统里有哪些连接。
 *
 * 和 Capabilities/MCP 页签的分工：
 *   这里   怎么连（URL / 认证 / 开关），凭证只留一个密钥库引用名
 *   那里   谁可以用其中哪些工具（授权）
 *
 * status 是上次 Test 的结论，不是实时探针 —— “Connected” 不代表现在还通，
 * 只是上次测的时候通。unknown = 从没测过。
 */
export function McpServerSettings() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServer | null | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listMcpServers();
      setServers(result.servers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(input: McpServerInput): Promise<void> {
    if (editing) {
      const result = await api.updateMcpServer(editing.id, input);
      setServers((current) => (current ?? []).map((item) => (item.id === result.server.id ? result.server : item)));
    } else {
      const result = await api.createMcpServer(input);
      setServers((current) => [...(current ?? []), result.server]);
    }
    setEditing(undefined);
    setCreating(false);
  }

  async function remove(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api.deleteMcpServer(id);
      setServers((current) => (current ?? []).filter((item) => item.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(server: McpServer): Promise<void> {
    setBusyId(server.id);
    setError(null);
    try {
      const result = await api.updateMcpServer(server.id, {
        id: server.id,
        displayName: server.name,
        description: server.description,
        type: server.type,
        ...(server.url ? { url: server.url } : {}),
        ...(server.command ? { command: server.command } : {}),
        enabled: !server.enabled,
        tools: server.tools.map((tool) => ({ name: tool.name, risk: tool.risk })),
        version: server.version,
      });
      setServers((current) => (current ?? []).map((item) => (item.id === result.server.id ? result.server : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function test(server: McpServer): Promise<void> {
    setBusyId(server.id);
    setError(null);
    setTestResult(null);
    try {
      const result = await api.testMcpServer(server.id);
      setTestResult({ id: server.id, ok: result.ok, detail: result.detail });
      setServers((current) => (current ?? []).map((item) => (item.id === result.server.id ? result.server : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (servers === null) {
    return <Spin tip="Loading MCP servers…" />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <div style={{ color: '#999', fontSize: 12 }}>
        这里配“系统里有哪些 MCP 连接”。谁可以用其中哪些工具，去 Capabilities 里按层授权；Task 里不需要选，自动用已授权的。
      </div>

      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError(null)} />}

      <div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          Add MCP Server
        </Button>
      </div>

      {servers.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有 MCP Server。先在这里定义连接，再去 Capabilities 里授权给谁用。"
        />
      )}

      {servers.map((server) => (
        <Card
          key={server.id}
          size="small"
          title={
            <Space>
              <strong>{server.name}</strong>
              <Tag style={{ marginInlineEnd: 0 }}>{server.type}</Tag>
              {server.status === 'connected' ? (
                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                  Connected
                </Tag>
              ) : server.status === 'error' ? (
                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                  Error
                </Tag>
              ) : (
                <Tag style={{ marginInlineEnd: 0 }}>Unknown</Tag>
              )}
              {!server.enabled && (
                <Tag color="default" style={{ marginInlineEnd: 0 }}>
                  Disabled
                </Tag>
              )}
            </Space>
          }
        >
          <div style={{ color: '#666', fontSize: 12 }}>
            {server.type === 'local' ? server.command : server.url}
            {server.description ? ` · ${server.description}` : ''}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {authLabel(server)} · {server.tools.length} tools
          </Typography.Text>
          <div style={{ color: '#999', fontSize: 12 }}>
            {server.authType === 'none' || !server.secretConfigured
              ? null
              : '凭证值在密钥库里，本系统不存也不回显 —— 这里显示的只是「去哪找」。'}
          </div>

          {testResult?.id === server.id && (
            <Alert
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              closable
              onClose={() => setTestResult(null)}
              message={testResult.ok ? '地址可达' : '连接失败'}
              description={testResult.detail}
              style={{ marginTop: 8 }}
            />
          )}

          <Space style={{ marginTop: 8 }} wrap>
            <Button size="small" loading={busyId === server.id} onClick={() => void test(server)}>
              Test
            </Button>
            <Button size="small" onClick={() => setEditing(server)}>
              Edit
            </Button>
            <Button size="small" loading={busyId === server.id} onClick={() => void toggleEnabled(server)}>
              {server.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Popconfirm
              title={`删除 MCP Server ${server.name}？引用它的授权绑定会留着（目录里可见、可关闭），但轮次里再也解析不到它。`}
              okText="删除"
              cancelText="取消"
              onConfirm={() => void remove(server.id)}
            >
              <Button size="small" danger loading={busyId === server.id}>
                Delete
              </Button>
            </Popconfirm>
          </Space>
        </Card>
      ))}

      {(creating || editing) && (
        <McpServerEditor
          initial={editing ?? null}
          onSubmit={save}
          onCancel={() => {
            setCreating(false);
            setEditing(undefined);
          }}
        />
      )}
    </Space>
  );
}
