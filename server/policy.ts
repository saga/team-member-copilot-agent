import { randomUUID } from 'node:crypto';
import type { RuntimeTool, ToolExecutionContext } from './capabilities/types.js';

/**
 * 高风险动作（external-write / privileged）的独立决策点。
 *
 * 它存在的理由：Provider 定义并执行工具，所以 Provider 的 guard() 只能管输入
 * 边界（参数格式、路径范围），**不能批准高风险动作** —— 那是「执行的人给自己
 * 签发许可」。放行与否需要站在工具之外的一方判断，这一方就是 PolicyService。
 *
 * 进程内实现是当前部署的形态：高风险一律拒绝。多副本或需要集中审计时，把实现
 * 换成远程 Policy 服务，`DefaultToolPolicy` 与所有调用方不变 —— 这正是把它定成
 * 接口而不是内联在 tool-policy 里的原因。
 *
 * ── 为什么要 revision() ───────────────────────────────────────────────
 *
 * 决策必须能事后复现：「当时是按哪版政策放的行」。没有版本号时，一次
 * 政策变更会让所有历史 execution 的记录变成无法解释的 —— 同样的一次调用，
 * 昨天放行今天拒绝，而记录上看不出差别。
 *
 * 版本号也进 `policy_decision_audit`，于是「这条审计是按哪版政策产生的」
 * 和「这一轮用的哪版政策」能对上。
 */

/** 内置实现的版本。改判定逻辑必须同时改它 —— 否则审计里的版本号会撒谎。 */
export const BUILTIN_POLICY_REVISION = 'deny-high-risk-v2';

export interface PolicyDecisionInput {
  tool: RuntimeTool;
  context: ToolExecutionContext;
  args: Record<string, unknown>;
}

/**
 * Command 层的决策输入。
 *
 * 和 `PolicyDecisionInput` 分开是必要的，不是重复：前者问「这次**工具调用**
 * 该不该发生」，后者问「这笔**业务动作**该不该发生」。Command 可能由平台
 * （控制面）发起而没有对应的工具调用，也可能一次工具调用产生多条 Command。
 * 硬把 Command 塞进 RuntimeTool 的形状里，等于为了复用签名而编一个假工具。
 */
export interface CommandPolicyInput {
  action: string;
  target: string;
  memberId: string;
  executionId: string;
  args: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  /** 这条决策的 id。进了 `policy_decision_audit`，工具审计用它回指。 */
  decisionId?: string;
  policyRevision?: string;
  /** true = 不是「不许」，而是「要人批」。当前部署没有批准出口，所以同时是拒绝。 */
  approvalRequired?: boolean;
}

export interface PolicyService {
  revision(): string;

  decide(input: PolicyDecisionInput): Promise<PolicyDecision> | PolicyDecision;
}

/** Command 层的策略口。和 PolicyService 分开，见 CommandPolicyInput 上的说明。 */
export interface CommandPolicy {
  revision(): string;

  decideCommand(input: CommandPolicyInput): Promise<PolicyDecision> | PolicyDecision;
}

/**
 * 进程内默认实现：本部署没有配置外部写入通道，高风险动作没有可批准的出口。
 *
 * `approvalRequired: true` 和 `allowed: false` 同时出现不是矛盾：它表达的是
 * 「这件事本来该走审批，但这个部署里没有人能批」，而不是「这件事被明令禁止」。
 * 前端与日志据此可以说出「需要审批」而不是「被拒绝」—— 前者指向一条可行的
 * 操作路径（把 Policy Service 接上），后者看起来像配置错误。
 */
export class DenyHighRiskPolicyService implements PolicyService, CommandPolicy {
  revision(): string {
    return BUILTIN_POLICY_REVISION;
  }

  decide(input: PolicyDecisionInput): PolicyDecision {
    return {
      allowed: false,
      decisionId: randomUUID(),
      policyRevision: this.revision(),
      reason: `${input.tool.name}（risk=${input.tool.risk}）需要独立 Policy 决策，当前部署未提供外部动作通道`,
      approvalRequired: true,
    };
  }

  decideCommand(input: CommandPolicyInput): PolicyDecision {
    return {
      allowed: false,
      decisionId: randomUUID(),
      policyRevision: this.revision(),
      reason: `Command ${input.action}（target=${input.target}）需要独立 Policy 决策，当前部署未提供外部动作通道`,
      approvalRequired: true,
    };
  }
}
