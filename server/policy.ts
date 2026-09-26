import type { RuntimeTool, ToolDecision, ToolExecutionContext } from './capabilities/types.js';

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
 */
export interface PolicyDecisionInput {
  tool: RuntimeTool;
  context: ToolExecutionContext;
  args: Record<string, unknown>;
}

export interface PolicyService {
  decide(input: PolicyDecisionInput): Promise<ToolDecision> | ToolDecision;
}

/** 进程内默认实现：本部署没有配置外部写入通道，高风险动作没有可批准的出口。 */
export class DenyHighRiskPolicyService implements PolicyService {
  decide(input: PolicyDecisionInput): ToolDecision {
    return {
      allowed: false,
      reason: `${input.tool.name}（risk=${input.tool.risk}）需要独立 Policy 决策，当前部署未提供外部动作通道`,
    };
  }
}
