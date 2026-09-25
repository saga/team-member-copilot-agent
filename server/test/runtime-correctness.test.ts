import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';

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
const { TeamService } = await import('../team-service.js');
const { CopilotService, isSessionNotFound, isTurnTimeout } = await import('../copilot.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════ 1. 错误分类（纯函数）

describe('isSessionNotFound / isTurnTimeout 必须保持窄', () => {
  it('只认明确的 session-not-found', () => {
    assert.equal(isSessionNotFound(new Error('Session not found: abc')), true);
    assert.equal(isSessionNotFound(new Error('No such session: abc')), true);
    assert.equal(isSessionNotFound(new Error('Unknown session abc')), true);
  });

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
}): FakeClient {
  const calls = { resume: 0, create: 0, metadata: 0 };

  const client = {
    async start() {},
    async stop() {
      return [];
    },
    async resumeSession(sessionId: string) {
      calls.resume += 1;
      if (!config.resume) throw new Error('test: resume not configured');
      return config.resume(sessionId);
    },
    async createSession() {
      calls.create += 1;
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

function turnInput(overrides: { onDelta?: (delta: string) => void } = {}) {
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
      toolProfile: 'safe' as const,
      status: 'active' as const,
      createdAt: 't',
      updatedAt: 't',
    },
    systemPrompt: 'You are Alice.',
    prompt: 'hello',
    executionId: 'exec-1',
    conversationId: 'conv-1',
    ...overrides,
  };
}

describe('resumeSession 的降级必须窄', () => {
  it('resume 成功 → 不建新 session', async () => {
    const fakeSession = createFakeSession({});
    const fake = createFakeClient({ resume: async () => fakeSession.session });
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

    const result = await copilot.runMemberTurn(turnInput());

    assert.equal(result, 'hello');
    assert.equal(fake.calls.resume, 1);
    assert.equal(fake.calls.create, 0);
    assert.equal(fakeSession.calls.disconnect, 1, 'turn 结束必须 disconnect');
    assert.equal(copilot.activeTurnCount(), 0, 'activeSessions 必须清空');
  });

  it('resume 抛认证错误且 session 确实存在 → 原样抛出，绝不新建', async () => {
    const authError = new Error('No GitHub OAuth token or Copilot HMAC key provided');
    const fake = createFakeClient({
      resume: async () => {
        throw authError;
      },
      // session 还在磁盘上 —— 说明这不是「session 不存在」
      metadata: async () => ({ sessionId: 'sess-1' }),
    });
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

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
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

    const result = await copilot.runMemberTurn(turnInput());

    assert.equal(result, 'hello');
    assert.equal(fake.calls.resume, 1);
    assert.equal(fake.calls.create, 1);
    assert.equal(fake.calls.metadata, 0, '已经明确匹配就不需要再问一次');
  });

  it('resume 抛未知错误 + 元数据说 session 不存在 → 新建', async () => {
    const fresh = createFakeSession({ sessionId: 'sess-new' });
    const fake = createFakeClient({
      resume: async () => {
        throw new Error('session.resume failed (code 5001)');
      },
      metadata: async () => undefined, // 权威来源确认：真的没有了
      create: async () => fresh.session,
    });
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

    await copilot.runMemberTurn(turnInput());
    assert.equal(fake.calls.create, 1);
  });

  it('resume 抛未知错误 + 元数据也查不了 → 原样抛出，不猜', async () => {
    const resumeError = new Error('connection lost mid-handshake');
    const fake = createFakeClient({
      resume: async () => {
        throw resumeError;
      },
      metadata: async () => {
        throw new Error('Client not connected');
      },
      create: async () => createFakeSession({}).session,
    });
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

    await assert.rejects(() => copilot.runMemberTurn(turnInput()), /connection lost mid-handshake/);
    assert.equal(fake.calls.create, 0, '无法确认就必须让原始错误抛出');
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
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

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
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

    await assert.rejects(() => copilot.runMemberTurn(turnInput()), /No GitHub OAuth token/);
    assert.equal(fakeSession.calls.abort, 0, '普通失败不该 abort');
  });

  it('正常结束不 abort', async () => {
    const fakeSession = createFakeSession({});
    const fake = createFakeClient({ resume: async () => fakeSession.session });
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

    await copilot.runMemberTurn(turnInput());
    assert.equal(fakeSession.calls.abort, 0);
  });

  it('cancelTurn 找不到 execution 时如实返回 found=false', async () => {
    const fakeSession = createFakeSession({});
    const fake = createFakeClient({ resume: async () => fakeSession.session });
    const copilot = new CopilotService({} as never, { createClient: () => fake.client });

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
    const copilot2 = new CopilotService({} as never, { createClient: () => holdingClient.client });

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

// ═══════════════════════════════════════════ 3/4. TeamService

interface TurnInput {
  member: { id: string };
  executionId: string;
  prompt: string;
}

class StubCopilot {
  readonly turns: TurnInput[] = [];
  failWith: string | null = null;
  hold: Promise<void> | null = null;
  /** 模拟「abort 让 sendAndWait 正常返回半截结果」而不是抛错。 */
  resolveOnCancel = false;
  private readonly cancelled = new Set<string>();

  async runMemberTurn(input: TurnInput): Promise<string> {
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

const stub = new StubCopilot();
const memberService = new MemberService(db);
const team = new TeamService(db, memberService, stub as never);

const alice = team.createMember({ name: 'Alice', role: 'Analyst' });
const bob = team.createMember({ name: 'Bob', role: 'Reviewer' });

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
      const sent = await team.sendMessage({ conversationId: conv.id, content: 'long task' });
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
      const sent = await team.sendMessage({ conversationId: conv.id, content: 'long task' });
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
    const conv = newConversation();
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      // 第一条占住 runtime
      const blocker = await team.sendMessage({ conversationId: conv.id, content: 'blocker' });
      await waitForStatus(blocker.executionId, 'running');

      // 第二条被挤在 runtime 锁后面，停在 queued
      const queued = await team.sendMessage({ conversationId: conv.id, content: 'queued one' });
      assert.equal(executionRow(queued.executionId).status, 'queued');

      const cancelled = await team.cancelExecution(queued.executionId);
      assert.equal(cancelled.status, 'cancelled');

      release();
      stub.hold = null;
      await waitForStatus(blocker.executionId, 'completed');
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(
        executionRow(queued.executionId).status,
        'cancelled',
        '被取消的 queued execution 不能在锁放开后跑起来',
      );
      assert.equal(
        stub.turns.filter((turn) => turn.executionId === queued.executionId).length,
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
    const sent = await team.sendMessage({ conversationId: conv.id, content: 'done' });
    await waitForStatus(sent.executionId, 'completed');

    await assert.rejects(() => team.cancelExecution(sent.executionId), /已经结束/);

    // 手工造一条 waiting_for_member：第一版不做子树的取消传播
    db.prepare(
      `UPDATE execution SET status = 'waiting_for_member', waiting_for_runtime_id = 'r' WHERE id = ?`,
    ).run(sent.executionId);
    await assert.rejects(() => team.cancelExecution(sent.executionId), /waiting_for_member/);
  });

  it('cancel 是幂等的：对已取消的 execution 再调一次不报错', async () => {
    const conv = newConversation();
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const sent = await team.sendMessage({ conversationId: conv.id, content: 'x' });
      await waitForStatus(sent.executionId, 'running');
      const first = team.cancelExecution(sent.executionId);
      release();
      stub.hold = null;
      await first;

      const again = await team.cancelExecution(sent.executionId);
      assert.equal(again.status, 'cancelled');
    } finally {
      release?.();
      stub.hold = null;
    }
  });
});

describe('归档 Member 的 conversation 语义', () => {
  it('归档后保留在 roster 里（历史事实），但不能作为新的执行目标', async () => {
    const conv = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
      defaultMemberId: alice.id,
    });

    const sent = await team.sendMessage({
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
        () => team.sendMessage({ conversationId: conv.id, content: 'again', targetMemberId: bob.id }),
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
      defaultMemberId: alice.id,
    });
    const parent = await team.sendMessage({ conversationId: conv.id, content: 'parent' });
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

describe('retryExecution 的语义', () => {
  it('retry 后新 execution 指回原记录，原记录不被改写', async () => {
    const conv = newConversation();
    stub.failWith = 'transient';
    let failedId = '';
    try {
      const failed = await team.sendMessage({ conversationId: conv.id, content: 'try' });
      failedId = failed.executionId;
      await waitForStatus(failedId, 'failed');
    } finally {
      stub.failWith = null;
    }

    const { executionId } = team.retryExecution(failedId);
    await waitForStatus(executionId, 'completed');

    assert.equal(executionRow(executionId).status, 'completed');
    assert.equal(team.getExecution(executionId).retryOfExecutionId, failedId);
    assert.equal(executionRow(failedId).status, 'failed', '原记录保持不变');
  });
});
