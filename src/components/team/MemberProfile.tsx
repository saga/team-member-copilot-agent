import { useState } from 'react';
import { Drawer, Tabs, Tag } from 'antd';
import type { Member } from '../../lib/api';
import { MemberEditor } from './MemberEditor';
import { MemberMemory } from './MemberMemory';
import { MemberSkills } from './MemberSkills';
import { MemberActivity } from './MemberActivity';

interface MemberProfileProps {
  member: Member;
  onSaved: (member: Member) => void;
  onClose: () => void;
}

type TabKey = 'profile' | 'memory' | 'team' | 'skills';

/**
 * Member 的详情抽屉。用 Drawer 而不用 Modal：这是「对象详情」，
 * 不是一次性对话框 —— 用户会开着它对照聊天内容改。
 *
 * 四个页签对应 Member 模型的四块：
 *
 *   Profile —— 它是谁（跨 Team 稳定的人格）
 *   Memory  —— 跨 Team 稳定的长期习惯
 *   Team Context —— 只属于当前 Team 的上下文
 *   Skills  —— 这个 Member 自己的 skill 目录
 */
export function MemberProfile({ member, onSaved, onClose }: MemberProfileProps) {
  const [tab, setTab] = useState<TabKey>('profile');

  return (
    <Drawer
      open
      onClose={onClose}
      width={520}
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
          { key: 'team', label: 'Team Context' },
          { key: 'skills', label: 'Skills' },
        ]}
      />
      {tab === 'profile' && (
        <MemberEditor member={member} onSaved={onSaved} onCancel={onClose} />
      )}
      {tab === 'memory' && <MemberMemory member={member} kind="global" />}
      {tab === 'team' && <MemberMemory member={member} kind="team" />}
      {tab === 'skills' && <MemberSkills member={member} />}
      <div style={{ marginTop: 16 }}>
        <MemberActivity member={member} />
      </div>
    </Drawer>
  );
}
