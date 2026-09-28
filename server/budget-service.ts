/**
 * Budget —— 一次执行的资源上限。
 *
 * ── 为什么不是「超时就 kill」 ──────────────────────────────────────────
 *
 * 单看时长会漏掉两种最贵的失控：**调用次数**（一轮里模型来回调 200 次工具，
 * 每次都不慢，合起来很贵）和**扇出**（一个 Member 委派给另一个，另一个再委派，
 * 深度 6 层 × 每层 3 个 = 几百条 execution，单条都不超时）。所以四个维度要
 * 一起判，任何一个超了就拒绝。
 *
 * ── 为什么先只接这四个 ────────────────────────────────────────────────
 *
 * 它们**全部由平台自己数得出来**：时长来自 execution 的起止，调用次数来自
 * tool_execution_audit，委派深度来自 parent_execution_id 链，子执行数来自
 * 一次 count。不需要模型报数，也不需要接计费系统。
 *
 * token / cost 故意留到后面接 LiteLLM usage —— 那需要一个平台之外的数据源，
 * 在没有它之前用一个估算值填进去，只会让「预算」变成一句不准确的口号。
 *
 * ── 它不管的事 ────────────────────────────────────────────────────────
 *
 * 不管「谁有权做什么」（那是 Capability / Entitlement / Policy），也不管
 * 「要不要人批」（那是 Approval）。它只回答：**这次还跑得起吗**。
 */
export interface BudgetLimit {
  maxDurationMs: number;
  maxToolCalls: number;
  maxDelegationDepth: number;
  maxChildExecutions: number;
}

export interface BudgetUsage {
  durationMs: number;
  toolCalls: number;
  delegationDepth: number;
  childExecutions: number;
}

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
  /** 超掉的那个维度。允许时为 undefined。 */
  exceeded?: keyof BudgetLimit;
}

/**
 * 默认额度。
 *
 * 数值来自现有配置的量级，不是拍脑袋：时长跟着 executionTimeoutMs（10 分钟）
 * 走并留一倍余量；调用次数取「一个正常任务 30 次工具调用」的 5 倍 ——
 * 超过它基本可以断定模型在绕圈；深度与 config.maxDelegationDepth 一致；
 * 子执行数取「一个 Lead 最多带 20 个 Task」。
 */
export const DEFAULT_BUDGET_LIMIT: BudgetLimit = {
  maxDurationMs: 20 * 60_000,
  maxToolCalls: 150,
  maxDelegationDepth: 4,
  maxChildExecutions: 20,
};

export class BudgetService {
  constructor(private readonly limit: BudgetLimit = DEFAULT_BUDGET_LIMIT) {}

  /**
   * 判定顺序固定（时长 → 调用 → 深度 → 子执行）。
   *
   * 固定顺序的意义是**可复现**：同时超两个维度时，日志里永远是同一个原因。
   * 按 Map 顺序或随机顺序报第一个，会让「同一个现象两次日志不同」，
   * 而排查失控任务时最需要的恰恰是稳定信号。
   */
  check(usage: BudgetUsage): BudgetDecision {
    if (usage.durationMs > this.limit.maxDurationMs) {
      return { allowed: false, reason: 'execution duration budget exceeded', exceeded: 'maxDurationMs' };
    }

    if (usage.toolCalls > this.limit.maxToolCalls) {
      return { allowed: false, reason: 'tool call budget exceeded', exceeded: 'maxToolCalls' };
    }

    if (usage.delegationDepth > this.limit.maxDelegationDepth) {
      return { allowed: false, reason: 'delegation depth budget exceeded', exceeded: 'maxDelegationDepth' };
    }

    if (usage.childExecutions > this.limit.maxChildExecutions) {
      return { allowed: false, reason: 'child execution budget exceeded', exceeded: 'maxChildExecutions' };
    }

    return { allowed: true, reason: 'within budget' };
  }
}
