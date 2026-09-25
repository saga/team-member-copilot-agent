import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './http-error.js';
import type {
  PresenceAvailability,
  PrincipalRef,
  Project,
  ProjectStatus,
  ScheduledWake,
  ScheduledWakeRun,
  ScheduledWakeStatus,
  Team,
  TeamMembership,
  TeamParticipantKind,
  TeamPresence,
  TeamRole,
  WorkItem,
  WorkItemStatus,
} from './domain.js';

/**
 * Team 业务对象：Team / Membership / Project / WorkItem / Presence。
 *
 * 只管业务对象，不管 Copilot / Execution / Runtime / SSE / scheduler loop。
 * Scheduler 的执行入口在 scheduler-service，真正跑 turn 仍走 TeamService。
 */
export class TeamStructureService {
  constructor(private readonly db: DatabaseSync) {}

  // ------------------------------------------------------------------ Team

  /** 当前部署的唯一 Team，不存在则建。启动时调用，不提供新建 Team 入口。 */
  ensureDefaultTeam(createdBy?: string): Team {
    const existing = this.db.prepare(`SELECT * FROM team ORDER BY created_at LIMIT 1`).get() as
      | TeamRow
      | undefined;
    if (existing) return mapTeam(existing);

    const timestamp = now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO team (id, name, description, created_by, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?)`,
      )
      .run(id, config.teamName, createdBy ?? config.localActorId, timestamp, timestamp);
    return this.getTeam(id);
  }

  getTeam(id: string): Team {
    const row = this.db.prepare(`SELECT * FROM team WHERE id = ?`).get(id) as unknown as
      | TeamRow
      | undefined;
    if (!row) throw notFound(`Team 不存在：${id}`);
    return mapTeam(row);
  }

  // ------------------------------------------------------------- Membership

  /** 默认 human owner（单机占位）。接真正认证后 principalId 换成真实 user id。 */
  ensureHumanOwner(teamId: string, principalId: string): TeamMembership {
    return this.upsertMembership(teamId, 'human', principalId, 'owner', 'active');
  }

  ensureAgentMembership(teamId: string, memberId: string): TeamMembership {
    return this.upsertMembership(teamId, 'agent', memberId, 'member', 'active');
  }

  listMemberships(teamId: string): TeamMembership[] {
    const rows = this.db
      .prepare(`SELECT * FROM team_membership WHERE team_id = ? ORDER BY kind, principal_id`)
      .all(teamId) as unknown as TeamRow[];
    return (rows as unknown as MembershipRow[]).map(mapMembership);
  }

  getMembership(teamId: string, kind: TeamParticipantKind, principalId: string): TeamMembership {
    const row = this.db
      .prepare(`SELECT * FROM team_membership WHERE team_id = ? AND kind = ? AND principal_id = ?`)
      .get(teamId, kind, principalId) as unknown as MembershipRow | undefined;
    if (!row) throw notFound(`Team 成员不存在：${kind}/${principalId}`);
    return mapMembership(row);
  }

  /** 只有 active 成员算数。inactive 不能建 conversation / 接活。 */
  requireActiveMembership(teamId: string, kind: TeamParticipantKind, principalId: string): TeamMembership {
    const membership = this.getMembership(teamId, kind, principalId);
    if (membership.status !== 'active') throw forbidden(`Team 成员已停用：${kind}/${principalId}`);
    return membership;
  }

  updateMembership(
    teamId: string,
    kind: TeamParticipantKind,
    principalId: string,
    patch: { role?: TeamRole; status?: 'active' | 'inactive' },
  ): TeamMembership {
    const current = this.getMembership(teamId, kind, principalId);
    const role = patch.role ?? current.role;
    const status = patch.status ?? current.status;
    this.db
      .prepare(
        `UPDATE team_membership SET role = ?, status = ?, updated_at = ? WHERE team_id = ? AND kind = ? AND principal_id = ?`,
      )
      .run(role, status, now(), teamId, kind, principalId);
    return this.getMembership(teamId, kind, principalId);
  }

  private upsertMembership(
    teamId: string,
    kind: TeamParticipantKind,
    principalId: string,
    role: TeamRole,
    status: 'active' | 'inactive',
  ): TeamMembership {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO team_membership (team_id, kind, principal_id, role, status, joined_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, kind, principal_id) DO NOTHING`,
      )
      .run(teamId, kind, principalId, role, status, timestamp, timestamp);
    return this.getMembership(teamId, kind, principalId);
  }

  // ---------------------------------------------------------------- Project

  createProject(teamId: string, input: { name: string; description?: string }, createdBy: string): Project {
    const name = input.name.trim();
    if (!name) throw badRequest('Project 名称不能为空');
    this.getTeam(teamId);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO project (id, team_id, name, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, teamId, name.slice(0, 200), (input.description ?? '').slice(0, 2000), createdBy, timestamp, timestamp);
    return this.getProject(id);
  }

  listProjects(teamId: string): Project[] {
    const rows = this.db
      .prepare(`SELECT * FROM project WHERE team_id = ? ORDER BY created_at`)
      .all(teamId) as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  getProject(id: string): Project {
    const row = this.db.prepare(`SELECT * FROM project WHERE id = ?`).get(id) as unknown as
      | ProjectRow
      | undefined;
    if (!row) throw notFound(`Project 不存在：${id}`);
    return mapProject(row);
  }

  updateProject(id: string, patch: { name?: string; description?: string; status?: ProjectStatus }): Project {
    const current = this.getProject(id);
    const name = patch.name?.trim() || current.name;
    this.db
      .prepare(`UPDATE project SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(
        name.slice(0, 200),
        (patch.description ?? current.description).slice(0, 2000),
        patch.status ?? current.status,
        now(),
        id,
      );
    return this.getProject(id);
  }

  // --------------------------------------------------------------- WorkItem

  createWorkItem(
    teamId: string,
    input: { title: string; description?: string; projectId?: string | null },
    createdBy: string,
  ): WorkItem {
    const title = input.title.trim();
    if (!title) throw badRequest('WorkItem 标题不能为空');
    this.getTeam(teamId);
    const projectId = input.projectId?.trim() || null;
    if (projectId) {
      const project = this.getProject(projectId);
      if (project.teamId !== teamId) throw badRequest('Project 不属于这个 Team');
      if (project.status !== 'active') throw badRequest('已归档的 Project 不能建 WorkItem');
    }
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO work_item (id, team_id, project_id, title, description, status, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'todo', 1, ?, ?, ?)`,
      )
      .run(id, teamId, projectId, title.slice(0, 300), (input.description ?? '').slice(0, 8000), createdBy, timestamp, timestamp);
    return this.getWorkItem(id);
  }

  listWorkItems(
    teamId: string,
    filter: { projectId?: string; status?: WorkItemStatus; assigneeId?: string; claimedBy?: string } = {},
  ): WorkItem[] {
    const clauses = [`team_id = ?`];
    const params: Array<string | number> = [teamId];
    if (filter.projectId) {
      clauses.push(`project_id = ?`);
      params.push(filter.projectId);
    }
    if (filter.status) {
      clauses.push(`status = ?`);
      params.push(filter.status);
    }
    if (filter.assigneeId) {
      clauses.push(`assignee_id = ?`);
      params.push(filter.assigneeId);
    }
    if (filter.claimedBy) {
      clauses.push(`claimed_by_member_id = ?`);
      params.push(filter.claimedBy);
    }
    const rows = this.db
      .prepare(`SELECT * FROM work_item WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`)
      .all(...params) as unknown as WorkItemRow[];
    return rows.map(mapWorkItem);
  }

  getWorkItem(id: string): WorkItem {
    const row = this.db.prepare(`SELECT * FROM work_item WHERE id = ?`).get(id) as unknown as
      | WorkItemRow
      | undefined;
    if (!row) throw notFound(`WorkItem 不存在：${id}`);
    return mapWorkItem(row);
  }

  updateWorkItem(
    id: string,
    patch: { title?: string; description?: string; status?: WorkItemStatus },
    actor: PrincipalRef & { teamRole?: TeamRole },
  ): WorkItem {
    const current = this.getWorkItem(id);
    if (patch.status && ['done', 'cancelled'].includes(patch.status)) {
      // done/cancelled 必须是 claimer 或 Admin/owner，普通路过不能结别人的单。
      const isClaimer =
        actor.kind === 'agent' && current.claimedByMemberId === actor.principalId;
      const isAdmin = actor.teamRole === 'owner' || actor.teamRole === 'admin';
      // human 创建者本人结自己的单也允许（claim 为空时的个人任务）。
      const isCreatorHuman =
        actor.kind === 'human' && current.createdBy === actor.principalId && !current.claimedByMemberId;
      if (!isClaimer && !isAdmin && !isCreatorHuman) {
        throw forbidden('只有当前 claimer 或 Team admin/owner 能 done/cancelled');
      }
    }
    const title = patch.title?.trim() || current.title;
    this.db
      .prepare(`UPDATE work_item SET title = ?, description = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(
        title.slice(0, 300),
        (patch.description ?? current.description).slice(0, 8000),
        patch.status ?? current.status,
        now(),
        id,
      );
    // done/cancelled 后 claim 自动清空：业务结束，锁不应继续占着。
    if (patch.status === 'done' || patch.status === 'cancelled') {
      this.db
        .prepare(`UPDATE work_item SET claimed_by_member_id = NULL, claimed_execution_id = NULL, claimed_at = NULL WHERE id = ?`)
        .run(id);
    }
    return this.getWorkItem(id);
  }

  assignWorkItem(
    id: string,
    assignee: { kind: TeamParticipantKind; principalId: string } | null,
  ): WorkItem {
    const current = this.getWorkItem(id);
    if (current.claimedByMemberId) {
      throw conflict('WorkItem 已被 claim，先 release 再重新 assign');
    }
    if (assignee) {
      // assignee 必须是同 Team 的 active 成员（agent 要查 member 行，human 查 membership）。
      this.requireActiveMembership(current.teamId, assignee.kind, assignee.principalId);
      if (assignee.kind === 'agent') {
        const member = this.db.prepare(`SELECT status FROM member WHERE id = ?`).get(assignee.principalId) as unknown as
          | { status: string }
          | undefined;
        if (!member || member.status !== 'active') throw badRequest('不能指派给已归档的 Member');
      }
    }
    this.db
      .prepare(
        `UPDATE work_item SET assignee_kind = ?, assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(assignee?.kind ?? null, assignee?.principalId ?? null, now(), id);
    return this.getWorkItem(id);
  }

  /**
   * 原子 claim：UPDATE … WHERE version=? AND claimed_by IS NULL，不先读再写。
   * 成功返回新行；0 行 = 被抢先 / 状态不允许 / 版本过期，抛 409。
   */
  claimWorkItem(
    id: string,
    input: { memberId: string; executionId?: string | null; expectedVersion?: number },
  ): WorkItem {
    const current = this.getWorkItem(id);
    this.requireActiveMembership(current.teamId, 'agent', input.memberId);
    const member = this.db.prepare(`SELECT status FROM member WHERE id = ?`).get(input.memberId) as unknown as
      | { status: string }
      | undefined;
    if (!member || member.status !== 'active') throw forbidden('已归档的 Member 不能 claim');

    // 有明确 assignee 时只有它能 claim；未指定时任何 active agent 可 claim。
    if (current.assigneeKind === 'agent' && current.assigneeId !== input.memberId) {
      throw forbidden('这项工作已指派给别人，只有 assignee 能 claim');
    }
    if (current.assigneeKind === 'human') {
      throw forbidden('这项工作已指派给 Human，Agent 不能 claim');
    }

    const expectedVersion = input.expectedVersion ?? current.version;
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE work_item
         SET claimed_by_member_id = ?,
             claimed_at = ?,
             claimed_execution_id = ?,
             version = version + 1,
             status = 'in_progress',
             updated_at = ?
         WHERE id = ?
           AND version = ?
           AND claimed_by_member_id IS NULL
           AND status IN ('todo', 'in_progress')`,
      )
      .run(input.memberId, timestamp, input.executionId ?? null, timestamp, id, expectedVersion);
    if (Number(result.changes) !== 1) {
      throw conflict('Claim 失败：已被抢先、状态不允许或版本过期');
    }
    return this.getWorkItem(id);
  }

  releaseWorkItem(id: string, memberId?: string): WorkItem {
    const current = this.getWorkItem(id);
    if (!current.claimedByMemberId) return current;
    if (memberId && current.claimedByMemberId !== memberId) {
      throw forbidden('只有 claimer 能 release');
    }
    this.db
      .prepare(
        `UPDATE work_item SET claimed_by_member_id = NULL, claimed_execution_id = NULL, claimed_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(now(), id);
    return this.getWorkItem(id);
  }

  // --------------------------------------------------------------- Presence

  getPresence(teamId: string, kind: TeamParticipantKind, principalId: string): TeamPresence {
    const row = this.db
      .prepare(`SELECT * FROM team_presence WHERE team_id = ? AND kind = ? AND principal_id = ?`)
      .get(teamId, kind, principalId) as unknown as PresenceRow | undefined;
    if (!row) {
      const timestamp = now();
      return { teamId, kind, principalId, availability: 'available', lastSeenAt: timestamp, updatedAt: timestamp };
    }
    return mapPresence(row);
  }

  listPresence(teamId: string): TeamPresence[] {
    const rows = this.db
      .prepare(`SELECT * FROM team_presence WHERE team_id = ? ORDER BY kind, principal_id`)
      .all(teamId) as unknown as PresenceRow[];
    return rows.map(mapPresence);
  }

  setAvailability(
    teamId: string,
    kind: TeamParticipantKind,
    principalId: string,
    availability: PresenceAvailability,
  ): TeamPresence {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO team_presence (team_id, kind, principal_id, availability, last_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, kind, principal_id)
         DO UPDATE SET availability = excluded.availability, updated_at = excluded.updated_at`,
      )
      .run(teamId, kind, principalId, availability, timestamp, timestamp);
    return this.getPresence(teamId, kind, principalId);
  }

  touchPresence(teamId: string, kind: TeamParticipantKind, principalId: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO team_presence (team_id, kind, principal_id, availability, last_seen_at, updated_at)
         VALUES (?, ?, ?, 'available', ?, ?)
         ON CONFLICT(team_id, kind, principal_id)
         DO UPDATE SET last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
      )
      .run(teamId, kind, principalId, timestamp, timestamp);
  }

  /**
   * 有效状态：paused 落库即生效；有 active execution 即 busy；lastSeen 太旧即 offline；
   * 否则用落库的 available/away。busy/offline 永不落库，避免三边打架。
   */
  effectiveAvailability(
    stored: TeamPresence,
    hasActiveExecution: boolean,
    offlineAfterMs = 15 * 60_000,
  ): string {
    if (stored.availability === 'paused') return 'paused';
    if (hasActiveExecution) return 'busy';
    if (Date.now() - Date.parse(stored.lastSeenAt) > offlineAfterMs) return 'offline';
    return stored.availability;
  }

  // --------------------------------------------------------------- Schedule

  createSchedule(
    teamId: string,
    input: {
      memberId: string;
      conversationId: string;
      projectId?: string | null;
      workItemId?: string | null;
      prompt: string;
      type: 'once' | 'interval';
      runAt: string;
      intervalSeconds?: number | null;
    },
    createdBy: string,
  ): ScheduledWake {
    this.getTeam(teamId);
    const member = this.db.prepare(`SELECT id FROM member WHERE id = ?`).get(input.memberId) as unknown as
      | { id: string }
      | undefined;
    if (!member) throw notFound(`Member 不存在：${input.memberId}`);
    const conversation = this.db
      .prepare(`SELECT id, kind, team_id FROM conversation WHERE id = ?`)
      .get(input.conversationId) as unknown as { id: string; kind: string; team_id: string } | undefined;
    if (!conversation) throw notFound(`Conversation 不存在：${input.conversationId}`);
    if (conversation.team_id !== teamId) throw badRequest('Conversation 不属于这个 Team');
    if (conversation.kind !== 'work') throw badRequest('Schedule 只能绑定 work conversation');
    const prompt = input.prompt.trim();
    if (!prompt) throw badRequest('Schedule prompt 不能为空');
    if (input.type === 'interval' && (!input.intervalSeconds || input.intervalSeconds <= 0)) {
      throw badRequest('interval 类型必须给正整数 intervalSeconds');
    }
    const projectId = input.projectId?.trim() || null;
    if (projectId) {
      const project = this.getProject(projectId);
      if (project.teamId !== teamId) throw badRequest('Project 不属于这个 Team');
    }
    const workItemId = input.workItemId?.trim() || null;
    if (workItemId) {
      const work = this.getWorkItem(workItemId);
      if (work.teamId !== teamId) throw badRequest('WorkItem 不属于这个 Team');
    }
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO scheduled_wake (id, team_id, member_id, conversation_id, project_id, work_item_id, prompt, type, run_at, interval_seconds, next_run_at, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        teamId,
        input.memberId,
        input.conversationId,
        projectId,
        workItemId,
        prompt,
        input.type,
        input.runAt,
        input.type === 'interval' ? (input.intervalSeconds ?? null) : null,
        input.runAt,
        createdBy,
        timestamp,
        timestamp,
      );
    return this.getSchedule(id);
  }

  listSchedules(teamId: string): ScheduledWake[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_wake WHERE team_id = ? ORDER BY next_run_at`)
      .all(teamId) as unknown as ScheduledWakeRow[];
    return rows.map(mapSchedule);
  }

  getSchedule(id: string): ScheduledWake {
    const row = this.db.prepare(`SELECT * FROM scheduled_wake WHERE id = ?`).get(id) as unknown as
      | ScheduledWakeRow
      | undefined;
    if (!row) throw notFound(`Schedule 不存在：${id}`);
    return mapSchedule(row);
  }

  updateScheduleStatus(id: string, status: ScheduledWakeStatus): ScheduledWake {
    this.getSchedule(id);
    this.db.prepare(`UPDATE scheduled_wake SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
    return this.getSchedule(id);
  }

  dueSchedules(nowIso: string, limit = 20): ScheduledWake[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_wake WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as ScheduledWakeRow[];
    return rows.map(mapSchedule);
  }

  markFired(schedule: ScheduledWake, firedFor: string, error?: string): ScheduledWake {
    // 周期任务不补历史：next = 未来第一个 slot；once 跑完即 completed。
    let nextStatus: ScheduledWakeStatus = 'completed';
    let nextRunAt = schedule.nextRunAt;
    if (schedule.type === 'interval' && schedule.intervalSeconds) {
      nextRunAt = nextSlot(schedule.nextRunAt, schedule.intervalSeconds, new Date().toISOString());
      nextStatus = 'active';
    }
    this.db
      .prepare(`UPDATE scheduled_wake SET next_run_at = ?, status = ?, last_fired_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(nextRunAt, nextStatus, firedFor, error ?? null, now(), schedule.id);
    return this.getSchedule(schedule.id);
  }

  insertScheduleRun(scheduleId: string, scheduledFor: string): ScheduledWakeRun {
    const id = randomUUID();
    const timestamp = now();
    try {
      this.db
        .prepare(
          `INSERT INTO scheduled_wake_run (id, schedule_id, scheduled_for, status, created_at)
           VALUES (?, ?, ?, 'queued', ?)`,
        )
        .run(id, scheduleId, scheduledFor, timestamp);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw conflict('同一时间点已有一条 scheduled run（幂等跳过）');
      }
      throw error;
    }
    return this.getScheduleRun(id);
  }

  getScheduleRun(id: string): ScheduledWakeRun {
    const row = this.db.prepare(`SELECT * FROM scheduled_wake_run WHERE id = ?`).get(id) as unknown as
      | ScheduledWakeRunRow
      | undefined;
    if (!row) throw notFound(`Schedule run 不存在：${id}`);
    return mapScheduleRun(row);
  }

  updateScheduleRun(id: string, patch: { status?: ScheduledWakeRun['status']; executionId?: string | null; error?: string | null }): ScheduledWakeRun {
    const current = this.getScheduleRun(id);
    const status = patch.status ?? current.status;
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scheduled_wake_run SET status = ?, execution_id = ?, error = ?,
          started_at = COALESCE(started_at, ?), ended_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        patch.executionId !== undefined ? patch.executionId : current.executionId,
        patch.error !== undefined ? patch.error : current.error,
        status === 'queued' ? null : timestamp,
        status === 'queued' || status === 'running' ? null : timestamp,
        id,
      );
    return this.getScheduleRun(id);
  }

  recoverQueuedRuns(): ScheduledWakeRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_wake_run WHERE status IN ('queued', 'running') ORDER BY created_at`)
      .all() as unknown as ScheduledWakeRunRow[];
    return rows.map(mapScheduleRun);
  }
}

export function nextSlot(fromIso: string, intervalSeconds: number, nowIso: string): string {
  const from = Date.parse(fromIso);
  const current = Date.parse(nowIso);
  if (!Number.isFinite(from) || !Number.isFinite(current)) return nowIso;
  let next = from;
  // 不补历史：直接跳到第一个未来 slot，最多推进一次大步长避免长离线时空转。
  while (next <= current) next += intervalSeconds * 1000;
  return new Date(next).toISOString();
}

// ------------------------------------------------------------------- rows

interface TeamRow { id: string; name: string; description: string; created_by: string; created_at: string; updated_at: string }
interface MembershipRow { team_id: string; kind: TeamParticipantKind; principal_id: string; role: TeamRole; status: 'active' | 'inactive'; joined_at: string; updated_at: string }
interface ProjectRow { id: string; team_id: string; name: string; description: string; status: Project['status']; created_by: string; created_at: string; updated_at: string }
interface WorkItemRow { id: string; team_id: string; project_id: string | null; title: string; description: string; status: WorkItemStatus; assignee_kind: TeamParticipantKind | null; assignee_id: string | null; claimed_by_member_id: string | null; claimed_execution_id: string | null; claimed_at: string | null; version: number; created_by: string; created_at: string; updated_at: string }
interface PresenceRow { team_id: string; kind: TeamParticipantKind; principal_id: string; availability: PresenceAvailability; last_seen_at: string; updated_at: string }
interface ScheduledWakeRow { id: string; team_id: string; member_id: string; conversation_id: string; project_id: string | null; work_item_id: string | null; prompt: string; type: 'once' | 'interval'; run_at: string; interval_seconds: number | null; next_run_at: string; status: ScheduledWakeStatus; last_fired_at: string | null; last_error: string | null; created_by: string; created_at: string; updated_at: string }
interface ScheduledWakeRunRow { id: string; schedule_id: string; scheduled_for: string; status: ScheduledWakeRun['status']; execution_id: string | null; created_at: string; started_at: string | null; ended_at: string | null; error: string | null }

function mapTeam(row: TeamRow): Team {
  return { id: row.id, name: row.name, description: row.description, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapMembership(row: MembershipRow): TeamMembership {
  return { teamId: row.team_id, kind: row.kind, principalId: row.principal_id, role: row.role, status: row.status, joinedAt: row.joined_at, updatedAt: row.updated_at };
}
function mapProject(row: ProjectRow): Project {
  return { id: row.id, teamId: row.team_id, name: row.name, description: row.description, status: row.status, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapWorkItem(row: WorkItemRow): WorkItem {
  return { id: row.id, teamId: row.team_id, projectId: row.project_id, title: row.title, description: row.description, status: row.status, assigneeKind: row.assignee_kind, assigneeId: row.assignee_id, claimedByMemberId: row.claimed_by_member_id, claimedExecutionId: row.claimed_execution_id, claimedAt: row.claimed_at, version: row.version, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapPresence(row: PresenceRow): TeamPresence {
  return { teamId: row.team_id, kind: row.kind, principalId: row.principal_id, availability: row.availability, lastSeenAt: row.last_seen_at, updatedAt: row.updated_at };
}
function mapSchedule(row: ScheduledWakeRow): ScheduledWake {
  return { id: row.id, teamId: row.team_id, memberId: row.member_id, conversationId: row.conversation_id, projectId: row.project_id, workItemId: row.work_item_id, prompt: row.prompt, type: row.type, runAt: row.run_at, intervalSeconds: row.interval_seconds, nextRunAt: row.next_run_at, status: row.status, lastFiredAt: row.last_fired_at, lastError: row.last_error, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapScheduleRun(row: ScheduledWakeRunRow): ScheduledWakeRun {
  return { id: row.id, scheduleId: row.schedule_id, scheduledFor: row.scheduled_for, status: row.status, executionId: row.execution_id, createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at, error: row.error };
}
