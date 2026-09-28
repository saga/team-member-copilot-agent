import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopilotService } from '../copilot.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-mention-test-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack } = await import('./support.js');
const { findMentionedMembers } = await import('../member-mentions.js');

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);

async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution
         WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_for_member')`,
      )
      .get(conversationId) as unknown as { n: number };
    if (row.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('conversation 未进入 idle');
}

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('User @mention routing', () => {
  it('明确 @Member 时直接唤醒被点名 Member，不经过 Lead', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Mention Lead', role: 'Lead' });
    const architect = team.createMember({ name: 'Mention Architect', role: 'Architect' });
    const conversation = team.createConversation({
      kind: 'task',
      title: 'Mention routing',
      memberIds: [lead.id, architect.id],
      leadMemberId: lead.id,
    });

    const result = await team.sendMessage({
      conversationId: conversation.id,
      content: `@${architect.handle} 你怎么看这个方案？`,
    });
    assert.equal(result.wakes.length, 1);
    assert.equal(result.wakes[0].memberId, architect.id);
    assert.equal(result.wakes[0].reason, 'user_mention');

    await waitForConversationIdle(conversation.id);

    const rows = db
      .prepare(
        `SELECT member_id, wake_reason, kind FROM execution
         WHERE conversation_id = ? ORDER BY created_at`,
      )
      .all(conversation.id) as unknown as Array<{
      member_id: string;
      wake_reason: string | null;
      kind: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].member_id, architect.id);
    assert.equal(rows[0].wake_reason, 'user_mention');
    assert.equal(rows[0].kind, 'interactive');

    const messages = team.listMessages(conversation.id);
    assert.ok(
      messages.some(
        (message) =>
          message.senderType === 'member' &&
          message.senderId === architect.id &&
          message.content.includes('reply from'),
      ),
      '直接 mention 的 Member 必须把回答写回 Conversation',
    );
  });

  it('@多个 Member 时并行唤醒多个 Member', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Multi Lead', role: 'Lead' });
    const architect = team.createMember({ name: 'Multi Architect', role: 'Architect' });
    const reviewer = team.createMember({ name: 'Multi Reviewer', role: 'Reviewer' });
    const conversation = team.createConversation({
      kind: 'task',
      title: 'Multiple mentions',
      memberIds: [lead.id, architect.id, reviewer.id],
      leadMemberId: lead.id,
    });

    const result = await team.sendMessage({
      conversationId: conversation.id,
      content: `@${architect.handle} @${reviewer.handle} 请分别看一下这个设计。`,
    });
    assert.equal(result.wakes.length, 2);
    assert.deepEqual(
      new Set(result.wakes.map((wake) => wake.memberId)),
      new Set([architect.id, reviewer.id]),
    );
    assert.ok(result.wakes.every((wake) => wake.reason === 'user_mention'));

    await waitForConversationIdle(conversation.id);

    const rows = db
      .prepare(
        `SELECT member_id, wake_reason FROM execution WHERE conversation_id = ? ORDER BY created_at`,
      )
      .all(conversation.id) as unknown as Array<{ member_id: string; wake_reason: string | null }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      new Set(rows.map((row) => row.member_id)),
      new Set([architect.id, reviewer.id]),
    );
  });

  it('没有匹配到有效 @Member 时继续走 Lead', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Fallback Lead', role: 'Lead' });
    const architect = team.createMember({ name: 'Fallback Architect', role: 'Architect' });
    const conversation = team.createConversation({
      kind: 'task',
      title: 'Fallback',
      memberIds: [lead.id, architect.id],
      leadMemberId: lead.id,
    });

    const result = await team.sendMessage({
      conversationId: conversation.id,
      content: '@does-not-exist 这个方案怎么看？',
    });
    assert.equal(result.wakes.length, 1);
    assert.equal(result.wakes[0].memberId, lead.id);
    assert.equal(result.wakes[0].reason, 'lead_message');

    await waitForConversationIdle(conversation.id);

    const rows = db
      .prepare(
        `SELECT member_id, wake_reason FROM execution WHERE conversation_id = ? ORDER BY created_at`,
      )
      .all(conversation.id) as unknown as Array<{ member_id: string; wake_reason: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].member_id, lead.id);
    assert.equal(rows[0].wake_reason, 'lead_message');
  });

  it('被静音的 Member 即使被 @ 也不会被唤醒（muted 不能绕过）', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Muted Lead', role: 'Lead' });
    const architect = team.createMember({ name: 'Muted Architect', role: 'Architect' });
    const conversation = team.createConversation({
      kind: 'task',
      title: 'Muted mention',
      memberIds: [lead.id, architect.id],
      leadMemberId: lead.id,
    });
    team.setMemberMuted(conversation.id, architect.id, true);

    const result = await team.sendMessage({
      conversationId: conversation.id,
      content: `@${architect.handle} 看一下？`,
    });
    assert.equal(result.wakes.length, 0);
    await waitForConversationIdle(conversation.id);
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ?`)
      .get(conversation.id) as unknown as { n: number };
    assert.equal(rows.n, 0);
  });
});

describe('findMentionedMembers：只认 @handle', () => {
  it('邮箱 / 普通文本里的 @ 不算 mention，大小写不敏感，重复去重', async () => {
    const architect = team.createMember({ name: 'Parse Architect', role: 'Architect' });
    const reviewer = team.createMember({ name: 'Parse Reviewer', role: 'Reviewer' });
    const members = [architect, reviewer];

    assert.deepEqual(findMentionedMembers('请发到 foo@bar.com 再说', members), []);
    assert.deepEqual(findMentionedMembers('这个方案很好', members), []);
    assert.deepEqual(
      findMentionedMembers(`@${architect.handle.toUpperCase()} 看一下`, members).map((m) => m.id),
      [architect.id],
    );
    assert.deepEqual(
      findMentionedMembers(`@${architect.handle} @${architect.handle} 再看一眼`, members).map(
        (m) => m.id,
      ),
      [architect.id],
    );
    assert.deepEqual(findMentionedMembers('@nobody 在吗', members), []);
  });

  it('非 active 成员即使 handle 对上也不唤醒', async () => {
    const ghost = team.createMember({ name: 'Parse Ghost', role: 'Ghost' });
    memberService.archive(ghost.id);
    // archive 之后重读：入参是当时那一刻的 Member 行，不是创建时的快照。
    const members = [memberService.get(ghost.id), team.createMember({ name: 'Parse Live', role: 'Live' })];
    assert.deepEqual(findMentionedMembers(`@${ghost.handle} 在吗`, members), []);
  });
});
