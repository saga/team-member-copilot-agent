import { useEffect, useState } from 'react';
import { api, type Project, type ScheduledWake, type WorkItem } from '../../lib/api';

/** Projects：只有列表 + 新建，不做完整 Project 页。 */
export function ProjectSection({ onChanged }: { onChanged?: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');

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
    await api.createProject({ name: name.trim() });
    setName('');
    await refresh();
    onChanged?.();
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-title">Projects</div>
      {projects.map((project) => (
        <div key={project.id} className="member-row">
          <div className="member-row-ident">
            <strong>{project.name}</strong>
            <span>{project.status}</span>
          </div>
        </div>
      ))}
      <div className="panel-actions">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project" />
        <button type="button" onClick={() => void create()} disabled={!name.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

/** Work：按 status 分组的最简列表，不做拖拽 Kanban。 */
export function WorkSection({ members }: { members: { id: string; name: string }[] }) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [title, setTitle] = useState('');

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
    await api.createWorkItem({ title: title.trim() });
    setTitle('');
    await refresh();
  }

  const groups: { key: string; label: string; items: WorkItem[] }[] = [
    { key: 'todo', label: 'Todo', items: items.filter((i) => i.status === 'todo') },
    { key: 'in_progress', label: 'In Progress', items: items.filter((i) => i.status === 'in_progress') },
    { key: 'blocked', label: 'Blocked', items: items.filter((i) => i.status === 'blocked') },
    { key: 'done', label: 'Done', items: items.filter((i) => i.status === 'done') },
  ];

  return (
    <div className="sidebar-section">
      <div className="sidebar-title">Work</div>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="sidebar-hint">
            {group.label} ({group.items.length})
          </div>
          {group.items.slice(0, 8).map((item) => (
            <div key={item.id} className="member-row">
              <div className="member-row-ident">
                <strong>{item.title}</strong>
                <span>
                  {assigneeName(item, members)}
                  {item.claimedByMemberId ? ` · claimed` : ''}
                </span>
              </div>
              <div className="member-row-actions">
                {item.status !== 'done' && (
                  <button type="button" className="ghost" onClick={() => void api.updateWorkItem(item.id, { status: 'done' }).then(refresh)}>
                    Done
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
      <div className="panel-actions">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New work item" />
        <button type="button" onClick={() => void create()} disabled={!title.trim()}>
          Add
        </button>
      </div>
    </div>
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
    <div className="sidebar-section">
      <div className="sidebar-title">Schedules ({active.length})</div>
      {active.slice(0, 5).map((schedule) => (
        <div key={schedule.id} className="member-row">
          <div className="member-row-ident">
            <strong>{schedule.prompt.slice(0, 40)}</strong>
            <span>
              {schedule.type} · {schedule.nextRunAt.slice(0, 16).replace('T', ' ')}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
