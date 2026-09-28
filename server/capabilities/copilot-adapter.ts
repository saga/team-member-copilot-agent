import {
  BuiltInTools,
  defineTool,
  ToolSet,
  type MCPServerConfig,
  type ToolInvocation,
  type Tool,
} from '@github/copilot-sdk';
import type { ToolPolicy } from '../tool-policy.js';
import type { AuditService } from '../audit-service.js';
import { hashJson } from '../content-hash.js';
import type {
  CapabilityContext,
  RuntimeCapabilities,
  RuntimeMcpServer,
  RuntimeTool,
  ToolDecision,
  ToolExecutionContext,
} from './types.js';

/**
 * RuntimeCapabilities → Copilot SDK 的 session 配置。
 *
 * 这是**唯一**认识 SDK 的地方。放在 capabilities 目录下的原因很直接：把
 * `RuntimeCapabilities` 翻译成 `tools` / `availableTools` / `onPreToolUse` 是
 * 引擎细节，而 Provider 只该产出「有哪些能力」。以后换 Agent Engine，改这一个
 * 文件即可 —— Member / Conversation / Execution / Capability 全都不用动。
 *
 * ── 每个工具都在两处出现，而且必须一致 ────────────────────────────────
 *
 *   tools[] + availableTools   「模型看得见什么」
 *   onPreToolUse               「这一次调用放不放行」
 *
 * 第二道是真正的授权：`skipPermission: true` 只是「不必弹权限提示」，不是
 * 授权。两者共用同一份解析结果（toolIndex），所以不会出现「声明了却被自己拒掉」
 * 的漂移。
 */
export interface McpToolUse {
  serverId: string;
  toolName: string;
}

export interface CopilotCapabilities {
  /** custom tool 的 SDK 定义，交给 session 的 `tools`。 */
  tools: Tool<unknown>[];
  /** 交给 session 的 `availableTools`。 */
  availableTools: ToolSet;
  /** 交给 session 的 `mcpServers`：SDK 原生运行 MCP，生命周期不归我们管。 */
  mcpServers: Record<string, MCPServerConfig>;
  /**
   * 逐次授权。返回 `null` = 找不到这个工具的来历（从未声明过），调用方必须拒绝。
   *
   * 放行的是 MCP 工具时顺带报出是哪个 server 的哪个工具：调用方（copilot.ts）
   * 据此发一条「用过什么」的展示事件。授权判定本身不受影响。
   */
  checkToolUse(
    toolName: string,
    args: unknown,
  ): Promise<{ allowed: boolean; reason: string; mcp?: McpToolUse }>;
}

export class CopilotCapabilityAdapter {
  /**
   * `audit` 可选：不传时整条审计链静默关闭。
   *
   * 做成可选而不是必填，是因为它不该成为「装配顺序」的又一道约束 —— 适配器在
   * CopilotService 里构造，而 AuditService 只是个 DB 包装，两者没有真正的依赖。
   * 生产装配永远传（见 app.ts）；测试可以只关心判定结果。
   */
  constructor(
    private readonly policy: ToolPolicy,
    private readonly audit?: AuditService,
  ) {}

  build(capabilities: RuntimeCapabilities, context: CapabilityContext): CopilotCapabilities {
    // isolated built-in 恒可用：SDK 契约保证它们只在 session 边界内活动，
    // 不属于任何 Provider，也不经过授权层。
    const availableTools = new ToolSet().addBuiltIn(BuiltInTools.Isolated);
    const tools: Tool<unknown>[] = [];

    for (const tool of capabilities.tools) {
      // 部署收走的宿主工具**连声明都不给**：模型看到一个自己永远调不动的工具
      // 只会反复尝试，把一轮 turn 浪费在被拒的调用上。声明与放行同源 ——
      // 这里和 check() 用同一个判据（policy.hostToolWithheld），不会一边说
      // 「不给」一边又给了。
      if (this.policy.hostToolWithheld(tool)) continue;

      if (tool.kind === 'builtin') {
        availableTools.addBuiltIn(tool.name);
        continue;
      }

      if (!tool.parameters || !tool.execute) {
        throw new Error(`Custom Tool ${tool.name} 缺少 parameters/execute，无法交给引擎`);
      }

      availableTools.addCustom(tool.name);
      tools.push(this.defineCustomTool(tool, context));
    }

    // MCP 工具的可见性：逐个按规范 wire 名（`github-search_code`）声明，
    // 不用 `mcp:*` —— 通配等于把「这个 server 将来新增的工具」也提前放行了。
    for (const server of capabilities.mcpServers) {
      for (const toolName of server.tools) {
        availableTools.addMcp(`${server.id}-${toolName}`);
      }
    }

    return {
      tools,
      availableTools,
      mcpServers: buildMcpServerConfigs(capabilities.mcpServers),
      checkToolUse: (toolName, args) => this.check(toolName, args, capabilities, context),
    };
  }

  private defineCustomTool(tool: RuntimeTool, context: CapabilityContext): Tool<unknown> {
    return defineTool(tool.name, {
      description: tool.description,
      parameters: tool.parameters,
      // app-owned 工具不需要人点「同意」：没有终端可以点。真正的判定在
      // evaluateToolUse 里，下面是唯一执行入口。
      //
      // `skipPermission: true` 的含义是「不必弹权限提示」，也就是**无条件执行**
      // —— 它省掉的是一次交互，不是一次授权。所以授权判定必须在每次调用时重新
      // 算一遍，而不是在装配 session 时算完就完。
      skipPermission: true,
      handler: async (args: unknown, _invocation: ToolInvocation) => {
        const current: ToolExecutionContext = { ...context, toolName: tool.name };
        const normalized = normalizeArgs(args);
        const decision = await this.evaluateToolUse(tool, context, normalized);

        // 先落 Policy 决策，再落工具调用。顺序不能反：tool_execution_audit
        // 的外键指向 policy_decision_audit，反了会直接违反约束 —— 而那个约束
        // 正是「每一条调用都能回指到一次判定」这句话的实现。
        const policyDecisionId = this.recordPolicyDecision(tool, context, normalized, decision);

        // 审计在**判定之后、执行之前**开始：一条只有「想调」没有「调没调成」的
        // 记录没法用，所以 start 与 finish 成对出现，两条路径（放行/拒绝）
        // 都必须收口。
        const auditId = this.audit?.startToolExecution({
          executionId: context.executionId,
          conversationId: context.conversationId,
          memberId: context.memberId,
          toolName: tool.name,
          providerId: tool.providerId,
          implementation: tool.implementation,
          args: normalized,
          allowed: decision.allowed,
          policyDecisionId,
          entitlementId: decision.entitlementId ?? null,
        });

        if (!decision.allowed) {
          if (auditId) {
            this.audit!.finishToolExecution(auditId, { error: decision.reason });
          }
          throw new Error(`Tool ${tool.name} 被拒绝：${decision.reason}`);
        }

        try {
          const result = await tool.execute!(current, normalized);
          if (auditId) {
            this.audit!.finishToolExecution(auditId, { result });
          }
          return result;
        } catch (error) {
          if (auditId) {
            this.audit!.finishToolExecution(auditId, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      },
    });
  }

  /**
   * 一次工具调用的完整判定：**先 guard，再 Policy**。
   *
   * guard 是 Provider 对「这一次调用的输入边界」的判定（这条路径在不在
   * workspace 内、参数格式对不对）。它必须在这里被执行，而且必须在 Policy 之前：
   *
   *   guard 说不行 → 一定不行（Provider 最清楚自己的输入约束）
   *   guard 说行   → 只对低风险工具有效，external-write / privileged 的放行权
   *                  在 PolicyService（「执行动作的人」不能同时当「批准动作的人」）
   *
   * 放在适配器里、而不是只依赖注入进来的 ToolPolicy：授权判定的第一道闸不该
   * 取决于「装配时传了哪个 policy 实现」。这样即使换了一个忘了跑 guard 的
   * policy，guard 仍然生效。
   *
   * 因此 guard **必须保持无副作用**，只做输入 / 边界检查 —— 它可能被求值一次
   * 以上，而「检查两次」和「执行两次」是完全不同的后果。
   */
  private async evaluateToolUse(
    tool: RuntimeTool,
    context: CapabilityContext,
    args: Record<string, unknown>,
  ): Promise<ToolDecision> {
    if (tool.guard) {
      const guardDecision = await tool.guard({ ...context, toolName: tool.name }, args);
      if (!guardDecision.allowed) {
        return { allowed: false, reason: guardDecision.reason };
      }
    }

    return this.policy.check(tool, { ...context, toolName: tool.name }, args);
  }

  private async check(
    toolName: string,
    args: unknown,
    capabilities: RuntimeCapabilities,
    context: CapabilityContext,
  ): Promise<{ allowed: boolean; reason: string; mcp?: McpToolUse }> {
    if ((BuiltInTools.Isolated as readonly string[]).includes(toolName)) {
      return { allowed: true, reason: 'SDK isolated built-in' };
    }

    const tool = capabilities.toolIndex.get(toolName);
    if (tool) {
      const normalized = normalizeArgs(args);
      const decision = await this.evaluateToolUse(tool, context, normalized);
      // 被拒的调用**没有 handler**（引擎不会去执行它），所以审计必须在这里补。
      // 放行的那条不在这一层写 —— handler 会写，两处都写就是一次调用两条记录。
      if (!decision.allowed) {
        this.auditDecisionWithoutHandler(tool, context, normalized, decision);
      }
      return decision;
    }

    // MCP 工具走同一套 Policy：先按别名反查是哪个 server 的哪个工具，
    // 再按它声明的 risk 判定。SDK 原生能力不是绕过授权的理由。
    const candidates = capabilities.mcpToolIndex.get(toolName) ?? [];
    if (candidates.length === 0) {
      // 声明之外的任何名字 —— 引擎的其它 built-in、skill 带来的工具、拼错的名字。
      // 全部拒绝：放行一个来历不明的工具，等于授权层不存在。
      //
      // 这一条**不写审计**：没有 Provider 就没有 providerId / implementation，
      // 硬写一行会把「不知道是谁」记成一条看起来正常的记录。它只在日志里出现。
      return { allowed: false, reason: `未为该工具定义策略（${toolName}），授权层默认拒绝` };
    }
    if (candidates.length > 1) {
      const where = candidates.map((item) => item.providerId).join('、');
      return {
        allowed: false,
        reason:
          `工具 ${toolName} 在多个 MCP Server 上重名（${where}），无法确定是调哪一个，已拒绝执行：` +
          '请收窄授权绑定的 selector，让这个名字只剩一个来源',
      };
    }
    const normalizedMcp = normalizeArgs(args);
    const decision = await this.evaluateToolUse(candidates[0], context, normalizedMcp);
    // MCP 工具由 SDK 原生执行，本服务没有「执行完成」回调 —— 所以这一行只能记
    // 到判定为止。放行时 `ended_at` 留空，语义是「已授权、结果不由本服务观察」，
    // 不是「还在跑」也不是「崩了」。这正是 §29 的要点：`notifyMcpToolUse` 是给
    // UI 的展示事件，它替代不了审计；而审计在这里也确实只能记一半，不能编。
    this.auditDecisionWithoutHandler(candidates[0], context, normalizedMcp, decision);
    if (!decision.allowed) return decision;
    // wire 名是本适配器构造的 `${serverId}-${toolName}`：用已知前缀剥离，
    // 工具名里即使有 `-` 也不会切错。
    const serverId = candidates[0].providerId.slice('mcp.'.length);
    const wireName: string = candidates[0].name;
    const rawName = wireName.startsWith(`${serverId}-`) ? wireName.slice(serverId.length + 1) : wireName;
    return { ...decision, mcp: { serverId, toolName: rawName } };
  }

  /**
   * 记一次「没有 handler 兜底」的判定。
   *
   * 两类调用走这里，理由不同但结论一样 —— 本服务看不到它的执行结果：
   *
   *   被拒的 custom tool   引擎根本不会去执行，所以永远不会进 handler
   *   MCP 工具             执行在 SDK 里，没有完成回调
   *
   * 拒绝时立刻收口（错误就是结论）；放行时**故意不收口** —— 收口需要一个结果，
   * 而编一个 `result: null` 会让「执行成功但没有返回值」和「结果未知」在审计上
   * 长得一模一样。留着 `ended_at` 空，语义是明确的「已授权、结果不由本服务观察」。
   */
  private auditDecisionWithoutHandler(
    tool: RuntimeTool,
    context: CapabilityContext,
    args: Record<string, unknown>,
    decision: ToolDecision,
  ): void {
    if (!this.audit) return;

    const policyDecisionId = this.recordPolicyDecision(tool, context, args, decision);

    const auditId = this.audit.startToolExecution({
      executionId: context.executionId,
      conversationId: context.conversationId,
      memberId: context.memberId,
      toolName: tool.name,
      providerId: tool.providerId,
      implementation: tool.implementation,
      args,
      allowed: decision.allowed,
      policyDecisionId,
      entitlementId: decision.entitlementId ?? null,
    });

    if (!decision.allowed) {
      this.audit.finishToolExecution(auditId, { error: decision.reason });
    }
  }

  /**
   * 落一次 Policy 判定，返回它在 `policy_decision_audit` 里的 id。
   *
   * ── 为什么每一次判定都要落，不只是拒绝 ──────────────────────────────
   *
   * 「这一笔为什么被放行」和「为什么被拒」是同一类问题，而只有拒绝记录时，
   * 一次「本该被拦却放过了」的事故在审计上完全看不出来 —— 那恰恰是最需要
   * 回看的那一类。
   *
   * ── 为什么复用 decisionId ───────────────────────────────────────────
   *
   * PolicyService 自己产出的 `decisionId` 是那条决策的身份。换一个新的会让
   * 「谁批的」和「批了什么」对不上：工具审计里的 policy_decision_id 指向一条
   * 内容相同、id 不同的行，等于同一件事被记了两遍且互不相认。
   *
   * `approvalRequired` 映射成 `approval_required` 而不是 `deny`：前者指向一条
   * 可行的操作路径（把批准出口接上），后者看起来像配置错误。
   */
  private recordPolicyDecision(
    tool: RuntimeTool,
    context: CapabilityContext,
    args: Record<string, unknown>,
    decision: ToolDecision,
  ): string | null {
    if (!this.audit) return null;

    return this.audit.recordPolicyDecision({
      id: decision.policyDecisionId,
      executionId: context.executionId,
      toolName: tool.name,
      policyRevision: decision.policyRevision ?? '',
      decision: decision.allowed ? 'allow' : decision.approvalRequired ? 'approval_required' : 'deny',
      reason: decision.reason,
      inputHash: hashJson(args),
    });
  }
}

/**
 * RuntimeMcpServer → SDK session 配置。只做形状翻译：
 * `cwd` → SDK 的 `workingDirectory`，其余直通。定义里没有的字段
 * （displayName / version / toolPolicies）不进 session。
 */
function buildMcpServerConfigs(mcpServers: RuntimeMcpServer[]): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    mcpServers.map((server) => {
      if (server.type === 'http' || server.type === 'sse') {
        // 空 url 不交给 SDK：它会在 session 建立时报一个不知所云的错。
        // 正常路径下 loader 已经拦过，这里是最后一道闸。
        if (!server.url?.trim()) {
          throw new Error(`MCP Server ${server.id} 缺少 url，不能交给引擎`);
        }
        return [
          server.id,
          {
            type: server.type,
            url: server.url,
            ...(server.headers === undefined ? {} : { headers: server.headers }),
            tools: server.tools,
            ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
          },
        ];
      }
      if (!server.command?.trim()) {
        throw new Error(`MCP Server ${server.id} 缺少 command，不能交给引擎`);
      }
      return [
        server.id,
        {
          type: 'local' as const,
          command: server.command,
          args: server.args ?? [],
          ...(server.env === undefined ? {} : { env: server.env }),
          ...(server.cwd === undefined ? {} : { workingDirectory: server.cwd }),
          tools: server.tools,
          ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
        },
      ];
    }),
  );
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
