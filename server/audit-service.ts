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
   * 用 `INSERT OR REPLACE` 而不是纯 INSERT：适配器在两条路径上都会走到这里
   * （有 handler 的 custom tool、以及没有 handler 的拒绝 / MCP），而同一个
   * decisionId 落两次是**同一件事被记了两遍**，不该变成一次主键冲突。
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

    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO policy_decision_audit (
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

    return id;
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
