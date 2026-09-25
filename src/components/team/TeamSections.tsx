import { useEffect, useState } from 'react';
import { Button, Card, Input, List, Space, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api, type Project, type ScheduledWake, type WorkItem } from '../../lib/api';

/** Projects：只有列表 + 新建，不做完整 Project 页。 */
export function ProjectSection({ onChanged }: { onChanged?: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setProjects((await api.listProjects()).projects);
    } catch {
      // Team 未初始化时保持空列表，不挡主界面
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createProject({ name: name.trim() });
      setName('');
      await refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="small" bordered={false} style={{ marginBottom: 8 }}>
      <List
        size="small"
        dataSource={projects}
        locale={{ emptyText: '还没有 Project。' }}
        renderItem={(project) => (
          <List.Item>
            <List.Item.Meta
              title={project.name}
              description={project.status !== 'active' ? project.status : project.description || undefined}
            />
            {project.status !== 'active' && <Tag color="default">{project.status}</Tag>}
          </List.Item>
        )}
      />
      <Space.Compact block>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project" size="small" />
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => void create()} disabled={!name.trim()} loading={busy}>
          Add
        </Button>
      </Space.Compact>
    </Card>
  );
}

/** Work：按 status 分组的最简列表，不做拖拽 Kanban。 */
export function WorkSection({ members }: { members: { id: string; name: string }[] }) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setItems((await api.listWorkItems()).workItems);
    } catch {
      // 同上
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, []);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.createWorkItem({ title: title.trim() });
      setTitle('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const groups: { key: string; label: string; color: string; items: WorkItem[] }[] = [
    { key: 'todo', label: 'Todo', color: 'default', items: items.filter((i) => i.status === 'todo') },
    { key: 'in_progress', label: 'In Progress', color: 'processing', items: items.filter((i) => i.status === 'in_progress') },
    { key: 'blocked', label: 'Blocked', color: 'warning', items: items.filter((i) => i.status === 'blocked') },
    { key: 'done', label: 'Done', color: 'success', items: items.filter((i) => i.status === 'done') },
  ];

  return (
    <Card size="small" bordered={false} style={{ marginBottom: 8 }}>
      {groups.map((group) => (
        <div key={group.key} style={{ marginBottom: 8 }}>
          <Tag color={group.color}>
            {group.label} {group.items.length}
          </Tag>
          <List
            size="small"
            dataSource={group.items.slice(0, 8)}
            locale={{ emptyText: undefined }}
            renderItem={(item) => (
              <List.Item
                actions={
                  item.status !== 'done'
                    ? [
                        <Button
                          key="done"
                          type="link"
                          size="small"
                          onClick={() => void api.updateWorkItem(item.id, { status: 'done' }).then(refresh)}
                        >
                          Done
                        </Button>,
                      ]
                    : []
                }
              >
                <List.Item.Meta
                  title={item.title}
                  description={`${assigneeName(item, members)}${item.claimedByMemberId ? ' · claimed' : ''}`}
                />
              </List.Item>
            )}
          />
        </div>
      ))}
      <Space.Compact block>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New work item" size="small" />
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => void create()} disabled={!title.trim()} loading={busy}>
          Add
        </Button>
      </Space.Compact>
    </Card>
  );
}

function assigneeName(item: WorkItem, members: { id: string; name: string }[]): string {
  if (!item.assigneeId) return 'unassigned';
  return members.find((m) => m.id === item.assigneeId)?.name ?? item.assigneeId.slice(0, 8);
}

/** Schedules：只读列表，不做 Calendar 页。 */
export function ScheduleSection() {
  const [schedules, setSchedules] = useState<ScheduledWake[]>([]);

  useEffect(() => {
    api
      .listSchedules()
      .then((result) => setSchedules(result.schedules))
      .catch(() => {});
  }, []);

  const active = schedules.filter((s) => s.status === 'active');
  if (active.length === 0) return null;

  return (
    <Card size="small" bordered={false} title={`Schedules (${active.length})`} style={{ marginBottom: 8 }}>
      <List
        size="small"
        dataSource={active.slice(0, 5)}
        renderItem={(schedule) => (
          <List.Item>
            <List.Item.Meta
              title={schedule.prompt.slice(0, 40)}
              description={`${schedule.type} · ${schedule.nextRunAt.slice(0, 16).replace('T', ' ')}`}
            />
            <Tag>{schedule.type}</Tag>
          </List.Item>
        )}
      />
    </Card>
  );
}
