import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-orch-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack, reportTaskTurns } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);
// Task turn 内调 update_task(completed)，任务能正常跑完。
reportTaskTurns(team, stub);

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

describe('TaskOrchestrator：同 Member 一轮只 reserve 一个 ready task', () => {
  it('only one ready task per member is reserved', async () => {
    stub.reset();
    const alice = team.createMember({ name: 'Orch Alice', role: 'Lead' });
    const bob = team.createMember({ name: 'Orch Bob', role: 'Engineer' });
    const room = team.createConversation({
      kind: 'task',
      title: 'Reserve',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });

    // 按住 bob：第一个任务钉在 running，看第二个进不进得来。
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([bob.id]);
    try {
      const planned = await team.planTasks({
        conversationId: room.id,
        memberId: alice.id,
        objective: '两个并行任务',
        requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
        tasks: [
          { key: 'a', title: 'A', assigneeMemberId: bob.id },
          { key: 'b', title: 'B', assigneeMemberId: bob.id },
        ],
      });
      // startReadyTasks 的返回值：同一个人一次只 reserve 一个。
      assert.match(planned, /1 个已开始执行/);
      // 等第一个真正跑起来。
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const running = team
          .listTasks(room.id)
          .filter((task) => task.status === 'running' && task.currentExecutionId);
        if (running.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const started = team
        .listTasks(room.id)
        .filter((task) => task.assigneeMemberId === bob.id && task.currentExecutionId);
      assert.equal(started.length, 1, '同一轮只 reserve 一个，同一个人不能同时跑两个');
      const waiting = team
        .listTasks(room.id)
        .filter((task) => task.assigneeMemberId === bob.id && !task.currentExecutionId);
      assert.equal(waiting.length, 1, '另一个在 ready 里等着，不丢');

      release();
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
    }
    await waitForConversationIdle(room.id);
    // 第一个跑完，onTaskChanged 把第二个推进来，两个都做完。
    assert.ok(
      team.listTasks(room.id).every((task) => task.status === 'completed'),
      '第一个完成后第二个自动进来，不烂在 ready',
    );
  });
});
