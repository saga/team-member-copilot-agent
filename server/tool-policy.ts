import { BuiltInTools, ToolSet } from '@github/copilot-sdk';
import type { ToolProfile } from './domain.js';

/**
 * 工具授权层。
 *
 * 两个问题必须由同一处回答，否则它们会各自漂移：
 *
 *   1. 向引擎**声明**哪些工具（availableTools）—— 「它有什么」
 *   2. 每一次工具调用**放不放行**（hooks.onPreToolUse）—— 「它这次能不能用」
 *
 * 只做第 1 步不够。`skipPermission: true` 的含义是「这个 app-owned 工具不必弹
 * 权限提示」，也就是**无条件执行**；它是省一次交互，不是一次授权。
 * `toolProfile` 同理：那是成员自己声明想要什么能力，不是「允许它做任何事」。
 * 所以真正的判据必须在每次调用时重新算一遍，而不是在装配 session 时算完就完。
 *
 * 工具的**性质**差别极大，这是这一层存在的理由：
 *
 *   remember_member   只往自己的记忆文件里追加一行
 *   message_member    给另一个 Member 发一条消息
 *   bash              在宿主机上执行任意命令
 *
 * 把它们统一当成「成员自己说要用」的能力，等于把宿主机交给了一个
 * 由对话内容驱动的东西。
 *
 * ── 判定顺序 ────────────────────────────────────────────────────────
 *
 *   app-owned custom tool  → 允许（它们的副作用由各自的业务校验兜住）
 *   SDK isolated built-in  → 允许（SDK 契约保证只在 session 边界内活动）
 *   宿主工具               → 需要 coding profile **且**宿主工具已显式启用
 *   其它一切               → 拒绝
 *
 * 最后一条是默认拒绝。引擎新增一个工具、或某个 skill 让模型想调一个我们没
 * 显式承认过的名字时，必须在授权层被拦下，而不是默默执行。
 */

/** 应用自己注册的 custom tool。声明与放行共用这一份清单。 */
export const CUSTOM_TOOLS = ['ask_member', 'message_member', 'remember_member'] as const;

/**
 * 会触达宿主机的 built-in。
 *
 * 它们的工作目录是 conversation workspace，但 runtime 仍然是宿主机上的进程 ——
 * 没有沙箱时 `bash` 能走到 workspace 之外。所以这一组不是「能力」，是**部署前提**。
 */
export const HOST_TOOLS = ['bash', 'edit', 'grep', 'web_fetch'] as const;

const ISOLATED_BUILTINS = new Set<string>(BuiltInTools.Isolated);
const CUSTOM_TOOL_SET = new Set<string>(CUSTOM_TOOLS);
const HOST_TOOL_SET = new Set<string>(HOST_TOOLS);

export interface ToolCallRequest {
  memberId: string;
  toolProfile: ToolProfile;
  executionId: string;
  conversationId: string;
  /** 引擎报上来的工具名。 */
  toolName: string;
  /** 引擎报上来的原始参数，供更细的策略（路径白名单等）使用。 */
  toolArgs: unknown;
}

export interface ToolDecision {
  allowed: boolean;
  /** 允许或拒绝的理由。拒绝时必须写清楚「为什么」，它会出现在日志里。 */
  reason: string;
}

export interface ToolPolicy {
  /** 向引擎声明这个 profile 下可用的工具。 */
  availableTools(profile: ToolProfile): ToolSet;
  /** 每一次工具调用的授权判定。 */
  check(request: ToolCallRequest): ToolDecision;
  /**
   * 成员声明了 coding，但宿主工具没有启用 —— 调用方据此在日志 / 健康检查里
   * 说明「它要的能力没给」。不这样做的话，界面上写着 coding，实际跑起来
   * 一个 bash 都没有，只能靠翻日志猜。
   */
  hostToolsWithheld(profile: ToolProfile): boolean;
}

export interface ToolPolicyOptions {
  /**
   * 是否允许宿主机工具落地。
   *
   * 由部署决定，而不是由 Member 的配置决定：一个成员把 toolProfile 改成 coding，
   * 不该等于它获得了宿主机的执行权。
   */
  allowHostTools: boolean;
}

export class DefaultToolPolicy implements ToolPolicy {
  constructor(private readonly options: ToolPolicyOptions) {}

  availableTools(profile: ToolProfile): ToolSet {
    const tools = new ToolSet().addBuiltIn(BuiltInTools.Isolated);

    for (const name of CUSTOM_TOOLS) tools.addCustom(name);

    if (!this.hostToolsAllowed(profile)) return tools;

    for (const name of HOST_TOOLS) tools.addBuiltIn(name);
    return tools;
  }

  check(request: ToolCallRequest): ToolDecision {
    if (CUSTOM_TOOL_SET.has(request.toolName)) {
      return allow('app-owned tool');
    }

    if (ISOLATED_BUILTINS.has(request.toolName)) {
      // SDK 契约：这一组只在 session 边界内活动，不会泄漏宿主能力。
      return allow('isolated built-in');
    }

    if (HOST_TOOL_SET.has(request.toolName)) {
      if (request.toolProfile !== 'coding') {
        return deny(
          `${request.toolName} 只对 coding profile 开放，当前 profile 是 ${request.toolProfile}`,
        );
      }
      if (!this.options.allowHostTools) {
        return deny(
          `${request.toolName} 会触达宿主机，而宿主工具当前未启用（HOST_CODING_TOOLS != true）`,
        );
      }
      return allow('host tool，profile 与部署均已放行');
    }

    return deny(`未为该工具定义策略（${request.toolName}），授权层默认拒绝`);
  }

  /**
   * 两道门都开才给：成员自己声明 coding，且部署显式启用宿主工具。
   *
   * 这两个判断是 `availableTools` 与 `check` 的**同一个**判据 —— 分开写两份
   * 就会出现「声明了却调不动」或者反过来的漂移。
   */
  private hostToolsAllowed(profile: ToolProfile): boolean {
    return profile === 'coding' && this.options.allowHostTools;
  }

  hostToolsWithheld(profile: ToolProfile): boolean {
    // 只描述「声明了 coding 但没给到」这一种落差；safe profile 本来就不该有，
    // 那不是被收走，是从来没打算给。
    return profile === 'coding' && !this.options.allowHostTools;
  }
}

function allow(reason: string): ToolDecision {
  return { allowed: true, reason };
}

function deny(reason: string): ToolDecision {
  return { allowed: false, reason };
}
