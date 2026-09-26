import { useState } from 'react';
import { Alert, Button, Card, Input, Select, Space } from 'antd';
import type { Member } from '../../lib/api';

/**
 * Jira issue key 的常见形状（`ABC-123`）。
 *
 * 只用来**提示**，不用来校验：服务端刻意只校验「非空 + 长度」，不校验形状
 * （见 normalizeExternalWorkRef）。这里如果拦下来，就会造出一条比服务端更严的
 * 规则 —— 换一个 Jira 站点、或者对方用了别的 key 规则，前端反而成了障碍。
 */
const JIRA_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** 表单收集到的原始输入；建会话 + 发第一条消息由调用方（TeamChat）完成。 */
export interface WorkDraft {
  title: string;
  memberId: string;
  /** 空串 = 不挂业务（纯 Work 房间，没有 Jira 工单）。 */
  jiraKey: string;
  /** 空串 = 只建房间，不发第一条消息。 */
  instruction: string;
}

interface WorkCreatorProps {
  /** 候选成员（已归档的不会出现在这里）。 */
  members: Member[];
  onCreate: (input: WorkDraft) => Promise<void>;
  onCancel: () => void;
}

/**
 * 新建 Work。
 *
 * Work conversation 就是后端已有的 `kind = 'work'`：**一个 Member 围绕一条外部
 * 工作（Jira 工单）干活的房间**。所以它和后端一样只允许恰好一个成员 —— 需要多个
 * Member 一起看的东西是 Team，不是 Work。
 *
 * 「第一条指令」这一栏是刻意的，因为它回答了一个真实会踩到的疑问：
 *
 *   **只建房间，不会让 Current Work 出现任何东西。**
 *
 * Current Work 读的是活跃 execution，而 execution 只有在这个 Member 真的被唤醒
 * 时才产生。所以这里给两条路，并且把差别写在界面上：填了指令 → 建完立刻发出去，
 * 它马上开始干；留空 → 只建房间，并明确告诉你 Current Work 会是空的。
 */
export function WorkCreator({ members, onCreate, onCancel }: WorkCreatorProps) {
  const [title, setTitle] = useState('');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [jiraKey, setJiraKey] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedKey = jiraKey.trim();
  const activeMembers = members.filter((member) => member.status === 'active');
  /**
   * 标题必填。服务端在没有 title 时会退回「房间里第一个成员的名字」，那样建出来的
   * Work 房间在左栏看起来和一个单聊一模一样，而它其实挂着一张工单。
   */
  const canCreate = title.trim().length > 0 && memberId !== null && !busy;

  async function submit() {
    if (!canCreate || !memberId) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        memberId,
        jiraKey: trimmedKey,
        instruction: instruction.trim(),
      });
    } catch (e) {
      // 失败时保持面板打开：调用方（TeamChat）成功后会自己把它收起来
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="small" title="New Work" style={{ marginTop: 8 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Work title，例如 登录超时排查"
          autoFocus
        />

        <Select
          value={memberId}
          onChange={setMemberId}
          placeholder="谁来负责（一个 Member）"
          style={{ width: '100%' }}
          options={activeMembers.map((member) => ({
            value: member.id,
            label: `${member.name} · ${member.role}`,
          }))}
        />

        <Input
          value={jiraKey}
          onChange={(e) => setJiraKey(e.target.value)}
          placeholder="Jira issue key（可选，例如 ABC-123）"
          maxLength={60}
        />

        {trimmedKey && !title.trim() && (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto', alignSelf: 'flex-start' }}
            onClick={() => setTitle(trimmedKey)}
          >
            用 {trimmedKey} 当标题
          </Button>
        )}

        {trimmedKey && !JIRA_KEY_SHAPE.test(trimmedKey) && (
          <Alert
            type="warning"
            showIcon
            message="看起来不像 Jira issue key（通常是 ABC-123 这种形状）。仍然可以建，只是执行时去 Jira 取证会拿不到工单。"
          />
        )}

        <Input.TextArea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="第一条指令（可选）"
          autoSize={{ minRows: 3, maxRows: 6 }}
        />

        {canCreate && !instruction.trim() && (
          <Alert
            type="info"
            showIcon
            message="留空只会建房间，不会开始执行 —— Current Work 里暂时不会出现它。建好后在房间里发第一条消息才会开始。"
          />
        )}

        {activeMembers.length === 0 && (
          <Alert type="warning" showIcon message="还没有可用的 Member，先去建一个。" />
        )}

        {error && <Alert type="error" showIcon message={error} />}

        <Space>
          <Button
            type="primary"
            size="small"
            onClick={() => void submit()}
            disabled={!canCreate}
            loading={busy}
          >
            Create Work
          </Button>
          <Button size="small" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
