import { useState } from 'react';
import { Alert, Button, Form, Input, Popconfirm, Space, Tag } from 'antd';
import { api, type Member } from '../../lib/api';

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
 * 「能用什么」**不在这里**：能力现在是三层继承的（global + team + member），
 * 而这个表单只描述一个人。把能力和身份混在一个表单里，会让「改个名字」和
 * 「给它开 bash」变成同一个保存动作 —— 而且这里只看得见 member 那一层，
 * 会显示成一个「什么能力都没有的人」。
 */
export function MemberEditor({ member, onSaved, onCancel }: MemberEditorProps) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      <span
        style={{
          color: '#999',
          fontSize: 12,
          display: 'block',
          marginBottom: 16,
        }}
      >
        Capabilities 在顶栏的 Capabilities 配置窗口里配（Member 页签）。Global / Team
        两层能力会自动继承到这个 Member。
      </span>

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
