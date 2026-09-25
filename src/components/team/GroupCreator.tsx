import { useState } from 'react';
import type { Member } from '../../lib/api';

interface GroupCreatorProps {
  /** 可选的候选成员（已归档的不出现在这里）。 */
  members: Member[];
  onCreate: (input: { title: string; memberIds: string[] }) => Promise<void>;
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const canCreate = title.trim().length > 0 && selected.size >= 2 && !busy;

  function toggle(memberId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  }

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate({ title: title.trim(), memberIds: [...selected] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="group-creator">
      <div className="panel-title">New Team</div>

      <label className="field">
        <span>Team name</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Investment Review"
          autoFocus
        />
      </label>

      <div className="field">
        <span>Members</span>
        <div className="checkbox-list">
          {members.map((member) => (
            <label key={member.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={selected.has(member.id)}
                onChange={() => toggle(member.id)}
              />
              <span className="checkbox-label">{member.name}</span>
              <span className="checkbox-hint">{member.role}</span>
            </label>
          ))}
          {members.length < 2 && (
            <p className="sidebar-hint">至少需要 2 个 Member 才能建 Team。</p>
          )}
        </div>
      </div>

      <div className="panel-actions">
        <button type="button" onClick={() => void submit()} disabled={!canCreate}>
          {busy ? 'Creating…' : 'Create Team'}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>

      {selected.size === 1 && (
        <p className="sidebar-hint">Team 至少两个成员 —— 一个成员就是单聊。</p>
      )}
    </div>
  );
}
