import { useState } from 'react';
import { Modal, Tabs, Tag } from 'antd';
import type { Member } from '../../lib/api';
import { MemberEditor } from './MemberEditor';
import { MemberMemory } from './MemberMemory';
import { MemberSkills } from './MemberSkills';

interface MemberProfileProps {
  member: Member;
  onSaved: (member: Member) => void;
  onClose: () => void;
}

type TabKey = 'profile' | 'memory' | 'skills';

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

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={720}
      title={
        <>
          {member.name}{' '}
          <span style={{ color: '#999', fontWeight: 400, fontSize: 13 }}>
            @{member.handle} · {member.role}
          </span>{' '}
          {member.seedKey && (
            <Tag title="由 member template provision；修改 Profile 不会回写模板">
              from {member.seedKey}
            </Tag>
          )}
        </>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as TabKey)}
        items={[
          { key: 'profile', label: 'Profile' },
          { key: 'memory', label: 'Memory' },
          { key: 'skills', label: 'Skills' },
        ]}
      />
      {tab === 'profile' && (
        <MemberEditor member={member} onSaved={onSaved} onCancel={onClose} />
      )}
      {tab === 'memory' && <MemberMemory member={member} />}
      {tab === 'skills' && <MemberSkills member={member} />}
    </Modal>
  );
}
