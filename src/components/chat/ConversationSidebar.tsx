import { useState } from 'react';
import { Input } from 'antd';
import type { Conversation, Member } from '../../lib/api';
import { ConversationList } from '../team/ConversationList';
import type { WorkDraft } from '../team/WorkCreator';

interface ConversationSidebarProps {
  members: Member[];
  conversations: Conversation[];
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  showGroupCreator: boolean;
  onToggleGroupCreator: () => void;
  onCancelGroupCreator: () => void;
  onCreateGroup: (input: {
    title: string;
    memberIds: string[];
    externalWorkRef?: { provider?: 'jira'; key: string } | null;
  }) => Promise<void>;
  showWorkCreator: boolean;
  onToggleWorkCreator: () => void;
  onCancelWorkCreator: () => void;
  onCreateWork: (input: WorkDraft) => Promise<void>;
}

/**
 * 聊天工作面的第二列：只装会话。
 *
 * 这里只允许出现 Search、会话分组（Team discussions / Work / Direct）、
 * New Team、New Work。成员管理、Current Work、Schedules 都在 Team 管理面，
 * 不在这里。
 */
export function ConversationSidebar(props: ConversationSidebarProps) {
  const { members, conversations, selectedConversationId, onSelectConversation } = props;
  const [search, setSearch] = useState('');

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ fontSize: 13, fontWeight: 600, padding: '4px 4px 8px' }}>Conversations</div>
      <Input.Search
        allowClear
        size="small"
        placeholder="Search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 4 }}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <ConversationList
          conversations={conversations}
          selectedId={selectedConversationId}
          onSelect={onSelectConversation}
          members={members}
          search={search}
          showCreator={props.showGroupCreator}
          onToggleCreator={props.onToggleGroupCreator}
          onCancelCreator={props.onCancelGroupCreator}
          onCreateGroup={props.onCreateGroup}
          showWorkCreator={props.showWorkCreator}
          onToggleWorkCreator={props.onToggleWorkCreator}
          onCancelWorkCreator={props.onCancelWorkCreator}
          onCreateWork={props.onCreateWork}
        />
      </div>
    </div>
  );
}
