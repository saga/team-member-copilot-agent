import { useState } from 'react';
import { Button, Input, Space } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { Conversation } from '../../lib/api';
import { ConversationList } from '../team/ConversationList';

interface TaskSidebarProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onNewTask: () => void;
}

/**
 * 工作区第二列：只装 Task 工作区。
 *
 * 这里只允许出现搜索、Tasks 分组、New task。创建表单不在这里 ——
 * 按钮只负责打开挂在页面根部的 Modal。
 */
export function TaskSidebar({
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNewTask,
}: TaskSidebarProps) {
  const [search, setSearch] = useState('');

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 这一列装的全是 Task 工作区，不放总标题 —— 分区头才承载类型信息。 */}
      <Input
        allowClear
        size="small"
        placeholder="搜索任务"
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
        <Button type="primary" block icon={<PlusOutlined />} onClick={onNewTask}>
          New task
        </Button>
      </Space>
    </div>
  );
}
