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
 *   Group       一条消息 → 全体 active 且未静音的成员（open discussion），
 *               其中**恰好一人**被指定为应答者（reason=direct）
 *   @mention    只唤醒被点到的人
 *   NO_REPLY    「我不该发言」是一条成功的 execution，但不产出消息
 *   Persona     每个 Member 收到的是**自己**的身份，不是房间的
 *   Memory      每个 Member 注入的是**自己**的长期记忆，互不污染
 *
 * 后两条是这个产品最核心的承诺：同一个房间里，Member 是不同的人，
 * 不是一个模型换了几个名字。所以拿 stub 捕获真正传给引擎的 systemPrompt
 * 来断言 —— 只断言「数据库里存了不同字段」证明不了隔离。
 *
 * 「恰好一人应答」那一条是**责任扩散**的防线：全体都被允许沉默时，每个人
 * 单独看都做了合理判断，合起来是房间一个字都不回。断言必须落在「渲染给
 * 应答者的指令」上，而不只是 wakes 里的 reason —— reason 只是路由，
 * 真正改变模型行为的是它读到的那段话。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-chat-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { ConversationMemberService, asWakeReason } = await import(
  '../conversation-member-service.js'
);
const { NO_REPLY_SENTINEL } = await import('../member-decision.js');
const { MemberTurnScheduler } = await import('../member-turn-scheduler.js');
const { executionIdForWake, StubCopilot, createTestStack } = await import('./support.js');

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

/**
 * 假引擎需要知道「这一轮是被什么原因唤醒的」。
 *
 * 按原因开口的用例靠它区分「第几轮开口」—— 真实引擎是从
 * prompt 里的措辞读到这件事的，stub 直接查库更稳：断言不该绑在指令文案上，
 * 否则改一次措辞就会让一批用例变红，而它们本来想守的不是文案。
 */
stub.wakeReasonOf = (executionId) =>
  (
    db.prepare(`SELECT wake_reason FROM execution WHERE id = ?`).get(executionId) as
      | { wake_reason: string | null }
      | undefined
  )?.wake_reason ?? null;

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
 * 用户消息以 everyone 广播时会同时起好几轮，断言「消息数 / execution 数」
 * 之前必须先等它们收敛，否则读到的只是一个中间态。
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
  // 不静音：每一轮都由用例显式点名（targetMemberId 只唤醒一个人），
  // 而 Member 的回复不会自动唤醒别人，没有连锁可压。
  roomId = room.id;
});

afterEach(() => {
  stub.reset();
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Group conversation', () => {
  it('用户无 mention 的消息：全体未静音成员以 everyone 被唤醒', async () => {
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

    // 没有「应答者」：everyone 全员可以沉默，想协作走 ask_member / message_member。
    for (const wake of first.wakes) {
      assert.equal(wake.reason, 'everyone');
      assert.equal(wake.triggerSequence, first.message.messageSequence);
    }
    await waitForConversationIdle(group.id);

    // 静音之后不再被广播唤醒（@ 仍然可以，见下一个用例）
    team.setMemberMuted(group.id, iris.id, true);
    const second = await team.sendMessage({ conversationId: group.id, content: '再确认一次结论' });

    assert.deepEqual(
      second.wakes.map((wake) => wake.memberId).sort(),
      [alice.id, bob.id].sort(),
      'muted 的成员不该被 everyone 唤醒',
    );
    await waitForConversationIdle(group.id);

    const states = team.listConversationState(group.id);
    assert.equal(states.find((state) => state.memberId === iris.id)?.muted, true);
  });

  it('全员静音时，用户消息不产生任何唤醒', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'All Muted Room',
      memberIds: [alice.id, bob.id],
    });
    team.setMemberMuted(group.id, alice.id, true);
    team.setMemberMuted(group.id, bob.id, true);

    const result = await team.sendMessage({ conversationId: group.id, content: '有人吗' });

    assert.deepEqual(result.wakes, [], '全员静音时没有候选，不该凭空唤醒任何人');
    await waitForConversationIdle(group.id);
  });

  it('Member 发言不自动唤醒任何人（没有自动接龙）', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'No Chain Room',
      memberIds: [alice.id, bob.id, iris.id],
    });

    // 用户点名 Alice，让 Alice 说一句；她那句话不该再唤醒另外两人。
    const trigger = await team.sendMessage({
      conversationId: group.id,
      content: '先看下风险',
      targetMemberId: alice.id,
    });
    const aliceExecution = executionIdForWake(db, group.id, trigger.wakes[0]);
    await waitForStatus(aliceExecution, 'completed');
    await waitForConversationIdle(group.id);

    const chained = db
      .prepare(
        `
        SELECT e.member_id AS member_id, m.sender_id AS sender_id, m.sender_type AS sender_type
        FROM execution e
        JOIN conversation_message m
          ON m.conversation_id = e.conversation_id
          AND m.message_sequence = e.trigger_message_sequence
        WHERE e.conversation_id = ?
          AND m.sender_type = 'member'
        `,
      )
      .all(group.id) as unknown as Array<{
      member_id: string;
      sender_id: string;
      sender_type: string;
    }>;

    assert.equal(chained.length, 0, 'Member 的发言不该自动唤醒其他成员');
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

describe('everyone：用户对着房间说话时，人人都可以沉默', () => {
  /**
   * 这个 describe 守的是一条产品承诺：**discussion 里没有默认的接话人。**
   *
   * 用户发一条无 mention 的消息，全体以 everyone 被唤醒，每个人都拿到
   * 「没东西补就 <NO_REPLY>」的出口。房间要推进靠显式协作
   *（@mention / ask_member / message_member），不靠平台指定应答者。
   *
   * 所以这里必须断言**两件事**，缺一不可：
   *   1. 路由（wakes 里的 reason）—— 全员 everyone，没有 direct
   *   2. 指令（真正渲染给模型的那段话）—— 每个人都看到 <NO_REPLY> 出口
   */
  it('everyone 唤醒的成员拿到「可以沉默」，不拿到「必须回答」', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Addressed Room',
      memberIds: [alice.id, bob.id, iris.id],
    });

    const result = await team.sendMessage({
      conversationId: group.id,
      content: '我希望做架构设计review，应该做什么',
    });
    await waitForConversationIdle(group.id);

    assert.equal(result.wakes.length, 3);
    for (const wake of result.wakes) {
      assert.equal(wake.reason, 'everyone');
      const prompt = stub.turnFor(executionIdForWake(db, group.id, wake)).prompt;
      assert.match(
        prompt,
        new RegExp(NO_REPLY_SENTINEL.replace(/[<>]/g, '\\$&')),
        'everyone 唤醒的成员必须知道沉默是合法的，否则会重复别人的话',
      );
      assert.doesNotMatch(prompt, /expects to answer this message/);
    }
  });

  it('@mention 时只唤醒被点到的人，不广播', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Mentioned Room',
      memberIds: [alice.id, bob.id, iris.id],
    });

    const result = await team.sendMessage({ conversationId: group.id, content: '@bob 你怎么看' });

    assert.equal(result.wakes.length, 1, '@ 了人就只唤醒那个人，不广播');
    assert.equal(result.wakes[0].reason, 'mention');
    assert.equal(
      result.wakes.filter((wake) => wake.reason === 'direct').length,
      0,
      'mention 已经指名道姓，不该再叠一个 direct',
    );
    await waitForConversationIdle(group.id);
  });
});

describe('唤醒合并：更明确的理由赢', () => {
  /**
   * 这条用例守的是**合并优先级**，而不是「唤醒有没有派出去」。
   *
   * 一条更明确的唤醒可能和一条更弱的唤醒撞在同一个 (房间, 成员) 上：
   * 这个人此刻正忙，它被 `direct` 顺手指定过、还没轮到跑；这时一条 @ 到了。
   * 如果合并时 mention 输给 `direct`，那次点名就被悄悄降级成「顺带看看」。
   *
   * 这里直接构造 scheduler，而不是走 sendMessage：要考的是合并规则本身，
   * 通过消息驱动只能间接凑出这个竞态，而且结果会依赖 turn 的交替顺序。
   */
  it('mention 与更弱的唤醒相撞时 mention 必须赢（否则点名会被降级成顺带看看）', () => {
    const room = team.createConversation({
      kind: 'group',
      title: 'Mention Priority',
      memberIds: [alice.id, bob.id],
    });

    const states = new ConversationMemberService(db);
    const scheduler = new MemberTurnScheduler(
      states,
      // 永远不结束的一轮：把 alice 钉在「正在跑」上，后面两条唤醒才会落进
      // pending 并发生合并 —— 这正是真实竞态的形状。
      () => new Promise<void>(() => {}),
      () => {},
    );

    // 第一条：进引擎并被钉住，inFlight = true（pending 被 pump 取走后清空）
    scheduler.enqueue({
      conversationId: room.id,
      memberId: alice.id,
      reason: 'everyone',
      triggerSequence: 1,
    });

    // 第二条：alice 正忙 → 落进 pending，此时还没有可合并的对象
    scheduler.enqueue({
      conversationId: room.id,
      memberId: alice.id,
      reason: 'direct',
      triggerSequence: 5,
    });

    // 第三条：和第二条撞在一起 → 走 mergeWake
    scheduler.enqueue({
      conversationId: room.id,
      memberId: alice.id,
      reason: 'mention',
      triggerSequence: 5,
    });

    const pending = states.get(room.id, alice.id);
    assert.equal(pending.pendingWake, true);
    assert.equal(
      pending.pendingWakeReason,
      'mention',
      '点名必须压过 direct —— 反过来那次 @ 就被吞掉了',
    );
    assert.equal(
      pending.pendingWakeTriggerSequence,
      5,
      'reason 与 trigger 必须来自同一条消息，不能拼出一个不存在的事件',
    );
  });
});

describe('唤醒原因：落库之后必须原样读回来', () => {
  /**
   * 这一层守的是一条**不对称**的契约。
   *
   * 读不出来的值退回最宽松的 everyone（宁可让一个成员可以沉默，也不要
   * 凭空逼出一条消息）—— 这一半是对的。但**已知**的值必须原样还原，因为
   * `asWakeReason` 是 scheduler 写入、RecoveryService 与 mapState 读回的唯一判据。
   *
   * 真实踩过的坑：这里原本是一串 `value === 'direct' || ...` 的字符串比较，
   * 加新原因时漏改，**最强**的唤醒原因被静默降级成**最弱**的，而且没有任何
   * 报错。所以这张表必须逐项钉死 —— 现在它是一张 Record，少写一行编译不过。
   */
  it('三个已知原因逐一还原，认不出来的退回最宽松的一档', () => {
    const known = ['mention', 'direct', 'everyone'] as const;
    for (const reason of known) {
      assert.equal(asWakeReason(reason), reason, `${reason} 必须原样还原`);
    }

    // 乱码 / NULL / 未来版本写进来的值 / 大小写变体：一律退回最宽松的一档
    for (const junk of [null, '', 'schedule', 'ESCALATION', 'escalation', 'follow_up', 'open_discussion', 'nonsense']) {
      assert.equal(
        asWakeReason(junk),
        'everyone',
        `${String(junk)} 应该退回 everyone`,
      );
    }
  });

  it('崩溃恢复：排到一半的点名唤醒重放时仍然是点名，不能降级成普通讨论', () => {
    const room = team.createConversation({
      kind: 'group',
      title: 'Lost Mention',
      memberIds: [alice.id, bob.id],
    });
    const states = new ConversationMemberService(db);

    // 点名唤醒已经入队（durable 落库），但引擎还没跑起来 —— 进程就是在这个
    // 窗口里挂掉的。run 永不返回，把这一行留在 queued 上，正是崩溃现场的形状。
    const scheduler = new MemberTurnScheduler(states, () => new Promise<void>(() => {}), () => {});
    scheduler.enqueue({
      conversationId: room.id,
      memberId: alice.id,
      reason: 'mention',
      triggerSequence: 3,
    });

    const lost = states.findLostWakes().filter((wake) => wake.conversationId === room.id);
    assert.equal(lost.length, 1, 'queued 的唤醒应该被恢复出来');
    assert.equal(
      lost[0].reason,
      'mention',
      '降级成 everyone 的话，一次明确的点名重启后就变成「顺带看看」',
    );
    assert.equal(lost[0].triggerSequence, 3);
    assert.equal(lost[0].memberId, alice.id);
  });
});

describe('NO_REPLY 是一条成功的 execution', () => {
  /**
   * 捕获实时广播出去的 `message.delta`。
   *
   * 只能从广播抓，不能查库：delta 是 token 级高频事件，`emit()` 刻意**不落
   * conversation_event**（落库会把 DB 写爆），它没有 sequence、不参与 replay，
   * 丢掉的部分由 durable 的 message.created 收敛。
   *
   * 这也意味着「哨兵有没有漏出去」这件事**没有审计痕迹** —— 它只在用户眼前
   * 发生一次。所以这条断言必须盯着广播，而且必须真的跑一遍流式路径。
   */
  function captureDeltas(conversationId: string): {
    deltas: string[];
    unsubscribe: () => void;
  } {
    const deltas: string[] = [];
    const unsubscribe = team.subscribe(conversationId, (event) => {
      if (event.type !== 'message.delta') return;
      deltas.push((event.data as { delta: string }).delta);
    });
    return { deltas, unsubscribe };
  }

  it('哨兵不会以 message.delta 的形式转发出去（否则会先出现再消失）', async () => {
    const conversation = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    stub.mode = 'skip';
    stub.streamDeltas = true;

    const capture = captureDeltas(conversation.id);
    try {
      const result = await team.sendMessage({
        conversationId: conversation.id,
        content: '你还有补充吗',
      });
      const executionId = executionIdForWake(db, conversation.id, result.wakes[0]);
      await waitForStatus(executionId, 'completed');
      await waitForConversationIdle(conversation.id);

      // 真实引擎会逐字吐出 <NO_REPLY>。原样转发的话，用户会看着它长出来，
      // 然后在收口时整条消失 —— 看起来像 UI 故障，而不是「这个 Member 不发言」。
      assert.deepEqual(
        capture.deltas,
        [],
        `整条回复就是哨兵时一个字符都不该转发，实际：${JSON.stringify(capture.deltas.join(''))}`,
      );

      // 但 skip 本身仍然是一条成功的 execution，房间也不会被拖进循环
      const row = executionRow(executionId);
      assert.equal(row.status, 'completed', 'skip 是成功，不是 failed');
      assert.equal(row.decision, 'skip');
      assert.equal(row.response, null);
      assert.equal(team.listMessages(conversation.id).length, 1);
    } finally {
      capture.unsubscribe();
    }
  });

  it('正常回复仍然逐字流式转发（过滤器不吞内容、不引入延迟）', async () => {
    const conversation = team.createConversation({ kind: 'direct', memberIds: [bob.id] });
    stub.streamDeltas = true;

    const capture = captureDeltas(conversation.id);
    try {
      const result = await team.sendMessage({ conversationId: conversation.id, content: '说点什么' });
      const executionId = executionIdForWake(db, conversation.id, result.wakes[0]);
      await waitForStatus(executionId, 'completed');
      await waitForConversationIdle(conversation.id);

      assert.ok(
        capture.deltas.length > 1,
        `应该逐字流式，而不是最后一次性给出：${JSON.stringify(capture.deltas)}`,
      );
      // 流式拼起来必须等于落库的那条消息 —— 过滤器既不能吞也不能改内容
      assert.equal(capture.deltas.join(''), `reply from ${bob.name}`);
      assert.equal(executionRow(executionId).response, `reply from ${bob.name}`);
    } finally {
      capture.unsubscribe();
    }
  });

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
    // 会被广播唤醒的 Member —— 他的 turn 会和 Alice 的抢时序（Alice 的 checkpoint
    // 是否已经越过 Bob 那条消息），于是「Alice 恰好两条 execution」这个断言会随
    // 微任务顺序飘。断言时序之外的东西只能靠把无关的唤醒关掉，而不是把断言放宽。
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

      // #3 无 mention 的广播 → everyone（更弱）。它不该把 mention 顶掉。
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

  it('Team 上下文只注入当前 Team 的那一份，不泄漏其他 Team 的', async () => {
    const teamId = team.getConversation(roomId).teamId;
    team.replaceMemberTeamContext(
      alice.id,
      '# Team Context\n\n这个 Team 的 review 输出要求先给 P0/P1 风险。',
      teamId,
    );
    // 另一个 Team 的上下文：同一个 Member，但这一轮不该看到。
    // 直接走 MemberService 落文件 —— TeamService 层会校验 Team 存在，
    // 而单 Team 部署下本来就建不出第二个 Team。
    memberService.replaceTeamMemory(
      alice.id,
      'other-team-id',
      '# Team Context\n\n某客户的尚未公开项目代号是 Bluebird。',
    );

    const prompt = await runInRoom(alice);
    assert.match(prompt, /P0\/P1/, '当前 Team 的上下文必须进 prompt');
    assert.doesNotMatch(prompt, /Bluebird/, '其他 Team 的上下文进了 prompt 就是泄漏');
  });

  it('全局记忆与 Team 上下文分段注入，各归各的段', async () => {
    const teamId = team.getConversation(roomId).teamId;
    team.replaceMemberMemory(bob.id, '# Long-term Memory\n\n习惯把事实和推论分开写。');
    team.replaceMemberTeamContext(
      bob.id,
      '# Team Context\n\n本 Team 的 review 输出要求先给 P0/P1 风险。',
      teamId,
    );

    const prompt = await runInRoom(bob);
    assert.match(prompt, /stable habits/, '全局记忆段必须标出它是跨 Team 的');
    assert.match(prompt, /习惯把事实和推论分开写/);
    assert.match(prompt, /this Team only/, 'Team 上下文段必须标出它不出这个 Team');
    assert.match(prompt, /P0\/P1/);
  });
});
