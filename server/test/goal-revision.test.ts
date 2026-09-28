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
