import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
// type-only：被完全擦除，不参与运行时模块初始化顺序（这个文件要先把 DATA_DIR 设好）
import type { ToolPolicy } from '../tool-policy.js';
import type { RuntimeCapabilities } from '../capabilities/types.js';

/**
 * Runtime correctness 测试（Commit 1 + Commit 2）。
 *
 * 覆盖四组东西：
 *   1. resumeSession 的错误分类 —— 只有「session 真的不存在」才允许降级成新建
 *   2. sendAndWait 超时 → abort —— 否则 DB 判 failed 而 Agent 还在跑
 *   3. Conversation 形状约束 / 归档 Member 语义
 *   4. Execution 操作面：cancel 状态机 / retry / listExecutions
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-correctness-'));
process.env.DATA_DIR = dataDir;
process.env.MAX_DELEGATION_DEPTH = '4';
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { CopilotService, isSessionNotFound, isTurnTimeout } = await import('../copilot.js');
const { DefaultToolPolicy } = await import('../tool-policy.js');
import type { PolicyService } from '../policy.js';
import type { MemberCapabilities } from '../domain.js';
const { createTestStack, capabilityContext, singleExecutionId, muteAllMembers } = await import(
  './support.js'
);

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 本文件只练低风险与宿主开关路径，PolicyService 不参与 —— 放行桩即可。 */
function allowHighRisk(): PolicyService {
  return { decide: (input) => ({ allowed: true, reason: `policy allow: ${input.tool.name}` }) };
}

// ═══════════════════════════════════════════ 0. 共享装配

/**
 * TeamService 侧用的 Copilot stub。
 *
 * 只记下这一轮，不跑引擎 —— 这一段的用例考的是 execution 状态机与 runtime
 * 归属，不是引擎行为。`hold` 用来把一个 execution 稳定地钉在 running 上；
 * `failWith` / `resolveOnCancel` 用来构造失败与「abort 后半截结果正常返回」。
 */
class StubCopilot {
  readonly turns: Array<{ member: { id: string }; executionId: string; prompt: string }> = [];
  failWith: string | null = null;
  hold: Promise<void> | null = null;
  /** 模拟「abort 让 sendAndWait 正常返回半截结果」而不是抛错。 */
  resolveOnCancel = false;
  private readonly cancelled = new Set<string>();

  async runMemberTurn(input: {
    member: { id: string };
    executionId: string;
    prompt: string;
  }): Promise<string> {
    this.turns.push(input);
    if (this.hold) await this.hold;
    if (this.cancelled.has(input.executionId)) {
      if (this.resolveOnCancel) return 'partial output';
      throw new Error('aborted by user');
    }
    if (this.failWith) throw new Error(this.failWith);
    return `stub reply from ${input.member.id}`;
  }

  async cancelTurn(executionId: string) {
    const found = this.turns.some((turn) => turn.executionId === executionId);
    this.cancelled.add(executionId);
    return { found, aborted: found, idle: found };
  }
}

/**
 * 全文件共用一套装配，形状与 `server/app.ts` 一致（见 support.ts）。
 *
 * 上半段的用例自己 new CopilotService（要替换 createClient / toolPolicy），
 * 但能力解析走的是同一个 resolver。手写一份 `RuntimeCapabilities` 字面量会让
 * 「hook 认得出哪些工具」这件事与解析器脱钩 —— `toolIndex` 只有解析器会建，
 * 而授权判定的第一件事就是拿工具名去 `toolIndex` 里反查。
 */
const memberService = new MemberService(db);
const stub = new StubCopilot();
const stack = createTestStack(db, memberService, stub as never);
const { team, resolver: capabilityResolver } = stack;

const alice = team.createMember({ name: 'Alice', role: 'Analyst' });
const bob = team.createMember({ name: 'Bob', role: 'Reviewer' });

/** 当前部署的唯一 Team（建人时会自动建出来）。 */
const defaultTeam = stack.structure.ensureDefaultTeam();

/**
 * 一个普通 Member 的 **Member 层增量**。
 *
 * 这里手工写一份而不是从模板 provision：本文件考的是 runtime 机制（resume
 * 降级、超时 abort、execution 状态机），不是能力组合。但必须真的写进 member
 * 层 —— Provider 侧的 ACL 判据会按 (teamId, memberId) 回查 binding，光有一份
 * 字面量会在 `assertMemberCanAccess` 那里变成 403。
 */
function memberCapabilities(): MemberCapabilities {
  return {
    skills: [{ providerId: 'team.filesystem-skills' }, { providerId: 'member.filesystem-skills' }],
    knowledge: [{ providerId: 'local.filesystem-knowledge', selector: '$personal' }],
    tools: [{ providerId: 'team.core-tools' }, { providerId: 'knowledge.tools' }],
  };
}

stack.capabilities.replaceMember(alice.id, memberCapabilities());

/** 这一轮生效的能力（无宿主工具）。 */
const defaultCapabilities = await capabilityResolver.resolve(
  capabilityContext(alice.id, defaultTeam.id),
  memberCapabilities(),
);

/**
 * 「绑定了宿主工具」的能力。
 *
 * 它只代表这个 Member **想要**宿主工具：能不能真的用还要部署层放行
 * （`ToolPolicy.allowHostTools`）。两个开关是独立的，所以下面把「声明」与
 * 「放行」分开断言 —— 只测其中一个会漏掉一半。
 */
const hostCapabilities = await capabilityResolver.resolve(capabilityContext(alice.id, defaultTeam.id), {
  ...memberCapabilities(),
  tools: [...memberCapabilities().tools, { providerId: 'runtime.host-coding-tools' }],
});

// ═══════════════════════════════════════════ 1. 错误分类（纯函数）

describe('isSessionNotFound / isTurnTimeout 必须保持窄', () => {
  it('认证失败 / 网络故障不能被误判成 session 不存在', () => {
    // 这些如果被当成「session 不存在」，就会静默新建一个空 session，
    // 把该 Member 的全部历史丢掉 —— 这正是要修的 bug。
    const notSessionProblems = [
      'No GitHub OAuth token or Copilot HMAC key provided',
      'Client not connected',
      'connect ECONNREFUSED 127.0.0.1:8080',
      'Failed to spawn copilot CLI',
      'Invalid session config: availableTools is required',
      'Request timeout after 30000ms',
      'sessionId must be a string',
    ];
    for (const message of notSessionProblems) {
      assert.equal(isSessionNotFound(new Error(message)), false, message);
    }
  });

  it('sendAndWait 超时用精确文案匹配，不靠 /timeout/i', () => {
    assert.equal(isTurnTimeout(new Error('Timeout after 600000ms waiting for session.idle')), true);
    assert.equal(isTurnTimeout(new Error('Timeout after 100ms waiting for session.idle')), true);

    // 引擎自己报的超时不是「我们等超时了」，不该触发 abort 分支
    assert.equal(isTurnTimeout(new Error('Request timeout after 30000ms')), false);
    assert.equal(isTurnTimeout(new Error('session.error: upstream timeout')), false);
    assert.equal(isTurnTimeout('Timeout after 1ms waiting for session.idle'), false);
  });
});

// ═══════════════════════════════════════════ 2. resume / abort 状态机

interface FakeSession {
  session: CopilotSession;
  calls: { abort: number; disconnect: number; sendAndWait: number };
  emitIdle: (data?: Record<string, unknown>) => void;
}

function createFakeSession(options: {
  sessionId?: string;
  onSendAndWait?: () => Promise<unknown>;
}): FakeSession {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const calls = { abort: 0, disconnect: 0, sendAndWait: 0 };

  const emitIdle = (data: Record<string, unknown> = { aborted: true }) => {
    for (const handler of handlers.get('session.idle') ?? []) {
      handler({ type: 'session.idle', data });
    }
  };

  const session = {
    sessionId: options.sessionId ?? 'sess-1',
    on(type: string, handler: (event: unknown) => void) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    async sendAndWait() {
      calls.sendAndWait += 1;
      if (options.onSendAndWait) return options.onSendAndWait();
      return { data: { content: 'hello' } };
    },
    async abort() {
      calls.abort += 1;
      // 真实引擎在 abort 之后会发 session.idle(aborted=true)
      emitIdle();
    },
    async disconnect() {
      calls.disconnect += 1;
    },
  };

  return { session: session as unknown as CopilotSession, calls, emitIdle };
}

interface FakeClient {
  client: CopilotClient;
  calls: { resume: number; create: number; metadata: number };
}

function createFakeClient(config: {
  resume?: (sessionId: string) => Promise<CopilotSession>;
  create?: () => Promise<CopilotSession>;
  metadata?: (sessionId: string) => Promise<unknown>;
  /**
   * 记下真正交给引擎的那份 sessionConfig。
   *
   * 「工具声明」和「工具授权」都有两条腿：策略算出结论，CopilotService 把它
   * 交给引擎。只测策略等于只测了一半 —— 少接一根线（比如 hooks 忘了传），
   * 策略再正确也不会生效，而且没有任何断言会红。
   */
  onConfig?: (config: unknown) => void;
}): FakeClient {
  const calls = { resume: 0, create: 0, metadata: 0 };

  const client = {
    async start() {},
    async stop() {
      return [];
    },
    async resumeSession(sessionId: string, sessionConfig?: unknown) {
      calls.resume += 1;
      config.onConfig?.(sessionConfig);
      if (!config.resume) throw new Error('test: resume not configured');
      return config.resume(sessionId);
    },
    async createSession(sessionConfig?: unknown) {
      calls.create += 1;
      config.onConfig?.(sessionConfig);
      if (!config.create) throw new Error('test: create not configured');
      return config.create();
    },
    async getSessionMetadata(sessionId: string) {
      calls.metadata += 1;
      return config.metadata ? config.metadata(sessionId) : undefined;
    },
  };

  return { client: client as unknown as CopilotClient, calls };
}

/**
 * 一轮 turn 的输入。
 *
 * `capabilities` 这一项是这一轮真正生效的能力，默认给不带宿主工具的那份。
 * 它由解析器产出（见文件头），所以 hook 里能反查到的工具集合就是引擎拿到
 * 声明的那一份 —— 用例改的是「绑定」，不是在这个字面量里手改工具。
 */
function turnInput(
  overrides: {
    onDelta?: (delta: string) => void;
    capabilities?: RuntimeCapabilities;
  } = {},
) {
  const { capabilities, ...rest } = overrides;
  return {
    runtime: {
      id: 'runtime-1',
      conversationId: 'conv-1',
      memberId: 'member-1',
      copilotSessionId: 'sess-1',
      workspacePath: path.join(dataDir, 'ws'),
      status: 'idle' as const,
      activeExecutionId: null,
      lastContextMessageSequence: 0,
      lastUsedAt: null,
    },
    member: {
      id: 'member-1',
      handle: 'alice',
      name: 'Alice',
      role: 'Analyst',
      description: '',
      style: '',
      systemPrompt: '',
      model: null,
      status: 'active' as const,
      seedKey: null,
      createdAt: 't',
      updatedAt: 't',
    },
    systemPrompt: 'You are Alice.',
    prompt: 'hello',
    executionId: 'exec-1',
    conversationId: 'conv-1',
    teamId: defaultTeam.id,
    capabilities: capabilities ?? defaultCapabilities,
    ...rest,
  };
}

describe('resumeSession 的降级必须窄', () => {
  it('resume 抛认证错误且 session 确实存在 → 原样抛出，绝不新建', async () => {
    const authError = new Error('No GitHub OAuth token or Copilot HMAC key provided');
    const fake = createFakeClient({
      resume: async () => {
        throw authError;
      },
      // session 还在磁盘上 —— 说明这不是「session 不存在」
      metadata: async () => ({ sessionId: 'sess-1' }),
    });
    const copilot = new CopilotService({ createClient: () => fake.client });

    await assert.rejects(() => copilot.runMemberTurn(turnInput()), /No GitHub OAuth token/);

    assert.equal(fake.calls.create, 0, '认证失败不能降级成新建空 session');
    assert.equal(fake.calls.metadata, 1, '匹配不上已知形态时才去问权威来源');
    assert.equal(copilot.activeTurnCount(), 0);
  });

  it('resume 抛明确的 session-not-found → 新建（不额外查元数据）', async () => {
    const fresh = createFakeSession({ sessionId: 'sess-new' });
    const fake = createFakeClient({
      resume: async () => {
        throw new Error('Session not found: sess-1');
      },
      create: async () => fresh.session,
    });
    const copilot = new CopilotService({ createClient: () => fake.client });

    const result = await copilot.runMemberTurn(turnInput());

    assert.equal(result, 'hello');
    assert.equal(fake.calls.resume, 1);
    assert.equal(fake.calls.create, 1);
    assert.equal(fake.calls.metadata, 0, '已经明确匹配就不需要再问一次');
  });

});

describe('sendAndWait 超时 → abort', () => {
  it('超时后必须 abort，并等到 session.idle', async () => {
    const fakeSession = createFakeSession({
      onSendAndWait: async () => {
        throw new Error('Timeout after 600000ms waiting for session.idle');
      },
    });
    const fake = createFakeClient({ resume: async () => fakeSession.session });
    const copilot = new CopilotService({ createClient: () => fake.client });

    await assert.rejects(() => copilot.runMemberTurn(turnInput()), /Timeout after 600000ms/);

    assert.equal(fakeSession.calls.abort, 1, '超时必须 abort，否则引擎还在跑');
    assert.equal(fakeSession.calls.disconnect, 1);
    assert.equal(copilot.activeTurnCount(), 0);
  });

  it('非超时错误不触发 abort', async () => {
    const fakeSession = createFakeSession({
      onSendAndWait: async () => {
        throw new Error('No GitHub OAuth token or Copilot HMAC key provided');
      },
    });
    const fake = createFakeClient({ resume: async () => fakeSession.session });
    const copilot = new CopilotService({ createClient: () => fake.client });

    await assert.rejects(() => copilot.runMemberTurn(turnInput()), /No GitHub OAuth token/);
    assert.equal(fakeSession.calls.abort, 0, '普通失败不该 abort');
  });

  it('cancelTurn 找不到 execution 时如实返回 found=false', async () => {
    const fakeSession = createFakeSession({});
    const fake = createFakeClient({ resume: async () => fakeSession.session });
    const copilot = new CopilotService({ createClient: () => fake.client });

    assert.deepEqual(await copilot.cancelTurn('nope'), {
      found: false,
      aborted: false,
      idle: false,
    });

    // turn 进行中才拿得到 session
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = createFakeSession({
      onSendAndWait: async () => {
        await gate;
        return { data: { content: 'done' } };
      },
    });
    const holdingClient = createFakeClient({ resume: async () => holding.session });
    const copilot2 = new CopilotService({ createClient: () => holdingClient.client });

    const turn = copilot2.runMemberTurn(turnInput());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await copilot2.cancelTurn('exec-1');
    assert.equal(result.found, true);
    assert.equal(result.aborted, true);
    assert.equal(result.idle, true);

    release();
    await turn;
  });
});

// ═══════════════════════════════════════════ 2.5 工具授权接到引擎上

/**
 * 工具授权层有两条腿：
 *
 *   策略算出结论        tool-policy.test.ts 覆盖
 *   结论交给引擎        ← 这个 block
 *
 * 第二条腿很容易漏：策略写得再对，`hooks` 忘了传、`availableTools` 忘了解包，
 * 引擎那边就是「什么都没管」，而且不会有任何断言变红 —— 因为默认行为是不拦。
 */

interface CapturedSessionConfig {
  availableTools?: { toArray(): string[] } | string[];
  hooks?: {
    onPreToolUse?: (input: {
      sessionId: string;
      toolName: string;
      toolArgs: unknown;
    }) => unknown;
  };
  onPermissionRequest?: (request: { kind: string }, invocation: { sessionId: string }) => unknown;
}

function declaredTools(config: CapturedSessionConfig | undefined): string[] {
  const tools = config?.availableTools;
  if (!tools) return [];
  return Array.isArray(tools) ? tools : tools.toArray();
}

/** 跑一轮完整 turn，并在 turn 进行中执行 `during`。 */
async function runTurnCapturing(
  options: {
    capabilities?: RuntimeCapabilities;
    toolPolicy?: ToolPolicy;
    /**
     * 第二个参数是这一轮的 input，由本函数创建后才交给引擎 —— 用例的闭包里
     * 拿不到它（那时还在 TDZ），所以从这里传进去。
     */
    during?: (
      config: CapturedSessionConfig,
      input: ReturnType<typeof turnInput>,
    ) => void | Promise<void>;
  } = {},
) {
  let captured: CapturedSessionConfig | undefined;
  const input = turnInput(
    options.capabilities ? { capabilities: options.capabilities } : {},
  );

  const fakeSession = createFakeSession({
    onSendAndWait: async () => {
      if (options.during && captured) await options.during(captured, input);
      return { data: { content: 'ok' } };
    },
  });
  const fake = createFakeClient({
    resume: async () => fakeSession.session,
    onConfig: (config) => {
      captured = config as CapturedSessionConfig;
    },
  });

  const copilot = new CopilotService({
    createClient: () => fake.client,
    ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
  });

  await copilot.runMemberTurn(input);
  assert.ok(captured, '引擎没有拿到 sessionConfig');
  return { config: captured, input };
}

describe('工具授权层真的接到了引擎上', () => {
  it('绑定了宿主工具 + 部署放行：声明里有了，hook 也真的放行', async () => {
    let decision: Record<string, unknown> | undefined;

    const { config } = await runTurnCapturing({
      capabilities: hostCapabilities,
      toolPolicy: new DefaultToolPolicy({ allowHostTools: true }, allowHighRisk()),
      during: async (captured) => {
        decision = (await captured.hooks?.onPreToolUse?.({
          sessionId: 'sess-1',
          toolName: 'bash',
          toolArgs: { command: 'ls' },
        })) as Record<string, unknown>;
      },
    });

    assert.ok(declaredTools(config).includes('builtin:bash'));
    assert.equal(decision?.permissionDecision, 'allow');
  });

  it('绑定了宿主工具但部署没放行：声明里没有，hook 也拒绝', async () => {
    // 这是上面那条的另一半，也是「部署开关 ≠ Member 能力声明」的判据。
    // 少了这条，把部署开关接到 binding 上（或者干脆去掉判据）不会有断言变红：
    // 一个 Member 只要自己声明就能拿到宿主机执行权。
    let decision: Record<string, unknown> | undefined;

    const { config } = await runTurnCapturing({
      capabilities: hostCapabilities,
      toolPolicy: new DefaultToolPolicy({ allowHostTools: false }, allowHighRisk()),
      during: async (captured) => {
        decision = (await captured.hooks?.onPreToolUse?.({
          sessionId: 'sess-1',
          toolName: 'bash',
          toolArgs: { command: 'ls' },
        })) as Record<string, unknown>;
      },
    });

    assert.ok(
      !declaredTools(config).includes('builtin:bash'),
      '部署没放行时不该把宿主工具声明给引擎',
    );
    assert.equal(decision?.permissionDecision, 'deny');
  });

  it('不是工具调用引起的权限请求：拒绝，而不是挂在 pending 上等一个不会来的答案', async () => {
    let result: Record<string, unknown> | undefined;

    const { config } = await runTurnCapturing({
      during: async (captured) => {
        result = (await captured.onPermissionRequest?.({ kind: 'url' }, { sessionId: 'sess-1' })) as
          | Record<string, unknown>
          | undefined;
      },
    });

    assert.ok(config.onPermissionRequest, '没有接 onPermissionRequest，请求会一直 pending');
    assert.equal(result?.kind, 'user-not-available');
  });

  it('一轮 turn 用开始那一刻的能力 —— 中途重新解析不改变已经在跑的这一轮', async () => {
    let decision: Record<string, unknown> | undefined;

    // 按「没有宿主工具」起一轮，在 turn 进行中把 input.capabilities 换成
    // 「有宿主工具」的那份 —— 模拟解析在别处重算了一次。
    await runTurnCapturing({
      capabilities: defaultCapabilities,
      toolPolicy: new DefaultToolPolicy({ allowHostTools: true }, allowHighRisk()),
      during: async (captured, input) => {
        input.capabilities = hostCapabilities;
        decision = (await captured.hooks?.onPreToolUse?.({
          sessionId: 'sess-1',
          toolName: 'bash',
          toolArgs: {},
        })) as Record<string, unknown>;
      },
    });

    assert.equal(
      decision?.permissionDecision,
      'deny',
      '正在跑的这一轮突然多出了宿主工具 —— 能力必须在 turn 开始时冻结',
    );
  });
});

// ═══════════════════════════════════════════ 3/4. TeamService

function executionRow(id: string) {
  const row = db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
    | { id: string; status: string; response: string | null; error: string | null }
    | undefined;
  assert.ok(row, `execution ${id} 不存在`);
  return row;
}

function runtimeRow(conversationId: string, memberId: string) {
  return db
    .prepare(`SELECT * FROM member_runtime WHERE conversation_id = ? AND member_id = ?`)
    .get(conversationId, memberId) as unknown as { status: string } | undefined;
}

async function waitForStatus(id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (executionRow(id).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`execution ${id} 未变成 ${status}（当前 ${executionRow(id).status}）`);
}

const sendRaw = team.sendMessage.bind(team);

/**
 * `POST /messages` 返回 `wakes[]`，不再有单个 executionId —— group 房间里
 * 一条消息可以唤醒多个 Member。这个文件的用例都是单收件人场景，包一层
 * 把那条 execution 找回来。
 */
async function sendMessage(input: {
  conversationId: string;
  content: string;
  targetMemberId?: string;
  replyToMessageId?: string;
}) {
  const result = await sendRaw(input);
  return { ...result, executionId: singleExecutionId(db, input.conversationId, result.wakes) };
}

function newConversation() {
  return team.createConversation({
    kind: 'direct',
    memberIds: [alice.id],
    defaultMemberId: alice.id,
  });
}

describe('Execution cancel 状态机', () => {
  it('running → cancel：先 abort 再落库 cancelled，不是假取消', async () => {
    const conv = newConversation();
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const sent = await sendMessage({ conversationId: conv.id, content: 'long task' });
      await waitForStatus(sent.executionId, 'running');

      const cancelPromise = team.cancelExecution(sent.executionId);

      // cancel 会一直等到这一轮收尾，所以这里放行被 hold 住的 turn
      release();
      stub.hold = null;

      const cancelled = await cancelPromise;
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(executionRow(sent.executionId).status, 'cancelled');
      assert.equal(
        runtimeRow(conv.id, alice.id)?.status,
        'idle',
        '取消不是故障，runtime 应回到 idle 而不是 error',
      );
    } finally {
      release?.();
      stub.hold = null;
    }
  });

  it('abort 让 sendAndWait 正常返回时也不能记成 completed', async () => {
    const conv = newConversation();
    stub.resolveOnCancel = true;
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const sent = await sendMessage({ conversationId: conv.id, content: 'long task' });
      await waitForStatus(sent.executionId, 'running');

      const cancelPromise = team.cancelExecution(sent.executionId);
      release();
      stub.hold = null;

      const cancelled = await cancelPromise;
      assert.equal(cancelled.status, 'cancelled', '半截结果不能被当成 completed');
      assert.equal(cancelled.response, 'partial output', '半截内容要留下来便于排查');
    } finally {
      release?.();
      stub.hold = null;
      stub.resolveOnCancel = false;
    }
  });

  it('queued → cancel：直接落库，且不会在 runtime 锁放开后偷偷跑起来', async () => {
    // 不能再用「往同一个房间连发两条消息」来造 queued：同一个 Member 上并发的
    // 唤醒会被 scheduler 合并成排队轮次，第二条 execution 要等第一轮跑完才出现。
    // 真正会稳定停在 queued 的是 delegation —— 它不走 scheduler，直接堵在
    // 目标 Member 的 runtime 锁后面。
    const conv = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    muteAllMembers(team, conv.id);

    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      // Alice 占住自己的 runtime
      const aliceHeld = await sendMessage({
        conversationId: conv.id,
        content: 'blocker',
        targetMemberId: alice.id,
      });
      await waitForStatus(aliceHeld.executionId, 'running');

      // Bob 也需要一条 parent execution 才能发起委派
      const bobHeld = await sendMessage({
        conversationId: conv.id,
        content: 'parent',
        targetMemberId: bob.id,
      });
      await waitForStatus(bobHeld.executionId, 'running');

      // 不 await：delegateMember 在第一个 await 之前就把 child execution 落库了，
      // 而它的 turn 会堵在 Alice 的 runtime 锁后面 —— 这就是一个稳定的 queued。
      const delegation = team.delegateMember({
        conversationId: conv.id,
        fromMemberId: bob.id,
        parentExecutionId: bobHeld.executionId,
        targetMemberId: alice.id,
        task: 'queued work',
      });
      // 下面会被 cancel 掉，这一轮注定不会跑，拒绝是预期结果
      void delegation.catch(() => {});

      const child = db
        .prepare(`SELECT id FROM execution WHERE parent_execution_id = ?`)
        .get(bobHeld.executionId) as unknown as { id: string } | undefined;
      assert.ok(child, 'delegation 必须在进引擎之前落库');
      const queuedId = child.id;

      assert.equal(executionRow(queuedId).status, 'queued');

      const cancelled = await team.cancelExecution(queuedId);
      assert.equal(cancelled.status, 'cancelled');

      release();
      stub.hold = null;
      await waitForStatus(aliceHeld.executionId, 'completed');
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(
        executionRow(queuedId).status,
        'cancelled',
        '被取消的 queued execution 不能在锁放开后跑起来',
      );
      assert.equal(
        stub.turns.filter((turn) => turn.executionId === queuedId).length,
        0,
        '它根本不该进引擎',
      );
    } finally {
      release?.();
      stub.hold = null;
    }
  });

  it('已结束 / waiting_for_member 的 execution 不能 cancel', async () => {
    const conv = newConversation();
    const sent = await sendMessage({ conversationId: conv.id, content: 'done' });
    await waitForStatus(sent.executionId, 'completed');

    await assert.rejects(() => team.cancelExecution(sent.executionId), /已经结束/);

    // 手工造一条 waiting_for_member：第一版不做子树的取消传播
    db.prepare(
      `UPDATE execution SET status = 'waiting_for_member', waiting_for_runtime_id = 'r' WHERE id = ?`,
    ).run(sent.executionId);
    await assert.rejects(() => team.cancelExecution(sent.executionId), /waiting_for_member/);
  });

});

describe('归档 Member 的 conversation 语义', () => {
  it('归档后保留在 roster 里（历史事实），但不能作为新的执行目标', async () => {
    const conv = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    // 这个用例只关心「bob 被点名那一轮」，把自动唤醒关掉
    muteAllMembers(team, conv.id);

    const sent = await sendMessage({
      conversationId: conv.id,
      content: 'first',
      targetMemberId: bob.id,
    });
    await waitForStatus(sent.executionId, 'completed');

    try {
      team.updateMember(bob.id, { status: 'archived' });

      // 1) roster 保留完整历史，不因为归档就少一个人
      const after = team.getConversation(conv.id);
      const bobEntry = after.members.find((member) => member.id === bob.id);
      assert.ok(bobEntry, '归档的 Member 必须留在 roster 里');
      assert.equal(bobEntry.status, 'archived');
      assert.equal(after.members.length, 2);

      // 2) 历史 execution 仍然可查、指向它
      assert.equal(team.getExecution(sent.executionId).memberId, bob.id);
      assert.equal(team.listMessages(conv.id).some((m) => m.senderId === bob.id), true);

      // 3) 但不能派新活
      await assert.rejects(
        () => sendMessage({ conversationId: conv.id, content: 'again', targetMemberId: bob.id }),
        /已归档/,
      );
      assert.throws(
        () => team.retryExecution(sent.executionId),
        /已归档/,
        'retry 也是一次新活',
      );

      // 4) 归档的 Member 不能被加进新 conversation
      assert.throws(
        () => team.createConversation({ kind: 'direct', memberIds: [bob.id] }),
        /已归档/,
      );
      // 5) 也不能被加进已有 group
      assert.throws(() => team.addMember(conv.id, bob.id), /已归档/);
    } finally {
      team.updateMember(bob.id, { status: 'active' });
    }
  });
});

describe('listExecutions', () => {
  it('按创建时间正序返回，且能按 parentExecutionId 组树', async () => {
    // delegation 要求 target 在同一个 conversation 的 roster 里，
    // 所以这里必须是 group（alice + bob），不能用 newConversation()。
    const conv = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    // 断言的是「恰好 2 条 execution」，所以每一轮都点名，不让讨论自己展开
    muteAllMembers(team, conv.id);

    const parent = await sendMessage({
      conversationId: conv.id,
      content: 'parent',
      targetMemberId: alice.id,
    });
    await waitForStatus(parent.executionId, 'completed');

    await team.delegateMember({
      conversationId: conv.id,
      fromMemberId: alice.id,
      parentExecutionId: parent.executionId,
      targetMemberId: bob.id,
      task: 'child',
    });

    const executions = team.listExecutions(conv.id, 100);
    assert.equal(executions.length, 2);

    const [first, second] = executions;
    assert.equal(first.id, parent.executionId);
    assert.equal(first.parentExecutionId, null);
    assert.equal(second.parentExecutionId, parent.executionId);
    assert.equal(second.memberId, bob.id);
    assert.equal(second.delegationPath.length, 2);

    // 客户端组树的依据就在这两个字段上
    const roots = executions.filter((execution) => execution.parentExecutionId === null);
    assert.equal(roots.length, 1);
  });
});
