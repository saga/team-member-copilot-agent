import { useState } from 'react';
import { Alert, Checkbox, Input, Modal, Space, Typography } from 'antd';
import type { Member } from '../../lib/api';

interface GroupCreatorProps {
  open: boolean;
  members: Member[];
  onCreate: (input: { title: string; memberIds: string[] }) => Promise<void>;
  onCancel: () => void;
}

/**
 * 新建 Discussion（Modal，挂在页面根部）。
 *
 * 这不是创建 Team：它调的是 `POST /api/conversations`（kind=group），
 * 只是一个临时多人协作房间。关键差异：**不传 defaultMemberId** ——
 * 收件人集合是全部成员，由服务端 GroupDispatcher 按 @mention /
 * everyone 规则决定唤醒谁。
 */
export function GroupCreator({ open, members, onCreate, onCancel }: GroupCreatorProps) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = title.trim().length > 0 && selected.length >= 2 && !busy;

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ title: title.trim(), memberIds: selected });
    } catch (e) {
      // 失败时保持 Modal 打开：调用方成功后会自己把它收起来
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New discussion"
      okText="Create discussion"
      cancelText="Cancel"
      onCancel={onCancel}
      onOk={() => void submit()}
      okButtonProps={{
        disabled: !canCreate,
        loading: busy,
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：Security architecture review"
          autoFocus
        />

        <div>
          <Typography.Text type="secondary">Participants</Typography.Text>

          <Checkbox.Group
            value={selected}
            onChange={(values) => setSelected(values as string[])}
            style={{ width: '100%', marginTop: 8 }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {members.map((member) => (
                <Checkbox key={member.id} value={member.id}>
                  {member.name}
                  <Typography.Text type="secondary"> · {member.role}</Typography.Text>
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
        </div>

        {selected.length < 2 && <Alert type="info" showIcon message="至少选择 2 个 Member。" />}

        {error && <Alert type="error" showIcon message={error} />}
      </Space>
    </Modal>
  );
}
