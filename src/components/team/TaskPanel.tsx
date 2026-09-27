import { Button, Space, Tag, Typography } from 'antd';
import type { Conversation, ConversationTask } from '../../lib/api';

interface TaskPanelProps {
  conversation: Conversation;
  tasks: ConversationTask[];
  memberLabel: (id: string) => string;
  onRetryTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
}

const STATUS_COLOR: Record<ConversationTask['status'], string> = {
  pending: 'default',
  ready: 'blue',
  running: 'processing',
  blocked: 'error',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
};

const STATUS_ICON: Record<ConversationTask['status'], string> = {
  pending: '○',
  ready: '○',
  running: '●',
  blocked: '!',
  completed: '✓',
  failed: '×',
  cancelled: '−',
};

/**
 * 工作区左侧：目标 + 任务列表 + 进展。
 *
 * 不拆成五六个小组件：第一版一个文件够了，第二个调用方出现时再抽。
 */
export function TaskPanel({ conversation, tasks, memberLabel, onRetryTask, onCancelTask }: TaskPanelProps) {
  const done = tasks.filter((task) => task.status === 'completed').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          目标
        </Typography.Text>
        <Typography.Paragraph style={{ margin: '2px 0 0' }}>
          {conversation.objective || '还没有确定目标 —— 在右边说清楚要做什么，Lead 会先确认目标。'}
        </Typography.Paragraph>
        {conversation.openQuestions.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              等你回答
            </Typography.Text>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {conversation.openQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          任务
        </Typography.Text>
        {tasks.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {done}/{tasks.length} 完成
          </Typography.Text>
        )}
      </div>

      {tasks.length === 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          还没有任务。Lead 确认目标后会在这里列出任务并自动开始。
        </Typography.Text>
      )}

      <div style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tasks.map((task) => (
          <div
            key={task.id}
            style={{
              border: '1px solid #eee',
              borderRadius: 6,
              padding: '8px 10px',
              background: task.status === 'blocked' || task.status === 'failed' ? '#fff7f7' : '#fff',
            }}
          >
            <Space size={6} align="center">
              <span>{STATUS_ICON[task.status]}</span>
              <Typography.Text strong>{task.title}</Typography.Text>
            </Space>
            <div style={{ marginTop: 2 }}>
              <Space size={4}>
                <Tag color={STATUS_COLOR[task.status]}>{task.status}</Tag>
                <Tag>{memberLabel(task.assigneeMemberId)}</Tag>
              </Space>
            </div>
            {task.description && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 0' }} ellipsis={{ rows: 2 }}>
                {task.description}
              </Typography.Paragraph>
            )}
            {task.acceptanceCriteria.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: '#666' }}>
                {task.acceptanceCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            )}
            {task.blocker && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                卡住原因：{task.blocker}
              </Typography.Text>
            )}
            {task.result && task.status === 'completed' && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 0' }} ellipsis={{ rows: 2 }}>
                {task.result}
              </Typography.Paragraph>
            )}
            {(task.status === 'blocked' || task.status === 'failed' || task.status === 'cancelled') && (
              <div style={{ marginTop: 6 }}>
                <Space size={6}>
                  <Button size="small" onClick={() => onRetryTask(task.id)}>
                    重试
                  </Button>
                  {task.status !== 'cancelled' && (
                    <Button size="small" danger onClick={() => onCancelTask(task.id)}>
                      取消
                    </Button>
                  )}
                </Space>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
