import { useState } from 'react';
import { Button, Input, Space } from 'antd';
import { PlusOutlined, ProjectOutlined } from '@ant-design/icons';
import type { Conversation } from '../../lib/api';
import { ConversationList } from '../team/ConversationList';

interface ConversationSidebarProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onNewDiscussion: () => void;
  onNewWork: () => void;
}

/**
 * 聊天工作面的第二列：只装会话。
 *
 * 这里只允许出现 Search、会话分组（Discussions / Work / Direct）、
 * New discussion、New work。创建表单不在这里 —— 两个按钮只负责打开
 * 挂在页面根部的 Modal。成员管理、Current Work、Automation
 * 都在 Team 管理面，不在这里。
 */
export function ConversationSidebar({
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNewDiscussion,
  onNewWork,
}: ConversationSidebarProps) {
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
          search={search}
        />
      </div>
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        <Button type="primary" block icon={<PlusOutlined />} onClick={onNewDiscussion}>
          New discussion
        </Button>
        <Button block icon={<ProjectOutlined />} onClick={onNewWork}>
          New work
        </Button>
      </Space>
    </div>
  );
}
