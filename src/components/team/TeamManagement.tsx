import { Tabs } from 'antd';
import type { Conversation, Member } from '../../lib/api';
import { MemberList } from './MemberList';
import { CurrentWorkSection } from './TeamSections';
import { ScheduleSection } from './ScheduleSection';

/**
 * Team 管理面：工作面只管聊天，这里管「这个 Team 是什么样」。
 *
 * 三个页签各管一件事 —— 成员是谁、正在跑什么、定时了什么。
 * Capabilities 不在这里，它在 Settings。
 */
export function TeamManagement({
  members,
  conversations,
  showNewMember,
  onToggleNewMember,
  onCreateMember,
  onCancelNewMember,
  onChatMember,
  onViewMember,
  onManageMemberCapabilities,
  onArchiveMember,
}: {
  members: Member[];
  conversations: Conversation[];
  showNewMember: boolean;
  onToggleNewMember: () => void;
  onCreateMember: (input: { name: string; role: string }) => Promise<void>;
  onCancelNewMember: () => void;
  onChatMember: (member: Member) => void;
  onViewMember: (member: Member) => void;
  onManageMemberCapabilities: (member: Member) => void;
  onArchiveMember: (member: Member) => void;
}) {
  return (
    <div style={{ padding: '12px 18px', overflowY: 'auto', height: '100%' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Team</h2>
      <Tabs
        defaultActiveKey="members"
        items={[
          {
            key: 'members',
            label: `Members (${members.length})`,
            children: (
              <MemberList
                members={members}
                showNewMember={showNewMember}
                onToggleNewMember={onToggleNewMember}
                onCreateMember={onCreateMember}
                onCancelNewMember={onCancelNewMember}
                onChat={onChatMember}
                onViewProfile={onViewMember}
                onManageCapabilities={onManageMemberCapabilities}
                onArchive={onArchiveMember}
              />
            ),
          },
          {
            key: 'work',
            label: 'Current Work',
            children: <CurrentWorkSection />,
          },
          {
            key: 'automation',
            label: 'Automation',
            children: <ScheduleSection members={members} conversations={conversations} />,
          },
        ]}
      />
    </div>
  );
}
