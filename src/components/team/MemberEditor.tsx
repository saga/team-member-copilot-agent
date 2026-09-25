import { useEffect, useState } from 'react';
import { Alert, Button, Collapse, Form, Input, Popconfirm, Space, Tag } from 'antd';
import { api, type Member, type MemberCapabilities } from '../../lib/api';

interface MemberEditorProps {
  member: Member;
  onSaved: (member: Member) => void;
  onCancel: () => void;
}

/**
 * Member 身份编辑器。
 *
 * 字段和数据库一一对应，不做二次抽象：
 *
 *   name / handle / role / description / style / systemPrompt / model
 *
 * 这些字段最后会拼进 system prompt（见 TeamService.buildMemberSystemPrompt），
 * 所以它们是**人格定义**，不是元数据装饰。`model` 支持留空 = 显式回落
 * COPILOT_MODEL，所以提交时要用 null 而不是空串。
 *
 * 「能用什么」不在这里编辑，而是单独显示：它属于
 * `/api/capabilities/members/:id`。把能力和身份混在一个表单里，会让「改个名字」
 * 和「给它开 bash」变成同一个保存动作。
 */
export function MemberEditor({ member, onSaved, onCancel }: MemberEditorProps) {
  const [form] = Form.useForm();
  const [capabilities, setCapabilities] = useState<MemberCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 能力是只读视图：它由模板 / 运维决定，不跟着这个表单一起保存。
  useEffect(() => {
    let cancelled = false;
    api
      .getMemberCapabilities(member.id)
      .then((result) => {
        if (!cancelled) setCapabilities(result.capabilities);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(null);
      });
    return () => {
      cancelled = true;
    };
  }, [member.id]);

  async function save(values: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateMember(member.id, {
        name: values.name.trim(),
        // 空 handle 不发：它是 @mention 的锚点，不能清空
        ...(values.handle.trim() ? { handle: values.handle.trim() } : {}),
        role: values.role.trim(),
        description: values.description.trim(),
        style: values.style.trim(),
        systemPrompt: values.systemPrompt,
        // 空 = 显式回落默认模型（后端按 !== undefined 判断，不会被 ?? 吃掉）
        model: values.model.trim() || null,
      });
      onSaved(result.member);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 归档 = 「不再接活」。
   *
   * 不是删除：这个 Member 仍然是房间里发生过的事实的引用方（历史消息、
   * execution、delegation 都指向它），只是不再作为新的执行目标。
   *
   * 归档前必须把它手上的活收干净。这条规则由服务端强制（未完的 execution /
   * 排队的唤醒都会返回 409），这里只把它的原话显示出来 —— 前端猜不出一条
   * 「还有活」的确切原因，也不该猜。
   */
  async function archive() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateMember(member.id, { status: 'archived' });
      onSaved(result.member);
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        name: member.name,
        handle: member.handle,
        role: member.role,
        description: member.description,
        style: member.style,
        systemPrompt: member.systemPrompt,
        model: member.model ?? '',
      }}
      onFinish={(values) => void save(values as Record<string, string>)}
    >
      <Form.Item name="name" label="Name" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="handle" label="Handle（@mention 用）">
        <Input placeholder="alice" />
      </Form.Item>
      <Form.Item name="role" label="Role" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="description" label="Description">
        <Input.TextArea placeholder="负责投资研究和事实核查" autoSize />
      </Form.Item>
      <Form.Item name="style" label="Personality / Style">
        <Input.TextArea placeholder="严谨、怀疑、证据优先、少说废话" autoSize />
      </Form.Item>
      <Form.Item name="systemPrompt" label="System Prompt">
        <Input.TextArea rows={5} placeholder="优先区分事实、推论和不确定性……" />
      </Form.Item>
      <Form.Item name="model" label="Model（留空 = 使用服务端默认模型）">
        <Input placeholder="gpt-5" />
      </Form.Item>

      <Collapse
        size="small"
        style={{ marginBottom: 16 }}
        items={[
          {
            key: 'capabilities',
            label: 'Capabilities（只读）',
            children: capabilities ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {(['skills', 'knowledge', 'tools'] as const).map((key) => (
                  <div key={key}>
                    <strong>{key}</strong>{' '}
                    {capabilities[key].length === 0 && <span style={{ color: '#999' }}>(none)</span>}
                    {capabilities[key].map((binding) => (
                      <Tag key={`${binding.providerId}#${binding.selector ?? ''}`} style={{ margin: 2 }}>
                        {binding.providerId}
                        {binding.selector ? ` · ${binding.selector}` : null}
                      </Tag>
                    ))}
                  </div>
                ))}
                <span style={{ color: '#999', fontSize: 12 }}>
                  能力组成决定这个 Member 能用哪些 skill 来源、知识源和工具。它由模板或运维配置，
                  不在这个表单里修改；上面存的是 Provider ID，所以换掉后端实现时这里不变。
                </span>
              </Space>
            ) : (
              <span style={{ color: '#999' }}>读取中…</span>
            ),
          },
        ]}
      />

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

      <Space>
        <Button type="primary" htmlType="submit" loading={busy}>
          Save
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {member.status === 'active' ? (
          <Popconfirm
            title={`归档 ${member.name}？它不会再接受新的任务，历史记录保留。`}
            onConfirm={() => void archive()}
            okText="归档"
            cancelText="取消"
          >
            <Button danger disabled={busy}>
              Archive
            </Button>
          </Popconfirm>
        ) : (
          <Tag color="error">已归档</Tag>
        )}
      </Space>
    </Form>
  );
}
