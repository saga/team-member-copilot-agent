import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.js';
import { badRequest, notFound } from './http-error.js';
import type {
  ConversationStatus,
  ConversationTask,
  ConversationTaskStatus,
  TaskRequirements,
} from './domain.js';

export interface TaskPlanInput {
  key: string;
  title: string;
  description?: string;
  assigneeMemberId?: string;
  dependencies?: string[];
  acceptanceCriteria?: string[];
}

/** refreshReady 一次扫出的两种变化：新就绪的与新被阻塞的。 */
export interface DependencyRefreshResult {
  ready: ConversationTask[];
  blocked: ConversationTask[];
}

interface TaskRow {
  id: string;
  conversation_id: string;
  title: string;
  description: string;
  assignee_member_id: string;
  status: ConversationTaskStatus;
  dependencies_json: string;
  acceptance_criteria_json: string;
  result: string | null;
  blocker: string | null;
  current_execution_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const MAX_TASKS = 20;
const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const TERMINAL_TASK: ReadonlySet<ConversationTaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function emptyRequirements(): TaskRequirements {
  return { facts: [], assumptions: [], constraints: [], successCriteria: [] };
}

export function parseRequirements(raw: string | null): TaskRequirements {
  if (!raw) return emptyRequirements();
  try {
    const parsed = JSON.parse(raw) as Partial<TaskRequirements>;
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [],
    };
  } catch {
    return emptyRequirements();
  }
}

export function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Task 的唯一业务入口：创建、查询、状态流转、依赖校验。
 *
 * 不负责跑 Agent、不认识 Copilot、不做 streaming。推进执行是
 * TaskOrchestrator 的事，这里只保证状态本身是对的。
 */
export class TaskService {
  constructor(private readonly db: DatabaseSync) {}

  list(conversationId: string): ConversationTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_task WHERE conversation_id = ? ORDER BY sort_order, created_at`,
      )
      .all(conversationId) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  get(taskId: string): ConversationTask {
    const row = this.db.prepare(`SELECT * FROM conversation_task WHERE id = ?`).get(taskId) as unknown as
      | TaskRow
      | undefined;
    if (!row) throw notFound(`Task 不存在：${taskId}`);
    return mapTask(row);
  }

  /** 一次 plan_tasks 调用的完整落库：建任务 + 更新工作区状态，同一个事务。 */
  plan(input: {
    conversationId: string;
    memberId: string;
    objective: string;
    requirements: TaskRequirements;
    tasks: TaskPlanInput[];
    rosterMemberIds: string[];
    leadMemberId: string | null;
  }): ConversationTask[] {
    // plan 只允许一次：已有任务时直接拒绝，而不是删掉重建 —— 重建会破坏
    // Task 历史、Execution 关联以及正在执行的任务。
    if (this.list(input.conversationId).length > 0) {
      throw badRequest('这个工作区已经存在任务，不能重新创建任务计划');
    }
    const convRow = this.db.prepare(`SELECT status FROM conversation WHERE id = ?`).get(input.conversationId) as
      | { status: ConversationStatus }
      | undefined;
    if (convRow && convRow.status !== 'intake' && convRow.status !== 'waiting_user') {
      throw badRequest('任务已经开始，不能重新创建任务计划');
    }
    const objective = input.objective.trim();
    if (!objective) throw badRequest('这次工作的目标不能为空');
    if (input.tasks.length === 0) throw badRequest('任务列表不能为空');
    if (input.tasks.length > MAX_TASKS) throw badRequest(`一次最多规划 ${MAX_TASKS} 个任务`);
    if (input.leadMemberId && input.memberId !== input.leadMemberId) {
      throw badRequest('只有负责这个工作的 Lead 才能制定任务计划');
    }

    const keys = input.tasks.map((task) => task.key.trim());
    for (const key of keys) {
      if (!KEY_PATTERN.test(key)) throw badRequest(`任务 key 不合法：${key}`);
    }
    if (new Set(keys).size !== keys.length) throw badRequest('任务 key 不能重复');

    const roster = new Set(input.rosterMemberIds);
    for (const task of input.tasks) {
      const assignee = (task.assigneeMemberId ?? input.leadMemberId ?? '').trim();
      if (!assignee) throw badRequest(`任务 ${task.key} 没有指定执行人`);
      if (!roster.has(assignee)) throw badRequest(`任务 ${task.key} 的执行人不在这个工作区里`);
      const title = task.title.trim();
      if (!title) throw badRequest(`任务 ${task.key} 的标题不能为空`);
      if (title.length > 300) throw badRequest(`任务 ${task.key} 的标题太长`);
      for (const dep of task.dependencies ?? []) {
        if (!keys.includes(dep)) throw badRequest(`任务 ${task.key} 依赖了不存在的任务：${dep}`);
        if (dep === task.key) throw badRequest(`任务 ${task.key} 不能依赖自己`);
      }
    }
    validateNoCycle(keys, input.tasks.map((task) => task.dependencies ?? []));

    const createdAt = now();
    const created: ConversationTask[] = [];
    // 依赖写的是 key，先分配 id 再翻译成 id 落库 —— 执行时只认 id。
    const idByKey = new Map(input.tasks.map((task) => [task.key.trim(), randomUUID()]));
    this.db.exec('BEGIN');
    try {
      // plan 只允许一次（入口已拒绝已有任务），这里直接插入，不删旧行。
      input.tasks.forEach((task, index) => {
        const row: TaskRow = {
          id: idByKey.get(task.key.trim())!,
          conversation_id: input.conversationId,
          title: task.title.trim(),
          description: (task.description ?? '').slice(0, 8000),
          assignee_member_id: (task.assigneeMemberId ?? input.leadMemberId ?? '').trim(),
          status: 'pending',
          dependencies_json: JSON.stringify((task.dependencies ?? []).map((dep) => idByKey.get(dep) ?? dep)),
          acceptance_criteria_json: JSON.stringify((task.acceptanceCriteria ?? []).slice(0, 20)),
          result: null,
          blocker: null,
          current_execution_id: null,
          sort_order: index,
          created_at: createdAt,
          updated_at: createdAt,
        };
        this.db
          .prepare(
            `INSERT INTO conversation_task (
              id, conversation_id, title, description, assignee_member_id, status,
              dependencies_json, acceptance_criteria_json, result, blocker,
              current_execution_id, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id, row.conversation_id, row.title, row.description, row.assignee_member_id,
            row.status, row.dependencies_json, row.acceptance_criteria_json, row.result,
            row.blocker, row.current_execution_id, row.sort_order, row.created_at, row.updated_at,
          );
        created.push(mapTask(row));
      });
      this.db
        .prepare(
          `UPDATE conversation SET objective = ?, requirements_json = ?, open_questions_json = '[]',
            status = 'running', updated_at = ? WHERE id = ?`,
        )
        .run(objective, JSON.stringify(normalizeRequirements(input.requirements)), createdAt, input.conversationId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.refreshReady(this.db, input.conversationId);
    return this.list(input.conversationId);
  }

  requestClarification(input: {
    conversationId: string;
    memberId: string;
    questions: string[];
    assumptions?: string[];
    summary?: string;
    leadMemberId: string | null;
    requirements: TaskRequirements;
  }): void {
    if (input.leadMemberId && input.memberId !== input.leadMemberId) {
      throw badRequest('只有负责这个工作的 Lead 才能请用户补充信息');
    }
    const questions = input.questions.map((question) => question.trim()).filter(Boolean);
    if (questions.length === 0 || questions.length > 3) {
      throw badRequest('一次最多问 3 个问题，至少问 1 个');
    }
    const merged: TaskRequirements = {
      ...input.requirements,
      assumptions: [...input.requirements.assumptions, ...(input.assumptions ?? []).slice(0, 10)],
    };
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE conversation SET status = 'waiting_user', open_questions_json = ?,
          requirements_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(questions), JSON.stringify(merged), timestamp, input.conversationId);
    void input.summary;
  }

  /** Task 执行人上报进展：只能动自己的任务。 */
  update(input: {
    taskId: string;
    memberId: string;
    status: 'running' | 'completed' | 'blocked';
    summary: string;
    blocker?: string;
  }): ConversationTask {
    const task = this.get(input.taskId);
    if (task.assigneeMemberId !== input.memberId) {
      throw badRequest('只能更新分给自己的任务');
    }
    if (TERMINAL_TASK.has(task.status)) {
      throw badRequest(`这个任务已经结束（${task.status}），不能再更新`);
    }
    const timestamp = now();
    const status: ConversationTaskStatus = input.status;
    const result = input.summary.slice(0, 10000);
    const blocker = status === 'blocked' ? (input.blocker ?? '').slice(0, 4000) : null;
    this.db
      .prepare(
        `UPDATE conversation_task SET status = ?, result = ?, blocker = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, result || null, blocker, timestamp, task.id);
    return this.get(task.id);
  }

  markRunning(taskId: string, executionId: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE conversation_task SET status = 'running', current_execution_id = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'ready', 'failed', 'blocked')`,
      )
      .run(executionId, timestamp, taskId);
  }

  markCompleted(taskId: string, result?: string): void {
    this.db
      .prepare(`UPDATE conversation_task SET status = 'completed', result = COALESCE(?, result), blocker = NULL, updated_at = ? WHERE id = ?`)
      .run(result ?? null, now(), taskId);
  }

  markFailed(taskId: string, error: string): void {
    this.db
      .prepare(`UPDATE conversation_task SET status = 'failed', blocker = ?, updated_at = ? WHERE id = ?`)
      .run(error.slice(0, 4000), now(), taskId);
  }

  markBlocked(taskId: string, blocker: string): void {
    this.db
      .prepare(`UPDATE conversation_task SET status = 'blocked', blocker = ?, updated_at = ? WHERE id = ?`)
      .run(blocker.slice(0, 4000), now(), taskId);
  }

  retry(taskId: string): ConversationTask {
    const task = this.get(taskId);
    if (task.status !== 'failed' && task.status !== 'blocked' && task.status !== 'cancelled') {
      throw badRequest(`这个任务当前是 ${task.status}，不需要重试`);
    }
    // 依赖没好时重试只会立刻再卡住：先让调用方处理依赖任务。
    if (!this.dependenciesCompleted(task)) {
      throw badRequest('任务依赖尚未完成，不能重试：请先处理它依赖的任务');
    }
    this.db
      .prepare(`UPDATE conversation_task SET status = 'ready', blocker = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), taskId);
    this.recomputeConversationStatus(task.conversationId);
    return this.get(taskId);
  }

  cancel(taskId: string): ConversationTask {
    const task = this.get(taskId);
    if (TERMINAL_TASK.has(task.status)) throw badRequest(`这个任务已经结束（${task.status}）`);
    this.db
      .prepare(`UPDATE conversation_task SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .run(now(), taskId);
    return this.get(taskId);
  }

  /** 依赖全部 completed 的 pending 任务变成 ready；依赖有失败/阻塞/取消的变成 blocked。 */
  refreshReady(db: DatabaseSync = this.db, conversationId?: string): DependencyRefreshResult {
    const scope = conversationId ?? '';
    const rows = (scope
      ? db.prepare(`SELECT * FROM conversation_task WHERE conversation_id = ? AND status = 'pending'`).all(scope)
      : db.prepare(`SELECT * FROM conversation_task WHERE status = 'pending'`).all()) as unknown as TaskRow[];
    const ready: ConversationTask[] = [];
    const blocked: ConversationTask[] = [];
    for (const row of rows) {
      const task = mapTask(row);
      const depStates = this.dependencyStates(db, task);
      if (depStates === 'failed') {
        // 依赖里有 failed / blocked / cancelled：下游不会再就绪，直接标 blocked，
        // 否则它会永久 pending，而工作区一直停在 running。
        const bad = this.dependencyStatusList(db, task).find((s) => s !== 'completed') ?? 'failed';
        db.prepare(`UPDATE conversation_task SET status = 'blocked', blocker = ?, updated_at = ? WHERE id = ?`).run(
          `依赖的任务没有完成（${bad}），等它处理完后重试这个任务`,
          now(),
          task.id,
        );
        const updated = db.prepare(`SELECT * FROM conversation_task WHERE id = ?`).get(task.id) as unknown as TaskRow;
        blocked.push(mapTask(updated));
      } else if (depStates === 'completed') {
        db.prepare(`UPDATE conversation_task SET status = 'ready', updated_at = ? WHERE id = ?`).run(now(), task.id);
        ready.push({ ...task, status: 'ready' });
      }
    }
    return { ready, blocked };
  }

  findReady(conversationId: string): ConversationTask[] {
    this.refreshReady(this.db, conversationId);
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_task WHERE conversation_id = ? AND status = 'ready' ORDER BY sort_order`,
      )
      .all(conversationId) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  /** 没有未完成的任务（且至少有一个任务）时，工作区自动完成。 */
  recomputeConversationStatus(conversationId: string): ConversationStatus | null {
    const rows = this.db
      .prepare(`SELECT status FROM conversation_task WHERE conversation_id = ?`)
      .all(conversationId) as unknown as Array<{ status: ConversationTaskStatus }>;
    if (rows.length === 0) return null;
    const timestamp = now();
    // failed 也是未解决：把它漏掉会让「全部失败」的工作区变成 completed。
    const runnable = rows.some((row) => ['pending', 'ready', 'running'].includes(row.status));
    if (runnable) {
      this.db.prepare(`UPDATE conversation SET status = 'running', updated_at = ? WHERE id = ?`).run(timestamp, conversationId);
      return 'running';
    }
    if (rows.some((row) => row.status === 'blocked' || row.status === 'failed')) {
      this.db.prepare(`UPDATE conversation SET status = 'blocked', updated_at = ? WHERE id = ?`).run(timestamp, conversationId);
      return 'blocked';
    }
    if (rows.every((row) => row.status === 'completed')) {
      this.db.prepare(`UPDATE conversation SET status = 'completed', updated_at = ? WHERE id = ?`).run(timestamp, conversationId);
      return 'completed';
    }
    if (rows.every((row) => row.status === 'cancelled')) {
      this.db.prepare(`UPDATE conversation SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(timestamp, conversationId);
      return 'cancelled';
    }
    // 混合终态（completed + cancelled）：没有可做的了，按完成收敛。
    this.db.prepare(`UPDATE conversation SET status = 'completed', updated_at = ? WHERE id = ?`).run(timestamp, conversationId);
    return 'completed';
  }

  /**
   * 依赖状态三态：'completed' 全完成、'failed' 有失败/阻塞/取消、'waiting' 还有未完成的。
   * 缺失的依赖行按未完成处理 —— 宁可等，也不要对着不存在的任务放行。
   */
  private dependencyStates(db: DatabaseSync, task: ConversationTask): 'completed' | 'failed' | 'waiting' {
    if (task.dependencies.length === 0) return 'completed';
    const states = this.dependencyStatusList(db, task);
    if (states.length !== task.dependencies.length) return 'waiting';
    if (states.some((s) => s === 'failed' || s === 'blocked' || s === 'cancelled')) return 'failed';
    if (states.every((s) => s === 'completed')) return 'completed';
    return 'waiting';
  }

  private dependencyStatusList(db: DatabaseSync, task: ConversationTask): string[] {
    if (task.dependencies.length === 0) return [];
    const placeholders = task.dependencies.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT status FROM conversation_task WHERE conversation_id = ? AND id IN (${placeholders})`,
      )
      .all(task.conversationId, ...task.dependencies) as unknown as Array<{ status: string }>;
    return rows.map((row) => row.status);
  }

  private dependenciesCompleted(task: ConversationTask): boolean {
    if (task.dependencies.length === 0) return true;
    const placeholders = task.dependencies.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, status FROM conversation_task WHERE conversation_id = ? AND id IN (${placeholders})`,
      )
      .all(task.conversationId, ...task.dependencies) as unknown as Array<{ id: string; status: string }>;
    if (rows.length !== task.dependencies.length) return false;
    return rows.every((row) => row.status === 'completed');
  }
}

function validateNoCycle(keys: string[], dependencies: string[][]): void {
  const index = new Map(keys.map((key, i) => [key, i]));
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (node: number, path: string[]): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) throw badRequest(`任务依赖存在循环：${[...path, keys[node]].join(' -> ')}`);
    visiting.add(node);
    for (const dep of dependencies[node] ?? []) {
      const next = index.get(dep);
      if (next !== undefined) visit(next, [...path, keys[node]]);
    }
    visiting.delete(node);
    visited.add(node);
  };
  keys.forEach((_, i) => visit(i, []));
}

function normalizeRequirements(input: TaskRequirements): TaskRequirements {
  return {
    facts: (input.facts ?? []).slice(0, 50).map((fact) => ({
      key: String(fact.key ?? '').slice(0, 200),
      value: String(fact.value ?? '').slice(0, 4000),
      source: fact.source,
      confirmed: Boolean(fact.confirmed),
    })),
    assumptions: (input.assumptions ?? []).slice(0, 20),
    constraints: (input.constraints ?? []).slice(0, 20),
    successCriteria: (input.successCriteria ?? []).slice(0, 20),
  };
}

export function mapTask(row: TaskRow): ConversationTask {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    description: row.description,
    assigneeMemberId: row.assignee_member_id,
    status: row.status,
    dependencies: parseStringArray(row.dependencies_json),
    acceptanceCriteria: parseStringArray(row.acceptance_criteria_json),
    result: row.result,
    blocker: row.blocker,
    currentExecutionId: row.current_execution_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
