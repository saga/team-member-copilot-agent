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

  it('@多个 Member 时按用户输入顺序串行回答，后面的 Member 看到前面的回答', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Multi Lead', role: 'Lead' });
    const security = team.createMember({ name: 'Multi Security', role: 'Security Reviewer' });
    const engineer = team.createMember({ name: 'Multi Engineer', role: 'Software Engineer' });
    const conversation = team.createConversation({
      kind: 'task',
      title: 'Ordered mentions',
      memberIds: [lead.id, security.id, engineer.id],
      leadMemberId: lead.id,
    });

    const result = await team.sendMessage({
      conversationId: conversation.id,
      content:
        `@${security.handle} @${engineer.handle} ` + '分别从安全和工程实现角度看看这个设计。',
    });
    // 第一次只启动 Security。
    assert.equal(result.wakes.length, 1);
    assert.equal(result.wakes[0].memberId, security.id);
    assert.equal(result.wakes[0].reason, 'user_mention');

    await waitForConversationIdle(conversation.id);

    const executions = db
      .prepare(
        `SELECT id, member_id, wake_reason, status, trigger_message_sequence FROM execution
         WHERE conversation_id = ? ORDER BY created_at`,
      )
      .all(conversation.id) as unknown as Array<{
      id: string;
      member_id: string;
      wake_reason: string;
      status: string;
      trigger_message_sequence: number | null;
    }>;
    // 不应该有 Lead execution。
    assert.equal(
      executions.some((execution) => execution.member_id === lead.id),
      false,
    );
    assert.equal(executions.length, 2);
    assert.deepEqual(
      executions.map((execution) => execution.member_id),
      [security.id, engineer.id],
    );
    assert.ok(executions.every((execution) => execution.wake_reason === 'user_mention'));
    // 两轮必须属于同一条 User message。
    assert.equal(executions[0].trigger_message_sequence, executions[1].trigger_message_sequence);

    // 最关键的断言：Engineer 的 prompt 必须看到 Security 已经产生的回答。
    const engineerExecution = executions.find(
      (execution) => execution.member_id === engineer.id,
    );
    assert.ok(engineerExecution);
    const engineerTurn = stub.turnFor(engineerExecution.id);
    assert.match(engineerTurn.prompt, /reply from Multi Security/);

    const messages = team.listMessages(conversation.id);
    assert.ok(messages.some((message) => message.senderId === security.id));
    assert.ok(messages.some((message) => message.senderId === engineer.id));
  });

  it('mention 顺序严格跟随用户输入，而不是 conversation roster 顺序', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Order Lead', role: 'Lead' });
    const security = team.createMember({ name: 'Order Security', role: 'Security Reviewer' });
    const engineer = team.createMember({ name: 'Order Engineer', role: 'Software Engineer' });
    const conversation = team.createConversation({
      kind: 'task',
      title: 'Mention order',
      // roster 故意反过来
      memberIds: [lead.id, engineer.id, security.id],
      leadMemberId: lead.id,
    });

    const result = await team.sendMessage({
      conversationId: conversation.id,
      content: `@${security.handle} ` + `@${engineer.handle} 看一下。`,
    });
    assert.equal(result.wakes.length, 1);
    assert.equal(result.wakes[0].memberId, security.id);

    await waitForConversationIdle(conversation.id);

    const rows = db
      .prepare(
        `SELECT member_id FROM execution
         WHERE conversation_id = ? AND wake_reason = 'user_mention' ORDER BY created_at`,
      )
      .all(conversation.id) as unknown as Array<{ member_id: string }>;
    assert.deepEqual(
      rows.map((row) => row.member_id),
      [security.id, engineer.id],
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

describe('Bootstrap 竞态：用户消息取消自动首轮', () => {
  it('用户第一次消息到达时，会取消仍在运行的 Lead bootstrap，避免旧 Lead 回复混入', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Bootstrap Lead', role: 'Lead' });
    const engineer = team.createMember({ name: 'Bootstrap Engineer', role: 'Engineer' });
    const conversation = team.createConversation(
      {
        kind: 'task',
        title: 'Bootstrap race',
        memberIds: [lead.id, engineer.id],
        leadMemberId: lead.id,
      },
      { autoStartLead: true },
    );

    // 把 bootstrap Lead turn 稳定挂住。
    // 共享 stub 没有 cancelTurn（真引擎才有 abort）：临时补一个「找到但
    // 停不掉」的实现，cancel 发得出信号，收尾时自己看到信号停下来。
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([lead.id]);
    const stubAny = stub as unknown as { cancelTurn?: unknown };
    const originalCancelTurn = stubAny.cancelTurn;
    stubAny.cancelTurn = async () => ({ found: false, aborted: false, idle: false });
    try {
      // 等到 bootstrap execution 真正开始。
      for (let i = 0; i < 300; i += 1) {
        const row = db
          .prepare(
            `SELECT id FROM execution
             WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_bootstrap'
             AND status IN ('running', 'queued') LIMIT 1`,
          )
          .get(conversation.id, lead.id) as unknown as { id: string } | undefined;
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const bootstrap = db
        .prepare(
          `SELECT id, status FROM execution
           WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'lead_bootstrap'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(conversation.id, lead.id) as unknown as { id: string; status: string } | undefined;
      assert.ok(bootstrap, 'bootstrap execution 必须先跑起来');

      const result = await team.sendMessage({
        conversationId: conversation.id,
        content: `@${engineer.handle} 你是谁？`,
      });
      assert.equal(result.wakes.length, 1);
      assert.equal(result.wakes[0].memberId, engineer.id);
      assert.equal(result.wakes[0].reason, 'user_mention');

      // Lead bootstrap 已经被取消。
      const cancelledBootstrap = db.prepare(`SELECT status FROM execution WHERE id = ?`).get(
        bootstrap.id,
      ) as unknown as { status: string };
      assert.equal(cancelledBootstrap.status, 'cancelled');

      // 释放 Lead，确保 cancellation race 真正收口。
      release();
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
      if (originalCancelTurn === undefined) delete stubAny.cancelTurn;
      else stubAny.cancelTurn = originalCancelTurn;
    }
    await waitForConversationIdle(conversation.id);

    const executions = db
      .prepare(
        `SELECT member_id, wake_reason FROM execution WHERE conversation_id = ? ORDER BY created_at`,
      )
      .all(conversation.id) as unknown as Array<{ member_id: string; wake_reason: string }>;
    // 只允许 cancelled bootstrap + engineer mention，不能再出现第二个 Lead execution。
    assert.equal(executions.length, 2);
    assert.deepEqual(
      executions.map((item) => item.member_id),
      [lead.id, engineer.id],
    );
    assert.equal(executions[0].wake_reason, 'lead_bootstrap');
    assert.equal(executions[1].wake_reason, 'user_mention');
  });

  it('@非 Lead Member 时不能把 waiting_user 清掉', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Waiting Lead', role: 'Lead' });
    const engineer = team.createMember({ name: 'Waiting Engineer', role: 'Engineer' });
    const conversation = team.createConversation({
      kind: 'task',
      title: 'Waiting mention',
      memberIds: [lead.id, engineer.id],
      leadMemberId: lead.id,
    });

    await team.requestClarification({
      conversationId: conversation.id,
      memberId: lead.id,
      questions: ['具体目标是什么？'],
      assumptions: [],
      summary: '需要明确目标',
    });
    assert.equal(team.getConversation(conversation.id).status, 'waiting_user');

    await team.sendMessage({
      conversationId: conversation.id,
      content: `@${engineer.handle} 你是谁？`,
    });
    await waitForConversationIdle(conversation.id);

    const after = team.getConversation(conversation.id);
    assert.equal(after.status, 'waiting_user');
    assert.deepEqual(after.openQuestions, ['具体目标是什么？']);
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
