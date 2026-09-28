import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { hashJson } from './content-hash.js';

/**
 * AuditEvidence —— 事后证明「发生了什么」。
 *
 * ── 它和 ConversationEvent / TeamEvent 的区别 ─────────────────────────
 *
 *   ConversationEvent / TeamEvent   UI / SSE / replay
 *   AuditEvidence                   compliance / regulatory evidence
 *
 * 两者不要互相替代。事件流是**给人看的当前状态**，它可以丢、可以只发增量、
 * 可以为了体验把两条合成一条；审计是**给检查用的历史事实**，它必须逐条完整、
 * 参数可验证、拒绝也要留痕。用事件流充当审计的问题不在于「少了什么」，而在于
 * 它是可变的、有展示语义的 —— 一次 UI 改版就可能让证据链断掉。
 *
 * ── 两张表的分工 ─────────────────────────────────────────────────────
 *
 *   policy_decision_audit   谁批的（allow / deny / approval_required）
 *   tool_execution_audit    批了之后真的调了什么、结果如何
 *
 * 一次拒绝只有前者 —— 而「拒绝了什么」恰恰是合规审计里最常被问的那一类。
 * 所以不能把 Policy 决策折进 tool_execution_audit：那样被拒的调用就没有记录了。
 *
 * ── 参数怎么留 ───────────────────────────────────────────────────────
 *
 *   args_hash           原文的 sha256 —— 「参数有没有被改过」可验证
 *   args_redacted_json  脱敏后的参数 —— 「这次调用想干什么」看得懂
 *
 * 只存 hash 没法排查（不知道它想干什么），只存明文等于把凭证又抄进一张新表。
 * 两个都存才对得上：hash 覆盖原文，明文覆盖语义。
 */
export interface ToolExecutionAuditInput {
  executionId: string;
  conversationId: string;
  memberId: string;
  toolName: string;
  providerId: string;
  implementation: string;

  args: Record<string, unknown>;

  allowed: boolean;
  policyDecisionId?: string | null;
  entitlementId?: string | null;

  startedAt?: string;
  endedAt?: string | null;
  result?: unknown;
  error?: string | null;
}

/** 一次工具调用的审计行（读回来的形状，给测试与将来的审计 API 用）。 */
export interface ToolExecutionAuditRecord {
  id: string;
  executionId: string;
  toolName: string;
  providerId: string;
  implementation: string;
  allowed: boolean;
  policyDecisionId: string | null;
  entitlementId: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface PolicyDecisionAuditRecord {
  id: string;
  executionId: string;
  toolName: string;
  policyRevision: string;
  decision: 'allow' | 'deny' | 'approval_required';
  reason: string;
  inputHash: string;
  createdAt: string;
}

/** Command 生命周期里会发生的事件。 */
export type CommandAuditEvent =
  | 'requested'
  | 'policy_decided'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'failed'
  /**
   * 外部结果**未知**：请求发出去了，但没能确认对方有没有处理。
   *
   * 与 `failed` 分开是必须的，因为它们在审计上是两个不同的结论，而下一步动作
   * 相反：`failed` = 「确认没发生」→ 可以重试；`unknown` = 「可能已发生」→
   * 必须先对账，直接重试会产生第二次副作用。
   *
   * 它也不是终态 —— 对账会把它收敛成 `completed` 或 `failed`，届时再补一条事件。
   */
  | 'unknown'
  /**
   * 对账（reconcile）走了一趟，带回了结论。
   *
   * 单独一条事件而不是复用 `unknown`：`unknown` 记的是「我们不知道」，这一条
   * 记的是「我们去查了，查到了什么」—— 包括**还是不知道**。审计要能回答
   * 「谁在什么时候为了这笔动作多花了一次外部查询」，那正是这条事件。
   */
  | 'reconciled'
  /**
   * 这条 Command 被一次 retry 复用，没有新建第二笔。
   *
   * 没有它的话，审计里会出现「一条 Command 的 attempt 来自两条不同的 execution」
   * 而没有任何解释 —— 看起来像数据串了。它是「为什么 retry 没有产生第二条
   * Jira 评论」这个问题的答案。
   */
  | 'inherited';

export interface CommandAuditRecord {
  id: string;
  commandId: string;
  executionId: string;
  event: CommandAuditEvent;
  actorType: 'agent' | 'human' | 'system';
  actorId: string;
  detail: string | null;
  createdAt: string;
}

export class AuditService {
  constructor(private readonly db: DatabaseSync) {}

  startToolExecution(
    input: Omit<ToolExecutionAuditInput, 'endedAt' | 'result' | 'error'>,
  ): string {
    const id = randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO tool_execution_audit (
          id,
          execution_id,
          conversation_id,
          member_id,
          tool_name,
          provider_id,
          implementation,
          args_hash,
          args_redacted_json,
          allowed,
          policy_decision_id,
          entitlement_id,
          started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.executionId,
        input.conversationId,
        input.memberId,
        input.toolName,
        input.providerId,
        input.implementation,
        hashJson(input.args),
        JSON.stringify(redactArgs(input.args)),
        input.allowed ? 1 : 0,
        input.policyDecisionId ?? null,
        input.entitlementId ?? null,
        input.startedAt ?? now(),
      );

    return id;
  }

  /**
   * 收口一次调用。
   *
   * 成功和失败都必须调它 —— 留一条只有 started_at 的行比没有记录更糟：
   * 看的人无法区分「还在跑」和「进程没了」。
   */
  finishToolExecution(
    auditId: string,
    input: { result?: unknown; error?: string | null },
  ): void {
    this.db
      .prepare(
        `
        UPDATE tool_execution_audit
        SET ended_at = ?,
            result_hash = ?,
            error = ?
        WHERE id = ?
        `,
      )
      .run(
        now(),
        input.result === undefined ? null : hashJson(input.result),
        input.error ?? null,
        auditId,
      );
  }

  /**
   * 落一条 Policy 决策。**每一次判定都要落**，不只是拒绝 ——
   * 「这一笔为什么被放行」和「为什么被拒」是同一类问题。
   *
   * `id` 可选：PolicyService 自己产出的 `decisionId` 要原样用（它是那条决策
   * 的身份，换成新的会让「谁批的」和「批了什么」对不上）；没给就生成一个。
   *
   * ── 为什么是 append-only ────────────────────────────────────────────
   *
   * 这里以前是 `INSERT OR REPLACE`，理由是「同一个 decisionId 落两次是同一件
   * 事被记了两遍，不该变成主键冲突」。那个理由本身没错，但 REPLACE 的代价是
   * **一行审计可以被另一行静默覆盖**：一旦 id 被复用（或者有人手工造了一个
   * 重复的 decisionId），旧证据就消失了，而且消失得没有任何痕迹 —— 而审计的
   * 全部价值就在「它不会被后来发生的事改写」。
   *
   * 改成「写入即终态」：
   *
   *   ON CONFLICT(id) DO NOTHING  → 冲突不覆盖（changes = 0）
   *   冲突时回读已有行，逐字段比对
   *     完全一致  → 同一件事被记了两遍，幂等，正常返回
   *     有任何不同 → **抛错**：这是 id 复用，是审计链被破坏的信号
   *
   * 关键差别在于「不一致时抛错」。REPLACE 会把这种破坏悄悄变成一次覆盖；
   * 而这里必须让人知道 —— 一条被改写的证据比一条缺失的证据更危险，因为
   * 它看起来是完整的。
   */
  recordPolicyDecision(input: {
    id?: string;
    executionId: string;
    toolName: string;
    policyRevision: string;
    decision: 'allow' | 'deny' | 'approval_required';
    reason: string;
    inputHash: string;
  }): string {
    const id = input.id ?? randomUUID();

    const result = this.db
      .prepare(
        `
        INSERT INTO policy_decision_audit (
          id,
          execution_id,
          tool_name,
          policy_revision,
          decision,
          reason,
          input_hash,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
        `,
      )
      .run(
        id,
        input.executionId,
        input.toolName,
        input.policyRevision,
        input.decision,
        input.reason,
        input.inputHash,
        now(),
      );

    if (Number(result.changes) === 0) {
      const existing = this.db
        .prepare(`SELECT * FROM policy_decision_audit WHERE id = ?`)
        .get(id) as unknown as Record<string, unknown> | undefined;

      // 冲突却查不到行 = 主键约束被别的唯一索引触发了，或者表被并发删了。
      // 这不是「幂等命中」，不能当成正常返回。
      if (!existing) {
        throw new Error(`Policy 决策审计写入失败且回读不到：${id}`);
      }

      const conflicts = describeDecisionConflict(existing, input);
      if (conflicts) {
        throw new Error(
          `Policy 决策审计 id 被复用（${id}）：${conflicts}。` +
            '审计是 append-only 的，同 id 必须是同一件事 —— 请检查 decisionId 的生成处。',
        );
      }
    }

    return id;
  }

  /**
   * 落一条 Command 生命周期事件。
   *
   * 为什么不复用 recordPolicyDecision：那是**工具层**的判定（Agent 想调什么
   * 工具），这里是**业务动作层**的过程（系统对外部世界做了什么）。一次 Jira
   * 流转可以不经过任何工具（控制面发起），但一定经过 Command —— 两张表各自
   * 完整，不互相替代。
   *
   * 写入不加唯一约束、不做去重：同一条 Command 可以合法地经历多次
   * executing → failed（重试执行），把「第几次」折掉会丢掉真正要看的东西。
   */
  recordCommandEvent(input: {
    commandId: string;
    executionId: string;
    event: CommandAuditEvent;
    actorType: 'agent' | 'human' | 'system';
    actorId: string;
    detail?: string | null;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO command_audit (
           id, command_id, execution_id, event, actor_type, actor_id, detail, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.commandId,
        input.executionId,
        input.event,
        input.actorType,
        input.actorId,
        input.detail ?? null,
        now(),
      );
    return id;
  }

  /** 一条 Command 的生命周期，按发生顺序。 */
  listCommandAudit(commandId: string): CommandAuditRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM command_audit WHERE command_id = ? ORDER BY created_at, rowid`)
      .all(commandId) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      commandId: String(row.command_id),
      executionId: String(row.execution_id),
      event: row.event as CommandAuditEvent,
      actorType: row.actor_type as CommandAuditRecord['actorType'],
      actorId: String(row.actor_id),
      detail: row.detail == null ? null : String(row.detail),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * 某条 execution 下**全部** Command 的事件，按发生顺序。
   *
   * 导出/查询接口用它：一条 execution 里可能有多笔业务动作，逐条 Command 去
   * 查会把「这一轮到底对外做了什么」拆成 N 次调用。
   */
  listCommandAuditForExecution(executionId: string): CommandAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM command_audit WHERE execution_id = ? ORDER BY created_at, rowid`,
      )
      .all(executionId) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      commandId: String(row.command_id),
      executionId: String(row.execution_id),
      event: row.event as CommandAuditEvent,
      actorType: row.actor_type as CommandAuditRecord['actorType'],
      actorId: String(row.actor_id),
      detail: row.detail == null ? null : String(row.detail),
      createdAt: String(row.created_at),
    }));
  }

  /** 某条 execution 的全部工具调用审计，按发生顺序。 */
  listToolExecutions(executionId: string): ToolExecutionAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_execution_audit
         WHERE execution_id = ?
         ORDER BY started_at`,
      )
      .all(executionId) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      executionId: String(row.execution_id),
      toolName: String(row.tool_name),
      providerId: String(row.provider_id),
      implementation: String(row.implementation),
      allowed: Number(row.allowed) === 1,
      policyDecisionId: row.policy_decision_id == null ? null : String(row.policy_decision_id),
      entitlementId: row.entitlement_id == null ? null : String(row.entitlement_id),
      startedAt: String(row.started_at),
      endedAt: row.ended_at == null ? null : String(row.ended_at),
      error: row.error == null ? null : String(row.error),
    }));
  }

  /** 某条 execution 的全部 Policy 决策（含拒绝）。 */
  listPolicyDecisions(executionId: string): PolicyDecisionAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM policy_decision_audit
         WHERE execution_id = ?
         ORDER BY created_at`,
      )
      .all(executionId) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      executionId: String(row.execution_id),
      toolName: String(row.tool_name),
      policyRevision: String(row.policy_revision),
      decision: row.decision as PolicyDecisionAuditRecord['decision'],
      reason: String(row.reason),
      inputHash: String(row.input_hash),
      createdAt: String(row.created_at),
    }));
  }
}

/**
 * 比对「已落库的那条决策」和「这次想落的」。
 *
 * 返回 null = 完全一致（同一件事被记了两遍，幂等）。
 * 返回字符串 = 不一致的字段说明（调用方据此抛错）。
 *
 * **只比对内容字段，不比对 created_at**：两条记录的时间必然不同，把它算进
 * 一致性判断会让「同一件事记两遍」永远被判成不一致 —— 而那恰恰是这里唯一
 * 应当放过的情形。
 */
function describeDecisionConflict(
  existing: Record<string, unknown>,
  input: {
    executionId: string;
    toolName: string;
    policyRevision: string;
    decision: string;
    reason: string;
    inputHash: string;
  },
): string | null {
  const fields: Array<[string, unknown, unknown]> = [
    ['execution_id', existing.execution_id, input.executionId],
    ['tool_name', existing.tool_name, input.toolName],
    ['policy_revision', existing.policy_revision, input.policyRevision],
    ['decision', existing.decision, input.decision],
    ['reason', existing.reason, input.reason],
    ['input_hash', existing.input_hash, input.inputHash],
  ];

  const mismatched = fields
    .filter(([, stored, incoming]) => stored !== incoming)
    .map(([name, stored, incoming]) => `${name}: 已存=${String(stored)} 本次=${String(incoming)}`);

  return mismatched.length ? mismatched.join('；') : null;
}

/**
 * 参数脱敏。
 *
 * 按**名字**匹配而不是按值猜：值层面的启发式（「长得像 token 就替换」）会把
 * 正常内容误伤成 [REDACTED]，而漏掉的那个反而是真的凭证。名字是调用方自己
 * 起的，`apiToken` / `authorization` 这类名字没有歧义。
 *
 * 只处理顶层键：工具参数是扁平的（issueKey / body / jql），为了嵌套去递归
 * 会让「什么被替换了」变得不可预期 —— 审计要的是可预期。
 */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const secretNames = new Set(['token', 'apitoken', 'password', 'secret', 'authorization', 'cookie']);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = secretNames.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}
