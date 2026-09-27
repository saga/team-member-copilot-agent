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
const { StubCopilot, createTestStack, singleExecutionId } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

void config;

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);

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
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_message'`,
        )
        .get(room.id, alice.id) as unknown as { n: number };
      assert.ok(leadRuns.n >= 1, 'Lead 应该在任务失败后被唤醒');
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

  it('blocked 的任务会自动唤醒 Lead', async () => {
    const room = team.createConversation({
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
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_message'`,
      )
      .get(room.id, alice.id) as unknown as { n: number };
    assert.ok(leadRuns.n >= 1, 'Lead 应该在任务阻塞后被唤醒');
  });
});
