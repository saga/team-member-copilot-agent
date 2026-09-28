import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Radio, Select, Space } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { McpServer, McpServerInput } from '../../lib/api';

interface McpServerEditorProps {
  /** null = 新建；否则编辑（secret 与 env 值不回显，只能重填或保持）。 */
  initial: McpServer | null;
  onSubmit: (input: McpServerInput) => Promise<void>;
  onCancel: () => void;
}

interface ToolRow {
  key: number;
  name: string;
  risk: string;
}

interface EnvRow {
  key: number;
  name: string;
  value: string;
}

const RISKS = ['read', 'self-write', 'coordination', 'external-read', 'external-write', 'host-execution', 'privileged'];

let rowSeq = 0;
function nextKey(): number {
  rowSeq += 1;
  return rowSeq;
}

/**
 * MCP Server 定义编辑器。
 *
 * 只管「连接形状 + 工具名单」：secret 只进不出（编辑时留空=保持），env 只增
 * 不删（值不回显，老变量删不掉 —— 要删直接改 DB 或定义文件，这里会说清楚）。
 * 工具列表是手工维护的：没有在线 discovery，保存时也不探测（Test 按钮另做）。
 */
export function McpServerEditor({ initial, onSubmit, onCancel }: McpServerEditorProps) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverType, setServerType] = useState<'http' | 'sse' | 'local'>(initial?.type ?? 'http');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'apiKey'>(initial?.authType ?? 'none');
  const [tools, setTools] = useState<ToolRow[]>(() =>
    (initial?.tools ?? []).map((tool) => ({ key: nextKey(), name: tool.name, risk: tool.risk })),
  );
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);

  useEffect(() => {
    form.setFieldsValue({
      id: initial?.id ?? '',
      displayName: initial?.name ?? '',
      description: initial?.description ?? '',
      type: initial?.type ?? 'http',
      url: initial?.url ?? '',
      command: initial?.command ?? '',
      argsText: initial?.args.join('\n') ?? '',
      cwd: initial?.cwd ?? '',
      timeout: initial?.timeout ?? undefined,
    });
    setServerType(initial?.type ?? 'http');
    setAuthType(initial?.authType ?? 'none');
    setTools((initial?.tools ?? []).map((tool) => ({ key: nextKey(), name: tool.name, risk: tool.risk })));
    setEnvRows([]);
    setError(null);
  }, [form, initial]);

  async function submit() {
    setError(null);
    try {
      const values = await form.validateFields();
      if (tools.length === 0) {
        setError('至少声明一个工具：空 allowlist 的 server 注册了也用不了');
        return;
      }
      const badTool = tools.find((tool) => !tool.name.trim());
      if (badTool) {
        setError('工具名不能为空');
        return;
      }
      const secret = String(values.secret ?? '').trim();
      const input: McpServerInput = {
        id: initial ? initial.id : String(values.id).trim(),
        displayName: String(values.displayName).trim(),
        description: String(values.description ?? '').trim() || undefined,
        type: serverType,
        ...(serverType === 'local'
          ? {
              command: String(values.command ?? '').trim(),
              args: String(values.argsText ?? '')
                .split('\n')
                .map((line: string) => line.trim())
                .filter(Boolean),
              cwd: String(values.cwd ?? '').trim() || undefined,
            }
          : {
              url: String(values.url ?? '').trim(),
            }),
        ...(values.timeout ? { timeout: Number(values.timeout) } : {}),
        authType,
        ...(secret ? { secret } : {}),
        ...(envRows.length > 0
          ? { env: Object.fromEntries(envRows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value])) }
          : {}),
        tools: tools.map((tool) => ({ name: tool.name.trim(), risk: tool.risk })),
        enabled: initial?.enabled ?? true,
      };
      setBusy(true);
      await onSubmit(input);
    } catch (e) {
      if (e instanceof Error && (e as { errorFields?: unknown }).errorFields) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={initial ? `编辑 MCP Server：${initial.name}` : '新建 MCP Server'}
      width={640}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>,
        <Button key="save" type="primary" loading={busy} onClick={() => void submit()}>
          Save
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical">
        <Space size={12} style={{ fontWeight: 600, marginBottom: 4 }}>
          Basic
        </Space>
        {!initial && (
          <Form.Item
            name="id"
            label="ID"
            rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/, message: '字母数字开头，只允许字母数字、-、_' }]}
            extra="稳定身份，创建后不能改，也是引用它的 providerId 后缀（mcp.&lt;id&gt;）。"
          >
            <Input placeholder="github" />
          </Form.Item>
        )}
        <Form.Item name="displayName" label="Display Name" rules={[{ required: true }]}>
          <Input placeholder="GitHub" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input placeholder="这个 server 是干什么的" />
        </Form.Item>
        <Form.Item name="type" label="Type" initialValue={initial?.type ?? 'http'}>
          <Radio.Group onChange={(e) => setServerType(e.target.value)} value={serverType}>
            <Radio value="http">HTTP</Radio>
            <Radio value="sse">SSE</Radio>
            <Radio value="local">Local / Stdio</Radio>
          </Radio.Group>
        </Form.Item>

        <Space size={12} style={{ fontWeight: 600, marginBottom: 4, marginTop: 8 }}>
          Connection
        </Space>
        {serverType === 'local' ? (
          <>
            <Form.Item
              name="command"
              label="Command"
              rules={[{ required: true }]}
              extra="服务机器上启动的子进程。默认部署禁用 local（MCP_LOCAL_ENABLED），先确认再填。"
            >
              <Input placeholder="node" />
            </Form.Item>
            <Form.Item name="argsText" label="Arguments" extra="一行一个参数。">
              <Input.TextArea rows={2} placeholder={'./mcp/devtools.js\n--port\n8080'} />
            </Form.Item>
            <Form.Item name="cwd" label="Working Directory">
              <Input placeholder="子进程的工作目录，可选" />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="url" label="URL" rules={[{ required: true }]}>
              <Input placeholder="https://mcp.example.com/mcp" />
            </Form.Item>
            <Form.Item name="timeout" label="Timeout（毫秒）">
              <InputNumber min={1000} max={3600000} style={{ width: '100%' }} placeholder="默认不设" />
            </Form.Item>
          </>
        )}

        <Form.Item label="Authentication">
          <Radio.Group onChange={(e) => setAuthType(e.target.value)} value={authType}>
            <Radio value="none">None</Radio>
            <Radio value="bearer">Bearer Token</Radio>
            <Radio value="apiKey">API Key</Radio>
          </Radio.Group>
        </Form.Item>
        {authType !== 'none' && (
          <Form.Item
            name="secret"
            label="Secret"
            extra={
              initial?.secretConfigured
                ? '已配过 secret。留空=保持不变，填了=替换；切换认证方式必须重填。值永远不回显。'
                : '只存服务端，永远不回显。Bearer 只填 token 本体，不要带 Bearer 前缀；API Key 走 X-Api-Key 头。'
            }
          >
            <Input.Password placeholder={initial?.secretConfigured ? '留空保持不变' : '粘贴 secret'} />
          </Form.Item>
        )}

        {initial && initial.envKeys.length > 0 && envRows.length === 0 ? (
          <div style={{ color: '#999', fontSize: 12, marginBottom: 8 }}>
            已配环境变量：{initial.envKeys.join('、')}（值不显示；下面新增的行会合并进去，老变量删不掉——要删改定义文件或数据库）。
          </div>
        ) : null}
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Environment（新增变量，可选）</div>
        {envRows.map((row) => (
          <Space key={row.key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <Input
              placeholder="NAME"
              value={row.name}
              onChange={(e) => setEnvRows((rows) => rows.map((item) => (item.key === row.key ? { ...item, name: e.target.value } : item)))}
              style={{ width: 180 }}
            />
            <Input
              placeholder="value"
              value={row.value}
              onChange={(e) => setEnvRows((rows) => rows.map((item) => (item.key === row.key ? { ...item, value: e.target.value } : item)))}
              style={{ flex: 1 }}
            />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => setEnvRows((rows) => rows.filter((item) => item.key !== row.key))}
            />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => setEnvRows((rows) => [...rows, { key: nextKey(), name: '', value: '' }])}>
          Add variable
        </Button>

        <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>
          Tools（手工维护：没有在线发现，保存也不探测）
        </div>
        {tools.map((tool) => (
          <Space key={tool.key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <Input
              placeholder="tool_name"
              value={tool.name}
              onChange={(e) => setTools((rows) => rows.map((item) => (item.key === tool.key ? { ...item, name: e.target.value } : item)))}
              style={{ flex: 1 }}
            />
            <Select
              value={tool.risk}
              onChange={(risk) => setTools((rows) => rows.map((item) => (item.key === tool.key ? { ...item, risk } : item)))}
              style={{ width: 170 }}
              options={RISKS.map((risk) => ({ value: risk, label: risk }))}
            />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => setTools((rows) => rows.filter((item) => item.key !== tool.key))}
            />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => setTools((rows) => [...rows, { key: nextKey(), name: '', risk: 'external-read' }])}>
          Add tool
        </Button>

        {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      </Form>
    </Modal>
  );
}
