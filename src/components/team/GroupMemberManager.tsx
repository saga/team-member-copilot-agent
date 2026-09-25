import { useState } from 'react';
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
 * Team 成员管理：加人 / 移人 / 静音。
 *
 * 两条约束必须在 UI 上也表达出来，而不是只在点下去之后等后端报错：
 *
 * 1. group 至少要两个成员。后端 `assertConversationKindShape()` 会拦，但把
 *    「移出」按钮留在那里让人点、再弹一个 400，是最差的交互。
 * 2. 归档的 Member 保留在 roster 里（历史事实），但不能被重新加进来。
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

  return (
    <div className="member-manager">
      <div className="panel-head">
        <div className="panel-title">Team Members</div>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="member-table">
        {conversation.members.map((member) => {
          const state = states[member.id];
          const muted = state?.muted ?? false;
          const archived = member.status !== 'active';
          const busy = busyMemberId === member.id;

          // 「有活没干完」：排队的唤醒，或者还在 queued / running / cooldown。
          // 这条判断只是把服务端真会拒绝的操作提前变灰 —— 真正的闸门在
          // assertMemberNotBusy，前端猜不出确切原因，所以点不动时把话说明白。
          const hasWork = Boolean(state?.pendingWake) || (state && state.wakeStatus !== 'idle');

          return (
            <div key={member.id} className="member-table-row">
              <div className="member-table-ident">
                <strong>{member.name}</strong>
                <span>@{member.handle}</span>
              </div>
              <div className="member-table-role">{member.role}</div>
              <div className="member-table-actions">
                {archived && <span className="tag">archived</span>}
                {hasWork && <span className="tag">有未完成的工作</span>}
                <button type="button" onClick={() => toggleMute(member.id)} disabled={busy}>
                  {muted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove(member.id)}
                  disabled={busy || removeDisabled || hasWork}
                  title={
                    removeDisabled
                      ? 'Team 至少需要两个成员'
                      : hasWork
                        ? `${member.name} 还有未完成的工作，等它跑完或先取消对应的 execution`
                        : `移出 ${member.name}`
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="add-member">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) add(e.target.value);
          }}
          disabled={addable.length === 0}
          aria-label="加入成员"
        >
          <option value="">
            {addable.length === 0 ? '没有可加入的成员' : 'Add member…'}
          </option>
          {addable.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} · {member.role}
            </option>
          ))}
        </select>
      </div>

      {removeDisabled && (
        <p className="sidebar-hint">Team 至少保留两个成员；要变单聊请直接和该成员开一个会话。</p>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
