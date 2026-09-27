import { useState } from 'react';
import { Alert, Input, Modal, Select, Space, Typography } from 'antd';
import type { Member } from '../../lib/api';

/**
 * Jira issue key 的常见形状（`ABC-123`）。
 *
 * 只用来**提示**，不用来校验：服务端刻意只校验「非空 + 长度」，不校验形状。
 * 这里如果拦下来，就会造出一条比服务端更严的规则。
 */
const JIRA_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** 表单收集到的原始输入；建工作区由调用方（Workspace）完成。 */
export interface TaskDraft {
  title: string;
  memberIds: string[];
  leadMemberId: string;
  /** 空串 = 不挂业务。 */
  jiraKey: string;
}

interface TaskCreatorProps {
  open: boolean;
  /** 候选成员（已归档的不会出现在这里）。 */
  members: Member[];
  onCreate: (input: TaskDraft) => Promise<void>;
  onCancel: () => void;
}

/**
 * 新建 Task 工作区（Modal，挂在页面根部）。
 *
 * 建完 Lead 会主动先开口（看 Jira 和上下文，缺信息就问），用户不用先想第一句话。
 * 不需要「开始执行」按钮：进入这个工作区本身就表示要完成这件事情。
 */
export function TaskCreator({ open, members, onCreate, onCancel }: TaskCreatorProps) {
  const [title, setTitle] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [leadMemberId, setLeadMemberId] = useState<string | null>(null);
  const [jiraKey, setJiraKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedKey = jiraKey.trim();
  const activeMembers = members.filter((member) => member.status === 'active');
  const effectiveLead = leadMemberId ?? memberIds[0] ?? null;
  const canCreate = title.trim().length > 0 && memberIds.length > 0 && effectiveLead !== null && !busy;

  async function submit() {
    if (!canCreate || !effectiveLead) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        memberIds,
        leadMemberId: effectiveLead,
        jiraKey: trimmedKey,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新建工作区"
      okText="创建"
      cancelText="取消"
      width={600}
      onCancel={onCancel}
      onOk={() => void submit()}
      confirmLoading={busy}
      okButtonProps={{ disabled: !canCreate }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            标题
          </Typography.Text>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="这次工作要达成什么，例如 解决 ABC-123 登录失败问题"
            autoFocus
            style={{ marginTop: 4 }}
          />
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            参与的成员
          </Typography.Text>
          <Select
            mode="multiple"
            value={memberIds}
            onChange={(values) => {
              setMemberIds(values);
              if (leadMemberId && !values.includes(leadMemberId)) setLeadMemberId(null);
            }}
            placeholder="选 1~20 个成员"
            style={{ width: '100%', marginTop: 4 }}
            maxTagCount="responsive"
            allowClear
            options={activeMembers.map((member) => ({
              value: member.id,
              label: `${member.name} · ${member.role}`,
            }))}
          />
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            谁负责推进（Lead）
          </Typography.Text>
          <Select
            value={effectiveLead}
            onChange={setLeadMemberId}
            placeholder="先选成员，再定 Lead"
            style={{ width: '100%', marginTop: 4 }}
            allowClear
            options={activeMembers
              .filter((member) => memberIds.includes(member.id))
              .map((member) => ({
                value: member.id,
                label: `${member.name} · ${member.role}`,
              }))}
          />
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Jira 工单（可选）
          </Typography.Text>
          <Input
            value={jiraKey}
            onChange={(e) => setJiraKey(e.target.value)}
            placeholder="例如 ABC-123，不填就是不挂业务"
            maxLength={60}
            style={{ marginTop: 4 }}
          />
        </div>

        {trimmedKey && !title.trim() && (
          <Typography.Link onClick={() => setTitle(trimmedKey)}>
            用 {trimmedKey} 当标题
          </Typography.Link>
        )}

        {trimmedKey && !JIRA_KEY_SHAPE.test(trimmedKey) && (
          <Alert
            type="warning"
            showIcon
            message="看起来不像 Jira issue key（通常是 ABC-123 这种格式）。仍然可以创建，只是执行时可能找不到对应的 Jira 工单。"
          />
        )}

        {activeMembers.length === 0 && (
          <Alert type="warning" showIcon message="还没有可用的 Member，先去建一个。" />
        )}

        {error && <Alert type="error" showIcon message={error} />}
      </Space>
    </Modal>
  );
}
