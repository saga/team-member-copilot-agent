import { useState } from 'react';
import { Button, Input, Space } from 'antd';
import { PlusOutlined, ProjectOutlined, SearchOutlined } from '@ant-design/icons';
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
      {/* 这一列装的全是会话，不再放「Conversations」总标题 ——
          它和第一个分区头 Discussions 撞名，看着像上下级却说不清；分区头才承载类型信息。 */}
      <Input
        allowClear
        size="small"
        placeholder="Search"
        prefix={<SearchOutlined style={{ color: '#bbb' }} />}
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
