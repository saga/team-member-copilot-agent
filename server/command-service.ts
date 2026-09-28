import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { hashJson } from './content-hash.js';
import type { EntitlementService } from './entitlement-service.js';
import type { CommandPolicy } from './policy.js';

/**
 * Command Layer —— 「真正要执行的业务动作」的唯一落点。
 *
 * ── 为什么 Agent 不能直接打外部 REST ──────────────────────────────────
 *
 * 直接调用的链条是这样的：
 *
 *   Agent → Jira REST
 *
 * 这条链上没有任何一处能回答「它刚才到底想干什么」。工具被拒了，只留下一行
 * 日志；工具成功了一半（HTTP 超时但服务端已经处理），本地什么都不知道；
 * 同一轮重试两次，Jira 上就多两条一模一样的评论。这些都不是理论问题 ——
 * 它们是「把副作用放在模型和网络之间」的必然结果。
 *
 * 插入 Command 之后：
 *
 *   Entitlement → Policy → Approval(可选) → Command → Executor → Jira
 *
 * 每一段都有落点：谁批的、批的什么、执行没执行、结果是什么。而 Command 是
 * **幂等**的 —— 重试拿回的是同一条记录，不是第二次副作用。
 *
 * ── 幂等靠 idempotencyKey，不靠调用方自觉 ────────────────────────────
 *
 * key 由调用方按「这一轮 + 这个动作 + 这个目标」拼（见 jira-tools.ts）。
 * 为什么不是 UUID：UUID 每次调用都不同，重试就会重复执行；而「同一轮对同一张
 * 单的同一类动作」天然只该发生一次，这个语义正好能拼成一个稳定的 key。
 *
 * 数据库上它还有 UNIQUE 约束 —— 进程内 Map 挡不住重启，约束能。
 *
 * ── 和 Policy 的关系 ─────────────────────────────────────────────────
 *
 * Command 自己再过一遍 Policy（`CommandPolicy`），不是因为不信任工具层，而是
 * 因为**平台自己也会发起 Command**（控制面补评论、webhook 回写），那些路径
 * 根本不经过工具授权。把 Policy 放在 Command 上，两条路径才共用同一道闸。
 *
 * 默认实现（DenyHighRiskPolicyService）对 Command 一律返回
 * `approvalRequired`：当前部署没有批准出口，于是外部写入停在 `policy_pending`，
 * 不会执行。这是刻意的 —— 「能列出工具」和「能执行动作」是两件事。
 */
export type CommandStatus =
  | 'requested'
  | 'policy_pending'
  | 'approved'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired';

/** 终态：不会再被推进。`request()` 命中终态时直接返回，不重新执行。 */
const TERMINAL_STATUSES: ReadonlySet<CommandStatus> = new Set([
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'expired',
]);

export interface CommandRecord {
  id: string;
  executionId: string;
  conversationId: string;
  memberId: string;

  actorType: 'agent' | 'human';
  actorId: string;

  action: string;
  target: string;

  argsHash: string;
  idempotencyKey: string;

  resourceVersion: string | null;

  policyDecisionId: string | null;
  approvalId: string | null;

  status: CommandStatus;

  createdAt: string;
  executedAt: string | null;
  resultHash: string | null;
}

export interface ApprovalRecord {
  id: string;
  commandId: string;
  requestedByType: 'agent' | 'human';
  requestedById: string;
  decision: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** 真正执行外部动作的那一段。由装配处注册（见 app.ts），CommandService 不 import 任何 Provider。 */
export type CommandExecutor = (input: {
  command: CommandRecord;
  args: Record<string, unknown>;
}) => Promise<unknown>;

export interface CommandRequestInput {
  executionId: string;
  conversationId: string;
  memberId: string;
  actorType: 'agent' | 'human';
  actorId: string;

  action: string;
  target: string;

  args: Record<string, unknown>;
  idempotencyKey: string;

  resourceVersion?: string | null;
  policyDecisionId?: string | null;
  approvalId?: string | null;
}

export interface CommandRequestResult {
  command: CommandRecord;
  /**
   * Executor 的返回值。三种情况下是 undefined：
   *   - 命中幂等（`reused`）—— 那条 Command 早就执行完了，这里没有它的结果
   *   - 停在审批（`approvalRequired`）—— 还没执行
   *   - 执行失败（会抛，不会走到这里）
   */
  result?: unknown;
  approvalRequired?: boolean;
  reused?: boolean;
}

export class CommandService {
  private readonly executors = new Map<string, CommandExecutor>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly entitlementService: EntitlementService,
    private readonly policy: CommandPolicy,
  ) {}

  /** 注册某个 action 的执行器。重复注册抛 —— 两个实现争一个 action 是配置错误。 */
  registerExecutor(action: string, executor: CommandExecutor): void {
    if (this.executors.has(action)) {
      throw new Error(`重复注册 Command Executor：${action}`);
    }
    this.executors.set(action, executor);
  }

  create(input: CommandRequestInput): CommandRecord {
    const existing = this.db
      .prepare(`SELECT * FROM command WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as unknown as Record<string, unknown> | undefined;

    if (existing) {
      return mapCommand(existing);
    }

    const record: CommandRecord = {
      id: randomUUID(),
      executionId: input.executionId,
      conversationId: input.conversationId,
      memberId: input.memberId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      target: input.target,
      argsHash: hashJson(input.args),
      idempotencyKey: input.idempotencyKey,
      resourceVersion: input.resourceVersion ?? null,
      policyDecisionId: input.policyDecisionId ?? null,
      approvalId: input.approvalId ?? null,
      status: input.approvalId ? 'approved' : 'ready',
      createdAt: now(),
      executedAt: null,
      resultHash: null,
    };

    this.db
      .prepare(
        `
        INSERT INTO command (
          id,
          execution_id,
          conversation_id,
          member_id,
          actor_type,
          actor_id,
          action,
          target,
          args_hash,
          idempotency_key,
          resource_version,
          policy_decision_id,
          approval_id,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        record.id,
        record.executionId,
        record.conversationId,
        record.memberId,
        record.actorType,
        record.actorId,
        record.action,
        record.target,
        record.argsHash,
        record.idempotencyKey,
        record.resourceVersion,
        record.policyDecisionId,
        record.approvalId,
        record.status,
        record.createdAt,
      );

    return record;
  }

  /**
   * 请求执行一笔业务动作。Agent 侧的唯一入口。
   *
   * 五步全部落库，任何一步失败都留下可查的记录：
   *   1. create（幂等）
   *   2. Entitlement —— 这类数据它有没有资格碰
   *   3. Policy      —— 这一笔该不该发生（可能返回「要人批」）
   *   4. Approval    —— 需要人批就停在 policy_pending，不执行
   *   5. Executor    —— 真正打外部系统
   */
  async request(input: CommandRequestInput): Promise<CommandRequestResult> {
    const command = this.create(input);

    // 幂等命中：同一条 key 已经走到过终态，直接返回，不重新执行。
    // 这是「重试不会产生第二条 Jira 评论」的全部实现 —— 不靠调用方判断。
    if (TERMINAL_STATUSES.has(command.status)) {
      return { command, reused: true };
    }

    const resource = resolveCommandResource(command.action, command.target);
    if (resource) {
      const entitlement = this.entitlementService.check({
        teamId: this.teamIdOf(command.conversationId),
        memberId: command.memberId,
        providerId: resource.providerId,
        resourceType: resource.type,
        resourceId: resource.id,
        action: 'write',
      });

      if (!entitlement.allowed) {
        this.setStatus(command.id, 'rejected');
        throw new Error(entitlement.reason);
      }
    }

    const decision = await this.policy.decideCommand({
      action: command.action,
      target: command.target,
      memberId: command.memberId,
      executionId: command.executionId,
      args: input.args,
    });

    if (!decision.allowed) {
      if (decision.approvalRequired) {
        const approval = this.createApproval(command);
        this.db
          .prepare(`UPDATE command SET status = 'policy_pending', approval_id = ? WHERE id = ?`)
          .run(approval.id, command.id);
        return { command: this.get(command.id), approvalRequired: true };
      }

      this.setStatus(command.id, 'rejected');
      throw new Error(decision.reason);
    }

    if (decision.decisionId) {
      this.db
        .prepare(`UPDATE command SET policy_decision_id = ? WHERE id = ?`)
        .run(decision.decisionId, command.id);
    }

    return { command: await this.execute(command.id, input.args) };
  }

  /**
   * 执行一条已经放行的 Command（`ready` / `approved`）。
   *
   * 单独暴露是为了审批路径：`approve()` 之后由审批方（或调度器）再调它。
   * `request()` 内部也走这里，所以两条路径的执行、收口、审计完全一致。
   */
  async execute(commandId: string, args: Record<string, unknown>): Promise<CommandRecord> {
    const command = this.get(commandId);

    if (command.status !== 'ready' && command.status !== 'approved') {
      throw new Error(`Command ${commandId} 状态是 ${command.status}，不能执行`);
    }

    const executor = this.executors.get(command.action);
    if (!executor) {
      // 没有执行器 = 这个 action 只落了记录、没有出口。标记失败而不是静默成功：
      // 「记录写着 ready 但其实没人能执行它」是最难排查的一种状态。
      this.markFailed(commandId);
      throw new Error(`没有为 Command action 注册执行器：${command.action}`);
    }

    this.markExecuting(commandId);

    try {
      const result = await executor({ command, args });
      this.markCompleted(commandId, hashJson(result ?? null));
      return this.get(commandId);
    } catch (error) {
      this.markFailed(commandId);
      throw error;
    }
  }

  /** 通过：审批行置 approved，Command 推进到 approved（执行仍要显式调 execute）。 */
  approve(commandId: string, approver: string): ApprovalRecord {
    const command = this.get(commandId);
    const approval = this.requireApproval(command);

    this.db
      .prepare(`UPDATE approval SET decision = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`)
      .run(approver, now(), approval.id);
    this.db
      .prepare(`UPDATE command SET status = 'approved' WHERE id = ? AND status = 'policy_pending'`)
      .run(commandId);

    return this.getApproval(approval.id);
  }

  /** 驳回：审批行置 rejected，Command 落到终态 rejected。 */
  reject(commandId: string, approver: string): ApprovalRecord {
    const command = this.get(commandId);
    const approval = this.requireApproval(command);

    this.db
      .prepare(`UPDATE approval SET decision = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`)
      .run(approver, now(), approval.id);
    this.setStatus(commandId, 'rejected');

    return this.getApproval(approval.id);
  }

  markExecuting(commandId: string): void {
    this.db
      .prepare(
        `UPDATE command
         SET status = 'executing'
         WHERE id = ? AND status IN ('approved', 'ready')`,
      )
      .run(commandId);
  }

  markCompleted(commandId: string, resultHash: string): void {
    this.db
      .prepare(
        `
        UPDATE command
        SET status = 'completed',
            executed_at = ?,
            result_hash = ?
        WHERE id = ?
        `,
      )
      .run(now(), resultHash, commandId);
  }

  markFailed(commandId: string): void {
    this.db
      .prepare(
        `UPDATE command
         SET status = 'failed',
             executed_at = ?
         WHERE id = ?`,
      )
      .run(now(), commandId);
  }

  get(commandId: string): CommandRecord {
    const row = this.db
      .prepare(`SELECT * FROM command WHERE id = ?`)
      .get(commandId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Command 不存在：${commandId}`);
    return mapCommand(row);
  }

  listForExecution(executionId: string): CommandRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM command WHERE execution_id = ? ORDER BY created_at`)
      .all(executionId) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapCommand);
  }

  getApproval(approvalId: string): ApprovalRecord {
    const row = this.db
      .prepare(`SELECT * FROM approval WHERE id = ?`)
      .get(approvalId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Approval 不存在：${approvalId}`);
    return mapApproval(row);
  }

  private setStatus(commandId: string, status: CommandStatus): void {
    this.db.prepare(`UPDATE command SET status = ? WHERE id = ?`).run(status, commandId);
  }

  private createApproval(command: CommandRecord): ApprovalRecord {
    const record: ApprovalRecord = {
      id: randomUUID(),
      commandId: command.id,
      requestedByType: command.actorType,
      requestedById: command.actorId,
      decision: 'pending',
      decidedBy: null,
      createdAt: now(),
      decidedAt: null,
    };

    this.db
      .prepare(
        `INSERT INTO approval (
           id, command_id, requested_by_type, requested_by_id, decision, decided_by, created_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.commandId,
        record.requestedByType,
        record.requestedById,
        record.decision,
        record.decidedBy,
        record.createdAt,
        record.decidedAt,
      );

    return record;
  }

  /** Command 已经挂在审批上时复用那一行，避免同一条 Command 攒出多条 pending。 */
  private requireApproval(command: CommandRecord): ApprovalRecord {
    if (!command.approvalId) {
      throw new Error(`Command ${command.id} 没有关联的审批，不能审批`);
    }
    return this.getApproval(command.approvalId);
  }

  private teamIdOf(conversationId: string): string {
    const row = this.db
      .prepare(`SELECT team_id FROM conversation WHERE id = ?`)
      .get(conversationId) as unknown as { team_id: string } | undefined;
    if (!row) throw new Error(`Conversation 不存在：${conversationId}`);
    return row.team_id;
  }
}

/**
 * 这笔 Command 碰的是哪条外部资源 —— Entitlement 的查询键。
 *
 * `target` 就是资源 id（Jira：issue key），action 前缀决定是哪个 Provider。
 * 认不出来就返回 null 让这一层跳过：跳过不等于放行，后面还有 Policy。
 *
 * 前缀表是显式的而不是 `action.split('.')[0]`：后者会把 `jira` 当成 providerId，
 * 而注册表里的 id 是 `atlassian.jira-tools` —— 拼错的 providerId 在 Entitlement
 * 里永远查不到行，于是**所有** Jira 写入都会被静默拒绝，且理由是「没有授权」。
 */
export function resolveCommandResource(
  action: string,
  target: string,
): { providerId: string; type: string; id: string } | null {
  if (action.startsWith('jira.')) {
    return { providerId: 'atlassian.jira-tools', type: 'jira.issue', id: target };
  }
  return null;
}

function mapCommand(row: Record<string, unknown>): CommandRecord {
  return {
    id: String(row.id),
    executionId: String(row.execution_id),
    conversationId: String(row.conversation_id),
    memberId: String(row.member_id),
    actorType: row.actor_type as 'agent' | 'human',
    actorId: String(row.actor_id),
    action: String(row.action),
    target: String(row.target),
    argsHash: String(row.args_hash),
    idempotencyKey: String(row.idempotency_key),
    resourceVersion: row.resource_version == null ? null : String(row.resource_version),
    policyDecisionId: row.policy_decision_id == null ? null : String(row.policy_decision_id),
    approvalId: row.approval_id == null ? null : String(row.approval_id),
    status: row.status as CommandStatus,
    createdAt: String(row.created_at),
    executedAt: row.executed_at == null ? null : String(row.executed_at),
    resultHash: row.result_hash == null ? null : String(row.result_hash),
  };
}

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    commandId: String(row.command_id),
    requestedByType: row.requested_by_type as 'agent' | 'human',
    requestedById: String(row.requested_by_id),
    decision: row.decision as ApprovalRecord['decision'],
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
  };
}
