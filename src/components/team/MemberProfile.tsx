import { useState } from 'react';
import { Drawer, Tabs, Typography } from 'antd';
import type { Member, ModelPolicy } from '../../lib/api';
import { MemberEditor } from './MemberEditor';
import { MemberMemory } from './MemberMemory';
import { MemberSkills } from './MemberSkills';
import { MemberActivity } from './MemberActivity';

interface MemberProfileProps {
  member: Member;
  /** 服务端模型策略：展示这个人的 Task 模型与 Lead 模型，编辑器共用。 */
  modelPolicy: ModelPolicy | null;
  onSaved: (member: Member) => void;
  onClose: () => void;
}

type TabKey = 'profile' | 'memory' | 'skills';

/**
 * Member 的详情抽屉。用 Drawer 而不用 Modal：这是「对象详情」，
 * 不是一次性对话框 —— 用户会开着它对照工作区内容改。
 *
 * 三个页签对应 Member 模型的三块：
 *
 *   Profile —— Identity & Work Contract
 *   Memory  —— 跨 Team 稳定的长期记忆
 *   Skills  —— 这个 Member 自己的 skill 目录
 *
 * `seedKey` 是 provisioning 元数据（这一行最初由哪份模板建出来），只存在库里，
 * 不在这里显示：它是给「重装 / 排查」用的，不是这个人的身份。
 */
export function MemberProfile({ member, modelPolicy, onSaved, onClose }: MemberProfileProps) {
  const [tab, setTab] = useState<TabKey>('profile');
  const taskModel = member.model ?? modelPolicy?.defaultMemberModel ?? '团队默认';

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
          </span>
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
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            默认 Task 模型：{taskModel}
            {modelPolicy &&
              `；担任 Lead 时，普通工作使用 ${modelPolicy.lead.standard.id}，` +
              `需要规划、综合或恢复时自动升级到 ${modelPolicy.lead.strong.id}。`}
          </Typography.Paragraph>
          <MemberEditor member={member} modelPolicy={modelPolicy} onSaved={onSaved} onCancel={onClose} />
        </>
      )}
      {tab === 'memory' && <MemberMemory member={member} />}
      {tab === 'skills' && <MemberSkills member={member} />}
      <div style={{ marginTop: 16 }}>
        <MemberActivity member={member} />
      </div>
    </Drawer>
  );
}
