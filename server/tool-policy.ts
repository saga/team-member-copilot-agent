import type { RuntimeTool, ToolDecision, ToolExecutionContext } from './capabilities/types.js';
import type { PolicyService } from './policy.js';

/**
 * 工具授权层。
 *
 * 两个问题必须由同一处回答，否则它们会各自漂移：
 *
 *   1. 向引擎**声明**哪些工具（availableTools）—— 「它有什么」
 *   2. 每一次工具调用**放不放行**（hooks.onPreToolUse）—— 「它这次能不能用」
 *
 * 只做第 1 步不够。`skipPermission: true` 的含义是「这个 app-owned 工具不必弹
 * 权限提示」，也就是**无条件执行**；它是省一次交互，不是一次授权。所以真正的
 * 判据必须在每次调用时重新算一遍，而不是在装配 session 时算完就完。
 *
 * ── 判据只有四个，全部来自声明，没有一个看工具名 ─────────────────────
 *
 *   requiresHostAccess + 部署开关      —— 会触达宿主机的工具要部署层放行
 *   guard()                            —— Provider 的输入边界判定，只能拒绝
 *   risk ∈ {external-write, privileged} —— 放行权在 PolicyService（见 policy.ts）
 *   其余 risk                           —— guard 通过即放行
 *
 * guard 与 Policy 的分工：guard 是「工具自己最清楚的事」（这条路径在不在
 * workspace 内），Policy 是「工具自己无资格回答的事」（这笔外部写入该不该发生）。
 * guard 说不行就一定不行；guard 说行只对低风险工具有效 —— 否则每个 Provider
 * 都能写一个 `() => ({ allowed: true })` 把自己升级成无限制工具。
 *
 * `if (toolName === 'bash')` 这种写法之所以必须消失：它让「新增一个工具」变成
 * 「改授权层」。现在新增工具只需要在 Provider 里声明 risk 与实现，授权层不动。
 *
 * ── 默认拒绝 ─────────────────────────────────────────────────────────
 *
 * 走到 `check()` 的每个工具都已经在 `RuntimeCapabilities.toolIndex` 里（未注册
 * 的直接在适配器里被拒）。所以这里的「默认」是把**未被任何 Provider 声明过的
 * 名字**挡在外面：引擎新增一个 built-in、或某份 skill 让模型想调一个我们没承认
 * 过的名字时，必须在授权层被拦下，而不是默默执行。
 */
export interface ToolPolicyOptions {
  /**
   * 是否允许会触达宿主机的工具落地。
   *
   * 由部署决定，而不是由 Member 的能力声明决定：一个 Member 绑定了
   * `runtime.host-coding-tools` 只代表「它想要」，不该等于它获得了宿主机的执行权。
   */
  allowHostTools: boolean;
}

export interface ToolPolicy {
  check(
    tool: RuntimeTool,
    context: ToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<ToolDecision> | ToolDecision;

  /**
   * 这个已解析出来的工具是不是「声明了却被部署收走」。
   *
   * 放在 policy 上而不是让调用方自己拼 `requiresHostAccess && !allowHostTools`：
   * 那两处一旦分开写就会漂移，而漂移的表现是「日志说没给、实际给了」。
   */
  hostToolWithheld(tool: RuntimeTool): boolean;
}

export class DefaultToolPolicy implements ToolPolicy {
  constructor(
    private readonly options: ToolPolicyOptions,
    private readonly policyService: PolicyService,
  ) {}

  async check(
    tool: RuntimeTool,
    context: ToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<ToolDecision> {
    if (tool.requiresHostAccess && !this.options.allowHostTools) {
      return deny(
        `${tool.name} 会触达宿主机，而宿主工具当前未启用（HOST_CODING_TOOLS != true）`,
      );
    }

    if (tool.guard) {
      const decision = await tool.guard(context, args);
      if (!decision.allowed) return decision;
    }

    if (tool.risk === 'external-write' || tool.risk === 'privileged') {
      return this.policyService.decide({ tool, context, args });
    }

    return { allowed: true, reason: `provider=${tool.providerId}, risk=${tool.risk}` };
  }

  /**
   * 某个已解析出来的宿主工具，是不是「声明了却被部署收走」。
   *
   * 调用方据此在日志里说明「它要的能力没给」。不说出来的话，成员配置上写着
   * 有宿主工具、实际跑起来一个都没有，只能靠翻执行日志猜。
   */
  hostToolWithheld(tool: RuntimeTool): boolean {
    return tool.requiresHostAccess === true && !this.options.allowHostTools;
  }
}

function deny(reason: string): ToolDecision {
  return { allowed: false, reason };
}
