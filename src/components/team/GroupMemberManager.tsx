import { useState } from 'react';
import { Alert, Button, Card, Select, Space, Table, Tag } from 'antd';
import {
  api,
  type Conversation,
  type ConversationMemberState,
  type Member,
} from '../../lib/api';

interface GroupMemberManagerProps {
  conversation: Conversation;
  /** 全部可用成员，用来挑「还没进房间的人」。 */
  allMembers: Member[];
  states: Record<string, ConversationMemberState>;
  onConversationChanged: (conversation: Conversation) => void;
  onStateChanged: (state: ConversationMemberState) => void;
  onClose: () => void;
}

/**
 * Team 成员管理：加人 / 移人 / 静音 / 指定负责人。
 *
 * 两条约束必须在 UI 上也表达出来，而不是只在点下去之后等后端报错：
 *
 * 1. group 至少要两个成员。后端 `assertConversationKindShape()` 会拦，但把
 *    「移出」按钮留在那里让人点、再弹一个 400，是最差的交互。
 * 2. 归档的 Member 保留在 roster 里（历史事实），但不能被重新加进来。
 *
 * 「负责人」是房间维度的角色，和静音一样挂在成员行上：日常它不参与排序，
 * 只在用户对着房间说话、而整个房间都没接话时兜底。一个房间至多一个 ——
 * 指定新的会自动顶掉旧的，所以 UI 上是单选而不是开关，见 Lead 按钮。
 */
export function GroupMemberManager({
  conversation,
  allMembers,
  states,
  onConversationChanged,
  onStateChanged,
  onClose,
}: GroupMemberManagerProps) {
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rosterIds = new Set(conversation.members.map((member) => member.id));
  const addable = allMembers.filter(
    (member) => member.status === 'active' && !rosterIds.has(member.id),
  );

  // 移出后 roster 必须仍是合法 group（≥ 2）
  const removeDisabled = conversation.members.length <= 2;

  async function run(memberId: string, action: () => Promise<void>) {
    setBusyMemberId(memberId);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyMemberId(null);
    }
  }

  function add(memberId: string) {
    void run(memberId, async () => {
      const result = await api.addMemberToConversation(conversation.id, memberId);
      onConversationChanged(result.conversation);
    });
  }

  function remove(memberId: string) {
    void run(memberId, async () => {
      const result = await api.removeMemberFromConversation(conversation.id, memberId);
      onConversationChanged(result.conversation);
    });
  }

  function toggleMute(memberId: string) {
    void run(memberId, async () => {
      const result = await api.setMemberMuted(
        conversation.id,
        memberId,
        !states[memberId]?.muted,
      );
      onStateChanged(result.state);
    });
  }

  /**
   * 指定 / 撤销负责人。
   *
   * 指定时**不需要**先把旧的撤销掉：服务端一条 CASE UPDATE 就把其余人清零，
   * 而且 DB 上的偏索引保证不可能出现两个。UI 上表现为单选。
   */
  function toggleLead(memberId: string) {
    void run(memberId, async () => {
      const result = await api.setMemberLead(
        conversation.id,
        memberId,
        !states[memberId]?.isLead,
      );
      onStateChanged(result.state);
      // 顶掉旧负责人会改**两行**，而接口只回被指定的那一行。让父层重拉一次
      // 全房间状态，比在这里手工推算「谁被顶掉了」可靠。
      await reloadStates();
    });
  }

  async function reloadStates() {
    const result = await api.listConversationState(conversation.id);
    for (const state of result.states) onStateChanged(state);
  }

  return (
    <Card size="small" title="Team Members" extra={<Button size="small" type="text" onClick={onClose}>Close</Button>} style={{ margin: '12px 18px 0' }}>
      <Table
        size="small"
        pagination={false}
        dataSource={conversation.members}
        rowKey="id"
        columns={[
          { title: '成员', key: 'name', render: (_, member) => <><strong>{member.name}</strong> <span style={{ color: '#999' }}>@{member.handle}</span></> },
          { title: '角色', dataIndex: 'role', key: 'role' },
          {
            title: '状态',
            key: 'status',
            render: (_, member) => {
              const state = states[member.id];
              const hasWork = Boolean(state?.pendingWake) || (state && state.wakeStatus !== 'idle');
              return (
                <Space>
                  {member.status !== 'active' && <Tag color="error">archived</Tag>}
                  {state?.isLead && <Tag color="gold">lead</Tag>}
                  {hasWork && <Tag color="warning">有未完成的工作</Tag>}
                  {state?.muted && <Tag>muted</Tag>}
                </Space>
              );
            },
          },
          {
            title: '操作',
            key: 'actions',
            render: (_, member) => {
              const state = states[member.id];
              const hasWork = Boolean(state?.pendingWake) || (state && state.wakeStatus !== 'idle');
              const busy = busyMemberId === member.id;
              return (
                <Space>
                  <Button size="small" onClick={() => toggleMute(member.id)} loading={busy}>
                    {state?.muted ? 'Unmute' : 'Mute'}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => toggleLead(member.id)}
                    loading={busy}
                    disabled={member.status !== 'active'}
                    title={
                      member.status !== 'active'
                        ? '已归档的成员不能当负责人'
                        : state?.isLead
                          ? `撤销 ${member.name} 的负责人身份`
                          : `指定 ${member.name} 为负责人：用户对房间说话而全员沉默时，由它兜底回答`
                    }
                  >
                    {state?.isLead ? 'Remove lead' : 'Make lead'}
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => remove(member.id)}
                    loading={busy}
                    disabled={removeDisabled || hasWork}
                    title={
                      removeDisabled
                        ? 'Team 至少需要两个成员'
                        : hasWork
                          ? `${member.name} 还有未完成的工作，等它跑完或先取消对应的 execution`
                          : `移出 ${member.name}`
                    }
                  >
                    Remove
                  </Button>
                </Space>
              );
            },
          },
        ]}
      />

      <div style={{ marginTop: 12 }}>
        <Select
          value=""
          onChange={(value) => {
            if (value) add(value);
          }}
          disabled={addable.length === 0}
          placeholder={addable.length === 0 ? '没有可加入的成员' : 'Add member…'}
          style={{ minWidth: 240 }}
          options={addable.map((member) => ({ value: member.id, label: `${member.name} · ${member.role}` }))}
        />
      </div>

      {removeDisabled && (
        <Alert type="info" showIcon message="Team 至少保留两个成员；要变单聊请直接和该成员开一个会话。" style={{ marginTop: 8 }} />
      )}
      {!conversation.members.some((member) => states[member.id]?.isLead) && (
        <Alert
          type="info"
          showIcon
          message="还没有负责人"
          description="指定一个之后：用户对着房间说话、而整个房间都没接话时，由它兜底回答。日常仍然是轮流应答，负责人不会抢答每一条。"
          style={{ marginTop: 8 }}
        />
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
    </Card>
  );
}
