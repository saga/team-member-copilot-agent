import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { hashJson } from './content-hash.js';
import { BAD_GATEWAY_STATUS, conflict, notFound } from './http-error.js';
import type { AuditService, CommandAuditEvent } from './audit-service.js';
import type { EntitlementService } from './entitlement-service.js';
import type { CommandPolicy } from './policy.js';
// 结果确定性的判据。刻意 import 而不是在这里重写一份：`failed` / `unknown` 的
// 分界线必须**只有一处定义**，否则传输层认出来的 5xx 和 Command 层认出来的
// 5xx 迟早会不一致 —— 而那时同一种故障会随机地记成两种状态。
import { classifyExternalError } from './work-management/outcome.js';
import type { ExternalOperationOutcome } from './work-management/outcome.js';

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
 *
 * ── completed ≠ HTTP 200：失败谱系必须被记下来 ────────────────────────
 *
 * 把外部调用的结果压成「成功 / 失败」两档会同时造成两种伤害：
 *
 *   把「结果未知」记成成功  → 没人去查，一次可能没发生的写入被当成已发生
 *   把「结果未知」记成失败  → 人会去重试，于是**可能已经发生的那次**再来一遍
 *
 * 后者更常见也更要命。所以 `execute()` 的 catch 里有一条明确的分界：
 * definite（4xx / 412 / 连接没建起来）→ `failed`；其余（超时 / 连接重置 /
 * 5xx / 进程崩了）→ `unknown` + `UnknownCommandOutcomeError`，由对账收敛。
 *
 * 每一次执行尝试单独落 `command_attempt` 一行。只留 command 上的当前状态的话，
 * 「第一次超时（可能已写）、第二次对账确认已写」这段过程会被压成一句
 * 「succeeded」—— 而那段过程恰恰解释了为什么这里多了一次外部查询、
 * 以及为什么当时不能简单地重试。
 */
export type CommandStatus =
  | 'requested'
  | 'policy_pending'
  | 'approved'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  /**
   * 外部结果**未知**。
   *
   * `failed` 的语义是「确认没有发生」；timeout / connection reset / 5xx 属于
   * 「**可能**已经发生了」。把后者记成 failed 会带来两个后果：人会去重试
   * （于是重复副作用），审计上留下一条「确定失败」的假结论。
   *
   * 它**不是终态** —— 对账（reconcile）会把它收敛到 completed / failed。
   */
  | 'unknown'
  | 'rejected'
  | 'cancelled'
  | 'expired';

/**
 * 终态：不会再被推进。`request()` 命中终态时直接返回，不重新执行。
 *
 * ── `failed` 为什么**不**在这里 ──────────────────────────────────────
 *
 * 它看起来该在（「失败」嘛），但 `failed` 的语义是**「确认外部没有发生」**
 * —— 那正是「可以安全重试」的定义。把它划成终态，等于把「确认没发生」和
 * 「已经做完了」当成同一件事，于是 retry 一条失败的 Command 会拿到一句
 * 「已经执行过」，而外部系统上其实什么都没有。模型据此认为事情办完了。
 *
 * `unknown` 同样不在（它连结论都还没有），但它有自己的处理：抛
 * `UnknownCommandOutcomeError`，因为重试可能已经生效的那一笔就是重复副作用。
 */
const TERMINAL_STATUSES: ReadonlySet<CommandStatus> = new Set([
  'completed',
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

  /**
   * 这一笔**外部业务动作**的身份（UNIQUE）。
   *
   * 刻意不是 `executionId`：retry 会铸出一条新的 execution，而「同一笔 Jira
   * 评论」不能因此变成两笔 —— 那正是重复副作用。`operationId` 跟着 Command 走，
   * 于是它同时是对账的查询键（拿它去外部系统问「这笔到底做了没有」）和幂等的
   * 第二道判据。
   *
   * 它也是打在外部系统上的**标记**（见 jira 执行器的 `<!-- copilot-operation:… -->`
   * 注释）：对账要能在一堆评论里认出「哪一条是我发的」，靠的就是它。
   */
  operationId: string;

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

/**
 * 一次**尝试**的结果。刻意只有四个取值 —— 这里记的是「这次调用怎么了」，
 * 不是「这笔业务该不该做」（policy / approval 在 command 与 command_audit 上）。
 */
export type CommandAttemptStatus = 'running' | 'succeeded' | 'failed' | 'unknown';

/**
 * Command 的一次执行尝试。
 *
 * ── 为什么单独一张表，而不是在 command 上加几列 ──────────────────────
 *
 * 「一笔业务动作」和「一次尝试」不是同一个东西：
 *
 *   Command #1  attempt#1 → unknown（超时，可能已写）
 *               attempt#2 → succeeded（对账确认已写）
 *
 * 只留一行的话，attempt#1 的 unknown 会被 attempt#2 的 succeeded 覆盖 —— 而
 * 那段「我们曾经不知道发生过什么」恰恰是审计最需要的一段：它解释了这个
 * Command 为什么多花了一次外部查询，以及为什么不能简单地「再试一次」。
 */
export interface CommandAttemptRecord {
  id: string;
  commandId: string;
  /** 从 1 开始，同一 Command 内单调递增。 */
  attemptNo: number;
  operationId: string;
  status: CommandAttemptStatus;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  resultHash: string | null;
}

/**
 * 外部结果未知。
 *
 * 抛这个而不是普通 Error 的原因：调用方（工具层）需要据此告诉模型
 * **「别重试」**。文案是给模型看的，`command` 字段是给程序看的 ——
 * 「这笔动作可能已经发生了」这个结论不能被压缩进一句可以随便改的字符串里。
 *
 * 带 502（`badGateway`）是为了 HTTP 控制面：500 会说成「我们坏了」，而这里
 * 是「上游没答复」。见 http-error.ts 里 badGateway 的说明。
 */
export class UnknownCommandOutcomeError extends Error {
  readonly status = BAD_GATEWAY_STATUS;

  constructor(
    readonly command: CommandRecord,
    reason: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `Command ${command.id} 的外部结果未知（${command.action} → ${command.target}）：${reason}。` +
        '请求已经发出，但没能确认外部系统是否处理了它 —— ' +
        '**不要直接重试**，重复执行会产生第二次副作用。这笔动作会通过对账（reconcile）收敛。',
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'UnknownCommandOutcomeError';
  }
}

/** 执行 / 对账的输入。两者用的是**同一份冻结参数**（`command.args`）。 */
export interface CommandExecutionInput {
  command: CommandRecord;
  args: Record<string, unknown>;
  /**
   * 这一次尝试。
   *
   * 执行时是刚开的那一次；对账时是**最后一次**尝试。
   *
   * ── 对账为什么必须用它、不能用 `command.executedAt` ──────────────────
   *
   * `executed_at` 是「我们放弃等待、判定结果未知」的时刻，而真正的外部写入
   * 发生在 `started_at` 和它**之间**。拿后者当时间窗下界，会把自己的那次写入
   * 排除在窗口外 —— 于是对账把一次**已经发生**的写入报成 `failed`，下一步就是
   * 重试，而重试是第二次副作用。方向恰好是反的。
   */
  attempt?: CommandAttemptRecord | null;
}

/**
 * 真正执行外部动作的那一段。由装配处注册（见 app.ts），CommandService 不 import
 * 任何 Provider。
 *
 * ── 为什么是带可选方法的 interface，而不是一个纯函数类型 ──────────────
 *
 * 因为「执行」和「对账」必须绑在**同一个 action** 上。拆成两张注册表
 * （`registerExecutor` + `registerReconciler`）会允许「注册了执行器、忘了对账器」
 * 这个状态存在，而它的表现是：Command 一旦进了 `unknown` 就**永远**收敛不了
 * —— 一个只在对账路径上才暴露的装配错误。
 *
 * 可选而不是必需：不是每个动作都能对账（有的外部系统根本没有可读的痕迹）。
 * 没有它时对账如实返回「无法对账」（仍然是 unknown），**不是** failed。
 */
export interface CommandExecutor {
  (input: CommandExecutionInput): Promise<unknown>;
  reconcile?(input: CommandExecutionInput): Promise<ExternalOperationOutcome>;
}

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

    // ── retry 链上的复用：这里挡的是**重复副作用**，不是重复记录 ────────
    //
    // idempotencyKey 由工具层按「这一轮 + 这个动作 + 这个目标」拼，而「这一轮」
    // 是 executionId。retry 会铸出一条**新的 execution**，于是 key 变了 ——
    // 同一笔「给 PROJ-1 加评论」被当成两笔，Jira 上出现两条一模一样的评论。
    //
    // 这是幂等键的一个盲区：它只覆盖「同一条 execution 内的重试」，而 retry
    // 恰恰是**跨 execution** 的重试。所以这里补第二道判据 —— 沿 retry 链往回
    // 找同 (action, target) 的既有 Command，找到就复用它。
    //
    // 复用而不是「新建一条但共用 operationId」：operationId 是这一笔**外部
    // 业务动作**的身份，它同时是打在 Jira 上的标记（对账靠它认人）。让两条
    // Command 共用一个 operationId 会让「哪条才是真的」变成一个问题，而
    // command_attempt 已经解决了「同一条动作试了几次」。
    const inherited = this.findRetryableCommand({
      executionId: input.executionId,
      retryOfExecutionId: this.retryOf(input.executionId),
      action: input.action,
      target: input.target,
    });
    if (inherited) {
      this.auditCommand(inherited, 'inherited', {
        actorType: 'system',
        actorId: 'command-service',
        detail:
          `retry（execution ${input.executionId}）复用了这条 Command，` +
          `没有新建第二笔 ${input.action} → ${input.target}`,
      });
      return inherited;
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
      args: input.args,
      idempotencyKey: input.idempotencyKey,
      operationId: randomUUID(),
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
          operation_id,
          resource_version,
          policy_decision_id,
          approval_id,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        record.operationId,
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

    // `unknown` **不是**终态，但它同样不能被再次执行 —— 上一次请求可能已经
    // 落到外部系统了，重试就是重复副作用。所以这里抛而不是返回 `reused`：
    // `reused` 会让模型以为「已经做完了」，那是另一个方向的假结论。
    // 正解是等对账（reconcile）把它收敛，届时再决定要不要重试。
    if (command.status === 'unknown') {
      throw new UnknownCommandOutcomeError(command, '这笔动作上一次执行的结果未知，尚未对账');
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

    // `failed` 也在可执行集合里：它的语义是「确认外部没有发生」，所以再做一次
    // 是安全的 —— 这正是 retry 该走的路。把它排除掉会让 retry 一条失败的
    // Command 变成一次报错，而「确认没发生的动作不能重试」本身没有道理。
    //
    // `unknown` 刻意**不**在：那笔可能已经生效了，重试就是重复副作用。它必须
    // 先经过对账（reconcile）收敛成 completed 或 failed。
    if (
      command.status !== 'ready' &&
      command.status !== 'approved' &&
      command.status !== 'failed'
    ) {
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

    // 到这里才算一次**尝试**。上面三条退路（状态不对 / 参数被改 / 没有执行器）
    // 都在碰外部系统之前就结束了，它们没有产生任何外部调用 —— 给它们记一条
    // attempt 会让审计里出现「一次什么也没做的尝试」，反而稀释掉真正要看的东西。
    const attempt = this.startAttempt(commandId, command.operationId);

    try {
      const result = await executor({ command, args, attempt });
      const resultHash = hashJson(result ?? null);
      this.finishAttempt(attempt.id, 'succeeded', { resultHash });
      this.markCompleted(commandId, resultHash);
      return this.get(commandId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      // ── 这里就是 `failed` 与 `unknown` 的分界，整条链上唯一的判据 ──────
      //
      // definite = 能证明外部系统**没有**处理这次请求（4xx、412、连接根本没
      //   建起来）。记 failed，人可以放心重试。
      // unknown  = 请求可能已经落地（超时、连接被重置、5xx、进程崩了）。
      //   记 failed 会让人去重试 —— 于是「可能已经发生的那一次」再来一遍。
      //
      // 判据来自传输层抛出的结构化 `ExternalOperationError`（见 jira/client.ts），
      // 不是对错误文案做匹配：文案会随实现漂移，而这里判错的代价不可撤销。
      if (classifyExternalError(error) === 'unknown') {
        this.finishAttempt(attempt.id, 'unknown', { error: detail });
        this.markUnknown(commandId, detail);
        throw new UnknownCommandOutcomeError(this.get(commandId), detail, { cause: error });
      }

      this.finishAttempt(attempt.id, 'failed', { error: detail });
      this.markFailed(commandId, detail);
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
         WHERE id = ? AND status IN ('approved', 'ready', 'failed')`,
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

  /**
   * 外部结果未知 —— 推进到 `unknown`。
   *
   * ── 为什么不是 markFailed ────────────────────────────────────────────
   *
   * `failed` 的语义是「确认没有发生」，于是它隐含地给出了下一步建议：重试。
   * 而 timeout / connection reset / 5xx 的语义是「**可能**已经发生了」，
   * 对它重试就是把可能已经生效的那次写入再做一遍。两者在审计上是两个结论，
   * 在动作上是两个方向，所以不能共用一列状态。
   *
   * 状态仍会被推进（不是停在 executing）：`unknown` 是一个**可被对账收敛**的
   * 中间态，而停在 `executing` 会让「正在跑」和「已经不知道结果了」混在一起，
   * 后者才是真正需要人看一眼的那种。
   */
  markUnknown(commandId: string, reason?: string): void {
    this.db
      .prepare(
        `UPDATE command
         SET status = 'unknown',
             executed_at = ?
         WHERE id = ?`,
      )
      .run(now(), commandId);
    this.auditCommand(this.get(commandId), 'unknown', {
      actorType: 'system',
      actorId: 'command-service',
      detail: reason ?? null,
    });
  }

  /**
   * 开一次尝试。
   *
   * `attempt_no` 用 `MAX(attempt_no) + 1` 现算，而不是在 command 上维护一个
   * 计数器列：计数器列需要在同一条 UPDATE 里自增并回读，而这里没有那个必要
   * —— `markExecuting` 的 CAS 已经保证同一时刻只有一个执行者在跑，并且
   * `UNIQUE(command_id, attempt_no)` 是最后一道闸。真撞上了会抛，那正是我们
   * 想知道的（说明 CAS 之外还有第二条执行路径）。
   */
  startAttempt(commandId: string, operationId: string): CommandAttemptRecord {
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next
         FROM command_attempt
         WHERE command_id = ?`,
      )
      .get(commandId) as unknown as { next: number } | undefined;

    const record: CommandAttemptRecord = {
      id: randomUUID(),
      commandId,
      attemptNo: Number(next?.next ?? 1),
      operationId,
      status: 'running',
      startedAt: now(),
      endedAt: null,
      error: null,
      resultHash: null,
    };

    this.db
      .prepare(
        `INSERT INTO command_attempt (
           id, command_id, attempt_no, operation_id, status, started_at, ended_at, error, result_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.commandId,
        record.attemptNo,
        record.operationId,
        record.status,
        record.startedAt,
        record.endedAt,
        record.error,
        record.resultHash,
      );

    return record;
  }

  /**
   * 收尾一次尝试。
   *
   * `WHERE … AND status = 'running'` 是有意的：attempt 行是 append-only 的
   * 事实记录，一条已经收尾的尝试不该被二次改写（比如对账先收敛了它，随后
   * 迟到的超时回调又把它改回 unknown）。SQLite 在这里是**静默 0 行**，
   * 而 0 行恰好就是我们要的行为 —— 不抛、不覆盖，让第一条结论胜出。
   */
  finishAttempt(
    attemptId: string,
    status: Exclude<CommandAttemptStatus, 'running'>,
    input: { error?: string | null; resultHash?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE command_attempt
         SET status = ?, ended_at = ?, error = ?, result_hash = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, now(), input.error ?? null, input.resultHash ?? null, attemptId);
  }

  /** 一条 Command 的全部尝试，按第几次。 */
  listAttempts(commandId: string): CommandAttemptRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM command_attempt WHERE command_id = ? ORDER BY attempt_no`)
      .all(commandId) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapAttempt);
  }

  /**
   * 对账收敛一次**已经收尾**的尝试。
   *
   * ── 和 finishAttempt 的分工 ──────────────────────────────────────────
   *
   *   finishAttempt  「这次调用结束了」      running → succeeded | failed | unknown
   *   settleAttempt  「我们现在知道它成没成」 unknown → succeeded | failed
   *
   * `WHERE … AND status = 'unknown'` 是关键：`running` 的还在飞（对账不该去动
   * 一个还没结束的调用），而 `succeeded` / `failed` 已经有结论了 —— 再改就是用
   * 一个更晚的猜测覆盖一个更早的事实。
   *
   * 刻意**不**动 `ended_at`：那是这次调用**结束**的时刻，不是我们**得知**结果的
   * 时刻。混在一起会让「这次调用花了多久」变得不可回答。
   */
  settleAttempt(
    attemptId: string,
    status: 'succeeded' | 'failed',
    input: { detail?: string | null; resultHash?: string | null } = {},
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE command_attempt
         SET status = ?, error = ?, result_hash = ?
         WHERE id = ? AND status = 'unknown'`,
      )
      .run(status, input.detail ?? null, input.resultHash ?? null, attemptId);
    return Number(result.changes) === 1;
  }

  /**
   * 对账一条 `unknown` 的 Command —— 去外部系统问「这一笔到底做了没有」。
   *
   * ── 为什么只有 unknown 能对账 ────────────────────────────────────────
   *
   * `completed` / `failed` 已经有结论了，再对一遍是用新的猜测覆盖旧的事实。
   * `ready` / `approved` / `policy_pending` 根本没执行过，没有可对的东西。
   * 所以状态闸放在最前面，并且是**冲突**（409）而不是静默返回 —— 「我查了但
   * 什么也没查」和「这个状态不需要查」对调用方是两件事。
   *
   * ── 结论的三种去向 ───────────────────────────────────────────────────
   *
   *   completed  找到痕迹  → settleAttempt(succeeded) + markCompleted
   *   failed     确认没发生 → settleAttempt(failed)    + markFailed
   *   unknown    还是不知道 → **什么都不改**
   *
   * 第三种是最容易被「修」坏的一处：把「对账也没查出来」当成「那就是没发生」
   * 会让 Command 落到 failed，而 failed 的下一个动作是重试 —— 重试一次可能
   * 已经生效的写入。保持 unknown 才是诚实的，而且它继续挡着重试。
   */
  async reconcile(commandId: string): Promise<ExternalOperationOutcome> {
    const command = this.get(commandId);
    if (command.status !== 'unknown') {
      throw conflict(
        `Command ${commandId} 状态是 ${command.status}，只有 unknown 需要且可以对账`,
      );
    }

    const executor = this.executors.get(command.action);
    const reconcile = executor?.reconcile;
    const attempts = this.listAttempts(commandId);
    const attempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

    if (!reconcile) {
      // 没有对账实现**不等于**「没发生」。如实说不知道。
      const outcome: ExternalOperationOutcome = {
        status: 'unknown',
        detail: `Command action ${command.action} 没有注册对账实现，无法确认外部结果`,
      };
      this.auditCommand(command, 'reconciled', {
        actorType: 'system',
        actorId: 'command-service',
        detail: `结论 unknown：${outcome.detail}`,
      });
      return outcome;
    }

    let outcome: ExternalOperationOutcome;
    try {
      outcome = await reconcile({ command, args: command.args, attempt });
    } catch (error) {
      // 对账自己失败（网络又断了、没权限读评论）**不是**外部动作失败。
      outcome = {
        status: 'unknown',
        detail: `对账本身失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 先记「我们去查了、查到了什么」，再收敛状态 —— 审计的时间线因此是
    // 「unknown → reconciled（结论）→ completed/failed」，读起来就是那个因果。
    this.auditCommand(command, 'reconciled', {
      actorType: 'system',
      actorId: 'command-service',
      detail: `结论 ${outcome.status}：${outcome.detail ?? '（无说明）'}`,
    });

    if (outcome.status === 'completed') {
      if (attempt) this.settleAttempt(attempt.id, 'succeeded');
      // result_hash 记的是「这次结论的依据」。对账没有执行器的返回值，用结论
      // 本身当指纹，事后能验证「这条 completed 是对账来的，不是执行来的」。
      this.markCompleted(
        commandId,
        hashJson({ reconciled: true, detail: outcome.detail ?? null }),
      );
    } else if (outcome.status === 'failed') {
      if (attempt) this.settleAttempt(attempt.id, 'failed', { detail: outcome.detail ?? null });
      this.markFailed(commandId, outcome.detail ?? '对账确认外部写入没有发生');
    }

    return outcome;
  }

  /**
   * 按 `operation_id` 反查尝试 —— **对账的入口**。
   *
   * 对账手里只有「这一笔外部动作的身份」（operationId，它同时是打在外部系统
   * 上的标记），需要据此找回本地是哪条 Command / 哪几次尝试。没有这个索引，
   * 对账就变成全表扫描，而它恰恰是故障时刻要跑的东西。
   */
  listAttemptsByOperationId(operationId: string): CommandAttemptRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM command_attempt WHERE operation_id = ? ORDER BY attempt_no`)
      .all(operationId) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapAttempt);
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
   * 沿 retry 链往回找同一条业务动作的既有 Command。
   *
   * ── 为什么是「链」而不是「直接父级」 ────────────────────────────────
   *
   * retry 可以连着 retry：A 失败 → B（retry of A）失败 → C（retry of B）。
   * 只看直接父级的话，C 会找不到 A 上的那条 Command，于是第三轮又加一条评论。
   * 链式回看才和「同一笔业务动作」的语义对齐。
   *
   * 环保护是必须的：`retry_of_execution_id` 是数据，而数据会坏（手工改库、
   * 迁移写错、将来某条路径忘了校验）。一个成环的 retry 链会让这里**死循环**，
   * 而它发生在一次 HTTP 请求的路径上 —— 表现为整个进程卡住，不是一条错误。
   * 所以用 `seen` 显式挡环，并且有深度上限。
   *
   * 返回的 Command 可能是任何状态 —— **不在这里过滤**。因为「什么状态能复用」
   * 是调用方（`request()`）的语义：`completed` 是「已经做过」、`unknown` 是
   * 「先别动」、`failed` 是「可以再做一次」。在这里按状态过滤会把那套判断
   * 复制成两份，然后两边慢慢漂移。
   */
  findRetryableCommand(input: {
    executionId: string;
    retryOfExecutionId: string | null;
    action: string;
    target: string;
  }): CommandRecord | null {
    const seen = new Set<string>([input.executionId]);
    let cursor = input.retryOfExecutionId;
    let depth = 0;

    while (cursor && depth < MAX_RETRY_CHAIN_DEPTH) {
      if (seen.has(cursor)) return null; // 环：当成「没有可复用的」，不去猜
      seen.add(cursor);
      depth += 1;

      const row = this.db
        .prepare(
          `SELECT * FROM command
           WHERE execution_id = ? AND action = ? AND target = ?
           ORDER BY created_at, rowid
           LIMIT 1`,
        )
        .get(cursor, input.action, input.target) as unknown as
        | Record<string, unknown>
        | undefined;
      if (row) return mapCommand(row);

      cursor = this.retryOf(cursor);
    }

    return null;
  }

  /** 这条 execution 是从哪条 retry 出来的。没有 / 记录不存在都返回 null。 */
  private retryOf(executionId: string): string | null {
    const row = this.db
      .prepare(`SELECT retry_of_execution_id FROM execution WHERE id = ?`)
      .get(executionId) as unknown as { retry_of_execution_id: string | null } | undefined;
    return row?.retry_of_execution_id ?? null;
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

/** retry 链最多往回走几代。见 findRetryableCommand 的环保护说明。 */
const MAX_RETRY_CHAIN_DEPTH = 32;

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
    operationId: String(row.operation_id),
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

function mapAttempt(row: Record<string, unknown>): CommandAttemptRecord {
  return {
    id: String(row.id),
    commandId: String(row.command_id),
    attemptNo: Number(row.attempt_no),
    operationId: String(row.operation_id),
    status: row.status as CommandAttemptStatus,
    startedAt: String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    error: row.error == null ? null : String(row.error),
    resultHash: row.result_hash == null ? null : String(row.result_hash),
  };
}
