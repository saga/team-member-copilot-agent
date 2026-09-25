import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, Select, Space } from 'antd';
import { api, type Member, type Project } from '../../lib/api';

interface GroupCreatorProps {
  /** 可选的候选成员（已归档的不出现在这里）。 */
  members: Member[];
  onCreate: (input: { title: string; memberIds: string[]; projectId?: string | null }) => Promise<void>;
  onCancel: () => void;
}

/**
 * 新建 Team。
 *
 * 关键差异：**不传 defaultMemberId**。
 *
 * 「这个房间默认归谁」和「这条消息发给谁」是两件事。给 group 指定一个默认成员
 * 只会在 UI 里造出一个「看起来有主」的房间，然后把共享讨论降回单人聊天。
 * 房间的收件人集合是全部成员，由服务端 GroupDispatcher 按 @mention /
 * open_discussion 规则决定唤醒谁。
 */
export function GroupCreator({ members, onCreate, onCancel }: GroupCreatorProps) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then((result) => setProjects(result.projects.filter((p) => p.status === 'active')))
      .catch(() => {});
  }, []);

  const canCreate = title.trim().length > 0 && selected.length >= 2 && !busy;

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ title: title.trim(), memberIds: selected, projectId: projectId || null });
    } catch (e) {
      // 失败时保持面板打开：调用方（TeamChat）成功后会自己把它收起来
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="small" title="New Team" style={{ marginTop: 8 }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Investment Review" autoFocus />
        <Select
          value={projectId}
          onChange={setProjectId}
          placeholder="Project (optional)"
          allowClear
          style={{ width: '100%' }}
          options={[{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <Checkbox.Group
          value={selected}
          onChange={(values) => setSelected(values as string[])}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            {members.map((member) => (
              <Checkbox key={member.id} value={member.id}>
                {member.name} <span style={{ color: '#999' }}>{member.role}</span>
              </Checkbox>
            ))}
          </Space>
        </Checkbox.Group>
        {members.length < 2 && <Alert type="warning" showIcon message="至少需要 2 个 Member 才能建 Team。" />}
        {selected.length === 1 && <Alert type="info" showIcon message="Team 至少两个成员 —— 一个成员就是单聊。" />}
        {error && <Alert type="error" showIcon message={error} />}
        <Space>
          <Button type="primary" size="small" onClick={() => void submit()} disabled={!canCreate} loading={busy}>
            Create Team
          </Button>
          <Button size="small" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
