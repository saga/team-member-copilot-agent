import { BuiltInTools, defineTool, ToolSet, type ToolInvocation, type Tool } from '@github/copilot-sdk';
import type { ToolPolicy } from '../tool-policy.js';
import type {
  CapabilityContext,
  RuntimeCapabilities,
  RuntimeTool,
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
export interface CopilotCapabilities {
  /** custom tool 的 SDK 定义，交给 session 的 `tools`。 */
  tools: Tool<unknown>[];
  /** 交给 session 的 `availableTools`。 */
  availableTools: ToolSet;
  /**
   * 逐次授权。返回 `null` = 找不到这个工具的来历（从未声明过），调用方必须拒绝。
   */
  checkToolUse(toolName: string, args: unknown): Promise<{ allowed: boolean; reason: string }>;
}

export class CopilotCapabilityAdapter {
  constructor(private readonly policy: ToolPolicy) {}

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

    return {
      tools,
      availableTools,
      checkToolUse: (toolName, args) => this.check(toolName, args, capabilities, context),
    };
  }

  private defineCustomTool(tool: RuntimeTool, context: CapabilityContext): Tool<unknown> {
    return defineTool(tool.name, {
      description: tool.description,
      parameters: tool.parameters,
      // app-owned 工具不需要人点「同意」：没有终端可以点。真正的判定在
      // policy.check 里，下面是唯一执行入口。
      skipPermission: true,
      handler: async (args: unknown, _invocation: ToolInvocation) => {
        const current: ToolExecutionContext = { ...context, toolName: tool.name };
        const decision = await this.policy.check(tool, current, normalizeArgs(args));
        if (!decision.allowed) {
          throw new Error(`Tool ${tool.name} 被拒绝：${decision.reason}`);
        }
        return tool.execute!(current, normalizeArgs(args));
      },
    });
  }

  private async check(
    toolName: string,
    args: unknown,
    capabilities: RuntimeCapabilities,
    context: CapabilityContext,
  ): Promise<{ allowed: boolean; reason: string }> {
    if ((BuiltInTools.Isolated as readonly string[]).includes(toolName)) {
      return { allowed: true, reason: 'SDK isolated built-in' };
    }

    const tool = capabilities.toolIndex.get(toolName);
    if (!tool) {
      // 声明之外的任何名字 —— 引擎的其它 built-in、skill 带来的工具、拼错的名字。
      // 全部拒绝：放行一个来历不明的工具，等于授权层不存在。
      return { allowed: false, reason: `未为该工具定义策略（${toolName}），授权层默认拒绝` };
    }

    return this.policy.check(tool, { ...context, toolName }, normalizeArgs(args));
  }
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
