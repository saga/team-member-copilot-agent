import type { Conversation, Member } from '../../lib/api';
import { GroupCreator } from './GroupCreator';
import { isMemberDm } from './constants';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  members: Member[];
  showCreator: boolean;
  onToggleCreator: () => void;
  onCancelCreator: () => void;
  onCreateGroup: (input: { title: string; memberIds: string[]; projectId?: string | null }) => Promise<void>;
}

/**
 * 副标题。
 *
 * Member 之间的私聊和用户单聊共用 `kind = 'direct'`，只显示 kind 会让两者
 * 在列表里长得一模一样 —— 一个是「我跟 Alice 说话」，一个是「Alice 和 Bob
 * 在说话」，用户一眼要能分清。
 */
function describeConversation(conversation: Conversation): string {
  if (isMemberDm(conversation)) {
    return `private · ${conversation.members.length} members`;
  }
  if (conversation.kind === 'group') {
    return `group · ${conversation.members.length} members`;
  }
  return conversation.kind;
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
          <span>{describeConversation(conversation)}</span>
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
