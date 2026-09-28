import type { RuntimeTool, ToolDecision, ToolExecutionContext } from './capabilities/types.js';
import type { PolicyService } from './policy.js';
import type { EntitlementChecker } from './entitlement-service.js';

/**
 * 工具授权层。
 *
 * 三个问题必须由同一处回答，否则它们会各自漂移：
 *
 *   1. 向引擎**声明**哪些工具（availableTools）—— 「它有什么」
 *   2. 每一次工具调用**放不放行**（hooks.onPreToolUse）—— 「它这次能不能用」
 *   3. 这一次调用**碰到哪些数据**（Entitlement）—— 「它能看哪些」
 *
 * 只做第 1 步不够。`skipPermission: true` 的含义是「这个 app-owned 工具不必弹
 * 权限提示」，也就是**无条件执行**；它是省一次交互，不是一次授权。所以真正的
 * 判据必须在每次调用时重新算一遍，而不是在装配 session 时算完就完。
 *
 * ── 判据只有五个，全部来自声明，没有一个看工具名 ─────────────────────
 *
 *   requiresHostAccess + 部署开关      —— 会触达宿主机的工具要部署层放行
 *   guard()                            —— Provider 的输入边界判定，只能拒绝
 *   Data Entitlement                   —— 「这类数据它有没有资格碰」（见 §Entitlement）
 *   risk ∈ {external-write, privileged} —— 放行权在 PolicyService（见 policy.ts）
 *   其余 risk                           —— guard 通过即放行
 *
 * ── 三层为什么必须是这个顺序 ─────────────────────────────────────────
 *
 *   Capability（这个工具在不在它的清单里）
 *     ↓  不在 → 调用根本到不了这里（适配器已拒）
 *   Entitlement（这类数据它有没有资格碰）
 *     ↓  没资格 → 连「该不该」都不用问 Policy
 *   Policy（这一笔该不该发生）
 *     ↓
 *   Command / 执行
 *
 * 顺序反过来的代价是具体的：先问 Policy 再问 Entitlement，等于让 Policy 去回答
 * 「这个人有没有权限看这个项目」—— 那是数据授权问题，Policy 手里只有工具声明，
 * 它只能猜。
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
 *
 * Entitlement 同样是默认拒绝：查不到授权就是没有授权。这一层的价值全在
 * 「默认关」上 —— 默认放行的话，它只是一份没人维护的文档。
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
    private readonly entitlementService: EntitlementChecker,
  ) {}

  async check(
    tool: RuntimeTool,
    context: ToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<ToolDecision> {
    if (tool.requiresHostAccess && !this.options.allowHostTools) {
      return deny(
        `${tool.name} 需要直接操作运行服务的机器，但宿主工具开关没有打开（需要 HOST_CODING_TOOLS=true），已拒绝执行`,
      );
    }

    if (tool.guard) {
      const decision = await tool.guard(context, args);
      if (!decision.allowed) return decision;
    }

    const resource = resolveToolResource(tool, args);

    // Entitlement 命中的那一条要一直带到最终决策里：它是「凭什么放行」的答案。
    // 只留在这一层的话，审计里只能看到「Policy 放行了」，而看不到「是因为哪条
    // 数据授权才轮到 Policy 判断」。
    let entitlementId: string | undefined;

    if (resource) {
      const entitlement = this.entitlementService.check({
        teamId: context.teamId,
        memberId: context.memberId,
        providerId: tool.providerId,
        resourceType: resource.type,
        resourceId: resource.id,
        action: tool.risk === 'read' ? 'read' : 'write',
      });

      if (!entitlement.allowed) {
        return {
          allowed: false,
          reason: entitlement.reason,
          entitlementRevision: entitlement.revision,
        };
      }

      entitlementId = entitlement.entitlementId;
    }

    if (tool.risk === 'external-write' || tool.risk === 'privileged') {
      const decision = await this.policyService.decide({ tool, context, args });

      // 显式搬运而不是 `return decision`：PolicyDecision 用的是 `decisionId`，
      // 而 ToolDecision 用的是 `policyDecisionId`。直接返回能通过类型检查
      // （函数返回值不做多余属性检查），但运行时那个字段会**悄悄丢掉** ——
      // 审计里的 policy_decision_id 从此永远是 null，而没有任何报错。
      return {
        allowed: decision.allowed,
        reason: decision.reason,
        policyDecisionId: decision.decisionId,
        policyRevision: decision.policyRevision,
        approvalRequired: decision.approvalRequired,
        entitlementId,
        entitlementRevision: this.entitlementService.revision(),
      };
    }

    return {
      allowed: true,
      reason: `provider=${tool.providerId}, risk=${tool.risk}`,
      entitlementId,
      entitlementRevision: this.entitlementService.revision(),
    };
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

/**
 * 这一次调用碰到的是哪条外部资源 —— Entitlement 的查询键。
 *
 * 只认 `atlassian.jira-tools`：其它 Provider 的工具参数里没有「资源」这个概念
 * （`ask_member` 碰的是本地房间，`bash` 碰的是宿主机，两者的边界分别由
 * Capability 与部署开关管）。给它们编一个资源类型，等于让 Entitlement 去管
 * 它不该管的事。
 *
 * 参数里同时有 issueKey 和 jql 时优先 issueKey：一次「按单查」比一次「按条件
 * 查」的授权更窄，取更窄的那个是安全的方向。
 *
 * 返回 null = 这次调用没有可判定的外部资源，Entitlement 这一层跳过。
 * 跳过不等于放行 —— 后面还有 Policy，而低风险路径本来就该直接过。
 */
export function resolveToolResource(
  tool: RuntimeTool,
  args: Record<string, unknown>,
): { type: string; id: string } | null {
  if (tool.providerId !== 'atlassian.jira-tools') return null;

  const issueKey = typeof args.issueKey === 'string' ? args.issueKey.trim() : '';
  if (issueKey) {
    return { type: 'jira.issue', id: issueKey };
  }

  const jql = typeof args.jql === 'string' ? args.jql.trim() : '';
  if (jql) {
    return { type: 'jira.query', id: jql };
  }

  return null;
}

function deny(reason: string): ToolDecision {
  return { allowed: false, reason };
}
