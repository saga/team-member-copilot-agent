import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-task-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { RecoveryService } = await import('../recovery-service.js');
const { ConversationMemberService } = await import('../conversation-member-service.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack, reportTaskTurns, singleExecutionId } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

void config;

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);
// stub 默认扮演守规矩的 Agent：Task turn 内调 update_task(completed)。
// turn 结束自动 completed 的旧语义已删除，不调 tool 的 turn 会判 failed ——
// 那个行为由“静默 Agent”单测单独覆盖，这里全部按正常完工走。
reportTaskTurns(team, stub);

const alice = team.createMember({ name: 'Task Alice', role: 'Lead' });
const bob = team.createMember({ name: 'Task Bob', role: 'Engineer' });
const carol = team.createMember({ name: 'Task Carol', role: 'Tester' });

function executionRow(id: string) {
  const row = db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
    | { id: string; status: string; task_id: string | null }
    | undefined;
  assert.ok(row, `execution ${id} 不存在`);
  return row;
}

async function waitForStatus(id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (executionRow(id).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`execution ${id} 未变成 ${status}`);
}

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


after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Task 规划', () => {
  it('Lead 一轮规划多个任务，无依赖的直接就绪', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Plan',
      memberIds: [alice.id, bob.id, carol.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '解决登录超时',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: ['成功率 99.9%'] },
      tasks: [
        { key: 'investigate', title: '调查根因', assigneeMemberId: alice.id },
        { key: 'fix', title: '修复', assigneeMemberId: bob.id },
        { key: 'test', title: '验证', assigneeMemberId: carol.id },
      ],
    });
    const tasks = team.listTasks(room.id);
    assert.equal(tasks.length, 3);
    const conv = team.getConversation(room.id);
    assert.equal(conv.objective, '解决登录超时');
    assert.equal(conv.status, 'running');
    for (const task of team.listTasks(room.id)) {
      assert.ok(
        ['ready', 'running', 'completed'].includes(task.status),
        `无依赖的任务应该直接就绪或已经开跑：${task.title} 是 ${task.status}`,
      );
    }
    await waitForConversationIdle(room.id);
  });

  it('依赖未完成时 pending，完成上游后自动 ready 并执行', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Deps',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '依赖链',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [
        { key: 'a', title: 'A', assigneeMemberId: alice.id },
        { key: 'b', title: 'B', assigneeMemberId: bob.id, dependencies: ['a'] },
      ],
    });
    const before = team.listTasks(room.id);
    assert.equal(before.find((task) => task.title === 'B')?.status, 'pending');

    const taskA = before.find((task) => task.title === 'A')!;
    await team.updateTask({
      conversationId: room.id,
      memberId: alice.id,
      taskId: taskA.id,
      status: 'completed',
      summary: 'A 做完了',
    });
    // B 可能在轮询间隙里已经跑完：等它离开 pending 即可
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const current = team.listTasks(room.id).find((task) => task.title === 'B');
      if (current && current.status !== 'pending') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.notEqual(
      team.listTasks(room.id).find((task) => task.title === 'B')?.status,
      'pending',
      '上游完成后 B 应该离开 pending',
    );
    await waitForConversationIdle(room.id);
    assert.equal(team.listTasks(room.id).find((task) => task.title === 'B')?.status, 'completed');
  });

  it('循环依赖直接拒绝', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Cycle',
      memberIds: [alice.id],
      leadMemberId: alice.id,
    });
    await assert.rejects(
      () =>
        team.planTasks({
          conversationId: room.id,
          memberId: alice.id,
          objective: '循环',
          requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
          tasks: [
            { key: 'a', title: 'A', assigneeMemberId: alice.id, dependencies: ['b'] },
            { key: 'b', title: 'B', assigneeMemberId: alice.id, dependencies: ['a'] },
          ],
        }),
      /循环/,
    );
  });

  it('只有 Lead 能规划，不是 Lead 被拒绝', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'LeadOnly',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await assert.rejects(
      () =>
        team.planTasks({
          conversationId: room.id,
          memberId: bob.id,
          objective: '越权',
          requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
          tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
        }),
      /Lead/,
    );
  });
});

describe('Task 执行', () => {
  it('同一个 Member 的多个任务串行，不并行', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Serial',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '串行',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [
          { key: 'b1', title: 'B1', assigneeMemberId: bob.id },
          { key: 'b2', title: 'B2', assigneeMemberId: bob.id },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const running = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND status = 'running'`,
        )
        .get(room.id, bob.id) as unknown as { n: number };
      assert.equal(running.n, 1, '同一个 Member 同时只能跑一个 Task');
    } finally {
      release();
      stub.hold = null;
    }
    await waitForConversationIdle(room.id);
  });

  it('不同 Member 的任务并行', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Parallel',
      memberIds: [bob.id, carol.id],
      leadMemberId: bob.id,
    });
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: bob.id,
        objective: '并行',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [
          { key: 'b1', title: 'B1', assigneeMemberId: bob.id },
          { key: 'c1', title: 'C1', assigneeMemberId: carol.id },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const running = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND status = 'running'`,
        )
        .get(room.id) as unknown as { n: number };
      assert.equal(running.n, 2, '不同 Member 应该并行');
    } finally {
      release();
      stub.hold = null;
    }
    await waitForConversationIdle(room.id);
  });

  it('Task execution 关联 taskId，全部完成工作区自动 completed', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Complete',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '收尾',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    await waitForConversationIdle(room.id);
    const tasks = team.listTasks(room.id);
    assert.equal(tasks[0].status, 'completed');
    assert.equal(team.getConversation(room.id).status, 'completed');
  });

  it('只能更新分给自己的任务', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Ownership',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '归属',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    const task = team.listTasks(room.id)[0];
    await assert.rejects(
      () =>
        team.updateTask({
          conversationId: room.id,
          memberId: alice.id,
          taskId: task.id,
          status: 'completed',
          summary: '冒领',
        }),
      /自己的任务/,
    );
    await waitForConversationIdle(room.id);
  });

  it('用户消息只唤醒 Lead，不唤醒执行人', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'LeadOnly',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    const result = await team.sendMessage({ conversationId: room.id, content: '补充一个要求' });
    assert.equal(result.wakes.length, 1);
    assert.equal(result.wakes[0].memberId, alice.id);
    assert.equal(result.wakes[0].reason, 'lead_message');
    const executionId = singleExecutionId(db, room.id, result.wakes);
    await waitForStatus(executionId, 'completed');
    await waitForConversationIdle(room.id);
  });

  it('request_clarification 进入 waiting_user，用户回复后回到 running', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Clarify',
      memberIds: [alice.id],
      leadMemberId: alice.id,
    });
    await team.requestClarification({
      conversationId: room.id,
      memberId: alice.id,
      questions: ['生产环境是哪个集群？'],
    });
    assert.equal(team.getConversation(room.id).status, 'waiting_user');
    assert.deepEqual(team.getConversation(room.id).openQuestions, ['生产环境是哪个集群？']);
    await team.sendMessage({ conversationId: room.id, content: '是 prod-1' });
    assert.equal(team.getConversation(room.id).status, 'running');
    await waitForConversationIdle(room.id);
  });

  it('进程重启把 running 的 Task 置成 blocked，不自动重跑', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Recovery',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '重启',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      // 等 Bob 的执行真的跑起来（Task 已是 running）
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const task = team.listTasks(room.id)[0];
        if (task && task.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(team.listTasks(room.id)[0].status, 'running');

      new RecoveryService(db, new ConversationMemberService(db)).recover();

      const blocked = team.listTasks(room.id)[0];
      assert.equal(blocked.status, 'blocked');
      assert.match(blocked.blocker ?? '', /重启/);
    } finally {
      release();
      stub.hold = null;
    }
    await waitForConversationIdle(room.id);
  });

  it('blocked 任务让工作区进入 blocked，重试后继续', async () => {    const room = team.createConversation({
      kind: 'task',
      title: 'Blocked',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '阻塞',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    const task = team.listTasks(room.id)[0];
    await team.updateTask({
      conversationId: room.id,
      memberId: bob.id,
      taskId: task.id,
      status: 'blocked',
      summary: '做不下去',
      blocker: '缺生产权限',
    });
    assert.equal(team.getConversation(room.id).status, 'blocked');
    const retried = team.retryTask(task.id);
    assert.equal(retried.status, 'ready');
    await waitForConversationIdle(room.id);
  });
});

describe('Task 生命周期补严', () => {
  const requirements = { facts: [], assumptions: [], constraints: [], successCriteria: [] };

  it('第二次 plan_tasks 被拒绝，旧任务一个不少', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'PlanOnce',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '第一版',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    const before = team.listTasks(room.id);
    await assert.rejects(
      () =>
        team.planTasks({
          conversationId: room.id,
          memberId: alice.id,
          objective: '第二版',
          requirements,
          tasks: [{ key: 'b', title: 'B', assigneeMemberId: bob.id }],
        }),
      /已经存在任务/,
    );
    const after = team.listTasks(room.id);
    assert.deepEqual(
      after.map((task) => task.id),
      before.map((task) => task.id),
    );
    await waitForConversationIdle(room.id);
  });

  it('failed 不会让工作区变成 completed，而是 blocked 并唤醒 Lead', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'FailedBlocked',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    stub.failMemberIds.add(bob.id);
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '失败',
        requirements,
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      await waitForConversationIdle(room.id);
      assert.equal(team.listTasks(room.id)[0].status, 'failed');
      assert.equal(team.getConversation(room.id).status, 'blocked');
      // Lead 被自动唤醒一次（之前 Lead 从没跑过，这一轮只能来自失败推进）
      const leadRuns = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_recovery'`,
        )
        .get(room.id, alice.id) as unknown as { n: number };
      assert.ok(leadRuns.n >= 1, 'Lead 应该在任务失败后以 recovery 原因被唤醒');
    } finally {
      stub.failMemberIds.delete(bob.id);
    }
    await waitForConversationIdle(room.id);
  });

  it('上游 failed / cancelled，下游直接 blocked，不死 pending', async () => {
    for (const upstream of ['failed', 'cancelled'] as const) {
      const room = team.createConversation({
        kind: 'task',
        title: `Downstream-${upstream}`,
        memberIds: [alice.id, bob.id],
        leadMemberId: alice.id,
      });
      if (upstream === 'failed') stub.failMemberIds.add(bob.id);
      // cancelled 分支：执行人静音让 A 停在 ready。running 的任务不能直接取消
      // （必须先取消 execution），ready 的可以直接取消。
      if (upstream === 'cancelled') team.setMemberMuted(room.id, bob.id, true);
      try {
        await team.planTasks({
          conversationId: room.id,
          memberId: alice.id,
          objective: '依赖失败',
          requirements,
          tasks: [
            { key: 'a', title: 'A', assigneeMemberId: bob.id },
            { key: 'b', title: 'B', assigneeMemberId: alice.id, dependencies: ['a'] },
          ],
        });
        if (upstream === 'cancelled') {
          const taskA = team.listTasks(room.id).find((task) => task.title === 'A')!;
          team.cancelTask(taskA.id);
        }
        await waitForConversationIdle(room.id);
        const tasks = team.listTasks(room.id);
        assert.equal(tasks.find((task) => task.title === 'A')?.status, upstream);
        const downstream = tasks.find((task) => task.title === 'B')!;
        assert.equal(downstream.status, 'blocked');
        assert.match(downstream.blocker ?? '', /依赖/);
      } finally {
        stub.failMemberIds.delete(bob.id);
      }
      await waitForConversationIdle(room.id);
    }
  });

  it('依赖没好时 retry 被拒绝，依赖好了才能 retry', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'RetryDeps',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    stub.failMemberIds.add(bob.id);
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '重试依赖',
        requirements,
        tasks: [
          { key: 'a', title: 'A', assigneeMemberId: bob.id },
          { key: 'b', title: 'B', assigneeMemberId: alice.id, dependencies: ['a'] },
        ],
      });
      await waitForConversationIdle(room.id);
      const downstream = team.listTasks(room.id).find((task) => task.title === 'B')!;
      assert.equal(downstream.status, 'blocked');
      assert.throws(() => team.retryTask(downstream.id), /依赖尚未完成/);
      // 上游重试成功后，下游才能重试
      stub.failMemberIds.delete(bob.id);
      const upstream = team.listTasks(room.id).find((task) => task.title === 'A')!;
      team.retryTask(upstream.id);
      await waitForConversationIdle(room.id);
      assert.equal(team.listTasks(room.id).find((task) => task.title === 'A')?.status, 'completed');
      const retried = team.retryTask(downstream.id);
      // enqueue 内 runWake 的落库段是同步的：返回时可能已经是 running。
      // 关键是重试被接受（不再是 blocked），最终能跑完。
      assert.ok(['ready', 'running'].includes(retried.status), `重试后应该是 ready/running：${retried.status}`);
    } finally {
      stub.failMemberIds.delete(bob.id);
    }
    await waitForConversationIdle(room.id);
    assert.equal(team.listTasks(room.id).find((task) => task.title === 'B')?.status, 'completed');
  });

  it('retry 建新 execution，retry_of_execution_id 指回上一轮', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'RetryChain',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([bob.id]);
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '重试链',
        requirements,
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (team.listTasks(room.id)[0]?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const firstExecutionId = team.listTasks(room.id)[0].currentExecutionId;
      assert.ok(firstExecutionId, 'Task 应该已经挂上第一次 execution');
      await team.updateTask({
        conversationId: room.id,
        memberId: bob.id,
        taskId: team.listTasks(room.id)[0].id,
        status: 'blocked',
        summary: '卡住了',
        blocker: '缺权限',
      });
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      await waitForConversationIdle(room.id);
      team.retryTask(team.listTasks(room.id)[0].id);
      await waitForConversationIdle(room.id);
      const second = db
        .prepare(
          `SELECT id, retry_of_execution_id AS retryOf FROM execution
           WHERE conversation_id = ? AND member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(room.id, bob.id) as unknown as { id: string; retryOf: string | null };
      assert.notEqual(second.id, firstExecutionId);
      assert.equal(second.retryOf, firstExecutionId);
      assert.equal(team.listTasks(room.id)[0].status, 'completed');
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
    }
    await waitForConversationIdle(room.id);
  });

  it('completed / cancelled 的工作区不再接受用户消息', async () => {
    const doneRoom = team.createConversation({
      kind: 'task',
      title: 'DoneNoMore',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: doneRoom.id,
      memberId: alice.id,
      objective: '做完',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    const task = team.listTasks(doneRoom.id)[0];
    await team.updateTask({
      conversationId: doneRoom.id,
      memberId: bob.id,
      taskId: task.id,
      status: 'completed',
      summary: '做完了',
    });
    assert.equal(team.getConversation(doneRoom.id).status, 'completed');
    await assert.rejects(
      team.sendMessage({ conversationId: doneRoom.id, content: '再加一个需求' }),
      /已经结束/,
    );

    const cancelledRoom = team.createConversation({
      kind: 'task',
      title: 'CancelledNoMore',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    // 执行人静音：任务停在 ready。running 的任务必须先取消 execution，
    // 不能直接取消（见“正在执行的 Task 不能直接 cancel”）。
    team.setMemberMuted(cancelledRoom.id, bob.id, true);
    await team.planTasks({
      conversationId: cancelledRoom.id,
      memberId: alice.id,
      objective: '取消',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    team.cancelTask(team.listTasks(cancelledRoom.id)[0].id);
    assert.equal(team.getConversation(cancelledRoom.id).status, 'cancelled');
    await assert.rejects(
      team.sendMessage({ conversationId: cancelledRoom.id, content: '再想想' }),
      /已经结束/,
    );
    await waitForConversationIdle(doneRoom.id);
    await waitForConversationIdle(cancelledRoom.id);
  });

  it('任务开始后不能增删成员，准备中可以；删 Lead 自动有人接替', async () => {
    const room = team.createConversation({
      kind: 'task',
      title: 'Roster',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    // intake：增删都行
    team.removeMember(room.id, bob.id);
    assert.equal(team.getConversation(room.id).members.length, 1);
    team.addMember(room.id, bob.id);
    assert.equal(team.getConversation(room.id).members.length, 2);

    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '冻结',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    assert.equal(team.getConversation(room.id).status, 'running');
    assert.throws(() => team.addMember(room.id, carol.id), /不能修改成员/);
    assert.throws(() => team.removeMember(room.id, bob.id), /不能修改成员/);
    await waitForConversationIdle(room.id);

    // intake 工作区删掉 Lead：剩下成员的第一个自动接替，不留 null
    const room2 = team.createConversation({
      kind: 'task',
      title: 'LeadHandover',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    team.removeMember(room2.id, alice.id);
    assert.equal(team.getConversation(room2.id).leadMemberId, bob.id);
  });

  it('blocked 的任务会自动唤醒 Lead', async () => {    const room = team.createConversation({
      kind: 'task',
      title: 'WakeLead',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '唤醒',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    const task = team.listTasks(room.id)[0];
    await team.updateTask({
      conversationId: room.id,
      memberId: bob.id,
      taskId: task.id,
      status: 'blocked',
      summary: '卡住了',
      blocker: '缺生产权限',
    });
    await waitForConversationIdle(room.id);
    const leadRuns = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_recovery'`,
      )
      .get(room.id, alice.id) as unknown as { n: number };
    assert.ok(leadRuns.n >= 1, 'Lead 应该在任务阻塞后以 recovery 原因被唤醒');
  });

  it('Task 失败唤醒 Lead，下游 blocked 的变化广播到前端', async () => {
    stub.reset();
    stub.failMemberIds.add(bob.id);
    try {
      const room = team.createConversation({
        kind: 'task',
        title: 'FailChain',
        memberIds: [alice.id, bob.id],
        leadMemberId: alice.id,
      });
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '失败链',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [
          { key: 'a', title: 'A', assigneeMemberId: bob.id },
          { key: 'b', title: 'B', assigneeMemberId: bob.id, dependencies: ['a'] },
        ],
      });
      const seen: Array<{ id: string; status: string }> = [];
      const off = team.subscribe(room.id, (event) => {
        if (event.type === 'task.updated') {
          const task = event.data as { id: string; status: string };
          seen.push({ id: task.id, status: task.status });
        }
      });
      try {
        await waitForConversationIdle(room.id);
      } finally {
        off();
      }

      const tasks = team.listTasks(room.id);
      assert.equal(tasks.find((task) => task.title === 'A')?.status, 'failed');
      const taskB = tasks.find((task) => task.title === 'B')!;
      assert.equal(taskB.status, 'blocked', '上游失败后下游必须 blocked，不能永久 pending');
      // B 的 blocked 不是静默翻的：前端必须收到 task.updated，否则 UI 还是旧状态
      assert.ok(
        seen.some((item) => item.id === taskB.id && item.status === 'blocked'),
        '下游变 blocked 必须广播 task.updated',
      );
      const leadRuns = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_recovery'`,
        )
        .get(room.id, alice.id) as unknown as { n: number };
      assert.ok(leadRuns.n >= 1, 'Task 失败后 Lead 必须以 recovery 原因被唤醒');
      assert.equal(team.getConversation(room.id).status, 'blocked');
    } finally {
      stub.failMemberIds.clear();
      stub.reset();
    }
  });

  it('Lead 正忙时 Task 失败，recovery 照样排队等 Lead 跑完', async () => {
    stub.reset();
    stub.failMemberIds.add(bob.id);
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([alice.id]);
    try {
      const room = team.createConversation({
        kind: 'task',
        title: 'BusyLeadRecovery',
        memberIds: [alice.id, bob.id],
        leadMemberId: alice.id,
      });
      await team.sendMessage({ conversationId: room.id, content: '开工' });
      // 等 Lead turn 真正跑起来再让 worker 失败，否则测不到“正忙”
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const running = db
          .prepare(
            `SELECT 1 AS ok FROM execution WHERE conversation_id = ? AND member_id = ? AND status = 'running'`,
          )
          .get(room.id, alice.id) as unknown as { ok: number } | undefined;
        if (running) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '忙中出错',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      // worker 失败落定（此时 Lead 还被按住）：recovery 必须已经排上，不能丢
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (team.listTasks(room.id)[0]?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(team.listTasks(room.id)[0].status, 'failed');
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      await waitForConversationIdle(room.id);

      const leadRuns = db
        .prepare(
          `SELECT wake_reason AS reason FROM execution WHERE conversation_id = ? AND member_id = ? ORDER BY created_at`,
        )
        .all(room.id, alice.id) as unknown as Array<{ reason: string }>;
      assert.ok(leadRuns.length >= 2, 'Lead 当前 turn 完成后必须接着跑 recovery');
      assert.ok(
        leadRuns.some((run) => run.reason === 'lead_recovery'),
        'recovery 唤醒不能在 Lead 正忙时丢掉',
      );
      assert.equal(team.getConversation(room.id).status, 'blocked');
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      stub.failMemberIds.clear();
      stub.reset();
    }
  });

  it('正在执行的 Task 不能直接 cancel，execution 收尾后可以', async () => {
    stub.reset();
    const room = team.createConversation({
      kind: 'task',
      title: 'CancelRunning',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([bob.id]);
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '取消执行中',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (team.listTasks(room.id)[0]?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const task = team.listTasks(room.id)[0];
      assert.equal(task.status, 'running');
      assert.throws(() => team.cancelTask(task.id), /先取消对应的 Execution/);
      // execution 收尾（这里直接落终态，效果等同用户在 UI 上取消了它）后放行
      db.prepare(`UPDATE execution SET status = 'cancelled' WHERE id = ?`).run(task.currentExecutionId);
      const cancelled = team.cancelTask(task.id);
      assert.equal(cancelled.status, 'cancelled');
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      stub.reset();
    }
    await waitForConversationIdle(room.id);
  });

  it('cancel ready 的 Task，下游变 blocked 并广播', async () => {
    stub.reset();
    const room = team.createConversation({
      kind: 'task',
      title: 'CancelChain',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    team.setMemberMuted(room.id, bob.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '取消链',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [
        { key: 'a', title: 'A', assigneeMemberId: bob.id },
        { key: 'b', title: 'B', assigneeMemberId: bob.id, dependencies: ['a'] },
      ],
    });
    const seen: Array<{ id: string; status: string }> = [];
    const off = team.subscribe(room.id, (event) => {
      if (event.type === 'task.updated') {
        const task = event.data as { id: string; status: string };
        seen.push({ id: task.id, status: task.status });
      }
    });
    try {
      const taskA = team.listTasks(room.id).find((task) => task.title === 'A')!;
      team.cancelTask(taskA.id);
      await waitForConversationIdle(room.id);
    } finally {
      off();
    }
    const tasks = team.listTasks(room.id);
    assert.equal(tasks.find((task) => task.title === 'A')?.status, 'cancelled');
    const taskB = tasks.find((task) => task.title === 'B')!;
    assert.equal(taskB.status, 'blocked', '上游取消后下游必须 blocked');
    assert.ok(
      seen.some((item) => item.id === taskB.id && item.status === 'blocked'),
      '下游变 blocked 必须广播 task.updated',
    );
    assert.equal(team.getConversation(room.id).status, 'blocked');
  });

  it('Task turn 内没调 update_task，任务判 failed 并唤醒 Lead', async () => {
    stub.reset();
    // 扮演不守规矩的 Agent：turn 内不报告完成也不报告阻塞
    stub.onTurnStart = null;
    try {
      const room = team.createConversation({
        kind: 'task',
        title: 'SilentAgent',
        memberIds: [alice.id, bob.id],
        leadMemberId: alice.id,
      });
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '静默',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      await waitForConversationIdle(room.id);
      const task = team.listTasks(room.id)[0];
      assert.equal(task.status, 'failed', '没报告的 turn 不能按完成处理');
      assert.match(task.blocker ?? '', /update_task/);
      const leadRuns = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_recovery'`,
        )
        .get(room.id, alice.id) as unknown as { n: number };
      assert.ok(leadRuns.n >= 1, '静默失败必须唤醒 Lead 来收拾');
      assert.equal(team.getConversation(room.id).status, 'blocked');
    } finally {
      reportTaskTurns(team, stub);
    }
  });

  it('Lead 补一个缺失任务：依赖满足自动执行，非 Lead 被拒绝', async () => {
    stub.reset();
    const room = team.createConversation({
      kind: 'task',
      title: 'AddTask',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    // 按住执行人：A 停在 running，工作区保持进行中，补任务环境才稳定
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([bob.id]);
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '补任务',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (team.listTasks(room.id)[0]?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const taskA = team.listTasks(room.id)[0];

      const waiting = await team.addTask({
        conversationId: room.id,
        memberId: alice.id,
        title: 'B',
        assigneeMemberId: bob.id,
        dependencies: [taskA.id],
      });
      assert.match(waiting, /等待依赖完成/);

      // 非 Lead 不能加
      await assert.rejects(
        team.addTask({ conversationId: room.id, memberId: bob.id, title: 'C', assigneeMemberId: bob.id }),
        /只有负责这个工作的 Lead/,
      );
      // 不存在的依赖被拒绝
      await assert.rejects(
        team.addTask({
          conversationId: room.id,
          memberId: alice.id,
          title: 'D',
          assigneeMemberId: bob.id,
          dependencies: ['no-such-task'],
        }),
        /Task 不存在/,
      );
      // 其它工作区的任务不能当依赖
      const other = team.createConversation({
        kind: 'task',
        title: 'Other',
        memberIds: [alice.id, bob.id],
        leadMemberId: alice.id,
      });
      await team.planTasks({
        conversationId: other.id,
        memberId: alice.id,
        objective: '隔壁',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [{ key: 'z', title: 'Z', assigneeMemberId: alice.id }],
      });
      await assert.rejects(
        team.addTask({
          conversationId: room.id,
          memberId: alice.id,
          title: 'E',
          assigneeMemberId: bob.id,
          dependencies: [team.listTasks(other.id)[0].id],
        }),
        /不属于当前工作区/,
      );
      await waitForConversationIdle(other.id);

      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      await waitForConversationIdle(room.id);
      const tasks = team.listTasks(room.id);
      assert.equal(tasks.length, 2);
      assert.ok(tasks.every((task) => task.status === 'completed'), '补的任务依赖满足就该自动跑完');
      assert.ok(tasks[1].sortOrder > tasks[0].sortOrder, '补的任务排在后面');

      // 工作结束后不能再加
      assert.equal(team.getConversation(room.id).status, 'completed');
      await assert.rejects(
        team.addTask({ conversationId: room.id, memberId: alice.id, title: 'F', assigneeMemberId: bob.id }),
        /已经结束/,
      );
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      stub.reset();
    }
  });

  it('Lead 给未开始任务换执行人：running/completed 换不动', async () => {
    stub.reset();
    const room = team.createConversation({
      kind: 'task',
      title: 'Reassign',
      memberIds: [alice.id, bob.id, carol.id],
      leadMemberId: alice.id,
    });
    // 执行人静音：任务不开跑，换人环境才稳定。A1 无依赖（ready），
    // A 依赖 A1（pending）—— reassign 只收 pending / blocked / failed。
    team.setMemberMuted(room.id, bob.id, true);
    team.setMemberMuted(room.id, carol.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '换人',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [
        { key: 'a1', title: 'A1', assigneeMemberId: bob.id },
        { key: 'a', title: 'A', assigneeMemberId: bob.id, dependencies: ['a1'] },
      ],
    });
    const task = team.listTasks(room.id).find((item) => item.title === 'A')!;
    assert.equal(task.status, 'pending');

    const moved = await team.reassignTask({
      conversationId: room.id,
      memberId: alice.id,
      taskId: task.id,
      assigneeMemberId: carol.id,
    });
    assert.match(moved, /新的执行/);
    assert.equal(team.getTask(task.id).assigneeMemberId, carol.id);

    // 已经 ready 的任务换不动
    const readyTask = team.listTasks(room.id).find((item) => item.title === 'A1')!;
    await assert.rejects(
      team.reassignTask({ conversationId: room.id, memberId: alice.id, taskId: readyTask.id, assigneeMemberId: carol.id }),
      /不能重新分派/,
    );

    // 换给同一个人是 no-op
    assert.equal(
      (await team.reassignTask({
        conversationId: room.id,
        memberId: alice.id,
        taskId: task.id,
        assigneeMemberId: carol.id,
      })),
      `任务「${task.title}」已分派给新的执行 Member`,
    );

    // 非 Lead 不能换
    await assert.rejects(
      team.reassignTask({ conversationId: room.id, memberId: bob.id, taskId: task.id, assigneeMemberId: bob.id }),
      /只有负责这个工作的 Lead/,
    );
    // 不在工作区里的人不能接
    const stranger = team.createMember({ name: 'Task Stranger', role: 'X' });
    await assert.rejects(
      team.reassignTask({ conversationId: room.id, memberId: alice.id, taskId: task.id, assigneeMemberId: stranger.id }),
      /不属于 conversation/,
    );

    await waitForConversationIdle(room.id);
  });

  it('跑起来 / 跑完的任务换不动执行人', async () => {
    stub.reset();
    const room = team.createConversation({
      kind: 'task',
      title: 'ReassignRunning',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([bob.id]);
    try {
      await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '换跑起来的',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
      });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (team.listTasks(room.id)[0]?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const task = team.listTasks(room.id)[0];
      assert.equal(task.status, 'running');
      await assert.rejects(
        team.reassignTask({ conversationId: room.id, memberId: alice.id, taskId: task.id, assigneeMemberId: alice.id }),
        /不能重新分派/,
      );
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      await waitForConversationIdle(room.id);
      assert.equal(team.getTask(task.id).status, 'completed');
      await assert.rejects(
        team.reassignTask({ conversationId: room.id, memberId: alice.id, taskId: task.id, assigneeMemberId: alice.id }),
        /不能重新分派/,
      );
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      stub.reset();
    }
  });

  it('Task 全部完成直接 completed，不唤醒 Lead', async () => {
    stub.reset();
    const room = team.createConversation({
      kind: 'task',
      title: 'NoLeadReview',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: alice.id,
      objective: '顺利完成',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: bob.id }],
    });
    await waitForConversationIdle(room.id);

    assert.equal(team.listTasks(room.id)[0].status, 'completed');
    assert.equal(team.getConversation(room.id).status, 'completed');
    const leadRuns = db
      .prepare(`SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ?`)
      .get(room.id, alice.id) as unknown as { n: number };
    assert.equal(leadRuns.n, 0, 'Task 完成是正常进展，不该把 Lead 叫起来回顾');
  });

  it('建工作区时 Lead 主动先开口，不用等用户说话', async () => {
    const room = team.createConversation(
      {
        kind: 'task',
        title: 'Proactive',
        memberIds: [alice.id, bob.id],
        leadMemberId: alice.id,
      },
      { autoStartLead: true },
    );
    // 开场 system 消息先落库（Lead 这一轮的触发消息）
    const opener = team.listMessages(room.id, 10)[0];
    assert.equal(opener.senderType, 'system');

    await waitForConversationIdle(room.id);
    // Lead 被唤醒并说了话
    const leadRuns = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_message'`,
      )
      .get(room.id, alice.id) as unknown as { n: number };
    assert.ok(leadRuns.n >= 1, 'Lead 建完就该被唤醒');
    const messages = team.listMessages(room.id, 10);
    assert.ok(
      messages.some((message) => message.senderType === 'member' && message.senderId === alice.id),
      'Lead 应该主动说第一句话',
    );
  });
});
