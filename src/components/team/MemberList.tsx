import { useEffect, useState } from 'react';
import { api, type Member, type TeamPresence } from '../../lib/api';
import { NewMemberForm } from './NewMemberForm';

interface MemberListProps {
  members: Member[];
  showNewMember: boolean;
  onToggleNewMember: () => void;
  onCreateMember: (input: { name: string; role: string }) => Promise<void>;
  onCancelNewMember: () => void;
  onChat: (member: Member) => void;
  onEdit: (member: Member) => void;
}

/**
 * 侧栏的 Team Members。
 *
 * 每一行是两个独立动作：
 *   Chat —— 打开/复用这个 Member 的 1:1 房间
 *   Edit —— 打开档案页（人格 / 记忆 / skill）
 *
 * 合成一个 handler 会把「改一下它的 system prompt」变成「顺手开了个新会话」。
 */
export function MemberList({
  members,
  showNewMember,
  onToggleNewMember,
  onCreateMember,
  onCancelNewMember,
  onChat,
  onEdit,
}: MemberListProps) {
  // Team presence：只读显示，不替换房间内的 working/muted。
  const [presence, setPresence] = useState<Record<string, TeamPresence>>({});
  useEffect(() => {
    api
      .listPresence()
      .then((result) => {
        const map: Record<string, TeamPresence> = {};
        for (const item of result.presence) {
          if (item.kind === 'agent') map[item.principalId] = item;
        }
        setPresence(map);
      })
      .catch(() => {});
  }, [members.length]);

  return (
    <div className="sidebar-section">
      <div className="sidebar-title">
        Team Members
        <button type="button" onClick={onToggleNewMember} aria-label="新建 Member">
          {showNewMember ? '×' : '+'}
        </button>
      </div>

      {showNewMember && (
        <NewMemberForm onCreate={onCreateMember} onCancel={onCancelNewMember} />
      )}

      {members.length === 0 && <p className="sidebar-hint">还没有 Member，点 + 创建一个。</p>}

      {members.map((member) => (
        <div key={member.id} className="member-row">
          <div className="member-row-ident">
            <strong>
              {member.name} · {presence[member.id]?.availability ?? 'available'}
            </strong>
            <span>{member.role}</span>
          </div>
          <div className="member-row-actions">
            <button type="button" onClick={() => onChat(member)}>
              Chat
            </button>
            <button type="button" className="ghost" onClick={() => onEdit(member)}>
              Edit
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
