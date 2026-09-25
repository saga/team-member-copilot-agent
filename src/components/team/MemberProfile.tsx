import { useState } from 'react';
import type { Member } from '../../lib/api';
import { MemberEditor } from './MemberEditor';

interface MemberProfileProps {
  member: Member;
  onSaved: (member: Member) => void;
  onClose: () => void;
}

type TabKey = 'profile';

/**
 * Member 的主页。刻意用 tab 把「它是谁」「它记得什么」分开：
 *
 *   Profile —— name / handle / role / personality / system prompt / model / tools
 *   Memory  —— 跨 conversation 的长期记忆
 *   Skills  —— 这个 Member 自己的 skill 目录
 *
 * 三者都是 Member 级（跨 conversation 稳定）的东西，落在 member home 下，
 * 不属于任何 conversation。Runtime / workspace 才是 per-conversation 的。
 */
export function MemberProfile({ member, onSaved, onClose }: MemberProfileProps) {
  const [tab, setTab] = useState<TabKey>('profile');

  const tabs: Array<{ key: TabKey; label: string }> = [{ key: 'profile', label: 'Profile' }];

  return (
    <div className="profile-overlay" role="dialog" aria-label={`${member.name} 的档案`}>
      <div className="profile-panel">
        <header className="profile-head">
          <div>
            <h2>{member.name}</h2>
            <p className="sub">
              @{member.handle} · {member.role}
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <nav className="tab-bar">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.key === tab ? 'tab selected' : 'tab'}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="profile-body">
          {tab === 'profile' && (
            <MemberEditor member={member} onSaved={onSaved} onCancel={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
