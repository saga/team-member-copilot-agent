import type { Conversation, Member } from '../../lib/api';
import { GroupCreator } from './GroupCreator';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  members: Member[];
  showCreator: boolean;
  onToggleCreator: () => void;
  onCancelCreator: () => void;
  onCreateGroup: (input: { title: string; memberIds: string[] }) => Promise<void>;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  members,
  showCreator,
  onToggleCreator,
  onCancelCreator,
  onCreateGroup,
}: ConversationListProps) {
  return (
    <div className="sidebar-section">
      <div className="sidebar-title">Conversations</div>

      {conversations.map((conversation) => (
        <button
          key={conversation.id}
          type="button"
          className={
            conversation.id === selectedId ? 'conversation-row selected' : 'conversation-row'
          }
          onClick={() => onSelect(conversation.id)}
        >
          <strong>{conversation.title}</strong>
          <span>
            {conversation.kind}
            {conversation.kind !== 'direct' ? ` · ${conversation.members.length} members` : ''}
          </span>
        </button>
      ))}

      {showCreator ? (
        <GroupCreator members={members} onCreate={onCreateGroup} onCancel={onCancelCreator} />
      ) : (
        <button type="button" className="group-button" onClick={onToggleCreator}>
          + New Team
        </button>
      )}
    </div>
  );
}
