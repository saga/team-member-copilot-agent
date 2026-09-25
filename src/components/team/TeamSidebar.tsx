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

/** 左栏：Members / Projects / Work / Conversations。只负责排布与转发。 */
export function TeamSidebar({
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
}: TeamSidebarProps) {
  return (
    <aside className="team-sidebar">
      <MemberList
        members={members}
        showNewMember={showNewMember}
        onToggleNewMember={onToggleNewMember}
        onCreateMember={onCreateMember}
        onCancelNewMember={onCancelNewMember}
        onChat={onChatMember}
        onEdit={onEditMember}
      />

      <ProjectSection />

      <WorkSection members={members} />

      <ScheduleSection />

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
    </aside>
  );
}
