import { Collapse } from 'antd';
import type { Conversation, Member } from '../../lib/api';
import { ConversationList } from './ConversationList';
import { MemberList } from './MemberList';
import { ProjectSection, ScheduleSection, WorkSection } from './TeamSections';

interface TeamSidebarProps {
  members: Member[];
  conversations: Conversation[];
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;

  showNewMember: boolean;
  onToggleNewMember: () => void;
  onCreateMember: (input: { name: string; role: string }) => Promise<void>;
  onCancelNewMember: () => void;

  onChatMember: (member: Member) => void;
  onEditMember: (member: Member) => void;

  showGroupCreator: boolean;
  onToggleGroupCreator: () => void;
  onCancelGroupCreator: () => void;
  onCreateGroup: (input: { title: string; memberIds: string[]; projectId?: string | null }) => Promise<void>;
}

/** 左栏：Members / Projects / Work / Schedules / Conversations 五个分区。只负责排布与转发。 */
export function TeamSidebar(props: TeamSidebarProps) {
  const {
    members,
    conversations,
    selectedConversationId,
    onSelectConversation,
    showNewMember,
    onToggleNewMember,
    onCreateMember,
    onCancelNewMember,
    onChatMember,
    onEditMember,
    showGroupCreator,
    onToggleGroupCreator,
    onCancelGroupCreator,
    onCreateGroup,
  } = props;

  return (
    <Collapse
      defaultActiveKey={['members', 'conversations']}
      ghost
      style={{ padding: 8 }}
      items={[
        {
          key: 'members',
          label: `Team Members (${members.length})`,
          children: (
            <MemberList
              members={members}
              showNewMember={showNewMember}
              onToggleNewMember={onToggleNewMember}
              onCreateMember={onCreateMember}
              onCancelNewMember={onCancelNewMember}
              onChat={onChatMember}
              onEdit={onEditMember}
            />
          ),
        },
        {
          key: 'projects',
          label: 'Projects',
          children: <ProjectSection />,
        },
        {
          key: 'work',
          label: 'Work',
          children: <WorkSection members={members} />,
        },
        {
          key: 'schedules',
          label: 'Schedules',
          children: <ScheduleSection />,
        },
        {
          key: 'conversations',
          label: `Conversations (${conversations.length})`,
          children: (
            <ConversationList
              conversations={conversations}
              selectedId={selectedConversationId}
              onSelect={onSelectConversation}
              members={members}
              showCreator={showGroupCreator}
              onToggleCreator={onToggleGroupCreator}
              onCancelCreator={onCancelGroupCreator}
              onCreateGroup={onCreateGroup}
            />
          ),
        },
      ]}
    />
  );
}
