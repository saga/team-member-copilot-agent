import { Button, Progress, Typography } from 'antd';
import type { Conversation, ConversationTask } from '../../lib/api';
import { TASK_STATUS_TEXT } from './constants';

interface TaskPanelProps {
  conversation: Conversation;
  tasks: ConversationTask[];
  memberLabel: (id: string) => string;
  onRetryTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
}

const STATUS_ICON: Record<ConversationTask['status'], string> = {
  pending: '○',
  ready: '○',
  running: '●',
  blocked: '!',
  completed: '✓',
  failed: '×',
  cancelled: '−',
};

const sectionLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#595959',
  letterSpacing: '0.04em',
};

/**
 * 右侧 Task Inspector：Goal + Progress + Tasks。
 *
 * 只显示 title / status / assignee / blocker，完成结果最多一行省略。
 * description 与 acceptance criteria 不在这里展开 —— 它们是执行细节，
 * 去 execution 里看。这里回答「做到哪了、谁在做、卡在哪」就够了。
 *
 * 只读（Retry / Cancel 除外）：Task 的正常变更路径是 Lead 的 plan（仅一次）
 * 和执行人的 update_task。
 */
export function TaskPanel({ conversation, tasks, memberLabel, onRetryTask, onCancelTask }: TaskPanelProps) {
  const done = tasks.filter((task) => task.status === 'completed').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <section>
        <Typography.Text style={sectionLabel}>Goal</Typography.Text>
        <Typography.Paragraph style={{ margin: '4px 0 0', fontSize: 13 }}>
          {conversation.objective || '还没有确定目标 —— 在下方说清楚要做什么，Lead 会先确认目标。'}
        </Typography.Paragraph>
        {conversation.openQuestions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Typography.Text style={{ ...sectionLabel, color: '#c7742c' }}>等你回答</Typography.Text>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {conversation.openQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <Typography.Text style={sectionLabel}>Progress</Typography.Text>
        <div style={{ marginTop: 4, fontSize: 13 }}>
          {tasks.length > 0 ? `${done} / ${tasks.length}` : '还没有任务'}
        </div>
        {tasks.length > 0 && (
          <Progress
            percent={Math.round((done / tasks.length) * 100)}
            size="small"
            showInfo={false}
            style={{ margin: '6px 0 0' }}
          />
        )}
        {tasks.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Lead 确认目标后会在这里列出任务并自动开始。
          </Typography.Text>
        )}
      </section>

      <section style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography.Text style={sectionLabel}>Tasks</Typography.Text>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tasks.map((task) => (
            <div key={task.id} style={{ fontSize: 13 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                <span style={{ flexShrink: 0 }}>{STATUS_ICON[task.status]}</span>
                <Typography.Text strong ellipsis style={{ minWidth: 0 }} title={task.title}>
                  {task.title}
                </Typography.Text>
              </div>
              <div
                style={{
                  marginTop: 2,
                  paddingLeft: 16,
                  color: '#8c8c8c',
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {memberLabel(task.assigneeMemberId)} · {TASK_STATUS_TEXT[task.status] ?? task.status}
              </div>
              {task.blocker && (
                <div style={{ paddingLeft: 16, marginTop: 2, fontSize: 12 }}>
                  <Typography.Text type="danger" ellipsis title={task.blocker}>
                    {task.blocker}
                  </Typography.Text>
                </div>
              )}
              {task.result && task.status === 'completed' && (
                <div style={{ paddingLeft: 16, marginTop: 2 }}>
                  <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }} title={task.result}>
                    {task.result}
                  </Typography.Text>
                </div>
              )}
              {(task.status === 'blocked' || task.status === 'failed' || task.status === 'cancelled') && (
                <div style={{ paddingLeft: 16, marginTop: 4, display: 'flex', gap: 6 }}>
                  <Button size="small" onClick={() => onRetryTask(task.id)}>
                    重试
                  </Button>
                  {task.status !== 'cancelled' && (
                    <Button size="small" danger onClick={() => onCancelTask(task.id)}>
                      取消
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
