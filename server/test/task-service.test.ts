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

  it('blocked 任务让工作区进入 blocked，重试后继续', async () => {
    const room = team.createConversation({
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
