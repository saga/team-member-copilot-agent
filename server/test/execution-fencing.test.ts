import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolInvocation } from '@github/copilot-sdk';

/**
 * Execution fencing —— 「租约」管谁能跑，「代次」管谁还能写。
 *
 * ── 这一组用例在锁的东西 ──────────────────────────────────────────────
 *
 * 租约方案有一个**已知且接受**的代价：TTL 内可能出现双跑。
 *
 *   A 拿到租约 → 假死（GC / 长工具调用 / 网络分区）
 *     → TTL 到期 → B 接手并推进了这条 execution
 *     → A 醒来，继续把它的结果写回
 *
 * 只按 id 做条件更新挡不住它：id 自始至终没变，而 A 眼里 `lease_owner` 还是
 * 「我自己」。所以每次重新夺取时 `fencing_token` 递增，A 手里永远是旧值 ——
 * 它的写回命中 0 行。
 *
 * ── 为什么必须显式传 leases ───────────────────────────────────────────
 *
 * 不传 = 单进程语义，`withExecutionLease` 直接 `fn(null)`，所有 fencing 条件
 * 退化成 `? IS NULL` 恒真。那样测出来的「全绿」证明不了任何事 —— 保护存在与
 * 否结果都一样。所以下面每一处都显式构造租约服务。
 *
 * ── 为什么全部走公开路径 ──────────────────────────────────────────────
 *
 * `updateExecution` 是 private 的。为了「方便测试」把它或 `internals` 摊开，
 * 等于让用例去断言实现细节而不是行为 —— 而这条链上真正要保证的恰恰是**行为**：
 * 「旧 worker 写不进去」。所以下面都用真实入口（sendMessage / retryExecution /
 * enqueueScheduledWork + runScheduledExecution），只在必须制造中间态时用
 * 原始 SQL 改库（与 recovery-lease.test.ts 同一手法）。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-fencing-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { WorkerLeaseService, LEASE_RESOURCE_EXECUTION } = await import('../worker-lease.js');const { CopilotCapabilityAdapter } = await import('../capabilities/copilot-adapter.js');
const { CapabilityRegistry } = await import('../capabilities/registry.js');
const { CapabilityResolver } = await import('../capabilities/resolver.js');
const {
  createTestStack,
  StubCopilot,
  capabilityContext,
  singleExecutionId,
} = await import('./support.js');
import type { CopilotService } from '../copilot.js';
import type { CapabilityContext, RuntimeCapabilities } from '../capabilities/types.js';
import type { LeaseGrant } from '../worker-lease.js';
import type { ToolPolicy } from '../tool-policy.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 一个「本进程」的租约服务。多副本用例里会再 new 一个当「另一个副本」。 */
function worker(ttlMs = 30_000): InstanceType<typeof WorkerLeaseService> {
  return new WorkerLeaseService(db, ttlMs);
}

/** 把租约行直接写成过期 —— 比 sleep 一个 TTL 稳定得多。 */
function forceExpire(resourceType: string, resourceId: string): void {
  db.prepare(
    `UPDATE worker_lease SET lease_expires_at = ? WHERE resource_type = ? AND resource_id = ?`,
  ).run(new Date(Date.now() - 60_000).toISOString(), resourceType, resourceId);
}

function mustClaim(
  service: InstanceType<typeof WorkerLeaseService>,
  resourceType: string,
  resourceId: string,
): LeaseGrant {
  const grant = service.claim(resourceType, resourceId);
  assert.ok(grant, `必须抢到 ${resourceType}/${resourceId}`);
  return grant;
}

function statusOf(executionId: string): string {
  return (
    db.prepare(`SELECT status FROM execution WHERE id = ?`).get(executionId) as {
      status: string;
    }
  ).status;
}

function errorOf(executionId: string): string | null {
  return (
    db.prepare(`SELECT error FROM execution WHERE id = ?`).get(executionId) as {
      error: string | null;
    }
  ).error;
}

function fencingTokenOf(executionId: string): number | null {
  return (
    db.prepare(`SELECT worker_fencing_token AS t FROM execution WHERE id = ?`).get(executionId) as {
      t: number | null;
    }
  ).t;
}

/**
 * 等一轮 turn 真正收尾。
 *
 * 判据用 **wake 租约行有没有被释放**（`runWithLease` 的 finally 里删掉它，
 * 而那一刻所有写回都已经发生过了）。不能等 execution 状态：本文件里好几种
 * 情况恰恰是「终态写不进去」，状态永远停在 running。
 */
async function waitForTurnSettled(conversationId: string, memberId: string): Promise<void> {
  const key = `${conversationId}:${memberId}`;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = db
      .prepare(`SELECT 1 AS present FROM worker_lease WHERE resource_type = 'wake' AND resource_id = ?`)
      .get(key);
    if (!row) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`wake 租约 ${key} 一直没有释放`);
}

// ═══════════════════════════ 1. 真实 Agent 路径上的终态写回

describe('终态写回带 fencing：代次被换掉之后 completed 写不进去', () => {
  it('旧 worker 跑完了整轮，但它的结果一个字都落不了库', async () => {
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const leases = worker();
    const stack = createTestStack(
      db,
      members,
      stub.asCopilot as unknown as CopilotService,
      undefined,
      leases,
    );

    const member = stack.team.createMember({ name: 'Stale Worker', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Stale',
      memberIds: [member.id],
      leadMemberId: member.id,
    });

    // 在引擎跑起来之后（也就是所有「开跑前」的写回都已经发生之后）把代次换掉。
    // 等价于「另一个副本在这一轮进行中接手了这条 execution」。
    stub.onTurnStart = (input) => {
      db.prepare(`UPDATE execution SET worker_fencing_token = 999 WHERE id = ?`).run(
        input.executionId,
      );
    };

    const sent = await stack.team.sendMessage({
      actorId: 'test-user',
      conversationId: room.id,
      content: '跑一轮',
    });
    const executionId = singleExecutionId(db, room.id, sent.wakes);

    await waitForTurnSettled(room.id, member.id);

    assert.equal(stub.turns.length, 1, '引擎确实跑了整轮 —— 拦的是写回，不是执行');
    assert.equal(fencingTokenOf(executionId), 999, '代次已经被别人换掉');
    assert.equal(
      statusOf(executionId),
      'running',
      '终态写回必须被 fencing 挡下：状态停在 running，而不是被旧 worker 写成 completed',
    );
    const row = db
      .prepare(`SELECT response, decision, ended_at FROM execution WHERE id = ?`)
      .get(executionId) as { response: string | null; decision: string | null; ended_at: string | null };
    assert.equal(row.response, null, 'response 也必须一个字都没写进去');
    assert.equal(row.decision, null);
    assert.equal(row.ended_at, null);
  });

  it('代次没被动过时，同一轮正常收口（fencing 不能误伤自己）', async () => {
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const leases = worker();
    const stack = createTestStack(
      db,
      members,
      stub.asCopilot as unknown as CopilotService,
      undefined,
      leases,
    );

    const member = stack.team.createMember({ name: 'Healthy Worker', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Healthy',
      memberIds: [member.id],
      leadMemberId: member.id,
    });

    const sent = await stack.team.sendMessage({
      actorId: 'test-user',
      conversationId: room.id,
      content: '跑一轮',
    });
    const executionId = singleExecutionId(db, room.id, sent.wakes);
    await waitForTurnSettled(room.id, member.id);

    assert.equal(statusOf(executionId), 'completed');
    assert.equal(fencingTokenOf(executionId), 1, 'wake 租约的第一代必须被钉到 execution 上');
  });
});

// ═══════════════════════════ 2. 代次被钉在每一条取得路径上

describe('每一条租约取得路径都必须把代次钉下去', () => {
  it('聊天唤醒（wake 租约）：新 execution 带着这一代，而不是 NULL', async () => {
    // 这条断言看着平淡，但它守着一个很难查的故障：钉代次漏掉某条路径时
    // `worker_fencing_token` 还是 NULL，而带 fencing 的写回会变成
    // `NULL = 1` → 0 行 —— 整轮所有写回**静默**失败，状态永远停在 running。
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const leases = worker();
    const stack = createTestStack(
      db,
      members,
      stub.asCopilot as unknown as CopilotService,
      undefined,
      leases,
    );

    const member = stack.team.createMember({ name: 'Wake Path', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Wake',
      memberIds: [member.id],
      leadMemberId: member.id,
    });

    const sent = await stack.team.sendMessage({
      actorId: 'test-user',
      conversationId: room.id,
      content: '一轮',
    });
    const executionId = singleExecutionId(db, room.id, sent.wakes);
    await waitForTurnSettled(room.id, member.id);

    assert.equal(fencingTokenOf(executionId), 1);
    assert.equal(statusOf(executionId), 'completed', '钉对了代次才不会把写回全挡掉');
  });

  it('retry（execution 租约）：新铸的 execution 带着这一代', async () => {
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const leases = worker();
    const stack = createTestStack(
      db,
      members,
      stub.asCopilot as unknown as CopilotService,
      undefined,
      leases,
    );

    const member = stack.team.createMember({ name: 'Retry Path', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Retry',
      memberIds: [member.id],
      leadMemberId: member.id,
    });

    const sent = await stack.team.sendMessage({
      actorId: 'test-user',
      conversationId: room.id,
      content: '一轮',
    });
    const first = singleExecutionId(db, room.id, sent.wakes);
    await waitForTurnSettled(room.id, member.id);
    assert.equal(statusOf(first), 'completed');

    const { executionId: retried } = stack.team.retryExecution(first);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (statusOf(retried) === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(statusOf(retried), 'completed');
    assert.equal(
      fencingTokenOf(retried),
      1,
      'retry 走 withExecutionLease，代次同样必须钉下去',
    );
  });
});

// ═══════════════════════════ 3. 开跑前断言：租约丢了就不进 Agent

describe('runTurn 进 Agent 之前断言：租约在排队期间被夺走时整轮停下', () => {
  it('scheduled execution：拿着过期凭证 → 直接判 interrupted，引擎一次都没跑', async () => {
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const leases = worker();
    const stack = createTestStack(
      db,
      members,
      stub.asCopilot as unknown as CopilotService,
      undefined,
      leases,
    );

    const team = stack.structure.ensureDefaultTeam('test-user');
    const member = stack.team.createMember({ name: 'Scheduled', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Scheduled',
      memberIds: [member.id],
      leadMemberId: member.id,
    });

    // 造一条「已经建好但还没开跑」的 scheduled execution —— 只有这条路径能
    // 让我们把凭证握在手里，再让它过期。
    const schedule = stack.structure.createSchedule(
      team.id,
      {
        memberId: member.id,
        conversationId: room.id,
        prompt: '定时跑一轮',
        type: 'once',
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      'test-user',
    );
    const run = stack.structure.insertScheduleRun(schedule.id, new Date().toISOString());
    const executionId = await stack.team.enqueueScheduledWork({
      scheduleRunId: run.id,
      conversationId: room.id,
      memberId: member.id,
      prompt: '定时跑一轮',
    });
    assert.equal(statusOf(executionId), 'queued', 'enqueue 只建不跑');

    // 抢到租约，然后让它过期 —— 等价于「抢到之后、开跑之前，另一个副本接手了」。
    const staleGrant = mustClaim(leases, LEASE_RESOURCE_EXECUTION, executionId);
    forceExpire(LEASE_RESOURCE_EXECUTION, executionId);

    await stack.team.runScheduledExecution(executionId, staleGrant);

    assert.equal(stub.turns.length, 0, '租约已经丢了，引擎一次都不该被调用');
    assert.equal(statusOf(executionId), 'interrupted');
    assert.match(errorOf(executionId) ?? '', /租约已失效/);
  });

  it('凭证有效时正常跑起来（fencing 不能误伤自己）', async () => {
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const leases = worker();
    const stack = createTestStack(
      db,
      members,
      stub.asCopilot as unknown as CopilotService,
      undefined,
      leases,
    );

    const team = stack.structure.ensureDefaultTeam('test-user');
    const member = stack.team.createMember({ name: 'Scheduled OK', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'ScheduledOK',
      memberIds: [member.id],
      leadMemberId: member.id,
    });
    const schedule = stack.structure.createSchedule(
      team.id,
      {
        memberId: member.id,
        conversationId: room.id,
        prompt: '定时跑一轮',
        type: 'once',
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      'test-user',
    );
    const run = stack.structure.insertScheduleRun(schedule.id, new Date().toISOString());
    const executionId = await stack.team.enqueueScheduledWork({
      scheduleRunId: run.id,
      conversationId: room.id,
      memberId: member.id,
      prompt: '定时跑一轮',
    });

    const grant = mustClaim(leases, LEASE_RESOURCE_EXECUTION, executionId);
    await stack.team.runScheduledExecution(executionId, grant);

    assert.equal(stub.turns.length, 1);
    assert.equal(statusOf(executionId), 'completed');
    assert.equal(fencingTokenOf(executionId), grant.fencingToken);
  });

  it('不传 leases = 单进程语义：没有代次，也没有任何 fencing', async () => {
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const stack = createTestStack(db, members, stub.asCopilot as unknown as CopilotService);

    const member = stack.team.createMember({ name: 'Single Process', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Single',
      memberIds: [member.id],
      leadMemberId: member.id,
    });

    const sent = await stack.team.sendMessage({
      actorId: 'test-user',
      conversationId: room.id,
      content: '一轮',
    });
    const executionId = singleExecutionId(db, room.id, sent.wakes);

    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (statusOf(executionId) === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(statusOf(executionId), 'completed');
    assert.equal(
      fencingTokenOf(executionId),
      null,
      '单进程不钉代次：null 的语义是「这一层保护不适用」，不是「代次是 0」',
    );
  });
});

// ═══════════════════════════ 4. 工具路径上的 fencing

describe('工具路径 fencing：外部副作用发不出去、结果不交回模型', () => {
  /**
   * 一律放行的 policy。
   *
   * 本组用例要验的是**租约**那一道闸，不是 Policy 那一道。用 `DefaultToolPolicy`
   * 会让 `external-write` 先被「当前部署未提供外部动作通道」拒掉 —— 于是
   * `execute` 一次都不跑，断言「执行后断言失败时结果不交回模型」就永远测不出来
   * （它测的是「策略拒绝」，不是「租约拒绝」）。
   */
  const policy: ToolPolicy = {
    check: () => ({ allowed: true, reason: 'permissive（本组用例只关心 fencing）' }),
    hostToolWithheld: () => false,
  };

  /** 一个可数的工具：`execute` 跑了多少次是断言的核心。 */
  function buildTool(execute: () => unknown): {
    runtime: Promise<RuntimeCapabilities>;
    calls: { count: number };
  } {
    const calls = { count: 0 };
    const registry = new CapabilityRegistry();
    registry.registerToolProvider({
      id: 'fencing.tools',
      version: '1',
      resolve: async () => [
        {
          providerId: 'fencing.tools',
          implementation: 'app' as const,
          kind: 'custom' as const,
          name: 'side_effect',
          description: 'stub',
          risk: 'external-write' as const,
          parameters: {},
          execute: () => {
            calls.count += 1;
            return execute();
          },
        },
      ],
    });
    // 走真实的 Resolver，保证拿到的形状和生产一致。
    return {
      runtime: new CapabilityResolver(registry).resolve(capabilityContext('fencing-member'), {
        skills: [],
        knowledge: [],
        tools: [{ providerId: 'fencing.tools' }],
      }),
      calls,
    };
  }

  it('执行前 assert 失败：execute 一次都不跑', async () => {
    const built = buildTool(() => 'done');
    const adapter = new CopilotCapabilityAdapter(policy);

    let asserts = 0;
    const context: CapabilityContext = {
      ...capabilityContext('fencing-member'),
      fencingToken: 3,
      assertExecutionActive: () => {
        asserts += 1;
        throw new Error('租约已失效（另一个 worker 已接手这条 execution）');
      },
    };

    const capabilities = adapter.build(await built.runtime, context);
    const tool = capabilities.tools.find((item) => item.name === 'side_effect');
    assert.ok(tool?.handler, 'custom tool 必须带 handler');

    await assert.rejects(async () => tool!.handler!({}, {} as ToolInvocation), /租约已失效/);
    assert.equal(asserts, 1, '执行前断言一次');
    assert.equal(built.calls.count, 0, '租约已经丢了，外部副作用连发都不该发出去');
  });

  it('执行后才失败：execute 跑了，但结果**不**交回模型', async () => {
    const built = buildTool(() => 'done');
    const adapter = new CopilotCapabilityAdapter(policy);

    // 第一次（执行前）放行，第二次（执行后）拒绝 —— 模拟「工具跑了很久，
    // 期间租约被别的副本接手」。
    let asserts = 0;
    const context: CapabilityContext = {
      ...capabilityContext('fencing-member'),
      fencingToken: 3,
      assertExecutionActive: () => {
        asserts += 1;
        if (asserts >= 2) throw new Error('租约已失效（另一个 worker 已接手这条 execution）');
      },
    };

    const capabilities = adapter.build(await built.runtime, context);
    const tool = capabilities.tools.find((item) => item.name === 'side_effect');

    await assert.rejects(async () => tool!.handler!({}, {} as ToolInvocation), /租约已失效/);
    assert.equal(asserts, 2, '执行前后各断言一次');
    assert.equal(built.calls.count, 1, '工具确实执行了 —— 这正是「拦不住已发出的请求」那件事');
  });

  it('checkToolUse 在租约失效时直接拒绝（MCP 那条路径只有这一道）', async () => {
    // MCP 工具由 SDK 原生执行，本服务没有「执行完成」回调 —— 只能在放行前拦一次。
    // 放在 check() 而不是 handler 里是必须的：MCP 根本不进 handler。
    const built = buildTool(() => 'done');
    const adapter = new CopilotCapabilityAdapter(policy);
    const context: CapabilityContext = {
      ...capabilityContext('fencing-member'),
      fencingToken: 3,
      assertExecutionActive: () => {
        throw new Error('租约已失效（另一个 worker 已接手这条 execution）');
      },
    };

    const decision = await adapter.build(await built.runtime, context).checkToolUse('side_effect', {});
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /租约已失效/);
  });

  it('没有 assertExecutionActive 时行为完全不变（单进程语义）', async () => {
    const built = buildTool(() => 'done');
    const adapter = new CopilotCapabilityAdapter(policy);
    const capabilities = adapter.build(
      await built.runtime,
      capabilityContext('fencing-member'),
    );
    const tool = capabilities.tools.find((item) => item.name === 'side_effect');

    assert.equal(await tool!.handler!({}, {} as ToolInvocation), 'done');
    assert.equal(built.calls.count, 1);
  });
});

// ═══════════════════════════ 5. 控制面写入不受 fencing 影响

describe('控制面写入不做 fencing', () => {
  it('用户取消一条 queued execution：代次对不上也必须能落库', async () => {
    // cancel / recovery 标 interrupted 不来自「某一轮 Agent 工作」，没有代次
    // 可言。用 fencing 挡住它们会造出「用户点了取消，DB 里还是 queued」——
    // 比不取消更糟：它让操作者以为取消生效了。
    const members = new MemberService(db);
    const stub = new StubCopilot();
    const leases = worker();
    const stack = createTestStack(
      db,
      members,
      stub.asCopilot as unknown as CopilotService,
      undefined,
      leases,
    );

    const member = stack.team.createMember({ name: 'Cancel Subject', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Cancel',
      memberIds: [member.id],
      leadMemberId: member.id,
    });

    const sent = await stack.team.sendMessage({
      actorId: 'test-user',
      conversationId: room.id,
      content: '一轮',
    });
    const executionId = singleExecutionId(db, room.id, sent.wakes);
    await waitForTurnSettled(room.id, member.id);

    // 摆一个「代次对不上」的 queued 记录，再走控制面取消。
    db.prepare(
      `UPDATE execution SET status = 'queued', worker_fencing_token = 999, ended_at = NULL WHERE id = ?`,
    ).run(executionId);

    const cancelled = await stack.team.cancelExecution(executionId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(statusOf(executionId), 'cancelled');
  });
});
