import { useEffect, useState } from 'react';
import { Card, Empty, List, Tag } from 'antd';
import { api, type CurrentActivity } from '../../lib/api';
import { useTeamEvents } from '../../lib/useTeamEvents';

/**
 * Current Work：谁在干什么。
 *
 * 业务工作以 Jira 为唯一事实源 —— 这里只展示「哪个 Member 正在跑哪张工单的
 * 哪一轮」，工单的标题 / 状态 / 负责人在 Jira 上看（本地不复制，也就不会腐烂）。
 * 数据 = active execution；没有独立的 activity 存储。
 */
export function CurrentWorkSection() {
  const [activity, setCurrentWork] = useState<CurrentActivity[]>([]);

  async function refresh() {
    try {
      setCurrentWork((await api.listCurrentActivity()).activity);
    } catch {
      // Team 未初始化时保持空列表，不挡主界面
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useTeamEvents((type) => {
    if (type === 'member.activity.changed') void refresh();
  });

  return (
    <Card size="small" bordered={false} style={{ marginBottom: 8 }} title="Current Work">
      {activity.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No member is working right now" />
      ) : (
        <List
          size="small"
          dataSource={activity}
          renderItem={(item) => (
            <List.Item>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.jiraIssueKey ? <Tag color="blue">{item.jiraIssueKey}</Tag> : null}
                  <span>{item.memberName}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary, #999)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.conversationTitle} · {item.status}
                </div>
              </div>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}
