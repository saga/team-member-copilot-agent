import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { hashJson } from './content-hash.js';
import { conflict, notFound } from './http-error.js';
import type { AuditService, CommandAuditEvent } from './audit-service.js';
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
  /**
   * **冻结**的规范化参数。执行时从这里读，不接受调用方再传一遍。
   *
   * 为什么必须有它：`request()` 落库、`approve()` 由人批、`execute()` 才真正
   * 打外部系统 —— 这三步之间可以隔着很久，而执行器原来拿的是**调用方当时传的
   * 那一份**。于是「人批准时看到的参数」和「真正执行的参数」可以是两份完全
   * 不同的东西，而审批的全部意义就在「批的和做的是同一件事」。
   *
   * `argsHash` 保留是为了**可验证**：它覆盖原文，执行前重新算一次就能证明
   * 落库的参数没有被改过（手工改库、迁移写错都会在这里暴露）。
   */
  args: Record<string, unknown>;
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
    /**
     * Command 生命周期审计（requested / policy_decided / approval_* / executing /
     * completed|failed）。
     *
     * 可选：不传时整条 Command 审计链静默关闭。生产装配永远传 —— 与
     * CopilotService 的 audit 参数同一约定，让「忘了传」表现为「没有审计」
     * 而不是启动失败。
     */
    private readonly audit?: AuditService,
  ) {}

  /** 注册某个 action 的执行器。重复注册抛 —— 两个实现争一个 action 是配置错误。 */
  registerExecutor(action: string, executor: CommandExecutor): void {
    if (this.executors.has(action)) {
      throw new Error(`重复注册 Command Executor：${action}`);
    }
    this.executors.set(action, executor);
  }

  /**
   * 落一条 Command（幂等）。
   *
   * ── 为什么不是「先 SELECT 再 INSERT」 ────────────────────────────────
   *
   * 那样写有两个进程同时进来时的经典窗口：两边都 SELECT 到「没有」，然后
   * 都去 INSERT。结果不是「幂等命中」，而是**主键冲突异常**从 `run()` 里
   * 抛出来 —— 一次本该静默复用的重试变成了一次失败。
   *
   * 改成 `INSERT … ON CONFLICT(idempotency_key) DO NOTHING`：判定与写入在
   * **一条 SQL** 里完成，SQLite 保证只有一个 changes = 1。changes = 0 就回读
   * 那一条 —— 那才是幂等命中该走的路径。
   *
   * 注意这里**不比对 args**。idempotencyKey 刻意不含 body（见 jira-tools.ts：
   * 「同一轮对同一张单的加评论只该发生一次，改了措辞重试仍算同一次动作」），
   * 所以同 key 不同 args 是**预期内**的。行为是「第一次的 args 胜出」：
   * 冻结的那份才是这条 Command 的定义，后来的措辞不覆盖它。
   */
  create(input: CommandRequestInput): CommandRecord {
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

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
      args: input.args,
      idempotencyKey: input.idempotencyKey,
      resourceVersion: input.resourceVersion ?? null,
      policyDecisionId: input.policyDecisionId ?? null,
      approvalId: input.approvalId ?? null,
      status: input.approvalId ? 'approved' : 'ready',
      createdAt: now(),
      executedAt: null,
      resultHash: null,
    };

    const result = this.db
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
          args_json,
          idempotency_key,
          resource_version,
          policy_decision_id,
          approval_id,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
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
        JSON.stringify(record.args),
        record.idempotencyKey,
        record.resourceVersion,
        record.policyDecisionId,
        record.approvalId,
        record.status,
        record.createdAt,
      );

    if (Number(result.changes) === 0) {
      // 另一个进程在 SELECT 和 INSERT 之间抢先落了同一条 key。
      // 回读它 —— 幂等命中的正解是「用已经存在的那一条」，不是报错。
      const raced = this.findByIdempotencyKey(input.idempotencyKey);
      if (!raced) {
        // DO NOTHING 只可能由 idempotency_key 的唯一约束触发，而那个键就是
        // 我们刚查过的。走到这里说明表上还有别的约束在挡，是装配错误。
        throw new Error(`Command 幂等写入冲突但回读不到：${input.idempotencyKey}`);
      }
      return raced;
    }

    this.auditCommand(record, 'requested', {
      actorType: record.actorType,
      actorId: record.actorId,
      detail: `${record.action} → ${record.target}`,
    });

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

    // 从这里往下，一切判定与执行都用 **command.args**（落库的那一份），
    // 而不是 input.args。第一次请求两者相同；重试改了措辞时它们不同 ——
    // 而那时该生效的是这条 Command 已经定下来的那一份，否则 Policy 批的、
    // 审批看到的、真正执行的会各是各的。
    const args = command.args;

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
        this.rejectCommand(command, entitlement.reason);
        throw new Error(entitlement.reason);
      }
    }

    const decision = await this.policy.decideCommand({
      action: command.action,
      target: command.target,
      memberId: command.memberId,
      executionId: command.executionId,
      args,
    });

    this.auditCommand(command, 'policy_decided', {
      actorType: 'system',
      actorId: this.policy.constructor?.name ?? 'policy',
      detail: `${decision.allowed ? 'allow' : 'deny'}${
        decision.approvalRequired ? '（approval_required）' : ''
      }：${decision.reason}`,
    });

    if (!decision.allowed) {
      if (decision.approvalRequired) {
        const approval = this.createApproval(command);
        this.db
          .prepare(`UPDATE command SET status = 'policy_pending', approval_id = ? WHERE id = ?`)
          .run(approval.id, command.id);
        this.auditCommand(command, 'approval_requested', {
          actorType: 'system',
          actorId: 'policy',
          detail: `approval=${approval.id}：${decision.reason}`,
        });
        return { command: this.get(command.id), approvalRequired: true };
      }

      this.rejectCommand(command, decision.reason);
      throw new Error(decision.reason);
    }

    if (decision.decisionId) {
      this.db
        .prepare(`UPDATE command SET policy_decision_id = ? WHERE id = ?`)
        .run(decision.decisionId, command.id);
    }

    return { command: await this.execute(command.id) };
  }

  /**
   * 执行一条已经放行的 Command（`ready` / `approved`）。
   *
   * ── 为什么不再接受调用方传 args ──────────────────────────────────────
   *
   * 签名原来是 `execute(commandId, args)`，而 args 来自**调用方**。这让
   * 「Command 上记着的参数」变成一条仅供参考的历史，而不是执行的定义 ——
   * 审批路径尤其致命：人批的是落库的那份，执行的是调用方新传的一份。
   *
   * 现在只接受 commandId，参数从库里读，并且**执行前校验哈希**：
   * `hashJson(args) !== argsHash` 说明落库的参数被改过（手工改库 / 迁移写错），
   * 这时必须失败而不是照常执行 —— 一次「参数和审计对不上」的外部写入，
   * 事后是无法分辨它到底做了什么。
   */
  async execute(commandId: string): Promise<CommandRecord> {
    const command = this.get(commandId);

    if (command.status !== 'ready' && command.status !== 'approved') {
      throw new Error(`Command ${commandId} 状态是 ${command.status}，不能执行`);
    }

    const args = command.args;
    const recomputed = hashJson(args);
    if (recomputed !== command.argsHash) {
      this.markFailed(commandId);
      throw new Error(
        `Command ${commandId} 的参数与 args_hash 不符（落库后被改过）：` +
          `args_hash=${command.argsHash} 实算=${recomputed}`,
      );
    }

    const executor = this.executors.get(command.action);
    if (!executor) {
      // 没有执行器 = 这个 action 只落了记录、没有出口。标记失败而不是静默成功：
      // 「记录写着 ready 但其实没人能执行它」是最难排查的一种状态。
      this.markFailed(commandId);
      throw new Error(`没有为 Command action 注册执行器：${command.action}`);
    }

    // CAS：从上面 get() 到这一刻之间，另一个执行者可能已经抢先把状态推到
    // executing。抢不到就**不能执行** —— 两条路径同时打外部系统就是两次副作用。
    if (!this.markExecuting(commandId)) {
      const current = this.get(commandId);
      throw conflict(
        `Command ${commandId} 已被其他执行者接手（当前状态 ${current.status}），本次执行放弃`,
      );
    }

    try {
      const result = await executor({ command, args });
      this.markCompleted(commandId, hashJson(result ?? null));
      return this.get(commandId);
    } catch (error) {
      this.markFailed(commandId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** 通过：审批行置 approved，Command 推进到 approved（执行仍要显式调 execute）。 */
  approve(commandId: string, approver: string): ApprovalRecord {
    const command = this.get(commandId);
    const approval = this.requireApproval(command);

    // CAS：只有还停在 policy_pending 的才能被批。少了这个条件，
    // 「先驳回、后误点通过」会把一条已经 rejected 的 Command 拉回 approved ——
    // 而 rejected 是终态，终态被改写等于审计链断在这里。
    const advanced = this.db
      .prepare(`UPDATE command SET status = 'approved' WHERE id = ? AND status = 'policy_pending'`)
      .run(commandId);
    if (Number(advanced.changes) !== 1) {
      throw conflict(
        `Command ${commandId} 当前状态是 ${this.get(commandId).status}，不能审批通过`,
      );
    }

    this.db
      .prepare(`UPDATE approval SET decision = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`)
      .run(approver, now(), approval.id);

    this.auditCommand(command, 'approved', {
      actorType: 'human',
      actorId: approver,
      detail: `approval=${approval.id}`,
    });

    return this.getApproval(approval.id);
  }

  /** 驳回：审批行置 rejected，Command 落到终态 rejected。 */
  reject(commandId: string, approver: string): ApprovalRecord {
    const command = this.get(commandId);
    const approval = this.requireApproval(command);

    this.db
      .prepare(`UPDATE approval SET decision = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`)
      .run(approver, now(), approval.id);
    this.rejectCommand(command, `审批驳回（${approver}）`, {
      actorType: 'human',
      actorId: approver,
    });

    return this.getApproval(approval.id);
  }

  /**
   * 推进到 executing（CAS）。
   *
   * 返回 `changes === 1` 而不是 void：SQLite 的 UPDATE 在 WHERE 不成立时是
   * **静默 0 行**（不抛异常）。旧签名返回 void，于是「没抢到」和「抢到了」
   * 对调用方完全一样 —— 而这里两者的差别是「执行一次」和「执行两次」。
   */
  markExecuting(commandId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE command
         SET status = 'executing'
         WHERE id = ? AND status IN ('approved', 'ready')`,
      )
      .run(commandId);

    if (Number(result.changes) === 1) {
      const command = this.get(commandId);
      this.auditCommand(command, 'executing', {
        actorType: 'system',
        actorId: 'command-service',
      });
      return true;
    }
    return false;
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
    this.auditCommand(this.get(commandId), 'completed', {
      actorType: 'system',
      actorId: 'command-service',
      detail: `result_hash=${resultHash}`,
    });
  }

  markFailed(commandId: string, reason?: string): void {
    this.db
      .prepare(
        `UPDATE command
         SET status = 'failed',
             executed_at = ?
         WHERE id = ?`,
      )
      .run(now(), commandId);
    this.auditCommand(this.get(commandId), 'failed', {
      actorType: 'system',
      actorId: 'command-service',
      detail: reason ?? null,
    });
  }

  get(commandId: string): CommandRecord {
    const row = this.db
      .prepare(`SELECT * FROM command WHERE id = ?`)
      .get(commandId) as unknown as Record<string, unknown> | undefined;
    // notFound（404）而不是普通 Error：Command 现在有 HTTP 面，而「id 打错了」
    // 与「服务出错了」对调用方是两件事 —— 后者会让人去翻日志找一个不存在的故障。
    if (!row) throw notFound(`Command 不存在：${commandId}`);
    return mapCommand(row);
  }

  listForExecution(executionId: string): CommandRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM command WHERE execution_id = ? ORDER BY created_at`)
      .all(executionId) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapCommand);
  }

  /**
   * 按状态列 Command（最新的在前）。
   *
   * 审批收件箱用它：待审批的 Command 散在各个 execution 里，而审批人关心的是
   * 「有什么在等我批」，不是「某一轮里有什么」—— 按 execution 列会让这个界面
   * 需要先把所有 execution 拉一遍，那正是收件箱不该做的事。
   *
   * `limit` 必须给：这张表只增不减，无上限的列表迟早会把响应撑爆。
   */
  listByStatus(status: CommandStatus, limit = 100): CommandRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM command
         WHERE status = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(status, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapCommand);
  }

  getApproval(approvalId: string): ApprovalRecord {
    const row = this.db
      .prepare(`SELECT * FROM approval WHERE id = ?`)
      .get(approvalId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Approval 不存在：${approvalId}`);
    return mapApproval(row);
  }

  private findByIdempotencyKey(key: string): CommandRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM command WHERE idempotency_key = ?`)
      .get(key) as unknown as Record<string, unknown> | undefined;
    return row ? mapCommand(row) : null;
  }

  /**
   * 落到终态 rejected 并留痕。
   *
   * 单独一个方法而不是直接 `setStatus(id, 'rejected')`：拒绝有**两种来源**
   * （Entitlement 拦下、Policy 判否、审批驳回），而它们都必须在审计里留下
   * 「为什么被拒」。散在三个调用点各写一次，迟早有一处只改状态不写审计 ——
   * 于是那条被拒的记录看起来像是凭空消失的。
   */
  private rejectCommand(
    command: CommandRecord,
    reason: string,
    actor: { actorType: 'agent' | 'human' | 'system'; actorId: string } = {
      actorType: 'system',
      actorId: 'command-service',
    },
  ): void {
    this.db.prepare(`UPDATE command SET status = 'rejected' WHERE id = ?`).run(command.id);
    this.auditCommand(command, 'rejected', { ...actor, detail: reason });
  }

  /**
   * 写一条 Command 生命周期审计。
   *
   * 审计失败**不能**让业务失败：一条 Jira 评论已经发出去了，此时因为审计写库
   * 出错而抛异常，会让调用方以为「没执行」并去重试 —— 而幂等键会拦住重试，
   * 于是那次写入永远停留在「业务已完成、审计说失败」的错位状态。
   *
   * 所以这里是 try/catch + 日志。丢一条审计事件是可接受的（可观测性问题），
   * 让外部副作用的状态与记录不一致是不可接受的。
   */
  private auditCommand(
    command: CommandRecord,
    event: CommandAuditEvent,
    input: {
      actorType: 'agent' | 'human' | 'system';
      actorId: string;
      detail?: string | null;
    },
  ): void {
    if (!this.audit) return;
    try {
      this.audit.recordCommandEvent({
        commandId: command.id,
        executionId: command.executionId,
        event,
        actorType: input.actorType,
        actorId: input.actorId,
        detail: input.detail ?? null,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[command] 审计事件写入失败（${event} / ${command.id}）:`,
        error instanceof Error ? error.message : error,
      );
    }
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
    args: parseArgsJson(row.args_json),
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

/**
 * 把落库的 args_json 读回对象。
 *
 * 解析失败**抛错**而不是返回 `{}`：空对象会让 `hashJson(args) !== argsHash`
 * 在执行前拦下它（这是对的），但那时错误信息会指向「哈希不符」，而真正的原因
 * 是「这一列的内容不是 JSON」。让错误在源头说出来。
 *
 * 也不做 `?? '{}'` 之类的兜底：args_json 是 NOT NULL 列，读不到内容说明库的
 * 形状和代码预期不一致 —— 静默兜底会把 schema 漂移伪装成一次正常的空参数执行。
 */
function parseArgsJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new Error('command.args_json 不是字符串 —— schema 与代码不一致');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `command.args_json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('command.args_json 解析出来不是对象');
  }
  return parsed as Record<string, unknown>;
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
