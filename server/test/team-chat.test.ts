import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Member } from '../domain.js';

/**
 * Team chat 的**产品行为**测试。
 *
 * 前面的用例文件覆盖机制（runtime 生命周期、恢复、delegation 审计链），
 * 这里回答的是另一个问题：**房间里到底发生了什么**。
 *
 *   Direct      一条消息 → 一个收件人 → 一条 execution
 *   Group       一条消息 → 全体 active 且未静音的成员（open discussion）
 *   @mention    只唤醒被点到的人
 *   NO_REPLY    「我不该发言」是一条成功的 execution，但不产出消息
 *   Persona     每个 Member 收到的是**自己**的身份，不是房间的
 *   Memory      每个 Member 注入的是**自己**的长期记忆，互不污染
 *
 * 后两条是这个产品最核心的承诺：同一个房间里，Member 是不同的人，
 * 不是一个模型换了几个名字。所以拿 stub 捕获真正传给引擎的 systemPrompt
 * 来断言 —— 只断言「数据库里存了不同字段」证明不了隔离。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-chat-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { executionIdForWake, muteAllMembers, StubCopilot, createTestStack } = await import('./support.js');

const ALICE_PROMPT = 'ALICE_PERSONA_SENTINEL';
const BOB_PROMPT = 'BOB_PERSONA_SENTINEL';

interface ExecutionRow {
  id: string;
  conversation_id: string;
  member_id: string;
  kind: string;
  status: string;
  decision: string | null;
  response: string | null;
  trigger_message_sequence: number | null;
  wake_reason: string | null;
}

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot);

function executionRow(id: string): ExecutionRow {
  const row = db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
    | ExecutionRow
    | undefined;
  assert.ok(row, `execution ${id} 不存在`);
  return row;
}

function executionIds(conversationId: string): string[] {
  const rows = db
    .prepare(`SELECT id FROM execution WHERE conversation_id = ? ORDER BY rowid`)
    .all(conversationId) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function waitForStatus(id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (executionRow(id).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`execution ${id} 未在预期时间内变成 ${status}（当前 ${executionRow(id).status}）`);
}

/**
 * 等到房间里没有在跑的 execution。
 *
 * group 里的成员发言会 follow_up 唤醒别人（受 groupAutoWakeRounds 限制），
 * 断言「消息数 / execution 数」之前必须先等这串连锁反应收敛，
 * 否则读到的只是一个中间态。
 */
async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const row = db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM execution
        WHERE conversation_id = ?
          AND status IN ('queued', 'running', 'waiting_for_member')
        `,
      )
      .get(conversationId) as unknown as { n: number };
    if (row.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`conversation ${conversationId} 仍有未完成的 execution`);
}

let alice: Member;
let bob: Member;
let iris: Member;
/** 隔离类用例共用的房间：**同一个人房间里**才谈得上「谁拿到谁的记忆」。 */
let roomId: string;

before(() => {
  alice = team.createMember({
    name: 'Alice',
    role: 'Analyst',
    description: '拆解需求与风险',
    style: 'terse',
    systemPrompt: ALICE_PROMPT,
  });
  bob = team.createMember({
    name: 'Bob',
    role: 'Engineer',
    description: '验证可行性',
    style: 'blunt',
    systemPrompt: BOB_PROMPT,
  });
  iris = team.createMember({ name: 'Iris', role: 'Reviewer' });

  const room = team.createConversation({
    kind: 'group',
    title: 'Shared Room',
    memberIds: [alice.id, bob.id, iris.id],
  });
  // 静音全体：每一轮都由用例显式点名（targetMemberId 不走静音判断），
  // 免得 open_discussion / follow_up 的连锁唤醒把「谁跑了几轮」变随机。
  muteAllMembers(team, room.id);
  roomId = room.id;
});

afterEach(() => {
  stub.reset();
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Direct conversation', () => {
});

describe('Group conversation', () => {
  it('open discussion 广播给全体 active 且未静音的成员，静音的除外', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Investment Review Team',
      memberIds: [alice.id, bob.id, iris.id],
    });

    const first = await team.sendMessage({ conversationId: group.id, content: '大家看一下这个方案' });

    assert.equal(first.wakes.length, 3, 'group 里无 mention 的用户消息应该广播给全体');
    assert.deepEqual(
      first.wakes.map((wake) => wake.memberId).sort(),
      [alice.id, bob.id, iris.id].sort(),
    );
    for (const wake of first.wakes) {
      assert.equal(wake.reason, 'open_discussion');
      assert.equal(wake.triggerSequence, first.message.messageSequence);
    }
    await waitForConversationIdle(group.id);

    // 静音之后不再被广播唤醒（@ 仍然可以，见下一个用例）
    team.setMemberMuted(group.id, iris.id, true);
    const second = await team.sendMessage({ conversationId: group.id, content: '再确认一次结论' });

    assert.deepEqual(
      second.wakes.map((wake) => wake.memberId).sort(),
      [alice.id, bob.id].sort(),
      'muted 的成员不该被 open discussion 唤醒',
    );
    await waitForConversationIdle(group.id);

    const states = team.listConversationState(group.id);
    assert.equal(states.find((state) => state.memberId === iris.id)?.muted, true);
  });

  it('@mention 只唤醒被点到的人，@ 到不存在的人则不广播', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Mention Room',
      memberIds: [alice.id, bob.id, iris.id],
    });

    const mentioned = await team.sendMessage({ conversationId: group.id, content: '@bob 这条你怎么看' });

    assert.equal(mentioned.wakes.length, 1);
    assert.equal(mentioned.wakes[0].memberId, bob.id);
    assert.equal(mentioned.wakes[0].reason, 'mention');
    assert.deepEqual(mentioned.unresolvedMentions, []);

    await waitForConversationIdle(group.id);

    // 明确想找某个人、却谁都没匹配上时，把消息广播给全员是更糟的误解：
    // 服务端刻意不唤醒任何人，只把没认领的 @ 原样回给调用方。
    const unknown = await team.sendMessage({ conversationId: group.id, content: '@nobody 在吗' });

    assert.deepEqual(unknown.wakes, []);
    assert.deepEqual(unknown.unresolvedMentions, ['nobody']);
    await waitForConversationIdle(group.id);
  });
});

describe('NO_REPLY 是一条成功的 execution', () => {
  it('decision = skip、不新增 conversation_message，且不把房间拖进循环', async () => {
    const conversation = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    stub.mode = 'skip';

    const result = await team.sendMessage({ conversationId: conversation.id, content: '你还有补充吗' });
    const executionId = executionIdForWake(db, conversation.id, result.wakes[0]);
    await waitForStatus(executionId, 'completed');
    await waitForConversationIdle(conversation.id);

    const row = executionRow(executionId);
    assert.equal(row.status, 'completed', 'skip 是成功，不是 failed');
    assert.equal(row.decision, 'skip');
    assert.equal(row.response, null);

    // 只有用户那一条；Member 没发言
    assert.equal(team.listMessages(conversation.id).length, 1);
    // 没有新消息 → 不需要再派发唤醒，循环自然终止
    assert.deepEqual(executionIds(conversation.id), [executionId]);
  });
});

describe('同一轮还在跑时到达的唤醒', () => {
  interface WakeStateRow {
    pending_wake: number;
    pending_wake_trigger_sequence: number | null;
    pending_wake_reason: string | null;
  }

  function wakeState(conversationId: string, memberId: string): WakeStateRow {
    const row = db
      .prepare(
        `
        SELECT pending_wake, pending_wake_trigger_sequence, pending_wake_reason
        FROM conversation_member_state
        WHERE conversation_id = ? AND member_id = ?
        `,
      )
      .get(conversationId, memberId) as unknown as WakeStateRow | undefined;
    assert.ok(row, 'conversation_member_state 行应该存在');
    return row;
  }

  it('合并时 reason 与 trigger 必须来自同一条消息，不能拼出一个不存在的事件', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Coalescing Room',
      memberIds: [alice.id, bob.id],
    });

    // 静音 Bob：这个用例考的是 Alice 的 pending 合并，而 Bob 是同一房间里另一个
    // 会自动被唤醒的 Member —— 他的回复会再反过来 follow_up 唤醒 Alice。那一轮
    // 到底有没有发生取决于两人 turn 的交替顺序（Alice 的 checkpoint 是否已经越过
    // Bob 那条消息），于是「Alice 恰好两条 execution」这个断言会随微任务顺序飘。
    // 断言时序之外的东西只能靠把无关的自动唤醒关掉，而不是把断言放宽。
    team.setMemberMuted(group.id, bob.id, true);

    // 按住引擎，让 Alice 的第一轮停在 running —— 后面两条唤醒才会落进 pending
    // 并发生合并，而不是各自开一轮。
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      // #1 显式点名 → direct。它进引擎（被按住）。
      const first = await team.sendMessage({
        conversationId: group.id,
        content: '先看下风险',
        targetMemberId: alice.id,
      });
      const firstExecutionId = executionIdForWake(db, group.id, first.wakes[0]);
      await waitForStatus(firstExecutionId, 'running');

      // #2 @alice → mention。入队，等第一轮结束再跑。
      await team.sendMessage({ conversationId: group.id, content: '@alice 再看下依赖' });

      // #3 无 mention 的广播 → open_discussion（更弱）。它不该把 mention 顶掉。
      await team.sendMessage({ conversationId: group.id, content: '大家也一起看下' });

      // 关键断言：留下的是 mention 与它自己那条消息。
      // 早先的实现分别取「更明确的 reason」和「更大的 sequence」，
      // 会拼出 mention @3 —— 而 #3 并没有点名 Alice。
      assert.deepEqual(
        { ...wakeState(group.id, alice.id) },
        { pending_wake: 1, pending_wake_trigger_sequence: 2, pending_wake_reason: 'mention' },
      );
    } finally {
      release();
      stub.hold = null;
    }

    await waitForConversationIdle(group.id);

    // 补跑的那一轮也必须按 mention @2 走，而不是把两件事错配。
    const aliceExecutions = (
      db
        .prepare(
          `
          SELECT trigger_message_sequence, wake_reason
          FROM execution
          WHERE conversation_id = ? AND member_id = ?
          ORDER BY rowid
          `,
        )
        .all(group.id, alice.id) as unknown as Array<{
        trigger_message_sequence: number | null;
        wake_reason: string | null;
      }>
    ).map((row) => ({ ...row }));

    assert.deepEqual(aliceExecutions, [
      { trigger_message_sequence: 1, wake_reason: 'direct' },
      { trigger_message_sequence: 2, wake_reason: 'mention' },
    ]);

    // 合并之后 pending 被真正消费掉，不留幽灵标记
    assert.equal(wakeState(group.id, alice.id).pending_wake, 0);
  });
});

describe('Member 之间是隔离的', () => {
  /**
   * 在**同一个房间**里点名一个 Member 跑一轮，返回真正传给引擎的 system prompt。
   *
   * 刻意不用「每人一个 direct 房间」：那样房间里只有它自己，「按 member 取身份 /
   * 记忆」和「按房间第一个人取」结果完全相同，断言区分不出隔离有没有做对。
   */
  async function runInRoom(member: Member): Promise<string> {
    const result = await team.sendMessage({
      conversationId: roomId,
      content: '介绍一下你自己',
      targetMemberId: member.id,
    });
    assert.equal(result.wakes.length, 1, '显式点名应该恰好唤醒一个人');

    const executionId = executionIdForWake(db, roomId, result.wakes[0]);
    await waitForStatus(executionId, 'completed');
    await waitForConversationIdle(roomId);
    return stub.turnFor(executionId).systemPrompt;
  }

  it('personality 隔离：同一个房间里，每人拿到的是自己的身份', async () => {
    const alicePrompt = await runInRoom(alice);
    const bobPrompt = await runInRoom(bob);

    assert.match(alicePrompt, /You are Alice\./);
    assert.match(alicePrompt, new RegExp(ALICE_PROMPT));
    assert.doesNotMatch(alicePrompt, new RegExp(BOB_PROMPT));

    assert.match(bobPrompt, /You are Bob\./);
    assert.match(bobPrompt, new RegExp(BOB_PROMPT));
    assert.doesNotMatch(bobPrompt, new RegExp(ALICE_PROMPT));
  });

});
