import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-exp-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { ExperienceStore } = await import('../experience-store.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack, reportTaskTurns, singleExecutionId } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function freshStore(): { store: InstanceType<typeof ExperienceStore>; teamId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-exp-store-'));
  return { store: new ExperienceStore(root), teamId: 'team-1' };
}

describe('ExperienceStore：存与取', () => {
  it('保存一条经验，字段齐全', () => {
    const { store, teamId } = freshStore();
    const experience = store.add({
      memberId: 'alice',
      teamId,
      kind: 'user_feedback',
      trigger: 'jira story existing subtasks',
      lesson: '先检查现有 subtasks，再创建缺失工作',
    });
    assert.equal(experience.kind, 'user_feedback');
    // 默认只给自己，不默认全 Team 可见。
    assert.equal(experience.scope, 'member');
    assert.equal(experience.reviewStatus, 'approved');
    assert.equal(experience.createdByMemberId, 'alice');
    assert.ok(experience.id);
    assert.ok(experience.createdAt);
  });

  it('按 trigger 关键词检索到相关经验', () => {
    const { store, teamId } = freshStore();
    store.add({
      memberId: 'alice',
      teamId,
      kind: 'user_feedback',
      trigger: 'jira story existing subtasks',
      lesson: '先检查现有 subtasks，再创建缺失工作',
    });
    store.add({
      memberId: 'alice',
      teamId,
      kind: 'strategy',
      trigger: 'compliance review checklist',
      lesson: '先看数据边界，再看工具权限',
    });

    const results = store.search({
      memberId: 'alice',
      teamId,
      query: '处理 Jira Story，检查现有 Subtask',
    });
    assert.equal(results.length, 1);
    assert.match(results[0].lesson, /现有 subtasks/);
  });

  it('Team 隔离：别的 Team 检索不到', () => {
    const { store, teamId } = freshStore();
    store.add({
      memberId: 'alice',
      teamId,
      kind: 'user_feedback',
      trigger: 'jira story existing subtasks',
      lesson: '先检查现有 subtasks，再创建缺失工作',
    });

    const otherResults = store.search({ memberId: 'alice', teamId: 'other-team', query: 'Jira Story Subtask' });
    assert.equal(otherResults.length, 0);
  });

  it('Member scope 隔离：别人的私有经验检索不到', () => {
    const { store, teamId } = freshStore();
    store.add({
      memberId: 'alice',
      teamId,
      kind: 'preference',
      trigger: 'reporting',
      lesson: 'Alice prefers executive summary first',
      scope: 'member',
    });

    const bobResults = store.search({ memberId: 'bob', teamId, query: 'reporting executive summary' });
    assert.equal(bobResults.length, 0);

    const aliceResults = store.search({ memberId: 'alice', teamId, query: 'reporting executive summary' });
    assert.equal(aliceResults.length, 1);
  });

  it('同一 Team + trigger + lesson 不重复写', () => {
    const { store, teamId } = freshStore();
    const first = store.add({
      memberId: 'alice',
      teamId,
      kind: 'user_feedback',
      trigger: 'jira story',
      lesson: '先看 subtask',
    });
    const second = store.add({
      memberId: 'alice',
      teamId,
      kind: 'user_feedback',
      trigger: 'jira story',
      lesson: '先看 subtask',
    });
    assert.equal(first.id, second.id);
    assert.equal(
      store.search({ memberId: 'alice', teamId, query: 'jira story' }).length,
      1,
    );
  });
});

describe('Experience 回路：存 → 下一轮 prompt', () => {
  const stub = new StubCopilot();
  const memberService = new MemberService(db);
  const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);
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

  it('不在房间里的 Member 不能存经验', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Exp Lead', role: 'Lead' });
    const outsider = team.createMember({ name: 'Exp Outsider', role: 'X' });
    const room = team.createConversation({
      kind: 'task',
      title: 'ExpScope',
      memberIds: [lead.id],
      leadMemberId: lead.id,
    });
    await assert.rejects(
      team.learnExperience({
        conversationId: room.id,
        memberId: outsider.id,
        kind: 'strategy',
        trigger: 'x',
        lesson: 'y',
      }),
      /不属于 conversation/,
    );
    await waitForConversationIdle(room.id);
  });

  it('存下的经验自动进入下一轮 prompt，行为从此改变', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Exp Lead2', role: 'Lead' });
    const room = team.createConversation({
      kind: 'task',
      title: 'ExpLoop',
      memberIds: [lead.id],
      leadMemberId: lead.id,
    });

    // 用户纠正 → Lead 存经验（第一轮 prompt 里还没有它）。
    const first = await team.sendMessage({ actorId: 'test-user', conversationId: room.id, content: '处理 Jira Story 要小心' });
    const firstId = singleExecutionId(db, room.id, first.wakes);
    await waitForConversationIdle(room.id);
    assert.doesNotMatch(stub.turnFor(firstId).prompt, /先检查现有 subtasks/);

    const saved = await team.learnExperience({
      conversationId: room.id,
      memberId: lead.id,
      kind: 'user_feedback',
      trigger: 'Jira Story with existing subtasks',
      lesson: '先检查现有 subtasks，再判断缺失工作；不要复制已有 Subtask。',
      scope: 'team',
      confidence: 0.95,
    });
    assert.match(saved, /待.*审核/);

    // 审批前：team 候选对检索不可见。
    const pending = await team.sendMessage({ actorId: 'test-user', conversationId: room.id, content: '处理 ABC-123 这个 Jira Story' });
    const pendingId = singleExecutionId(db, room.id, pending.wakes);
    await waitForConversationIdle(room.id);
    assert.doesNotMatch(stub.turnFor(pendingId).prompt, /先检查现有 subtasks/);

    // 审批后：下一次类似任务自动检索并注入，不需要 Agent 记得检索。
    const approved = team.approveTeamExperience(
      room.teamId,
      team.listTeamExperiences(room.teamId).find((item) => item.reviewStatus === 'pending')!.id,
      'owner-1',
    );
    assert.equal(approved.reviewStatus, 'approved');

    const second = await team.sendMessage({ actorId: 'test-user', conversationId: room.id, content: '处理 ABC-123 这个 Jira Story' });
    const secondId = singleExecutionId(db, room.id, second.wakes);
    await waitForConversationIdle(room.id);
    assert.match(stub.turnFor(secondId).prompt, /先检查现有 subtasks/);
  });
});
