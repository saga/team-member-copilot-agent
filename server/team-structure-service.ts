import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './http-error.js';
import type {
  PresenceAvailability,
  ScheduledWake,
  ScheduledWakeRun,
  ScheduledWakeStatus,
  Team,
  TeamChangeSink,
  TeamMembership,
  TeamParticipantKind,
  TeamPresence,
  TeamRole,
} from './domain.js';
import { parseExternalWorkRef, type ExternalWorkRef } from './work-management/types.js';

/**
 * Team 业务对象：Team / Membership / Presence / Schedule。
 *
 * 只管业务对象，不管 Copilot / Execution / Runtime / SSE / scheduler loop。
 * Scheduler 的执行入口在 scheduler-service，真正跑 turn 仍走 TeamService。
 */
export class TeamStructureService {
  /**
   * Team 级变更出口（Team SSE 的数据源）。结构服务只管「在正确的时机喊一声」，
   * 落库与广播由 TeamEventService 做：回调发生在业务写入的同一个事务里，
   * 广播由 db-tx 的 commit hook 保证在 COMMIT 之后。
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly onTeamChange?: TeamChangeSink,
  ) {}

  private emitChange(
    teamId: string,
    type: Parameters<TeamChangeSink>[1],
    payload: unknown,
  ): void {
    this.onTeamChange?.(teamId, type, payload);
  }

  /**
   * 把跨表写入收成一个原子块。嵌套安全：深度由 db-tx 统一追踪，
   * COMMIT 只由最外层负责，onCommit hook 在 COMMIT 之后才执行。
   */
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
    // Member 归档后 membership 不会自动变，两边不能漂移成「已归档但仍 active」。
    if (kind === 'agent') {
      const row = this.db.prepare(`SELECT status FROM member WHERE id = ?`).get(principalId) as
        | { status: string }
        | undefined;
      if (!row || row.status !== 'active') {
        throw forbidden(`Agent 已归档：${principalId}`);
      }
    }
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
    // Agent 只能是 member：权限角色与职业角色绝不合并，Agent 永不做 owner。
    if (kind === 'agent' && role === 'owner') {
      throw badRequest('Agent 不能成为 Team owner');
    }
    // 最后一个 active owner 不能被降级/停用，否则 Team 进入无主状态。
    if (current.role === 'owner' && (role !== 'owner' || status !== 'active')) {
      const row = this.db
        .prepare(
          `
          SELECT COUNT(*) AS n
          FROM team_membership
          WHERE team_id = ?
            AND kind = 'human'
            AND role = 'owner'
            AND status = 'active'
            AND NOT (
              principal_id = ?
            )
          `,
        )
        .get(teamId, principalId) as { n: number };
      if (row.n === 0) {
        throw conflict('Team 至少必须保留一个 active owner');
      }
    }
    this.db
      .prepare(
        `UPDATE team_membership SET role = ?, status = ?, updated_at = ? WHERE team_id = ? AND kind = ? AND principal_id = ?`,
      )
      .run(role, status, now(), teamId, kind, principalId);
    const membership = this.getMembership(teamId, kind, principalId);
    this.emitChange(teamId, 'membership.changed', membership);
    return membership;
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
    const presence = this.getPresence(teamId, kind, principalId);
    this.emitChange(teamId, 'presence.changed', presence);
    return presence;
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

  /**
   * Member 正在干什么 = active execution；挂了外部工作的带上引用。
   * 没有独立的 activity 表：execution 本身就是「此刻在跑什么」的记录，
   * 再建一张就是在第二个地方记同一件事。
   *
   * 返回的是**引用**而不是工单内容：要看标题/状态，拿 ref 去问 Jira。
   */
  listCurrentActivity(
    teamId: string,
  ): Array<{
    executionId: string;
    conversationId: string;
    conversationTitle: string;
    memberId: string;
    memberName: string;
    externalWorkRef: ExternalWorkRef | null;
    kind: string;
    status: string;
    startedAt: string | null;
  }> {
    this.getTeam(teamId);
    const rows = this.db
      .prepare(
        `
        SELECT e.id AS execution_id, e.conversation_id, e.member_id, e.external_work_ref,
               e.kind, e.status, e.started_at,
               c.title AS conversation_title, m.name AS member_name
        FROM execution e
        JOIN conversation c ON c.id = e.conversation_id
        JOIN member m ON m.id = e.member_id
        WHERE c.team_id = ?
          AND e.status IN ('queued', 'running', 'waiting_for_member')
        ORDER BY (e.started_at IS NULL), e.started_at DESC
        `,
      )
      .all(teamId) as unknown as Array<{
        execution_id: string;
        conversation_id: string;
        member_id: string;
        external_work_ref: string | null;
        kind: string;
        status: string;
        started_at: string | null;
        conversation_title: string;
        member_name: string;
      }>;
    return rows.map((row) => ({
      executionId: row.execution_id,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title,
      memberId: row.member_id,
      memberName: row.member_name,
      externalWorkRef: parseExternalWorkRef(row.external_work_ref),
      kind: row.kind,
      status: row.status,
      startedAt: row.started_at,
    }));
  }

  // --------------------------------------------------------------- Schedule

  createSchedule(
    teamId: string,
    input: {
      memberId: string;
      conversationId: string;
      prompt: string;
      type: 'once' | 'interval';
      runAt: string;
      intervalSeconds?: number | null;
    },
    createdBy: string,
  ): ScheduledWake {
    this.getTeam(teamId);
    // 被调度的必须是 active 的 Team 成员：归档 / 停用的 Agent 不能等到
    // scheduler 真运行时才失败 —— 那时错误藏在一个没人盯的 run 记录里。
    this.requireActiveMembership(teamId, 'agent', input.memberId);
    const conversation = this.db
      .prepare(`SELECT id, kind, team_id FROM conversation WHERE id = ?`)
      .get(input.conversationId) as unknown as { id: string; kind: string; team_id: string } | undefined;
    if (!conversation) throw notFound(`Conversation 不存在：${input.conversationId}`);
    if (conversation.team_id !== teamId) throw badRequest('Conversation 不属于这个 Team');
    if (conversation.kind !== 'work') throw badRequest('Schedule 只能绑定 work conversation');
    // 被调度的 Member 必须属于绑定的 work conversation，否则运行时才炸。
    const memberInConversation = this.db
      .prepare(
        `
        SELECT 1
        FROM conversation_member
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(input.conversationId, input.memberId);
    if (!memberInConversation) {
      throw badRequest('Schedule 的 Member 必须属于绑定的 work conversation');
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw badRequest('Schedule prompt 不能为空');
    if (input.type === 'interval' && (!input.intervalSeconds || input.intervalSeconds <= 0)) {
      throw badRequest('interval 类型必须给正整数 intervalSeconds');
    }
    // runAt 在创建时就验证：非法时间会变成一条永远跑不到的 schedule（once），
    // 只有用户在列表里看到 next_run_at 是空/乱码时才发现。
    const runAtMs = Date.parse(input.runAt);
    if (!Number.isFinite(runAtMs)) {
      throw badRequest('runAt 必须是有效时间');
    }
    if (runAtMs <= Date.now()) {
      throw badRequest('runAt 必须是未来时间');
    }
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO scheduled_wake (id, team_id, member_id, conversation_id, prompt, type, run_at, interval_seconds, next_run_at, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        teamId,
        input.memberId,
        input.conversationId,
        prompt,
        input.type,
        input.runAt,
        input.type === 'interval' ? (input.intervalSeconds ?? null) : null,
        input.runAt,
        createdBy,
        timestamp,
        timestamp,
      );
    const schedule = this.getSchedule(id);
    this.emitChange(teamId, 'schedule.changed', schedule);
    return schedule;
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
    const current = this.getSchedule(id);
    // 已完成的 once 不能 resume：它的一次性语义已经兑现。
    if (current.status === 'completed' && status === 'active') {
      throw conflict('已完成的 once schedule 不能 resume');
    }
    this.db.prepare(`UPDATE scheduled_wake SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
    const schedule = this.getSchedule(id);
    this.emitChange(current.teamId, 'schedule.changed', schedule);
    return schedule;
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
    const updated = this.getSchedule(schedule.id);
    this.emitChange(schedule.teamId, 'schedule.changed', updated);
    return updated;
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
    // 时间戳跟语义走，不是「status ≠ queued 就写」：running 第一次进入才写
    // started_at（completed/failed 收口不该顶掉它），completed/failed 才写
    // ended_at（回到 queued/running 不该清掉结束时间）。用一个旧值回填的
    // COALESCE 写法做不到这两件事。
    this.db
      .prepare(
        `UPDATE scheduled_wake_run SET status = ?, execution_id = ?, error = ?,
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          ended_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE ended_at END
         WHERE id = ?`,
      )
      .run(
        status,
        patch.executionId !== undefined ? patch.executionId : current.executionId,
        patch.error !== undefined ? patch.error : current.error,
        status,
        timestamp,
        status,
        timestamp,
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
interface PresenceRow { team_id: string; kind: TeamParticipantKind; principal_id: string; availability: PresenceAvailability; last_seen_at: string; updated_at: string }
interface ScheduledWakeRow { id: string; team_id: string; member_id: string; conversation_id: string; prompt: string; type: 'once' | 'interval'; run_at: string; interval_seconds: number | null; next_run_at: string; status: ScheduledWakeStatus; last_fired_at: string | null; last_error: string | null; created_by: string; created_at: string; updated_at: string }
interface ScheduledWakeRunRow { id: string; schedule_id: string; scheduled_for: string; status: ScheduledWakeRun['status']; execution_id: string | null; created_at: string; started_at: string | null; ended_at: string | null; error: string | null }

function mapTeam(row: TeamRow): Team {
  return { id: row.id, name: row.name, description: row.description, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapMembership(row: MembershipRow): TeamMembership {
  return { teamId: row.team_id, kind: row.kind, principalId: row.principal_id, role: row.role, status: row.status, joinedAt: row.joined_at, updatedAt: row.updated_at };
}
function mapPresence(row: PresenceRow): TeamPresence {
  return { teamId: row.team_id, kind: row.kind, principalId: row.principal_id, availability: row.availability, lastSeenAt: row.last_seen_at, updatedAt: row.updated_at };
}
function mapSchedule(row: ScheduledWakeRow): ScheduledWake {
  return { id: row.id, teamId: row.team_id, memberId: row.member_id, conversationId: row.conversation_id, prompt: row.prompt, type: row.type, runAt: row.run_at, intervalSeconds: row.interval_seconds, nextRunAt: row.next_run_at, status: row.status, lastFiredAt: row.last_fired_at, lastError: row.last_error, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapScheduleRun(row: ScheduledWakeRunRow): ScheduledWakeRun {
  return { id: row.id, scheduleId: row.schedule_id, scheduledFor: row.scheduled_for, status: row.status, executionId: row.execution_id, createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at, error: row.error };
}
