import type { RuntimeTool, ToolDecision, ToolExecutionContext } from './capabilities/types.js';

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
 * ── 这一层不再认识任何工具名 ──────────────────────────────────────────
 *
 * 判据只有三个，全部来自 RuntimeTool 的声明：
 *
 *   requiresHostAccess  + 部署开关   —— 会触达宿主机的工具要部署层放行
 *   risk === 'privileged' / 'external-write' —— 高风险动作必须有独立决策：
 *     没有 authorize() 直接拒绝，有则以它的结论为准
 *   authorize()                      —— Provider 自己的逐次判定（路径白名单等）
 *
 * `if (toolName === 'bash')` 这种写法之所以必须消失：它让「新增一个工具」变成
 * 「改授权层」——于是第三方 / 新 Provider 提供的工具永远无法真正插件化，而且
 * 每加一个工具都要重新审一遍这个文件。现在新增工具只需要在 Provider 里声明
 * 它的 risk，授权层不动。
 *
 * 声明与放行的关系也随之变了：以前是「一份白名单同时喂两边」，现在是
 * 「可用集合 = 解析出来的工具集合」，声明与放行天然同源 —— 引擎看得见的东西
 * 就是解析器交出去的东西。
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
  constructor(private readonly options: ToolPolicyOptions) {}

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

    // privileged 一律拒绝：它要的是独立 Policy 服务的决策，不是 Provider 自己的
    // authorize() 自证清白 —— 后者让「执行动作的人」同时当「批准动作的人」。
    if (tool.risk === 'privileged') {
      return deny('privileged Tool 必须经过独立 Policy 决策，授权层不直接放行');
    }

    // external-write 默认拒绝：必须有 authorize() 且它明确放行。
    // 没有它时直接拒绝 —— 否则以后加一个 send_email（无 authorize）会默认允许。
    if (tool.risk === 'external-write') {
      if (!tool.authorize) {
        return deny('external-write Tool 缺少独立 Policy 决策（authorize），默认拒绝');
      }
      const decision = await tool.authorize(context, args);
      if (!decision.allowed) return decision;
      return { allowed: true, reason: `policy allow: ${decision.reason}` };
    }

    if (tool.authorize) {
      const decision = await tool.authorize(context, args);
      if (!decision.allowed) return decision;
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
