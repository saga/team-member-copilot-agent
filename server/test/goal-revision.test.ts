import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-goal-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { modelPolicy } = await import('../config.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack, reportTaskTurns } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);
// stub 扮演守规矩的 Agent：Task turn 内调 update_task(completed)。
reportTaskTurns(team, stub);

const alice = team.createMember({ name: 'Goal Alice', role: 'Lead' });
const bob = team.createMember({ name: 'Goal Bob', role: 'Engineer' });

const requirements = { facts: [], assumptions: [], constraints: [], successCriteria: [] };

async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_for_member')`,
      )
      .get(conversationId) as unknown as { n: number };
    if (row.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`conversation ${conversationId} 仍有未完成的 execution`);
}

function makeRoom(title: string) {
  return team.createConversation({
    kind: 'task',
    title,
    memberIds: [alice.id, bob.id],
    leadMemberId: alice.id,
  });
}

async function planV1(roomId: string, assigneeId = bob.id) {
  await team.planTasks({
    conversationId: roomId,
    memberId: alice.id,
    objective: '做 A',
    requirements,
    tasks: [{ key: 'a', title: 'A', assigneeMemberId: assigneeId }],
  });
  await waitForConversationIdle(roomId);
}

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Goal revision', () => {
  it('initial plan creates Goal v1', async () => {
    stub.reset();
    const room = makeRoom('GoalV1');
    assert.equal(room.goalRevision, 0, '建完还没 plan 时没有正式 Goal');

    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '做 A',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    await waitForConversationIdle(room.id);

    const conv = team.getConversation(room.id);
    assert.equal(conv.goalRevision, 1);
    assert.equal(conv.objective, '做 A');
    const tasks = team.listTasks(room.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].goalRevision, 1);

    const history = team.listGoalRevisions(room.id);
    assert.deepEqual(history.map((item) => item.revision), [1]);
    assert.equal(history[0].changeKind, 'initial');
    assert.equal(history[0].objective, '做 A');
  });

  it('Goal update creates immutable Goal v2（带 goal_changed 唤醒 + Strong）', async () => {
    stub.reset();
    const room = makeRoom('GoalV2');
    await planV1(room.id);

    const result = await team.updateGoal({
      conversationId: room.id,
      actorType: 'user',
      actorId: 'u1',
      objective: '改成做 B',
      changeKind: 'scope_change',
      reason: '用户改主意',
    });
    assert.equal(result.revision.revision, 2);
    assert.equal(result.revision.objective, '改成做 B');
    assert.equal(result.revision.changeKind, 'scope_change');
    assert.equal(result.conversation.goalRevision, 2);
    assert.equal(result.conversation.objective, '改成做 B');
    await waitForConversationIdle(room.id);

    // v1 行一个字没动
    const history = team.listGoalRevisions(room.id);
    assert.deepEqual(history.map((item) => item.revision), [2, 1]);
    assert.equal(history[1].objective, '做 A');

    // Lead 被 goal_changed 唤醒，且用 Strong planning 模型
    const leadExec = db
      .prepare(
        `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'goal_changed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(room.id, alice.id) as unknown as { id: string } | undefined;
    assert.ok(leadExec, '用户改 Goal 后 Lead 必须被唤醒');
    const snapshot = team.getExecution(leadExec.id).configSnapshot;
    assert.equal(snapshot?.modelPurpose, 'lead:planning');
    assert.equal(snapshot?.model, modelPolicy.lead.strong.id);
  });

  it('active tasks from v1 become cancelled（pending/ready 不跑，running 被收口）', async () => {
    stub.reset();
    const room = makeRoom('GoalCancel');
    // 执行人静音：任务停在 ready/pending 不开跑，updateGoal 时 deterministic。
    team.setMemberMuted(room.id, bob.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '做 A',
      requirements,
      tasks: [
        { key: 'a', title: 'A', assigneeMemberId: bob.id },
        { key: 'b', title: 'B', assigneeMemberId: bob.id, dependencies: ['a'] },
      ],
    });
    const before = team.listTasks(room.id);
    assert.equal(before.length, 2);

    await team.updateGoal({
      conversationId: room.id,
      actorType: 'user',
      actorId: 'u1',
      objective: '改成做 B',
      changeKind: 'scope_change',
    });
    await waitForConversationIdle(room.id);

    for (const task of before) {
      const current = team.getTask(task.id);
      assert.equal(current.status, 'cancelled', `v1 任务 ${task.title} 必须 cancelled`);
      assert.equal(current.goalRevision, 1);
      assert.match(current.blocker ?? '', /v2/);
    }
    assert.equal(team.listTasks(room.id).length, 0, '当前 Goal 还没有任务');
    assert.equal(team.getConversation(room.id).status, 'running');
  });

  it('running 的 v1 任务：行变 cancelled，turn 收尾不动它', async () => {
    stub.reset();
    const room = makeRoom('GoalRunning');
    // 按住 turn：任务钉在 running，updateGoal 时 execution 还活着。
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([bob.id]);
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '做 A',
        requirements,
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      // 等 execution 真正跑起来（不只 task 行变 running）：只有这时取消，
      // 才走得了 running 分支（cancel 发不出去被吞掉，execution 留在 running）。
      // 只看 task 行会撞上 microtask 间隙——行先变 running，execution 后变。
      let executionId: string | null = null;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const current = team.listTasks(room.id)[0];
        if (current?.status === 'running' && current.currentExecutionId) {
          const row = db.prepare(`SELECT status FROM execution WHERE id = ?`).get(current.currentExecutionId) as unknown as { status: string };
          if (row.status === 'running') {
            executionId = current.currentExecutionId;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const task = team.listTasks(room.id)[0];
      assert.equal(task.status, 'running');
      assert.ok(executionId);

      await team.updateGoal({
        conversationId: room.id,
        actorType: 'user',
        actorId: 'u1',
        objective: '改成做 B',
        changeKind: 'scope_change',
      });
      assert.equal(team.getTask(task.id).status, 'cancelled');
      // stub 没有真引擎：cancel 发不出去但被吞掉，execution 还在跑（held）。
      // 关键是 Task 行已经是 cancelled，等 turn 自己收尾。
      const row = db.prepare(`SELECT status FROM execution WHERE id = ?`).get(executionId) as unknown as { status: string };
      assert.equal(row.status, 'running');
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
    }
    await waitForConversationIdle(room.id);
    // turn 收尾发现是旧 Goal：不碰旧 Task 行（还是 cancelled，不是 failed）。
    const oldTask = db.prepare(`SELECT status FROM conversation_task WHERE conversation_id = ? AND goal_revision = 1`).get(room.id) as unknown as { status: string };
    assert.equal(oldTask.status, 'cancelled', '旧 Task 不能被 turn 收尾改成 failed');
  });

  it('user 改 Goal 时 Lead 正在 running：旧 Lead execution 被取消，不留旧 Goal 回复', async () => {
    stub.reset();
    const room = makeRoom('GoalLeadRace');
    // 执行人静音：v1 任务停在 ready 不开跑，工作区保持 running，用户消息才能进来。
    team.setMemberMuted(room.id, bob.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '做 A',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    assert.equal(team.getConversation(room.id).goalRevision, 1);

    // 按住 Lead 的 turn：用户消息已经唤醒它，但它还在跑。
    // 共享 stub 没有 cancelTurn（真引擎才有 abort）：这里临时补一个「找到但
    // 停不掉」的实现 —— cancel 发得出信号（cancelRequests），但按住的 turn
    // 照跑，收尾时自己看到信号停下来。测完删掉，不影响其它用例。
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([alice.id]);
    const stubAny = stub as unknown as { cancelTurn?: unknown };
    const originalCancelTurn = stubAny.cancelTurn;
    stubAny.cancelTurn = async () => ({ found: false, aborted: false, idle: false });
    try {
      await team.sendMessage({ actorId: 'test-user', conversationId: room.id, content: '先按 v1 做' });
      let leadExecutionId: string | null = null;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const row = db
          .prepare(
            `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND task_id IS NULL
             AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
          )
          .get(room.id, alice.id) as unknown as { id: string } | undefined;
        if (row) {
          leadExecutionId = row.id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(leadExecutionId, 'Lead turn 必须先跑起来');

      // updateGoal 会卡在等 Lead turn 收尾（cancel 要等 runtime idle），所以先不 await。
      const updating = team.updateGoal({
        conversationId: room.id,
        actorType: 'user',
        actorId: 'u1',
        objective: '改成做 B',
        changeKind: 'scope_change',
      });
      // cancel 再慢，Goal 版本号也是先提交的 —— 调用方看到 v2 时旧 Lead 还在跑。
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (team.getConversation(room.id).goalRevision === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(team.getConversation(room.id).goalRevision, 2);
      const during = db
        .prepare(`SELECT status FROM execution WHERE id = ?`)
        .get(leadExecutionId) as unknown as { status: string };
      assert.equal(during.status, 'running', 'cancel 发出去了，但被按住的 turn 还没收尾');

      release();
      await updating;
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      if (originalCancelTurn === undefined) delete stubAny.cancelTurn;
      else stubAny.cancelTurn = originalCancelTurn;
    }
    await waitForConversationIdle(room.id);

    // 第一道闸（cancel）生效：旧 Lead execution 是 cancelled，不是 completed。
    const leadExecutionId = (
      db
        .prepare(
          `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND task_id IS NULL
           AND wake_reason = 'lead_message' ORDER BY created_at DESC LIMIT 1`,
        )
        .get(room.id, alice.id) as unknown as { id: string } | undefined
    )?.id;
    assert.ok(leadExecutionId);
    assert.equal(team.getExecution(leadExecutionId).status, 'cancelled');
    // 旧 Goal 的回复没有落库：cancel race 漏过去也还有收尾的版本号守卫。
    const staleMessages = db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_message WHERE execution_id = ?`)
      .get(leadExecutionId) as unknown as { n: number };
    assert.equal(staleMessages.n, 0, '旧 Goal 的 Lead 回复不能写进消息表');
    // 新 goal_changed wake 照常排上。
    const changed = db
      .prepare(
        `SELECT id FROM execution WHERE conversation_id = ? AND wake_reason = 'goal_changed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(room.id) as unknown as { id: string } | undefined;
    assert.ok(changed, 'goal_changed wake 必须存在');
  });

  it('Lead 调 update_goal 那一轮正常跑完：旧 Goal 回复不落库，也不再自唤醒', async () => {
    stub.reset();
    const room = makeRoom('GoalLeadTool');
    team.setMemberMuted(room.id, bob.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '做 A',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });

    // 按住 Lead turn，turn 里（工具调用点）改 Goal：member 分支不 cancel
    // 自己的 execution，这一轮会正常跑完 —— 收尾的版本号守卫是唯一的闸。
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([alice.id]);
    try {
      await team.sendMessage({ actorId: 'test-user', conversationId: room.id, content: '按 v1 做' });
      let leadExecutionId: string | null = null;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const row = db
          .prepare(
            `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND task_id IS NULL
             AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
          )
          .get(room.id, alice.id) as unknown as { id: string } | undefined;
        if (row) {
          leadExecutionId = row.id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(leadExecutionId);

      const reply = await team.updateGoalTool({
        conversationId: room.id,
        memberId: alice.id,
        executionId: leadExecutionId,
        objective: '改成做 B',
        changeKind: 'scope_change',
      });
      assert.match(reply, /v2/);
      assert.equal(team.getConversation(room.id).goalRevision, 2);

      release();
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
    }
    await waitForConversationIdle(room.id);

    const leadExecutionId = (
      db
        .prepare(
          `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND task_id IS NULL
           AND wake_reason = 'lead_message' ORDER BY created_at DESC LIMIT 1`,
        )
        .get(room.id, alice.id) as unknown as { id: string } | undefined
    )?.id;
    assert.ok(leadExecutionId);
    // 没人 cancel 它：正常跑完，execution 事实是 completed。
    assert.equal(team.getExecution(leadExecutionId).status, 'completed');
    // 但旧 Goal 的回复不能落库。
    const staleMessages = db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_message WHERE execution_id = ?`)
      .get(leadExecutionId) as unknown as { n: number };
    assert.equal(staleMessages.n, 0, '旧 Goal 的 Lead 回复不能写进消息表');
    // 也不能自己再唤醒一轮：member 调的 update_goal 不排 goal_changed，
    // 旧 turn 自唤醒会被守卫拦掉，所以 Lead execution 只有这一条。
    const leadTurns = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND task_id IS NULL`,
      )
      .get(room.id, alice.id) as unknown as { n: number };
    assert.equal(leadTurns.n, 1, '旧 Goal 的 turn 不能再唤醒出新 turn');
  });

  it('turn 内自己调 update_goal 建 v1：回复照常落库，任务照常推进', async () => {
    // 回归：新工作区首轮澄清时顺手定 Goal（0→1），收尾不能拿开局快照判自己过期。
    // update_goal 必须走 adapter（和生产同一条路），audit 行是归因依据。
    stub.reset();
    const room = makeRoom('GoalSelfBump');
    // bob 不静音：replan 出来的任务要能跑完，验证 startReadyTasks 照常执行。
    let holdRelease!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      holdRelease = resolve;
    });
    stub.holdMemberIds = new Set([alice.id]);
    try {
      await team.sendMessage({ actorId: 'test-user', conversationId: room.id, content: '帮我看看这个项目' });
      let leadExecutionId: string | null = null;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const row = db
          .prepare(
            `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND task_id IS NULL
             AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
          )
          .get(room.id, alice.id) as unknown as { id: string } | undefined;
        if (row) {
          leadExecutionId = row.id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(leadExecutionId);
      assert.equal(team.getConversation(room.id).goalRevision, 0, '改之前还没有正式 Goal');

      // 和生产完全同一条路：adapter handler → 授权 → audit → updateGoalTool。
      const { CopilotCapabilityAdapter } = await import('../capabilities/copilot-adapter.js');
      const { CoreTeamToolProvider } = await import(
        '../capabilities/providers/core-tools.js'
      );
      type CoreToolHost = import('../capabilities/providers/core-tools.js').CoreToolHost;
      type UpdateGoalInput = Parameters<CoreToolHost['updateGoal']>[0];
      const { AuditService } = await import('../audit-service.js');
      const { DefaultToolPolicy } = await import('../tool-policy.js');
      const { DenyHighRiskPolicyService } = await import('../policy.js');
      const { EntitlementService } = await import('../entitlement-service.js');
      const provider = new CoreTeamToolProvider({
        updateGoal: (input: UpdateGoalInput) => team.updateGoalTool(input),
      } as unknown as CoreToolHost);
      const tools = await provider.resolve({} as never, {} as never);
      const updateGoalTool = tools.find((tool) => tool.name === 'update_goal');
      assert.ok(updateGoalTool);
      const adapter = new CopilotCapabilityAdapter(
        new DefaultToolPolicy(
          { allowHostTools: false },
          new DenyHighRiskPolicyService(),
          new EntitlementService(db),
        ),
        new AuditService(db),
      );
      const built = adapter.build(
        {
          skills: [],
          knowledge: [],
          tools: [updateGoalTool],
          mcpServers: [],
          toolIndex: new Map([['update_goal', updateGoalTool]]),
          mcpToolIndex: new Map(),
          manifestHash: 'goal-self-bump-test',
        },
        {
          teamId: team.getConversation(room.id).teamId,
          memberId: alice.id,
          conversationId: room.id,
          executionId: leadExecutionId,
          userId: 'test-user',
        },
      );
      const handler = built.tools.find((tool) => tool.name === 'update_goal')?.handler;
      assert.ok(handler, 'update_goal 必须带 handler');
      const reply = await handler(
        { objective: '评审这个项目', changeKind: 'clarification' },
        {} as never,
      );
      assert.match(String(reply), /v1/);
      assert.equal(team.getConversation(room.id).goalRevision, 1);

      // audit 行是生产归因的依据：必须存在，否则下面测的就不是生产路径。
      const auditRows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM tool_execution_audit
           WHERE execution_id = ? AND tool_name = 'update_goal' AND allowed = 1`,
        )
        .get(leadExecutionId) as unknown as { n: number };
      assert.equal(auditRows.n, 1, 'update_goal 必须经过 adapter 留下 audit 行');

      await team.replanTasks({
        conversationId: room.id,
        memberId: alice.id,
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });

      holdRelease();
    } finally {
      holdRelease();
      stub.hold = null;
      stub.holdMemberIds = null;
    }
    await waitForConversationIdle(room.id);

    // 回复落库：内容是 stub 的固定回复。
    const messages = db
      .prepare(`SELECT content FROM conversation_message WHERE execution_id = ?`)
      .all(
        (
          db
            .prepare(
              `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND task_id IS NULL
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(room.id, alice.id) as unknown as { id: string }
        ).id,
      ) as unknown as Array<{ content: string }>;
    assert.equal(messages.length, 1, '自己推进的 Goal，回复必须落库');
    assert.match(messages[0].content, /reply from Goal Alice/);
    // 任务照常推进：replan 建出来的任务跑完了。
    assert.equal(team.listTasks(room.id)[0].status, 'completed');
  });

  it('completed v1 tasks remain historical', async () => {
    stub.reset();
    const room = makeRoom('GoalHistory');
    await planV1(room.id);
    const v1 = team.listTasks(room.id);
    assert.equal(v1[0].status, 'completed');

    await team.updateGoal({
      conversationId: room.id,
      actorType: 'user',
      actorId: 'u1',
      objective: '改成做 B',
      changeKind: 'scope_change',
    });
    await waitForConversationIdle(room.id);

    assert.equal(team.getTask(v1[0].id).status, 'completed', '做完的就是做完了，不因改 Goal 翻案');
    assert.equal(team.getTask(v1[0].id).goalRevision, 1);
  });

  it('new replan tasks use v2 且只有当期可见', async () => {
    stub.reset();
    const room = makeRoom('GoalReplan');
    await planV1(room.id);
    await team.updateGoal({
      conversationId: room.id,
      actorType: 'user',
      actorId: 'u1',
      objective: '改成做 B',
      changeKind: 'scope_change',
    });

    const created = await team.replanTasks({
      conversationId: room.id,
      memberId: alice.id,
      tasks: [{ key: 'b', title: 'B', assigneeMemberId: bob.id }],
    });
    assert.match(created, /创建 1 个任务/);
    await waitForConversationIdle(room.id);

    const tasks = team.listTasks(room.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].goalRevision, 2);
    assert.equal(tasks[0].title, 'B');
    assert.equal(team.getConversation(room.id).status, 'completed');
  });

  it('retry/update of old Goal task is rejected', async () => {
    stub.reset();
    const room = makeRoom('GoalGuard');
    // 执行人静音：任务停在 ready 不开跑，和自动上报撞车的竞态就不存在。
    team.setMemberMuted(room.id, bob.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '做 A',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    const v1 = team.listTasks(room.id);
    // 先让它失败，才有 retry 可点
    await team.updateTask({
      conversationId: room.id,
      memberId: bob.id,
      taskId: v1[0].id,
      status: 'blocked',
      summary: '卡住',
      blocker: '缺东西',
    });
    await team.updateGoal({
      conversationId: room.id,
      actorType: 'user',
      actorId: 'u1',
      objective: '改成做 B',
      changeKind: 'scope_change',
    });
    await waitForConversationIdle(room.id);

    assert.throws(() => team.retryTask(v1[0].id), /旧 Goal v1/);
    await assert.rejects(
      team.updateTask({ conversationId: room.id, memberId: bob.id, taskId: v1[0].id, status: 'completed', summary: '补交' }),
      /旧 Goal v1/,
    );
    await assert.rejects(
      team.reassignTask({ conversationId: room.id, memberId: alice.id, taskId: v1[0].id, assigneeMemberId: alice.id }),
      /旧 Goal v1/,
    );
  });

  it('execution stores Goal revision', async () => {
    stub.reset();
    const room = makeRoom('GoalExec');
    await planV1(room.id);
    await team.updateGoal({
      conversationId: room.id,
      actorType: 'user',
      actorId: 'u1',
      objective: '改成做 B',
      changeKind: 'scope_change',
    });
    await team.replanTasks({
      conversationId: room.id,
      memberId: alice.id,
      tasks: [{ key: 'b', title: 'B', assigneeMemberId: bob.id }],
    });
    await waitForConversationIdle(room.id);

    const rows = db
      .prepare(`SELECT DISTINCT goal_revision AS rev FROM execution WHERE conversation_id = ? ORDER BY rev`)
      .all(room.id) as unknown as Array<{ rev: number }>;
    // v1 task execution + lead goal_changed execution 都是 1，v2 task 是 2
    assert.ok(rows.some((row) => row.rev === 1));
    assert.ok(rows.some((row) => row.rev === 2));
    const taskExec = db
      .prepare(`SELECT goal_revision AS rev FROM execution WHERE task_id = ? ORDER BY created_at LIMIT 1`)
      .get(team.listTasks(room.id)[0].id) as unknown as { rev: number };
    assert.equal(taskExec.rev, 2, 'v2 任务的 execution 必须记 v2');
  });
});

describe('Goal 工具入口：只有 Lead 能改能重排', () => {
  it('非 Lead 调 update_goal / replan_tasks 被拒绝', async () => {
    stub.reset();
    const room = makeRoom('GoalAuth');
    await assert.rejects(
      team.updateGoalTool({
        conversationId: room.id,
        memberId: bob.id,
        executionId: 'exec-tool',
        objective: '我要改',
        changeKind: 'scope_change',
      }),
      /只有 Lead/,
    );
    await assert.rejects(
      team.replanTasks({
        conversationId: room.id,
        memberId: bob.id,
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      }),
      /只有 Lead/,
    );
    await waitForConversationIdle(room.id);
  });

  it('replan 守卫：没 Goal 用 plan，有任务用 add', async () => {
    stub.reset();
    const room = makeRoom('GoalReplanGuard');
    await assert.rejects(
      team.replanTasks({
        conversationId: room.id,
        memberId: alice.id,
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      }),
      /plan_tasks/,
    );
    await planV1(room.id);
    await assert.rejects(
      team.replanTasks({
        conversationId: room.id,
        memberId: alice.id,
        tasks: [{ key: 'b', title: 'B', assigneeMemberId: bob.id }],
      }),
      /add_task/,
    );
    await waitForConversationIdle(room.id);
  });
});
