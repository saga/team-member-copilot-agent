import { useState } from 'react';
import { Button, Drawer, List, Select, Space, Tag } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import { api, type WorkItem, type WorkItemEvent, type WorkItemStatus } from '../../lib/api';

/**
 * 单条 WorkItem 的操作行。
 *
 * 语义边界（不要破坏）：Human = Coordinator —— Assign / Release / 改状态都在这里；
 * Agent = Worker —— 它的 claim 只能由「Execution → claim tool」发起，
 * UI 上没有也不该有「替 Agent 点 claim」的按钮。
 */
export function WorkItemRow({
  item,
  members,
  onChanged,
}: {
  item: WorkItem;
  members: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [events, setEvents] = useState<WorkItemEvent[]>([]);

  async function openHistory() {
    setHistoryOpen(true);
    try {
      setEvents((await api.listWorkItemEvents(item.id)).events);
    } catch {
      // 打开抽屉失败不打断列表；下次打开会重试
    }
  }

  function describeEvent(event: WorkItemEvent): string {
    const actor = `${event.actorKind}:${event.actorId.slice(0, 8)}`;
    switch (event.eventType) {
      case 'created':
        return `${actor} 创建了任务`;
      case 'updated':
        return `${actor} 更新了标题 / 描述`;
      case 'status_changed':
        return `${actor} 把状态从 ${event.fromStatus} 改为 ${event.toStatus}`;
      case 'assigned':
        return `${actor} 指派给了 ${event.toAssigneeKind}:${event.toAssigneeId?.slice(0, 8) ?? ''}`;
      case 'unassigned':
        return `${actor} 取消了指派（原 ${event.fromAssigneeKind}:${event.fromAssigneeId?.slice(0, 8) ?? ''}）`;
      case 'claimed':
        return `${actor} claim（execution ${event.executionId?.slice(0, 8) ?? '-'}）`;
      case 'released':
        return `${actor} 释放了 claim${event.executionId ? `（execution ${event.executionId.slice(0, 8)}）` : ''}`;
      default:
        return actor;
    }
  }

  return (
    <List.Item
      actions={[
        <Select
          key="assignee"
          size="small"
          value={item.assigneeId}
          style={{ minWidth: 130 }}
          placeholder="Unassigned"
          allowClear
          onChange={(value) => {
            void api
              .assignWorkItem(item.id, value ? { kind: 'agent', principalId: value } : null)
              .then(onChanged)
              .catch(() => onChanged());
          }}
          options={members.map((m) => ({ value: m.id, label: m.name }))}
        />,
        <Select
          key="status"
          size="small"
          value={item.status}
          style={{ minWidth: 110 }}
          onChange={(value: WorkItemStatus) => {
            void api.updateWorkItem(item.id, { status: value }).then(onChanged).catch(() => onChanged());
          }}
          options={[
            { value: 'todo', label: 'Todo' },
            { value: 'in_progress', label: 'In Progress' },
            { value: 'blocked', label: 'Blocked' },
            { value: 'done', label: 'Done' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />,
        ...(item.claimedByMemberId
          ? [
              <Button
                key="release"
                type="link"
                size="small"
                onClick={() => void api.releaseWorkItem(item.id).then(onChanged).catch(() => onChanged())}
              >
                Release
              </Button>,
            ]
          : []),
        <Button key="history" type="link" size="small" icon={<HistoryOutlined />} onClick={() => void openHistory()}>
          History
        </Button>,
      ]}
    >
      <List.Item.Meta
        title={
          <Space size={4}>
            <span>{item.title}</span>
            <Tag color={STATUS_COLORS[item.status]} style={{ marginInlineEnd: 0 }}>
              {item.status}
            </Tag>
            {item.claimedByMemberId && (
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                claimed
              </Tag>
            )}
          </Space>
        }
        description={
          item.claimedByMemberId
            ? `claimed by ${members.find((m) => m.id === item.claimedByMemberId)?.name ?? item.claimedByMemberId.slice(0, 8)}`
            : undefined
        }
      />
      <Drawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title={`Activity History · ${item.title}`}
        width={420}
      >
        <List
          size="small"
          dataSource={events}
          locale={{ emptyText: '还没有记录。' }}
          renderItem={(event) => (
            <List.Item>
              <List.Item.Meta
                title={describeEvent(event)}
                description={event.createdAt.slice(0, 19).replace('T', ' ')}
              />
            </List.Item>
          )}
        />
      </Drawer>
    </List.Item>
  );
}

const STATUS_COLORS: Record<WorkItemStatus, string> = {
  todo: 'default',
  in_progress: 'processing',
  blocked: 'warning',
  done: 'success',
  cancelled: 'default',
};
