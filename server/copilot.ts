import {
  CopilotClient,
  type CopilotSession,
  type SessionConfigBase,
  type SessionHooks,
} from '@github/copilot-sdk';
import { config } from './config.js';
import { db } from './db.js';
import type { Member, MemberRuntime } from './domain.js';
import { CopilotCapabilityAdapter, type CopilotCapabilities } from './capabilities/copilot-adapter.js';
import type { CapabilityContext, RuntimeCapabilities } from './capabilities/types.js';
import { DefaultToolPolicy, type ToolPolicy } from './tool-policy.js';
import { DenyHighRiskPolicyService } from './policy.js';
import { EntitlementService } from './entitlement-service.js';
import type { AuditService } from './audit-service.js';

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
  /**
   * 这一轮真正用的模型，由 TeamService 按模型策略决定后传进来。
   *
   * 这一层不做任何判断：模型选择只有一个地方（TeamService.executionModel），
   * 这里再按 member.model 回落一次，Lead 就会绕过策略。
   */
  model: string;
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
  /**
   * 触发这一轮的消息带上的文件。
   *
   * 交给 SDK 作为 attachment（引擎自己知道怎么读 PDF / 图片），而不是把内容
   * 抄进 prompt —— 那既浪费 token，也会让「到底是文件里写的还是模型记的」
   * 变得说不清。默认空数组：绝大多数 turn 没有附件。
   */
  attachments?: Array<{
    path: string;
    displayName: string;
    contentType?: string;
  }>;
}

export interface CancelTurnResult {
  /** 有没有找到属于这条 execution 的活跃 session。false = 还没进引擎或已经结束。 */
  found: boolean;
  /** abort 请求是否被引擎受理。 */
  aborted: boolean;
  /** abort 之后是否观察到 session 真的回到 idle。 */
  idle: boolean;
}

/** MCP 工具调用被放行时的通知（给 Activity 的「用过什么」展示用）。 */
export interface McpToolCallInfo {
  executionId: string;
  conversationId: string;
  memberId: string;
  serverId: string;
  toolName: string;
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
  /**
   * MCP 工具放行回调。注意语义是「放行」，不是「执行完成」—— 引擎没有跑完
   * 回调。这里只回答「这一轮用了哪个 MCP」，展示层据此打标，不做审计与计费。
   */
  onMcpToolUse?: (info: McpToolCallInfo) => void;
  /**
   * 审计链。不传 = 不写审计（判定行为完全不变）。
   *
   * 它是**旁路**：审计写失败不该让一轮正常的工作失败，所以调用点都容错；
   * 但它也不该是「可选的能力」—— 生产装配永远传（见 app.ts），
   * 因为「事后能证明发生了什么」是这套系统对外承诺的一部分。
   */
  audit?: AuditService;
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
        // 兜底路径自己建一个：它只在「调用方没给 policy」时生效（app.ts 与测试
        // 都显式传），所以这里用进程全局 db 是安全的。
        new EntitlementService(db),
      );
    this.capabilityAdapter = new CopilotCapabilityAdapter(this.toolPolicy, this.options.audit);
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
        model: input.model,
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
        // MCP Server 的运行与工具调用是 SDK 原生的：这里只递配置，
        // 授权仍走 onPreToolUse（MCP 工具名按别名反查回声明的 risk）。
        mcpServers: copilotCapabilities.mcpServers,
        hooks: {
          onPreToolUse: (hookInput: PreToolUseInput) =>
            this.checkToolUse(hookInput, copilotCapabilities, {
              executionId: input.executionId,
              conversationId: input.conversationId,
              memberId: input.member.id,
            }),
        },
        // 不是由工具调用引起的权限请求（url / mcp / 扩展管理……），见 answerPermissionRequest。
        onPermissionRequest: (request: PermissionRequest, invocation: PermissionInvocation) =>
          this.answerPermissionRequest(request, invocation),
        // SDK 默认 false。不打开的话 assistant.message_delta 根本不会发，
        // 前端的实时增量就永远是空的。
        streaming: true,
        /**
         * Infinite Session：把「上下文快满了怎么办」交给 SDK，而不是自己实现一套
         * 摘要 / 压缩系统。
         *
         * SDK 到 backgroundCompactionThreshold 时**后台**压缩（这一轮不受影响），
         * 到 bufferExhaustionThreshold 时**阻塞**压缩（否则下一轮没地方放）。
         * 压缩结果作为 checkpoint 持久化在 copilotBaseDirectory 下，resume 时恢复。
         *
         * 关键点：压缩的是「这个 Member 自己的 Copilot Session」，也就是它作为
         * Agent 的工作上下文 —— 不是 conversation_message（那是永久原始记录，
         * 不动），也不是 Member / Team Memory（那是跨 Conversation 的长期记忆）。
         */
        infiniteSessions: {
          enabled: true,
          backgroundCompactionThreshold: config.copilotCompactionBackgroundThreshold,
          bufferExhaustionThreshold: config.copilotCompactionBufferExhaustionThreshold,
        },
        /**
         * 显式关掉 SDK 的 Memory。
         *
         * 长期记忆在本项目里由 Member / Team Memory 承担（跨 Conversation、
         * 可审计、有自己的存储），不是 SDK Memory。两个都开着会变成两套记忆互相
         * 打架，且哪套生效不可预测。这里必须显式 false —— 不能省，因为
         * MemoryConfiguration.enabled 是必填字段。
         */
        memory: { enabled: false },
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
      /**
       * Compaction 事件只做**遥测**，不做业务。
       *
       * 这里刻意不落库、不改 conversation、不触发任何 LLM 调用：
       *   · 压缩是 SDK 的内部动作，不是业务事实，写进 DB 只会制造一个
       *     「和 SDK 真实状态可能不一致」的副本；
       *   · 每轮都写一次 summary 会把 conversation_message 的历史语义污染掉。
       * 需要知道「这台机器有没有在压缩、压了多少」时，看日志就够了。
       */
      const offCompactionStart = session.on('session.compaction_start', (event) => {
        // eslint-disable-next-line no-console
        console.info(
          JSON.stringify({
            event: 'copilot.compaction_start',
            sessionId: input.runtime.copilotSessionId,
            executionId: input.executionId,
            conversationId: input.conversationId,
            memberId: input.member.id,
            model: event.data.model,
            currentTokens: event.data.currentTokens,
            tokenLimit: event.data.tokenLimit,
            conversationTokens: event.data.conversationTokens,
            systemTokens: event.data.systemTokens,
            toolDefinitionsTokens: event.data.toolDefinitionsTokens,
            trigger: event.data.trigger,
          }),
        );
      });
      const offCompactionComplete = session.on('session.compaction_complete', (event) => {
        // eslint-disable-next-line no-console
        console.info(
          JSON.stringify({
            event: 'copilot.compaction_complete',
            sessionId: input.runtime.copilotSessionId,
            executionId: input.executionId,
            conversationId: input.conversationId,
            memberId: input.member.id,
            success: event.data.success,
            error: event.data.error,
            statusCode: event.data.statusCode,
            trigger: event.data.trigger,
            messagesRemoved: event.data.messagesRemoved,
            tokensRemoved: event.data.tokensRemoved,
            preCompactionTokens: event.data.preCompactionTokens,
            postCompactionTokens: event.data.postCompactionTokens,
            checkpointNumber: event.data.checkpointNumber,
            requestId: event.data.requestId,
          }),
        );
      });

      try {
        const finalEvent = await session.sendAndWait(
          {
            prompt: input.prompt,
            ...(input.sourceMemberId ? { source: `agent-${input.sourceMemberId}` } : {}),
            // path 必须指向真实存在的文件：SDK 会自己去读它，读不到时它会静默
            // 少一个附件，而模型只会说「我没看到那个文件」。所以空的 path 直接
            // 不过滤掉 —— 宁可少传一个附件，也不要传一个注定读不到的路径。
            ...(input.attachments?.length
              ? {
                  attachments: input.attachments
                    .filter((file) => file.path)
                    .map((file) => ({
                      type: 'file' as const,
                      path: file.path,
                      displayName: file.displayName,
                    })),
                }
              : {}),
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
        offCompactionStart();
        offCompactionComplete();
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
    execution: { executionId: string; conversationId: string; memberId: string },
  ): Promise<PreToolUseOutput> {
    const decision = await capabilities.checkToolUse(hookInput.toolName, hookInput.toolArgs);

    if (decision.allowed) {
      if (decision.mcp) {
        this.options.onMcpToolUse?.({
          ...execution,
          serverId: decision.mcp.serverId,
          toolName: decision.mcp.toolName,
        });
      }
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
   *
   * ── 它将来会变成什么（现在刻意不做） ─────────────────────────────────
   *
   * 最终这条链应该是：
   *
   *   PermissionRequest → Policy → Approval → Human → ApprovalDecision
   *
   * 但**不是** `permissionRequest → allow`。今天不做的原因不是「以后再说」，
   * 而是这条链需要一个「人在哪里批」的答案：Approval 表现在有（见 command-service），
   * 但没有能把请求推给人、再把决定送回来的通道。在那条通道存在之前，任何
   * 「先放行再说」的实现都会把一个待批准的外部动作变成一次已执行的外部动作。
   *
   * 同样刻意的是：`onPermissionRequest` **不是** Policy Service 的一部分。
   * 它只处理「不是由工具调用引起」的请求（url / mcp / memory / 扩展管理），
   * 工具调用那一路已经被 onPreToolUse + PolicyService 收口了。把两者混为一谈，
   * 会让「Policy 决策」和「权限提示」这两件不同粒度的事共用一个出口。
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
