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
 *
 * ── 两条可靠性纪律（改动前请先读 SDK 文档）─────────────────────────────
 *
 *  1. resumeSession() 失败 ≠ session 不存在。
 *     认证失败 / CLI·RPC 故障 / session 数据损坏 / 参数错误都会抛异常，
 *     把它们统统降级成 createSession() 会静默丢掉该 Member 的全部历史。
 *     只有明确的 session-not-found 才允许降级（见 isSessionNotFound）。
 *
 *  2. sendAndWait(timeout) 的 timeout 不是 cancellation。
 *     SDK 文档原文：Controls how long to wait; **does not abort in-flight agent work**。
 *     超时后必须显式 abort()，否则会出现「DB 判 failed、Agent 还在跑」的状态分裂。
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

export interface CancelTurnResult {
  /** 有没有找到属于这条 execution 的活跃 session。false = 还没进引擎或已经结束。 */
  found: boolean;
  /** abort 请求是否被引擎受理。 */
  aborted: boolean;
  /** abort 之后是否观察到 session 真的回到 idle。 */
  idle: boolean;
}

export interface CopilotServiceOptions {
  /**
   * 替换 CopilotClient 的构造，仅用于测试 —— 让 resume/create/abort 这套
   * 状态机可以在不拉起真实 CLI 进程的前提下被断言。
   * 生产环境不传，走默认的 `new CopilotClient({ mode: 'empty', ... })`。
   */
  createClient?: () => CopilotClient;
}

/**
 * `sendAndWait` 超时抛出的**精确**文案（见 session.js）：
 *
 *   `Timeout after ${effectiveTimeout}ms waiting for session.idle`
 *
 * 只匹配这一句，不要放宽成 /timeout/i —— session.error 里也可能带 timeout 字样，
 * 那种情况是引擎自己报的错，不该当成「我们等超时了」。
 */
const TURN_TIMEOUT_PATTERN = /^Timeout after \d+ms waiting for session\.idle$/;

/**
 * `session.resume` 报「session 不存在」时的文案形态。
 *
 * SDK 内部对缺失 session 统一用 `Session not found: <id>`；这里额外容忍几种
 * 常见变体，但**必须保持窄**：宁可多抛一次原始错误，也不能把认证/故障误判成
 * 「这是全新会话」。匹配不上时由 getSessionMetadata() 做权威裁决。
 */
const SESSION_NOT_FOUND_PATTERNS: RegExp[] = [
  /session not found/i,
  /no such session/i,
  /unknown session/i,
  /session .* does not exist/i,
  /session .* has been deleted/i,
];

/** JSON-RPC 的 MethodNotFound（-32601）。某些 CLI 用它表示「不认识这个 session」。 */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** 只接受**明确**的 session-not-found；其它错误一律返回 false，由调用方原样抛出。 */
export function isSessionNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as { code?: unknown }).code;
  if (code === JSON_RPC_METHOD_NOT_FOUND && /session/i.test(error.message)) return true;

  return SESSION_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(error.message));
}

/** `sendAndWait` 等超时（引擎还在跑，需要 abort）。 */
export function isTurnTimeout(error: unknown): boolean {
  return error instanceof Error && TURN_TIMEOUT_PATTERN.test(error.message);
}

/** abort 之后最多再等多久观察 session.idle。超时不报错，只记录。 */
const ABORT_IDLE_GRACE_MS = 10_000;

export class CopilotService {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  private lastError: string | null = null;
  /** 同一 runtime 的 turn 串行化：一个 Copilot session 一次只能跑一个 turn。 */
  private locks = new Map<string, Promise<unknown>>();
  /** sessionId → 当前 execution 上下文，供 custom tool handler 反查。 */
  private readonly executionContexts = new Map<string, RuntimeExecutionContext>();
  /**
   * executionId → 正在跑这个 execution 的 session。
   *
   * 存在的唯一理由是 cancel：`POST /executions/:id/cancel` 需要拿到活着的
   * session 才能真的 abort 掉。没有它就只能做「DB 里写 cancelled、Agent 继续跑」
   * 的假取消。
   */
  private readonly activeSessions = new Map<string, CopilotSession>();

  constructor(
    private readonly host: CopilotHost,
    private readonly options: CopilotServiceOptions = {},
  ) {}

  async getClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const client =
        this.options.createClient?.() ??
        new CopilotClient({
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

  /** 当前有几条 execution 真的挂在引擎上（可观测性用）。 */
  activeTurnCount(): number {
    return this.activeSessions.size;
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

      // resumeSession 的第二个参数是 ResumeSessionConfig（没有 sessionId 字段）。
      // 多传一个 sessionId 是无害的：resume RPC 逐字段取值，sessionId 来自第一个参数。
      const session = await this.acquireSession(
        client,
        input.runtime.copilotSessionId,
        sessionConfig,
      );

      this.executionContexts.set(session.sessionId, {
        executionId: input.executionId,
        conversationId: input.conversationId,
        memberId: input.member.id,
      });
      this.activeSessions.set(input.executionId, session);

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
      } catch (error) {
        if (isTurnTimeout(error)) {
          // 超时只是「我们不再等 session.idle」，Agent 很可能还在跑。
          // 必须显式 abort，否则 DB 里判 failed 而引擎仍在工作 —— 状态分裂。
          const result = await this.abortAndWaitIdle(session, 'sendAndWait 超时');
          // eslint-disable-next-line no-console
          console.warn(
            `[copilot] execution ${input.executionId} 超时（${config.executionTimeoutMs}ms），` +
              `abort=${result.aborted} idle=${result.idle}`,
          );
        }
        throw error;
      } finally {
        offDelta();
        offMessage();
        this.activeSessions.delete(input.executionId);
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

  /**
   * 真的把某个 execution 的引擎停掉。
   *
   * 返回值刻意把「找到没找到」和「停成功没成功」分开，因为调用方需要区分：
   *   found=false        → 还没进引擎（queued）或已经结束，改 DB 即可
   *   found=true, idle=false → abort 受理了但没观察到 idle，属于降级成功
   */
  async cancelTurn(executionId: string): Promise<CancelTurnResult> {
    const session = this.activeSessions.get(executionId);
    if (!session) return { found: false, aborted: false, idle: false };
    return { found: true, ...(await this.abortAndWaitIdle(session, 'cancel 请求')) };
  }

  /**
   * resume 优先、create 兜底 —— 但**只在确认 session 真的不存在时**才兜底。
   *
   * 关键点：错误信息匹配不上已知形态时，不靠字符串猜，而是问一次权威来源
   * （getSessionMetadata 对缺失 session 返回 undefined）。如果连这次查询都失败，
   * 说明是基础设施问题而不是 session 问题 —— 那就保持 false，让原始错误抛出，
   * 绝不把「引擎坏了」伪装成「这是一轮全新对话」。
   */
  private async acquireSession(
    client: CopilotClient,
    sessionId: string,
    sessionConfig: Parameters<CopilotClient['createSession']>[0],
  ): Promise<CopilotSession> {
    try {
      return await client.resumeSession(sessionId, sessionConfig);
    } catch (error) {
      if (!(await this.isSessionMissing(client, sessionId, error))) throw error;
      return client.createSession(sessionConfig);
    }
  }

  private async isSessionMissing(
    client: CopilotClient,
    sessionId: string,
    error: unknown,
  ): Promise<boolean> {
    if (isSessionNotFound(error)) return true;
    try {
      return (await client.getSessionMetadata(sessionId)) === undefined;
    } catch {
      // 连存在性都查不了 → 无法确认，当作「不是不存在」
      return false;
    }
  }

  /** abort 只保证请求被受理；这里再等一次 session.idle，让「已停止」变成可观测事实。 */
  private async abortAndWaitIdle(
    session: CopilotSession,
    reason: string,
  ): Promise<{ aborted: boolean; idle: boolean }> {
    // 必须先订阅再 abort：abort 的 ack 与 session.idle 之间有一段空隙，
    // 引擎可能已经 idle 了。事后订阅会漏掉这个事件，白白等满一个 grace，
    // 把「已经停稳」误报成 idle=false。
    const idle = this.watchIdle(session, ABORT_IDLE_GRACE_MS);

    try {
      await session.abort();
    } catch (error) {
      idle.cancel();
      // eslint-disable-next-line no-console
      console.warn(
        `[copilot] abort 失败（${reason}）：${error instanceof Error ? error.message : String(error)}`,
      );
      return { aborted: false, idle: false };
    }

    const settled = await idle.promise;
    if (!settled) {
      // eslint-disable-next-line no-console
      console.warn(
        `[copilot] abort 已受理（${reason}）但 ${ABORT_IDLE_GRACE_MS}ms 内没观察到 session.idle`,
      );
    }
    return { aborted: true, idle: settled };
  }

  /** 订阅 session.idle。返回句柄而不是裸 Promise，方便 abort 失败时撤销这次等待。 */
  private watchIdle(
    session: CopilotSession,
    timeoutMs: number,
  ): { promise: Promise<boolean>; cancel: () => void } {
    let cancel = () => {};

    const promise = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(value);
      };

      // session.idle 的 data.aborted 表示这一轮是被 abort 掉的，正好是我们想要的确认。
      const off = session.on('session.idle', (event) => {
        finish(event.data.aborted === true || event.data.mode !== 'autopilot');
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      cancel = () => finish(false);
    });

    return { promise, cancel };
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
    this.activeSessions.clear();
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
