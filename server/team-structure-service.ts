import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { runInTransaction } from './db-tx.js';
import { now } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './http-error.js';
import type {
  ExecutionStatus,
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
  WorkItemActorKind,
  WorkItemEvent,
  WorkItemEventType,
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

  /**
   * 把跨表写入收成一个原子块。嵌套安全：深度由 db-tx 统一追踪，
   * COMMIT 只由最外层负责，onCommit hook 在 COMMIT 之后才执行。
   */
  private transaction<T>(fn: () => T, onCommit?: () => void): T {
    return runInTransaction(this.db, fn, onCommit);
  }

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
    actor: PrincipalRef,
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
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_item (id, team_id, project_id, title, description, status, version, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'todo', 1, ?, ?, ?)`,
        )
        .run(id, teamId, projectId, title.slice(0, 300), (input.description ?? '').slice(0, 8000), actor.principalId, timestamp, timestamp);
      this.appendWorkItemEvent({
        workItemId: id,
        teamId,
        eventType: 'created',
        actor,
        toStatus: 'todo',
      });
    });
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
    // 对象级授权：admin、当前 claimer、未被 claim 时的人类创建者，三者之外一律拒绝。
    const isAdmin = actor.teamRole === 'owner' || actor.teamRole === 'admin';
    const isAgentClaimer =
      actor.kind === 'agent' && current.claimedByMemberId === actor.principalId;
    const isHumanCreator =
      actor.kind === 'human' && current.createdBy === actor.principalId;
    if (!isAdmin && !isAgentClaimer && !isHumanCreator) {
      throw forbidden('没有修改这个 WorkItem 的权限');
    }
    if (patch.status) {
      // 工作状态流转只属于 claimer 与 admin：路过不能把别人的任务改成 blocked。
      if (
        ['in_progress', 'blocked', 'done', 'cancelled'].includes(patch.status) &&
        !isAdmin &&
        !isAgentClaimer
      ) {
        throw forbidden('只有当前 claimer 或 Team admin/owner 可以改变工作状态');
      }
      // 已被 claim 的任务不能由其他人退回 todo。
      if (
        patch.status === 'todo' &&
        current.claimedByMemberId &&
        !isAdmin &&
        !isAgentClaimer
      ) {
        throw forbidden('已被 claim 的 WorkItem 不能由其他人退回 todo');
      }
    }
    const title = patch.title?.trim() || current.title;
    const description = patch.description ?? current.description;
    const status = patch.status ?? current.status;
    const contentChanged = title !== current.title || description !== current.description;
    const statusChanged = status !== current.status;
    this.transaction(() => {
      this.db
        .prepare(`UPDATE work_item SET title = ?, description = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(title.slice(0, 300), description.slice(0, 8000), status, now(), id);
      // done/cancelled 后 claim 自动清空：业务结束，锁不应继续占着。
      // 必须和状态变更同事务：中间崩进程会留下「已结束却仍被 claim」的行。
      const claimCleared =
        (patch.status === 'done' || patch.status === 'cancelled') && !!current.claimedByMemberId;
      if (claimCleared) {
        this.db
          .prepare(`UPDATE work_item SET claimed_by_member_id = NULL, claimed_execution_id = NULL, claimed_at = NULL WHERE id = ?`)
          .run(id);
      }
      // 内容与状态分开记：审计里「改了标题」和「todo → blocked」是两类事实。
      if (contentChanged) {
        this.appendWorkItemEvent({
          workItemId: id,
          teamId: current.teamId,
          eventType: 'updated',
          actor,
        });
      }
      if (statusChanged) {
        this.appendWorkItemEvent({
          workItemId: id,
          teamId: current.teamId,
          eventType: 'status_changed',
          actor,
          fromStatus: current.status,
          toStatus: status,
        });
      }
      if (claimCleared) {
        this.appendWorkItemEvent({
          workItemId: id,
          teamId: current.teamId,
          eventType: 'released',
          actor,
          executionId: current.claimedExecutionId,
          fromClaimedByMemberId: current.claimedByMemberId,
        });
      }
    });
    return this.getWorkItem(id);
  }

  assignWorkItem(
    id: string,
    assignee: { kind: TeamParticipantKind; principalId: string } | null,
    actor: PrincipalRef & { teamRole?: TeamRole },
  ): WorkItem {
    // Assignment 是协调动作：Human = Coordinator，Agent = Worker。
    // Agent 想接活走 claim（Execution → Claim），不能把工作指给别人。
    if (actor.kind === 'agent') {
      throw forbidden('Agent 不能 assign WorkItem；接活请使用 claim');
    }
    const current = this.getWorkItem(id);
    if (current.status === 'done' || current.status === 'cancelled') {
      throw conflict(`WorkItem 已经结束：${current.status}`);
    }
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
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE work_item SET assignee_kind = ?, assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(assignee?.kind ?? null, assignee?.principalId ?? null, now(), id);
      // 取消一个本来就没有 assignee 的指派是 no-op，不记流水。
      if (assignee || current.assigneeId) {
        this.appendWorkItemEvent({
          workItemId: id,
          teamId: current.teamId,
          eventType: assignee ? 'assigned' : 'unassigned',
          actor,
          fromAssigneeKind: current.assigneeKind,
          fromAssigneeId: current.assigneeId,
          toAssigneeKind: assignee?.kind ?? null,
          toAssigneeId: assignee?.principalId ?? null,
        });
      }
    });
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

    // execution 绑定校验：claim 必须由一条真实、可执行的 execution 发起，
    // 且一条 execution 不能同时绑两个 WorkItem。
    if (input.executionId) {
      const execution = this.db
        .prepare(
          `
          SELECT id, member_id, status, work_item_id
          FROM execution
          WHERE id = ?
          `,
        )
        .get(input.executionId) as
        | { id: string; member_id: string; status: ExecutionStatus; work_item_id: string | null }
        | undefined;
      if (!execution) {
        throw notFound(`Execution 不存在：${input.executionId}`);
      }
      if (execution.member_id !== input.memberId) {
        throw forbidden('Execution 不属于当前 Member');
      }
      if (!['queued', 'running'].includes(execution.status)) {
        throw conflict('当前 Execution 不能 claim WorkItem');
      }
      if (execution.work_item_id && execution.work_item_id !== id) {
        throw conflict('Execution 已绑定另一个 WorkItem');
      }
    }

    const expectedVersion = input.expectedVersion ?? current.version;
    // claim 是跨表写入（work_item + execution.work_item_id），必须同事务：
    // 中间崩进程会留下「WorkItem 已被 claim、execution 却不知道自己在干哪项工作」的断链。
    return this.transaction(() => {
      const timestamp = now();

      if (current.claimedByMemberId) {
        // 已被 claim。语义是「谁负责」+「这一轮谁在驱动」，所以同一 Member
        // 换一轮 Execution 允许重绑（retry：Execution 1 failed → Execution 2 接着驱动），
        // 其他 Member 则一律 409 —— 那是抢别人的活。
        if (current.claimedByMemberId !== input.memberId) {
          throw conflict('WorkItem 已被其他 Member claim');
        }
        const previousExecutionId = current.claimedExecutionId;
        const previous = previousExecutionId
          ? (this.db.prepare(`SELECT status FROM execution WHERE id = ?`).get(previousExecutionId) as unknown as
              | { status: ExecutionStatus }
              | undefined)
          : undefined;
        // 旧轮已到任意终态（completed / failed / cancelled / interrupted）才允许重绑：
        // 多轮工作（completed）与 retry（failed）都要把锁交给新的一轮。
        const previousEnded =
          !previousExecutionId ||
          (previous !== undefined &&
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(previous.status));
        if (!previousEnded) {
          throw conflict('WorkItem 已被当前 Member 一条未结束的 Execution claim');
        }
        const rebind = this.db
          .prepare(
            `UPDATE work_item
             SET claimed_execution_id = ?,
                 claimed_at = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND claimed_by_member_id = ?
               AND version = ?`,
          )
          .run(input.executionId ?? null, timestamp, timestamp, id, input.memberId, expectedVersion);
        if (Number(rebind.changes) !== 1) {
          throw conflict('Claim 重绑失败：状态已变化，请重新读取后重试');
        }
      } else {
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
      }

      // 双向绑定：execution.work_item_id 与 work_item.claimed_execution_id 保持一致。
      if (input.executionId) {
        this.db
          .prepare(`UPDATE execution SET work_item_id = ? WHERE id = ? AND work_item_id IS NULL`)
          .run(id, input.executionId);
      }
      // 重绑时 from = to = 同一个 Member：流水上仍是一次 claim（换了驱动它的一轮）。
      this.appendWorkItemEvent({
        workItemId: id,
        teamId: current.teamId,
        eventType: 'claimed',
        actor: { kind: 'agent', principalId: input.memberId },
        executionId: input.executionId ?? null,
        fromClaimedByMemberId: current.claimedByMemberId,
        toClaimedByMemberId: input.memberId,
      });
      return this.getWorkItem(id);
    });
  }

  releaseWorkItem(id: string, actor: PrincipalRef & { teamRole?: TeamRole }): WorkItem {
    const current = this.getWorkItem(id);
    if (!current.claimedByMemberId) return current;
    const isClaimer =
      actor.kind === 'agent' && current.claimedByMemberId === actor.principalId;
    const isAdmin = actor.teamRole === 'owner' || actor.teamRole === 'admin';
    if (!isClaimer && !isAdmin) {
      throw forbidden('只有 claimer 或 Team admin/owner 能 release WorkItem');
    }
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE work_item SET claimed_by_member_id = NULL, claimed_execution_id = NULL, claimed_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(now(), id);
      this.appendWorkItemEvent({
        workItemId: id,
        teamId: current.teamId,
        eventType: 'released',
        actor,
        executionId: current.claimedExecutionId,
        fromClaimedByMemberId: current.claimedByMemberId,
      });
    });
    return this.getWorkItem(id);
  }

  /**
   * Execution 收口为 cancelled / interrupted 时释放它 claim 的 WorkItem。
   *
   * 这两种终态意味着这一轮执行已不再拥有业务执行权，锁继续占着只会挡住 retry。
   * failed 保留 claim（retry 由同一 Member 继续）；completed 也不自动释放 ——
   * 完成一轮执行不等于业务工作结束（WorkItem ≠ Execution）。
   *
   * 守卫是 `claimed_execution_id = ?`：它只清「这一轮亲手 claim 的」记录，
   * 不碰 Member 重新 claim 到别的 Execution 上的新锁。没有匹配行时是 no-op，
   * 重复调用安全。
   */
  releaseClaimForExecution(executionId: string): void {
    // 先读再清：流水里要记「释放的是谁的锁」。
    const claimed = this.db
      .prepare(
        `SELECT id, team_id, claimed_by_member_id FROM work_item
         WHERE claimed_execution_id = ? AND claimed_by_member_id IS NOT NULL`,
      )
      .get(executionId) as unknown as
      | { id: string; team_id: string; claimed_by_member_id: string }
      | undefined;
    if (!claimed) return;
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE work_item
           SET claimed_by_member_id = NULL,
               claimed_execution_id = NULL,
               claimed_at = NULL,
               version = version + 1,
               updated_at = ?
           WHERE claimed_execution_id = ?
             AND claimed_by_member_id IS NOT NULL`,
        )
        .run(now(), executionId);
      this.appendWorkItemEvent({
        workItemId: claimed.id,
        teamId: claimed.team_id,
        eventType: 'released',
        actor: { kind: 'system', principalId: 'system' },
        executionId,
        fromClaimedByMemberId: claimed.claimed_by_member_id,
      });
    });
  }

  /**
   * WorkItem 的审计流水，时间正序（最新 limit 条）。
   *
   * 必须先验证 WorkItem 属于这个 Team 再查：直接按 work_item_id 查会把
   * 跨 Team 的 id 当成合法输入，权限过滤就绕过去了。
   */
  listWorkItemEvents(teamId: string, workItemId: string, limit = 100): WorkItemEvent[] {
    const item = this.getWorkItem(workItemId);
    if (item.teamId !== teamId) throw notFound(`WorkItem 不存在：${workItemId}`);
    const rows = this.db
      .prepare(
        `SELECT * FROM work_item_event WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(workItemId, limit) as unknown as WorkItemEventRow[];
    return rows.reverse().map(mapWorkItemEvent);
  }

  /**
   * WorkItem 审计流水的唯一写入口：所有 mutation 都从这里进。
   * 必须在调用方的事务里执行（业务行与流水同生共死，拆开就会留下
   * 「状态变了但没有流水」或反过来的半截事实）。
   */
  private appendWorkItemEvent(input: {
    workItemId: string;
    teamId: string;
    eventType: WorkItemEventType;
    actor: { kind: WorkItemActorKind; principalId: string };
    executionId?: string | null;
    fromStatus?: WorkItemStatus | null;
    toStatus?: WorkItemStatus | null;
    fromAssigneeKind?: TeamParticipantKind | null;
    fromAssigneeId?: string | null;
    toAssigneeKind?: TeamParticipantKind | null;
    toAssigneeId?: string | null;
    fromClaimedByMemberId?: string | null;
    toClaimedByMemberId?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO work_item_event (
           id, team_id, work_item_id, event_type, actor_kind, actor_id, execution_id,
           from_status, to_status, from_assignee_kind, from_assignee_id,
           to_assignee_kind, to_assignee_id, from_claimed_by_member_id, to_claimed_by_member_id,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.teamId,
        input.workItemId,
        input.eventType,
        input.actor.kind,
        input.actor.principalId,
        input.executionId ?? null,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        input.fromAssigneeKind ?? null,
        input.fromAssigneeId ?? null,
        input.toAssigneeKind ?? null,
        input.toAssigneeId ?? null,
        input.fromClaimedByMemberId ?? null,
        input.toClaimedByMemberId ?? null,
        now(),
      );
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
    const projectId = input.projectId?.trim() || null;
    if (projectId) {
      const project = this.getProject(projectId);
      if (project.teamId !== teamId) throw badRequest('Project 不属于这个 Team');
    }
    const workItemId = input.workItemId?.trim() || null;
    if (workItemId) {
      const work = this.getWorkItem(workItemId);
      if (work.teamId !== teamId) throw badRequest('WorkItem 不属于这个 Team');
      if (work.status === 'done' || work.status === 'cancelled') {
        throw badRequest('已结束的 WorkItem 不能建立自动任务');
      }
      // Schedule 明确属于某个 Project 时，绑定的 WorkItem 必须同属那个 Project。
      // WorkItem 没有 projectId（游离任务）也不行：自动任务产出的工作落在哪个
      // Project 必须无歧义，不能靠「WorkItem 恰好没填」混进另一个 Project。
      if (projectId && work.projectId !== projectId) {
        throw badRequest('Schedule 的 projectId 必须与 WorkItem 的 projectId 一致');
      }
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
    const current = this.getSchedule(id);
    // 已完成的 once 不能 resume：它的一次性语义已经兑现。
    if (current.status === 'completed' && status === 'active') {
      throw conflict('已完成的 once schedule 不能 resume');
    }
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
interface ProjectRow { id: string; team_id: string; name: string; description: string; status: Project['status']; created_by: string; created_at: string; updated_at: string }
interface WorkItemRow { id: string; team_id: string; project_id: string | null; title: string; description: string; status: WorkItemStatus; assignee_kind: TeamParticipantKind | null; assignee_id: string | null; claimed_by_member_id: string | null; claimed_execution_id: string | null; claimed_at: string | null; version: number; created_by: string; created_at: string; updated_at: string }
interface WorkItemEventRow { id: string; team_id: string; work_item_id: string; event_type: WorkItemEventType; actor_kind: WorkItemActorKind; actor_id: string; execution_id: string | null; from_status: WorkItemStatus | null; to_status: WorkItemStatus | null; from_assignee_kind: TeamParticipantKind | null; from_assignee_id: string | null; to_assignee_kind: TeamParticipantKind | null; to_assignee_id: string | null; from_claimed_by_member_id: string | null; to_claimed_by_member_id: string | null; created_at: string }
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
function mapWorkItemEvent(row: WorkItemEventRow): WorkItemEvent {
  return { id: row.id, teamId: row.team_id, workItemId: row.work_item_id, eventType: row.event_type, actorKind: row.actor_kind, actorId: row.actor_id, executionId: row.execution_id, fromStatus: row.from_status, toStatus: row.to_status, fromAssigneeKind: row.from_assignee_kind, fromAssigneeId: row.from_assignee_id, toAssigneeKind: row.to_assignee_kind, toAssigneeId: row.to_assignee_id, fromClaimedByMemberId: row.from_claimed_by_member_id, toClaimedByMemberId: row.to_claimed_by_member_id, createdAt: row.created_at };
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
