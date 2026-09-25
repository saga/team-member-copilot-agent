import {
  BuiltInTools,
  CopilotClient,
  defineTool,
  ToolSet,
  type CopilotSession,
  type ToolInvocation,
} from '@github/copilot-sdk';
import { z } from 'zod';
import { config } from './config.js';
import type { Member, MemberRuntime } from './domain.js';

/**
 * Runtime 执行引擎。这一层不再管理任何「业务 session」：
 *
 *   MemberRuntime  →  CopilotSession
 *
 * Member / Conversation / Execution 全都在 team-service 里，本文件只负责
 * 「把一个 runtime 跑起来」以及两个收口到应用的 custom tool。
 *
 * 多用户后端约定：mode = "empty"，由应用显式控制工具、工作目录和身份，
 * 不使用 copilot-cli 的 ambient tools / 自定义指令。
 */

export interface RuntimeExecutionContext {
  executionId: string;
  conversationId: string;
  memberId: string;
}

/** 反向依赖注入：CopilotService 需要调 TeamService，但不能直接 import 它。 */
export interface CopilotHost {
  delegateMember(input: {
    conversationId: string;
    fromMemberId: string;
    parentExecutionId: string;
    targetMemberId: string;
    task: string;
    reason?: string;
  }): Promise<string>;
  rememberMember(input: { memberId: string; content: string }): Promise<string>;
}

export interface RunMemberTurnInput {
  runtime: MemberRuntime;
  member: Member;
  systemPrompt: string;
  prompt: string;
  sourceMemberId?: string;
  onDelta?: (delta: string) => void;
  executionId: string;
  conversationId: string;
}

export class CopilotService {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  private lastError: string | null = null;
  /** 同一 runtime 的 turn 串行化：一个 Copilot session 一次只能跑一个 turn。 */
  private locks = new Map<string, Promise<unknown>>();
  /** sessionId → 当前 execution 上下文，供 custom tool handler 反查。 */
  private readonly executionContexts = new Map<string, RuntimeExecutionContext>();

  constructor(private readonly host: CopilotHost) {}

  async getClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const client = new CopilotClient({
        // "empty" 模式：应用显式控制工具与工作目录，不继承 CLI 的环境。
        mode: 'empty',
        baseDirectory: config.copilotBaseDirectory,
        ...(config.githubToken
          ? { gitHubToken: config.githubToken, useLoggedInUser: false }
          : { useLoggedInUser: true }),
      });
      await client.start();
      this.client = client;
      this.lastError = null;
      this.starting = null;
      return client;
    })().catch((error) => {
      this.starting = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });

    return this.starting;
  }

  /** connected = 已建连；idle = 尚未建连（懒加载）；error = 建连失败。 */
  getStatus(): 'connected' | 'idle' | 'error' {
    if (this.client) return 'connected';
    if (this.lastError) return 'error';
    return 'idle';
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async warmup(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getClient();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runMemberTurn(input: RunMemberTurnInput): Promise<string> {
    return this.withLock(input.runtime.id, async () => {
      const client = await this.getClient();
      const availableTools = this.buildAvailableTools(input.member.toolProfile);

      const sessionConfig = {
        sessionId: input.runtime.copilotSessionId,
        model: input.member.model ?? config.defaultModel,
        workingDirectory: input.runtime.workspacePath,
        systemMessage: {
          // append：保留 SDK 自己那部分 system message（工具使用说明等），
          // 把 Member 身份追加在后面。"empty" 模式下 SDK 会把它提升为 customize。
          mode: 'append' as const,
          content: input.systemPrompt,
        },
        skillDirectories: [pathForSkills(input.member.id)],
        tools: [this.createAskMemberTool(), this.createRememberMemberTool()],
        availableTools,
        // SDK 默认 false。不打开的话 assistant.message_delta 根本不会发，
        // 前端的实时增量就永远是空的。
        streaming: true,
      };

      let session: CopilotSession;
      try {
        // 同一个 runtime 复用同一个 Copilot session，保留引擎侧对话状态。
        session = await client.resumeSession(input.runtime.copilotSessionId, sessionConfig);
      } catch {
        session = await client.createSession(sessionConfig);
      }

      this.executionContexts.set(session.sessionId, {
        executionId: input.executionId,
        conversationId: input.conversationId,
        memberId: input.member.id,
      });

      let content = '';
      const offDelta = session.on('assistant.message_delta', (event) => {
        const delta = event.data.deltaContent;
        if (!delta) return;
        content += delta;
        input.onDelta?.(delta);
      });
      const offMessage = session.on('assistant.message', (event) => {
        // 某些后端只发全量 message 不发 delta：用全量兜底，避免流式无输出。
        const full = event.data.content;
        if (full && !content) input.onDelta?.(full);
      });

      try {
        const finalEvent = await session.sendAndWait(
          {
            prompt: input.prompt,
            ...(input.sourceMemberId ? { source: `agent-${input.sourceMemberId}` } : {}),
          },
          config.executionTimeoutMs,
        );
        return finalEvent?.data.content || content;
      } finally {
        offDelta();
        offMessage();
        this.executionContexts.delete(session.sessionId);
        try {
          // SDK 已把 session 状态持久化，断开只释放内存；失败不影响业务状态。
          await session.disconnect();
        } catch {
          // ignore
        }
      }
    });
  }

  private createAskMemberTool() {
    return defineTool('ask_member', {
      description:
        'Ask another Team Member to perform a focused piece of work. ' +
        'This creates a delegated execution in the current conversation.',
      parameters: z.object({
        memberId: z.string().describe('Target Team Member ID'),
        task: z.string().min(1).max(8000).describe('The specific task for the other member'),
        reason: z.string().max(2000).optional().describe('Why this delegation is useful'),
      }),
      skipPermission: true,
      handler: async (
        args: { memberId: string; task: string; reason?: string },
        invocation: ToolInvocation,
      ) => {
        const context = this.executionContexts.get(invocation.sessionId);
        if (!context) throw new Error('找不到当前 Member execution context');
        return this.host.delegateMember({
          conversationId: context.conversationId,
          fromMemberId: context.memberId,
          parentExecutionId: context.executionId,
          targetMemberId: args.memberId,
          task: args.task,
          reason: args.reason,
        });
      },
    });
  }

  private createRememberMemberTool() {
    return defineTool('remember_member', {
      description: 'Persist a durable memory that belongs to the current Team Member.',
      parameters: z.object({
        content: z.string().min(1).max(8000).describe('The memory to persist'),
      }),
      skipPermission: true,
      handler: async (args: { content: string }, invocation: ToolInvocation) => {
        const context = this.executionContexts.get(invocation.sessionId);
        if (!context) throw new Error('找不到当前 Member execution context');
        return this.host.rememberMember({
          memberId: context.memberId,
          content: args.content,
        });
      },
    });
  }

  /**
   * safe:
   *   只允许 Copilot SDK 的 isolated built-ins + Team tools。
   *
   * coding:
   *   在 safe 基础上开放 bash/edit/grep/web_fetch。
   *
   * coding profile 不应该直接用于多租户生产环境：没有 sandbox 时
   * bash 可以触达宿主机边界。
   */
  private buildAvailableTools(profile: Member['toolProfile']): ToolSet {
    const tools = new ToolSet().addCustom('ask_member').addCustom('remember_member');

    tools.addBuiltIn(BuiltInTools.Isolated);

    if (profile === 'coding') {
      tools.addBuiltIn('bash').addBuiltIn('edit').addBuiltIn('grep').addBuiltIn('web_fetch');
    }

    return tools;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.finally(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.locks.set(key, current);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async stop(): Promise<void> {
    this.executionContexts.clear();
    this.locks.clear();
    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        // 关闭失败忽略，进程仍要退出
      }
      this.client = null;
    }
  }
}

function pathForSkills(memberId: string): string {
  return `${config.memberHomeRoot}/${memberId}/skills`;
}
