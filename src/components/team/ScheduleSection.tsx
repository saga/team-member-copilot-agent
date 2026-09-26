import { useEffect, useState } from 'react';
import { Button, Card, List, Space, Tag } from 'antd';
import { api, type Conversation, type Member, type ScheduledWake } from '../../lib/api';
import { ScheduleForm } from './ScheduleForm';

const STATUS_COLORS: Record<ScheduledWake['status'], string> = {
  active: 'processing',
  paused: 'warning',
  completed: 'success',
  cancelled: 'default',
};

/**
 * Schedules 分区：全部 schedule（不只 active）+ 行内 Pause/Resume/Cancel。
 *
 * 之前是「只读列表」：后端有 durable scheduler、恢复、幂等 run，UI 却什么
 * 都不能运营。第一版只做 Create / Pause / Resume / Cancel，不做 Calendar。
 */
export function ScheduleSection({
  members,
  conversations,
}: {
  members: Member[];
  conversations: Conversation[];
}) {
  const [schedules, setSchedules] = useState<ScheduledWake[]>([]);

  async function refresh() {
    try {
      setSchedules((await api.listSchedules()).schedules);
    } catch {
      // Team 未初始化时保持空列表
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, []);

  function act(id: string, action: 'pause' | 'resume' | 'cancel') {
    const fn = action === 'pause' ? api.pauseSchedule : action === 'resume' ? api.resumeSchedule : api.cancelSchedule;
    void fn(id)
      .then(refresh)
      .catch(() => refresh());
  }

  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card size="small" bordered={false} title={`Schedules (${schedules.length})`} style={{ marginBottom: 8 }}>
      <ScheduleForm members={members} conversations={conversations} onCreated={() => void refresh()} />
      <List
        size="small"
        dataSource={schedules}
        locale={{ emptyText: '还没有自动任务。' }}
        renderItem={(schedule) => (
          <List.Item
            actions={
              schedule.status === 'active'
                ? [
                    <Button key="pause" type="link" size="small" onClick={() => act(schedule.id, 'pause')}>
                      Pause
                    </Button>,
                    <Button key="cancel" type="link" size="small" danger onClick={() => act(schedule.id, 'cancel')}>
                      Cancel
                    </Button>,
                  ]
                : schedule.status === 'paused'
                  ? [
                      <Button key="resume" type="link" size="small" onClick={() => act(schedule.id, 'resume')}>
                        Resume
                      </Button>,
                      <Button key="cancel" type="link" size="small" danger onClick={() => act(schedule.id, 'cancel')}>
                        Cancel
                      </Button>,
                    ]
                  : []
            }
          >
            <List.Item.Meta
              title={schedule.prompt.slice(0, 60)}
              description={
                <Space size={4}>
                  <span>{memberName(schedule.memberId)}</span>
                  <span>·</span>
                  <span>{schedule.type}</span>
                  <span>·</span>
                  <span>next {schedule.nextRunAt.slice(0, 16).replace('T', ' ')}</span>
                  {schedule.lastError && (
                    <>
                      <span>·</span>
                      <span style={{ color: '#cf1322' }}>last error: {schedule.lastError.slice(0, 40)}</span>
                    </>
                  )}
                </Space>
              }
            />
            <Tag color={STATUS_COLORS[schedule.status]}>{schedule.status}</Tag>
          </List.Item>
        )}
      />
    </Card>
  );
}
