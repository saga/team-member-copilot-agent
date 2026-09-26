import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversationMessage, Member } from '../domain.js';

/**
 * Group Dispatcher 语义：确定性收件人选择，不做自动接龙。
 *
 * 十条缺一不可，其中第 7、9 是这一轮最关键的两条 —— 它们钉死
 * 「Member 发言不会自动唤醒别人」，Member 之间的协作只能走
 * ask_member / message_member 这两个显式入口。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-dispatch-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { GroupDispatcher } = await import('../group-dispatcher.js');
const { ConversationMemberService } = await import('../conversation-member-service.js');
const { StubCopilot, createTestStack } = await import('./support.js');

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot);
const states = new ConversationMemberService(db);

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function newMember(name: string): Member {
  seq += 1;
  return team.createMember({ name: `${name}${seq}`, role: 'Analyst' });
}

function userMessage(content: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: `msg-${seq}-${Math.random().toString(36).slice(2)}`,
    conversationId: '',
    messageSequence: 1,
    senderType: 'user',
    senderId: 'user',
    targetMemberId: null,
    replyToMessageId: null,
    clientRequestId: null,
    content,
    executionId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('GroupDispatcher.plan', () => {
  it('1. direct → 唯一的 Member', () => {
    const alice = newMember('Solo');
    const conversation = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({ conversation, message: userMessage('你好') });
    assert.equal(plan.wakes.length, 1);
    assert.equal(plan.wakes[0].memberId, alice.id);
    assert.equal(plan.wakes[0].reason, 'direct');
  });

  it('2. work → 唯一的 Member', () => {
    const alice = newMember('Worker');
    const conversation = team.createConversation({ kind: 'work', memberIds: [alice.id] });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({ conversation, message: userMessage('开工') });
    assert.equal(plan.wakes.length, 1);
    assert.equal(plan.wakes[0].memberId, alice.id);
    assert.equal(plan.wakes[0].reason, 'direct');
  });

  it('3. group + targetMemberId → 指定的人', () => {
    const alice = newMember('GA');
    const bob = newMember('GB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({
      conversation,
      message: userMessage('就你了', { targetMemberId: bob.id }),
    });
    assert.equal(plan.wakes.length, 1);
    assert.equal(plan.wakes[0].memberId, bob.id);
    assert.equal(plan.wakes[0].reason, 'direct');
  });

  it('4. group + @mention → 被点到的人', () => {
    const alice = newMember('MA');
    const bob = newMember('MB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({
      conversation,
      message: userMessage(`@${bob.handle} 你怎么看`),
    });
    assert.equal(plan.wakes.length, 1);
    assert.equal(plan.wakes[0].memberId, bob.id);
    assert.equal(plan.wakes[0].reason, 'mention');
  });

  it('5. group + @ 了不存在的人 → 谁也不唤醒', () => {
    const alice = newMember('UA');
    const bob = newMember('UB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({
      conversation,
      message: userMessage('@nobody 在吗'),
    });
    assert.deepEqual(plan.wakes, []);
    assert.deepEqual(plan.unresolvedMentions, ['nobody']);
  });

  it('6. group + 用户无 mention → 全体 everyone', () => {
    const alice = newMember('EA');
    const bob = newMember('EB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({
      conversation,
      message: userMessage('大家看一下这个方案'),
    });
    assert.equal(plan.wakes.length, 2);
    for (const wake of plan.wakes) {
      assert.equal(wake.reason, 'everyone');
    }
  });

  it('7. group + Member 无 mention → 谁也不唤醒（不自动接龙）', () => {
    const alice = newMember('NA');
    const bob = newMember('NB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({
      conversation,
      message: userMessage('我的回复', {
        senderType: 'member',
        senderId: alice.id,
      }),
      authorMemberId: alice.id,
    });
    assert.deepEqual(plan.wakes, []);
  });

  it('8. 被静音的成员不被唤醒', () => {
    const alice = newMember('SA');
    const bob = newMember('SB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    team.setMemberMuted(conversation.id, bob.id, true);
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({
      conversation,
      message: userMessage('大家看一下'),
    });
    assert.equal(plan.wakes.length, 1);
    assert.equal(plan.wakes[0].memberId, alice.id);
  });

  it('9. Member A 的回复不会自动唤醒 B（端到端：落库 + 跑完一轮）', async () => {
    const alice = newMember('CA');
    const bob = newMember('CB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });

    const trigger = await team.sendMessage({
      conversationId: conversation.id,
      content: 'Alice 先看',
      targetMemberId: alice.id,
    });
    assert.equal(trigger.wakes.length, 1);

    for (let attempt = 0; attempt < 300; attempt += 1) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND status IN ('queued','running','waiting_for_member')`,
        )
        .get(conversation.id) as unknown as { n: number };
      if (row.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const memberTriggered = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution e
         JOIN conversation_message m ON m.conversation_id = e.conversation_id
           AND m.message_sequence = e.trigger_message_sequence
         WHERE e.conversation_id = ? AND m.sender_type = 'member'`,
      )
      .get(conversation.id) as unknown as { n: number };
    assert.equal(memberTriggered.n, 0, '没有任何一轮是由 Member 的发言触发的');
  });

  it('10. Member A @B → B 被唤醒（显式点名永远有效）', () => {
    const alice = newMember('PA');
    const bob = newMember('PB');
    const conversation = team.createConversation({
      kind: 'group',
      memberIds: [alice.id, bob.id],
    });
    const dispatcher = new GroupDispatcher(states);

    const plan = dispatcher.plan({
      conversation,
      message: userMessage(`@${bob.handle} 确认一下`, {
        senderType: 'member',
        senderId: alice.id,
      }),
      authorMemberId: alice.id,
    });
    assert.equal(plan.wakes.length, 1);
    assert.equal(plan.wakes[0].memberId, bob.id);
    assert.equal(plan.wakes[0].reason, 'mention');
  });
});
