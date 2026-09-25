import { useState } from 'react';
import { Button, Card, Input, Space } from 'antd';

interface NewMemberFormProps {
  onCreate: (input: { name: string; role: string }) => Promise<void>;
  onCancel: () => void;
}

/**
 * 快速新建 Member：只收 name + role。
 *
 * 剩下的 description / style / systemPrompt / model 由 MemberProfile 补 ——
 * 那是一个需要人认真填的表单，不该塞进侧栏。
 */
export function NewMemberForm({ onCreate, onCancel }: NewMemberFormProps) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);

  const canCreate = name.trim().length > 0 && role.trim().length > 0 && !busy;

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), role: role.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Member name" autoFocus />
        <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" />
        <Space>
          <Button type="primary" size="small" onClick={() => void submit()} disabled={!canCreate} loading={busy}>
            Create
          </Button>
          <Button size="small" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
