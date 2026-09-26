import {
  CopilotClient,
  type CopilotSession,
  type SessionConfigBase,
  type SessionHooks,
} from '@github/copilot-sdk';
import { config } from './config.js';
import type { Member, MemberRuntime } from './domain.js';
import { CopilotCapabilityAdapter, type CopilotCapabilities } from './capabilities/copilot-adapter.js';
import type { CapabilityContext, RuntimeCapabilities } from './capabilities/types.js';
import { DefaultToolPolicy, type ToolPolicy } from './tool-policy.js';
import { DenyHighRiskPolicyService } from './policy.js';

/**
 * SDK 顶层没有导出 `PreToolUseHookInput` / `PreToolUseHookOutput`（它们在
 * dist/types.d.ts 里声明但未 re-export），所以从 `SessionHooks` 派生。
 */
type PreToolUseHook = NonNullable<SessionHooks['onPreToolUse']>;
type PreToolUseInput = Parameters<PreToolUseHook>[0];
type PreToolUseOutput = Exclude<Awaited<ReturnType<PreToolUseHook>>, void>;

type PermissionHook = NonNullable<SessionConfigBase['onPermissionRequest']>;
type PermissionRequest = Parameters<PermissionHook>[0];
type PermissionInvocation = Parameters<PermissionHook>[1];
type PermissionResult = Awaited<ReturnType<PermissionHook>>;

/**
 * Runtime 执行引擎。这一层不再管理任何「业务 session」，也不再认识任何具体的
 * Skill / Knowledge / Tool：
 *
 *   MemberRuntime  →  CopilotSession
 *
 * Member / Conversation / Execution / Capability 全都在 team-service 与
 * capabilities 里，本文件只负责「把一个 runtime 跑起来」—— 输入是一份已经解析
 * 好的 `RuntimeCapabilities`，输出是这一轮的文本。
 *
 * 把 RuntimeCapabilities 翻译成 SDK 配置（tools / availableTools / 授权 hook）
 * 是 CopilotCapabilityAdapter 的职责。这样换引擎时改的是适配器，而不是这里。
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

export interface RunMemberTurnInput {
  runtime: MemberRuntime;
  member: Member;
  systemPrompt: string;
  prompt: string;
  sourceMemberId?: string;
  onDelta?: (delta: string) => void;
  executionId: string;
  conversationId: string;
  /**
   * 这一轮所属的 Team。能力是三层组合（global + team + member），
   * 而 Provider 需要知道 teamId 才能定位 Team 级 skill / knowledge 根目录，
   * 所以它必须随 turn 一起传进来，不能在 Provider 里现查。
   */
  teamId: string;
  /** 这一轮生效的能力。冻结在这里而不是在 hook 里现查 Member，见下。 */
  capabilities: RuntimeCapabilities;
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
  /**
   * 工具授权层。不传则用默认实现（宿主工具由 config.allowHostCodingTools 决定）。
   * 可替换是为了让测试能直接验证「某次调用被拒」而不必真的跑引擎。
   */
  toolPolicy?: ToolPolicy;
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
  /**
   * executionId → 正在跑这个 execution 的 session。
   *
   * 存在的唯一理由是 cancel：`POST /executions/:id/cancel` 需要拿到活着的
   * session 才能真的 abort 掉。没有它就只能做「DB 里写 cancelled、Agent 继续跑」
   * 的假取消。
   */
  private readonly activeSessions = new Map<string, CopilotSession>();
  /** 工具授权层。判定只看 RuntimeTool 声明，见 tool-policy.ts。 */
  private readonly toolPolicy: ToolPolicy;
  /** RuntimeCapabilities → SDK session 配置。唯一认识 SDK 的翻译层。 */
  private readonly capabilityAdapter: CopilotCapabilityAdapter;

  constructor(private readonly options: CopilotServiceOptions = {}) {
    this.toolPolicy =
      options.toolPolicy ??
      new DefaultToolPolicy(
        { allowHostTools: config.allowHostCodingTools },
        new DenyHighRiskPolicyService(),
      );
    this.capabilityAdapter = new CopilotCapabilityAdapter(this.toolPolicy);
  }

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

      // 一轮 turn 用的是**开始那一刻**的能力：中途有人改了 Member 的绑定，
      // 不该让正在跑的这一轮突然多出（或少掉）一个工具。解析在 team-service
      // 里完成，这里只消费结果。
      const runtimeContext: CapabilityContext = {
        teamId: input.teamId,
        memberId: input.member.id,
        conversationId: input.conversationId,
        executionId: input.executionId,
        userId: config.localUserId,
      };
      const copilotCapabilities = this.capabilityAdapter.build(
        input.capabilities,
        runtimeContext,
      );

      for (const tool of input.capabilities.tools) {
        if (this.toolPolicy.hostToolWithheld(tool)) {
          // 配置上绑定了宿主工具，实际一个都没给。不说出来的话，只能靠
          // 「它怎么什么都不做」去猜。
          // eslint-disable-next-line no-console
          console.warn(
            `[copilot] Member ${input.member.name} 绑定了 ${tool.name}，但宿主工具未启用` +
              '（HOST_CODING_TOOLS != true），本次不提供该工具',
          );
        }
      }

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
        // 团队 skill + Member 个人 skill 由各自的 SkillProvider 解析出来，
        // 这里只是把结果交给 SDK。目录不存在时解析结果里就没有它。
        skillDirectories: input.capabilities.skills.map((skill) => skill.directory),
        tools: copilotCapabilities.tools,
        // availableTools 只决定「模型看得见什么」；真正的授权在下面的 hook 里
        // 每次调用重新判一遍。两者出自同一份解析结果，所以不会各自漂移。
        availableTools: copilotCapabilities.availableTools,
        hooks: {
          onPreToolUse: (hookInput: PreToolUseInput) =>
            this.checkToolUse(hookInput, copilotCapabilities),
        },
        // 不是由工具调用引起的权限请求（url / mcp / 扩展管理……），见 answerPermissionRequest。
        onPermissionRequest: (request: PermissionRequest, invocation: PermissionInvocation) =>
          this.answerPermissionRequest(request, invocation),
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

  /**
   * 每一次 tool call 的授权判定 —— 这块系统里**唯一**的授权判定。
   *
   * 判据来自这一轮解析出来的能力集合（`copilotCapabilities`），而不是任何工具名
   * 清单：声明过的工具按它的 risk 判，没声明过的名字一律拒绝。所以「引擎新增了
   * 一个 built-in」「某份 skill 让模型想调一个我们没承认过的名字」都会在这里被
   * 拦下，而不是默默执行。
   *
   * 放行时必须返回明确的 `allow`，不能返回 `{}`。空对象是「没有意见」，引擎会
   * 接着走它自己的权限流程 —— 而这个服务里没有可以点「同意」的人，那个请求会
   * 一直挂在 pending 上，直到 `EXECUTION_TIMEOUT_MS` 把一轮正常的工作判成超时。
   * `allow` / `deny` 两边都写出来，授权就只有这一个决策点。
   */
  private async checkToolUse(
    hookInput: PreToolUseInput,
    capabilities: CopilotCapabilities,
  ): Promise<PreToolUseOutput> {
    const decision = await capabilities.checkToolUse(hookInput.toolName, hookInput.toolArgs);

    if (decision.allowed) {
      return { permissionDecision: 'allow', permissionDecisionReason: decision.reason };
    }

    // eslint-disable-next-line no-console
    console.warn(`[copilot] 拒绝工具调用 ${hookInput.toolName}：${decision.reason}`);
    return this.deny(hookInput.toolName, decision.reason);
  }

  /**
   * 处理**不是由工具调用引起**的权限请求：url、mcp、memory、扩展管理等等。
   *
   * 工具调用那一路已经被 `onPreToolUse` 收口了；走到这里的是另一类问题：
   * 引擎想问一句「我可以吗」。而这个服务里没有人可以问 —— 没有终端、没有确认框、
   * 没有第二个进程在看着。把它挂在 pending 上等一个永远不会来的答案，只会把一轮
   * 正常的工作拖到超时才失败。
   *
   * 所以直接给出「没有用户可确认」。注意这**不是**默认放行：一个装出来的放宽
   * 会让权限层变成比策略层更弱的一条旁路，那正是策略层想避免的事。
   */
  private answerPermissionRequest(
    request: PermissionRequest,
    invocation: PermissionInvocation,
  ): PermissionResult {
    // eslint-disable-next-line no-console
    console.warn(
      `[copilot] 权限请求 ${request.kind} 被拒（session=${invocation.sessionId}）：` +
        '本服务没有可征得同意的用户',
    );
    return { kind: 'user-not-available' };
  }

  private deny(toolName: string, reason: string): PreToolUseOutput {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: `工具 ${toolName} 未被授权：${reason}`,
    };
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
