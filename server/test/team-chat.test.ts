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
const { GroupDispatcher } = await import('../group-dispatcher.js');
const { MemberTurnScheduler } = await import('../member-turn-scheduler.js');
const { NO_REPLY_SENTINEL } = await import('../member-decision.js');
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

/**
 * 假引擎需要知道「这一轮是被什么原因唤醒的」。
 *
 * 兜底用例靠它区分「第一轮选择沉默」和「被兜底时开口」—— 真实引擎是从
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

describe('Group conversation', () => {
  it('用户无 mention 的消息：全体被唤醒，但恰好一人被指定为应答者', async () => {
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

    // 恰好一人 reason=direct（必须回答），其余 open_discussion（可补可沉默）。
    // 「全员可沉默」曾经让三个 Member 各自判断「别人会说」，用户提问房间无人应答。
    const responders = first.wakes.filter((wake) => wake.reason === 'direct');
    assert.equal(responders.length, 1, '用户对着房间说话时必须有且只有一名应答者');
    assert.equal(
      first.wakes.filter((wake) => wake.reason === 'open_discussion').length,
      2,
      '其余成员是顺带被唤醒的，允许沉默',
    );

    for (const wake of first.wakes) {
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
    // 应答者只能从「被唤醒的人」里选：静音的成员不该被指定。
    assert.equal(
      second.wakes.filter((wake) => wake.reason === 'direct').length,
      1,
      '静音的成员不能被指定为应答者',
    );
    await waitForConversationIdle(group.id);

    const states = team.listConversationState(group.id);
    assert.equal(states.find((state) => state.memberId === iris.id)?.muted, true);
  });

  it('全员静音时，用户消息不产生任何应答者（没有候选就没有 direct）', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'All Muted Room',
      memberIds: [alice.id, bob.id],
    });
    team.setMemberMuted(group.id, alice.id, true);
    team.setMemberMuted(group.id, bob.id, true);

    const result = await team.sendMessage({ conversationId: group.id, content: '有人吗' });

    assert.deepEqual(result.wakes, [], '全员静音时没有候选，不该凭空造一个应答者');
    await waitForConversationIdle(group.id);
  });

  it('Member 发言触发的 follow_up 不指定应答者（作者之外无人欠回答）', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Follow Up Room',
      memberIds: [alice.id, bob.id, iris.id],
    });

    // 用户点名 Alice，让 Alice 说一句；她那句话会 follow_up 唤醒另外两人。
    const trigger = await team.sendMessage({
      conversationId: group.id,
      content: '先看下风险',
      targetMemberId: alice.id,
    });
    const aliceExecution = executionIdForWake(db, group.id, trigger.wakes[0]);
    await waitForStatus(aliceExecution, 'completed');
    await waitForConversationIdle(group.id);

    // 连回触发消息的作者：**「作者不被自己的消息唤醒」是逐条消息的规则，
    // 不是逐个人的**。Alice 会被 Bob 的下一条消息合法地唤醒 —— 她只是不能
    // 被自己刚发的那条唤醒。所以断言必须落在 (execution, 触发消息) 这一对上。
    const followUps = db
      .prepare(
        `
        SELECT e.member_id AS member_id, m.sender_id AS sender_id, m.sender_type AS sender_type
        FROM execution e
        JOIN conversation_message m
          ON m.conversation_id = e.conversation_id
         AND m.message_sequence = e.trigger_message_sequence
        WHERE e.conversation_id = ?
          AND e.wake_reason = 'follow_up'
        `,
      )
      .all(group.id) as unknown as Array<{
      member_id: string;
      sender_id: string;
      sender_type: string;
    }>;

    assert.ok(followUps.length > 0, 'Alice 的发言应该 follow_up 唤醒其他成员');
    for (const row of followUps) {
      assert.equal(row.sender_type, 'member', 'follow_up 只由 Member 的消息触发');
      assert.notEqual(row.member_id, row.sender_id, '没人该被自己刚发的那条消息唤醒');
    }

    // follow_up 全员可沉默 —— 应答者机制只服务于「用户对着房间说话」。
    // member 消息不该把任何人指定成应答者，否则房间会自己给自己派活。
    const strayDirect = db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM execution
        WHERE conversation_id = ? AND wake_reason = 'direct' AND member_id != ?
        `,
      )
      .get(group.id, alice.id) as unknown as { n: number };
    assert.equal(strayDirect.n, 0, 'member 消息不该把任何人指定成应答者');
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

describe('应答者：用户对着房间说话时，房间欠一个回答', () => {
  /**
   * 这个 describe 守的是一条产品承诺：**用户对房间提问，房间必须有人回答。**
   *
   * 曾经的失败形态（真实发生过）：用户发「我希望做架构设计review，应该做什么」，
   * 三个 Member 都被 open_discussion 唤醒，每个人都被允许沉默，于是三个人各自
   * 判断「别人会说」，全体沉默 —— 六条 execution 全部 completed / decision=skip，
   * 没有一条报错。机制完全正常，产品行为完全错误。
   *
   * 所以这里必须断言**两件事**，缺一不可：
   *   1. 路由（wakes 里的 reason）—— 恰好一人是 direct
   *   2. 指令（真正渲染给模型的那段话）—— 被指定的那个不能拿到沉默的出口
   * 只断言 1 是不够的：reason 对了但指令里仍写着「没东西可补就 <NO_REPLY>」，
   * 模型照样沉默。
   */
  it('被指定的应答者拿到「必须回答」，其余成员拿到「可以沉默」', async () => {
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

    const responder = result.wakes.find((wake) => wake.reason === 'direct');
    assert.ok(responder, '用户对着房间说话时必须有且只有一名应答者');
    const bystanders = result.wakes.filter((wake) => wake.memberId !== responder.memberId);
    assert.equal(bystanders.length, 2);

    const responderPrompt = stub.turnFor(executionIdForWake(db, group.id, responder)).prompt;
    assert.match(responderPrompt, /expects to answer this message/);
    assert.match(responderPrompt, /must respond/);
    // 关键：应答者不能同时看到「你可以沉默」这条出口，否则两个指令互相抵消，
    // 模型会挑更省力的那个 —— 责任扩散就是这么发生的。
    assert.doesNotMatch(
      responderPrompt,
      new RegExp(NO_REPLY_SENTINEL.replace(/[<>]/g, '\\$&')),
      '应答者不该拿到 <NO_REPLY> 这个出口',
    );

    for (const wake of bystanders) {
      const prompt = stub.turnFor(executionIdForWake(db, group.id, wake)).prompt;
      assert.match(
        prompt,
        new RegExp(NO_REPLY_SENTINEL.replace(/[<>]/g, '\\$&')),
        '顺带被唤醒的成员必须知道沉默是合法的，否则会重复别人的话',
      );
      assert.doesNotMatch(prompt, /expects to answer this message/);
    }
  });

  it('选择规则：最久没发言的成员优先，同一份数据总是得到同一个答案', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Rotation Room',
      memberIds: [alice.id, bob.id, iris.id],
    });

    // 先静音全体：把消息落库但不在这一刻派发唤醒。这个用例考的是选择规则本身，
    // 不需要真的跑 turn —— 让引擎跑起来反而会和下面的 markReplied 抢状态。
    muteAllMembers(team, group.id);
    const sent = await team.sendMessage({ conversationId: group.id, content: '这个方案该怎么推进' });
    assert.deepEqual(sent.wakes, [], '静音状态下不该派发唤醒');

    // 解除静音：静音只用来阻止这一刻的派发，不参与选择规则的断言
    // （静音成员本来就会被排除在候选之外，那由上一个 describe 覆盖）。
    for (const member of [alice, bob, iris]) {
      team.setMemberMuted(group.id, member.id, false);
    }

    const states = new ConversationMemberService(db);
    const dispatcher = new GroupDispatcher(db, states, 2);
    const conversation = team.getConversation(group.id);

    const primaryOf = (c = conversation): string => {
      const plan = dispatcher.plan({ conversation: c, message: sent.message });
      const responders = plan.wakes.filter((wake) => wake.reason === 'direct');
      assert.equal(responders.length, 1, '用户消息必须恰好指定一名应答者');
      return responders[0].memberId;
    };

    // 新房间全员 last_replied 都是 0 → 平手。平手必须按 id 定序，
    // 否则「谁回答」会取决于一个没人看得见的数组顺序。
    const first = primaryOf();
    assert.equal(first, [alice.id, bob.id, iris.id].sort()[0], '平手时按 id 定序');

    // 换一个成员数组顺序，结果必须一样。
    assert.equal(
      primaryOf({ ...conversation, members: [...conversation.members].reverse() }),
      first,
      '选择结果不能取决于成员在房间里的排列顺序',
    );

    // 应答者发言之后轮到他之外最久没发言的那个 —— 房间要轮流，不能永远同一个人。
    states.markReplied(group.id, first, sent.message.messageSequence);
    const second = primaryOf();
    assert.notEqual(second, first, '刚回答过的人应该让位');

    states.markReplied(group.id, second, sent.message.messageSequence + 1);
    const third = primaryOf();
    assert.notEqual(third, second, '连续两次都换人');
    assert.notEqual(third, first, '第三轮轮到还没回答过的那个');

    // 走完一圈回到第一个人：不是「谁先发言谁永远发言」，也不是随机。
    states.markReplied(group.id, third, sent.message.messageSequence + 2);
    assert.equal(primaryOf(), first, '三人各回答一次之后轮回到第一个人');
  });

  it('@mention 时不额外指定应答者：指名道姓已经是更强的指定', async () => {
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

describe('负责人兜底：整个房间都不接话时，由负责人回答', () => {
  interface EscalationRow {
    id: string;
    member_id: string;
    status: string;
    decision: string | null;
    trigger_message_sequence: number | null;
  }

  function escalationExecutions(conversationId: string): EscalationRow[] {
    return db
      .prepare(
        `
        SELECT id, member_id, status, decision, trigger_message_sequence
        FROM execution
        WHERE conversation_id = ? AND wake_reason = 'escalation'
        ORDER BY rowid
        `,
      )
      .all(conversationId) as unknown as EscalationRow[];
  }

  /** 兜底是在最后一条 skip 收口时**同步**派出去的，这里等它落库。 */
  async function waitForEscalation(conversationId: string, expected = 1): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (escalationExecutions(conversationId).length >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(
      `没有出现兜底 execution（期望 ${expected} 条，实际 ${escalationExecutions(conversationId).length} 条）`,
    );
  }

  function makeRoom(title: string): string {
    return team.createConversation({
      kind: 'group',
      title,
      memberIds: [alice.id, bob.id, iris.id],
    }).id;
  }

  /** 这个房间里已经收口成 skip 的 execution 有几条。 */
  function settledSkips(conversationId: string): number {
    const row = db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM execution
        WHERE conversation_id = ?
          AND status = 'completed'
          AND decision = 'skip'
        `,
      )
      .get(conversationId) as unknown as { n: number };
    return row.n;
  }

  async function waitForSettledSkips(conversationId: string, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (settledSkips(conversationId) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`只等到 ${settledSkips(conversationId)} 条收口的 skip（期望 ${expected} 条）`);
  }

  /**
   * 「等这一批跑完」这条守卫只在**有人已收口、有人还在跑**的形状下才可观测。
   *
   * 少了它，兜底会在**第一个** skip 收口时就派出去 —— 那时还有人在想，而那个人
   * 的回答可能马上就到。后果不是「多跑一轮」，是负责人与还没跑完的成员**同时**回答，
   * 房间轮流应答的规则被绕过。
   *
   * 光靠「一次沉默只兜一次」的计数断言抓不到它：`escalations > 0` 那道守卫会把
   * 后续的重复派发都拦掉，计数看起来仍然是对的（变异验证发现这条断言没有区分度）。
   * 必须真的制造出「半批已收口」的中间态。
   */
  it('这一批还没跑完时不兜底（否则负责人会在别人还在想的时候抢答）', async () => {
    const roomId = makeRoom('Still Running Room');
    team.setMemberLead(roomId, alice.id, true);

    // alice / iris 一律沉默，bob 是唯一会说话的人 —— 但把他按住，模拟「他还在想」
    stub.skipMemberIds.add(alice.id);
    stub.skipMemberIds.add(iris.id);

    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.holdMemberIds = new Set([bob.id]);

    try {
      await team.sendMessage({ conversationId: roomId, content: '这个方案该怎么推进' });

      // 两条 skip 已收口，bob 还挂在 running 上 —— 房间**还不能**算沉默
      await waitForSettledSkips(roomId, 2);
      assert.deepEqual(
        escalationExecutions(roomId),
        [],
        '还有人在跑就不能认定房间沉默 —— 那个人的回答可能马上就到',
      );
    } finally {
      release();
      stub.hold = null;
      stub.holdMemberIds = null;
    }

    await waitForConversationIdle(roomId);
    assert.deepEqual(
      escalationExecutions(roomId),
      [],
      'bob 最后回答了，本来就不该有兜底',
    );
  });

  it('全员沉默 → 负责人兜底回答，且只兜一次', async () => {
    const roomId = makeRoom('Escalation Room');
    team.setMemberLead(roomId, alice.id, true);

    // 只有「被兜底」这一种唤醒才开口：前一轮的 direct / open_discussion 全部沉默。
    // 这正是用户截图里发生的事 —— 三个 Member 各自判断「别人会说」。
    stub.speakOnlyOnReasons = new Set(['escalation']);

    await team.sendMessage({ conversationId: roomId, content: '这个方案该怎么推进' });
    await waitForEscalation(roomId);
    await waitForConversationIdle(roomId);

    const escalations = escalationExecutions(roomId);
    assert.equal(escalations.length, 1, '一次静默只兜一次底 —— 否则兜底失败会自我循环');
    assert.equal(escalations[0].member_id, alice.id, '兜底必须落在负责人头上');
    assert.equal(escalations[0].status, 'completed');
    assert.equal(escalations[0].decision, 'reply', '负责人这次真的开口了');
    assert.equal(escalations[0].trigger_message_sequence, 1, '兜底对着的是用户那条消息');

    // 房间里恰好一条 Member 消息，而且是负责人的
    const memberMessages = team
      .listMessages(roomId)
      .filter((message) => message.senderType === 'member');
    assert.equal(memberMessages.length, 1);
    assert.equal(memberMessages[0].senderId, alice.id);
  });

  /**
   * 这条用例守的是**兜底指令本身**，而不只是「兜底有没有被派出去」。
   *
   * 派发正确但指令写错，兜底是白兜的：负责人拿到一段和 `direct` 一模一样的
   * 说辞（「你是这个房间期待的回答者」），它会**再判断一次**「也许别人会说」——
   * 而它手上并没有「别人都沉默过」这条信息，于是又一次合理地选择沉默。
   *
   * 所以这一段里必须出现**别的档位没有**的那个事实：房间里没人接话。
   */
  it('兜底指令必须说清「房间里没人说话」—— 否则负责人会再判断一次', async () => {
    const roomId = makeRoom('Escalation Wording Room');
    team.setMemberLead(roomId, alice.id, true);
    stub.speakOnlyOnReasons = new Set(['escalation']);

    await team.sendMessage({ conversationId: roomId, content: '这个方案该怎么推进' });
    await waitForEscalation(roomId);
    await waitForConversationIdle(roomId);

    const escalation = escalationExecutions(roomId)[0];
    const prompt = stub.turnFor(escalation.id).prompt;

    // 兜底档独有的信息：整个房间都沉默过。这是它和 direct 唯一的区别。
    assert.match(prompt, /stayed silent/i, '必须告诉负责人：房间里没人接话');
    assert.match(prompt, /lead/i, '必须点明它是负责人 —— 这是它欠回答的理由');

    // 与 direct 的分野：不能复用 direct 的说辞，否则负责人会以为自己只是
    // 「这一轮的应答者」，重新判断一次「也许别人会说」。
    assert.doesNotMatch(
      prompt,
      /expects to answer this message/,
      '兜底不能退化成 direct 的说辞，否则「房间已沉默」这条信息就丢了',
    );

    // 出口同样必须是关的。
    assert.doesNotMatch(
      prompt,
      new RegExp(NO_REPLY_SENTINEL.replace(/[<>]/g, '\\$&')),
      '兜底的人不该拿到 <NO_REPLY> 这个出口',
    );
  });

  it('有人接话时不兜底（负责人不需要出场）', async () => {
    const roomId = makeRoom('Answered Room');
    team.setMemberLead(roomId, alice.id, true);

    // 被指定为应答者的那个人会开口，顺带被唤醒的沉默。
    stub.speakOnlyOnReasons = new Set(['direct']);

    await team.sendMessage({ conversationId: roomId, content: '这个方案该怎么推进' });
    await waitForConversationIdle(roomId);

    assert.deepEqual(escalationExecutions(roomId), [], '已经有人回答了，不该再叫负责人');
  });

  it('没设负责人时不兜底（没有兜底人不是错误）', async () => {
    const roomId = makeRoom('No Lead Room');
    stub.mode = 'skip';

    await team.sendMessage({ conversationId: roomId, content: '有人吗' });
    await waitForConversationIdle(roomId);

    assert.deepEqual(escalationExecutions(roomId), []);
  });

  it('负责人被静音时不兜底（静音是显式意图，兜底不该绕过去）', async () => {
    const roomId = makeRoom('Muted Lead Room');
    team.setMemberLead(roomId, alice.id, true);
    team.setMemberMuted(roomId, alice.id, true);
    stub.mode = 'skip';

    await team.sendMessage({ conversationId: roomId, content: '有人吗' });
    await waitForConversationIdle(roomId);

    assert.deepEqual(escalationExecutions(roomId), [], '被静音的负责人不该被兜底机制唤醒');
  });

  it('负责人本人就是应答者、也选择了沉默时，仍然兜底（房间不能就这么沉默下去）', async () => {
    const roomId = makeRoom('Asked Lead Room');
    team.setMemberLead(roomId, alice.id, true);
    stub.mode = 'skip';

    // 这条用例守的是一个**被删掉的「优化」**：早先的版本规定「负责人已经被
    // 明确问过就不再兜底」，理由是「同一件事不做两遍」。但它会在一个真实且
    // 常见的场景里让房间继续沉默 —— 负责人恰好被选为应答者、拿着「你必须
    // 回答」的指令选择了沉默，于是没人兜底。
    //
    // 再问一次并不是同一件事：兜底的指令带着一条别的分支没有的信息
    // （「房间里没人接话」）。房间保持沉默的代价没有上界，多跑一轮有。
    await team.sendMessage({ conversationId: roomId, content: '@alice 这个方案该怎么推进' });
    await waitForEscalation(roomId);
    await waitForConversationIdle(roomId);

    const escalations = escalationExecutions(roomId);
    assert.equal(escalations.length, 1, '一次静默只兜一次');
    assert.equal(escalations[0].member_id, alice.id);

    // 前置条件：她确实先被 @ 到过（否则这条用例守的是别的东西）
    const asked = db
      .prepare(
        `
        SELECT wake_reason FROM execution
        WHERE conversation_id = ? AND member_id = ?
        `,
      )
      .all(roomId, alice.id) as unknown as Array<{ wake_reason: string }>;
    assert.ok(
      asked.some((row) => row.wake_reason === 'mention'),
      `前置条件：她应该先被 @ 到过一次，实际 ${JSON.stringify(asked)}`,
    );
  });

  it('负责人自己也沉默时不会无限兜底（第二次不再派）', async () => {
    const roomId = makeRoom('Silent Lead Room');
    team.setMemberLead(roomId, alice.id, true);
    stub.mode = 'skip';

    await team.sendMessage({ conversationId: roomId, content: '这个方案该怎么推进' });
    await waitForEscalation(roomId);
    await waitForConversationIdle(roomId);

    // 兜底本身也可能被无视 —— 那时房间确实没人回答，但**不能**再兜一次：
    // 同一个问题、同一份上下文，再问一次不会得到不同结果，只会烧 token。
    const escalations = escalationExecutions(roomId);
    assert.equal(escalations.length, 1, '兜底必须是一次性的');
    assert.equal(escalations[0].decision, 'skip');
  });

  it('member 之间的 follow_up 沉默不算房间失职（不兜底）', async () => {
    const roomId = makeRoom('Member Silence Room');
    team.setMemberLead(roomId, alice.id, true);
    // Alice 是唯一会说话的人：她先回答用户，然后对别人的话一律沉默。
    stub.speakOnlyOnReasons = new Set(['direct']);

    await team.sendMessage({ conversationId: roomId, content: '这个方案该怎么推进' });
    await waitForConversationIdle(roomId);

    // 用户的提问已经有人回答 → 没有兜底。她后续的沉默属于讨论，不是失职。
    assert.deepEqual(escalationExecutions(roomId), []);
  });

  it('负责人不参与日常排序：他只在全员沉默时出场，不是默认发言人', async () => {
    const group = team.createConversation({
      kind: 'group',
      title: 'Lead Is Not The Default',
      memberIds: [alice.id, bob.id, iris.id],
    });
    team.setMemberLead(group.id, alice.id, true);

    // 先静音全体把消息落库（不在这一刻派发），再解除静音手动算一次 plan。
    muteAllMembers(team, group.id);
    const sent = await team.sendMessage({ conversationId: group.id, content: '这个方案该怎么推进' });
    assert.deepEqual(sent.wakes, []);
    for (const member of [alice, bob, iris]) {
      team.setMemberMuted(group.id, member.id, false);
    }

    // 让 Alice（负责人）成为**最近刚发过言**的那个。如果负责人参与排序，
    // 她会被选成应答者；如果她只是兜底，就轮不到她。
    const states = new ConversationMemberService(db);
    states.markReplied(group.id, alice.id, sent.message.messageSequence + 5);

    const dispatcher = new GroupDispatcher(db, states, 2);
    const plan = dispatcher.plan({
      conversation: team.getConversation(group.id),
      message: sent.message,
    });

    const responder = plan.wakes.find((wake) => wake.reason === 'direct');
    assert.ok(responder, '日常仍然要有一名应答者');
    assert.notEqual(
      responder.memberId,
      alice.id,
      '负责人不该抢日常应答 —— 让她回答每一条，房间就变回「一个 Agent 加几个装饰」',
    );
    assert.equal(
      plan.wakes.some((wake) => wake.reason === 'escalation'),
      false,
      '兜底不是「新消息到达」时的唤醒理由，它由房间沉默触发',
    );
  });

  it('planEscalation：只在 group 房间、且有能接活的负责人时才返回计划', () => {
    const dispatcher = new GroupDispatcher(db, new ConversationMemberService(db), 2);

    const directRoom = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    assert.equal(
      dispatcher.planEscalation({
        conversation: team.getConversation(directRoom.id),
        triggerSequence: 1,
      }),
      null,
      '1:1 房间没有「房间沉默」这回事',
    );

    const group = team.createConversation({
      kind: 'group',
      title: 'Escalation Edges',
      memberIds: [alice.id, bob.id],
    });
    assert.equal(
      dispatcher.planEscalation({
        conversation: team.getConversation(group.id),
        triggerSequence: 1,
      }),
      null,
      '没设负责人时没有兜底人 —— 这是合法状态，不是配置错误',
    );

    team.setMemberLead(group.id, bob.id, true);
    const plan = dispatcher.planEscalation({
      conversation: team.getConversation(group.id),
      triggerSequence: 7,
    });
    assert.deepEqual({ ...plan }, { memberId: bob.id, reason: 'escalation', triggerSequence: 7 });

    team.setMemberMuted(group.id, bob.id, true);
    assert.equal(
      dispatcher.planEscalation({
        conversation: team.getConversation(group.id),
        triggerSequence: 7,
      }),
      null,
      '被静音的负责人不兜底 —— 静音是用户的显式意图',
    );
  });

  /**
   * 这条用例守的是**合并优先级**，而不是「兜底有没有派出去」。
   *
   * 兜底的唤醒可能和一条更弱的唤醒撞在同一个 (房间, 成员) 上：负责人此刻正忙，
   * 它作为普通成员被 `direct` 顺手指定过、还没轮到跑；这时房间全体沉默，兜底到了。
   * 如果合并时兜底输给 `direct`，负责人拿到的是「你是这一轮的应答者」—— 那段话里
   * 没有「房间里没人接话」，于是它会**再判断一次**「也许别人会说」，兜底就白兜了。
   *
   * 这里直接构造 scheduler，而不是走 sendMessage：要考的是合并规则本身，通过消息
   * 驱动只能间接凑出这个竞态，而且结果会依赖 turn 的交替顺序。
   */
  it('兜底与更弱的唤醒相撞时兜底必须赢（否则「房间已沉默」这条信息会丢）', () => {
    const room = team.createConversation({
      kind: 'group',
      title: 'Escalation Priority',
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
      reason: 'open_discussion',
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
      reason: 'escalation',
      triggerSequence: 5,
    });

    const pending = states.get(room.id, alice.id);
    assert.equal(pending.pendingWake, true);
    assert.equal(
      pending.pendingWakeReason,
      'escalation',
      '兜底必须压过 direct —— 反过来负责人就看不到「房间里没人接话」',
    );
    assert.equal(
      pending.pendingWakeTriggerSequence,
      5,
      'reason 与 trigger 必须来自同一条消息，不能拼出一个不存在的事件',
    );
  });

  it('一个房间至多一个负责人（换人会顶掉旧的）', () => {
    const room = team.createConversation({
      kind: 'group',
      title: 'Lead Swap',
      memberIds: [alice.id, bob.id],
    });

    team.setMemberLead(room.id, alice.id, true);
    assert.deepEqual(
      team.listConversationState(room.id).filter((state) => state.isLead).map((s) => s.memberId),
      [alice.id],
    );

    team.setMemberLead(room.id, bob.id, true);
    assert.deepEqual(
      team.listConversationState(room.id).filter((state) => state.isLead).map((s) => s.memberId),
      [bob.id],
      '换负责人必须顶掉旧的，不能出现两个 —— 否则「谁兜底」会变得不确定',
    );

    team.setMemberLead(room.id, bob.id, false);
    assert.deepEqual(
      team.listConversationState(room.id).filter((state) => state.isLead),
      [],
      '撤销负责人是合法状态',
    );
  });
});

describe('唤醒原因：落库之后必须原样读回来', () => {
  /**
   * 这一层守的是一条**不对称**的契约。
   *
   * 读不出来的值退回最宽松的 open_discussion（宁可让一个成员可以沉默，也不要
   * 凭空逼出一条消息）—— 这一半是对的。但**已知**的值必须原样还原，因为
   * `asWakeReason` 是 scheduler 写入、RecoveryService 与 mapState 读回的唯一判据。
   *
   * 真实踩过的坑：这里原本是一串 `value === 'direct' || ...`，加 'escalation' 时
   * 漏改了。字符串比较不会报错，于是**最强**的唤醒原因被静默降级成**最弱**的 ——
   * 崩溃恢复重放一条 durable 的兜底唤醒时，负责人拿到「你可以沉默」，兜底在最
   * 需要它的时刻失效，而且没有任何报错。所以这张表必须逐项钉死。
   */
  it('五个已知原因逐一还原，认不出来的退回最宽松的一档', () => {
    const known = ['escalation', 'mention', 'direct', 'follow_up', 'open_discussion'] as const;
    for (const reason of known) {
      assert.equal(asWakeReason(reason), reason, `${reason} 必须原样还原`);
    }

    // 乱码 / NULL / 未来版本写进来的值 / 大小写变体：一律退回最宽松的一档
    for (const junk of [null, '', 'schedule', 'ESCALATION', 'nonsense']) {
      assert.equal(
        asWakeReason(junk),
        'open_discussion',
        `${String(junk)} 应该退回 open_discussion`,
      );
    }
  });

  it('崩溃恢复：排到一半的兜底唤醒重放时仍然是兜底，不能降级成普通讨论', () => {
    const room = team.createConversation({
      kind: 'group',
      title: 'Lost Escalation',
      memberIds: [alice.id, bob.id],
    });
    const states = new ConversationMemberService(db);

    // 兜底唤醒已经入队（durable 落库），但引擎还没跑起来 —— 进程就是在这个
    // 窗口里挂掉的。run 永不返回，把这一行留在 queued 上，正是崩溃现场的形状。
    const scheduler = new MemberTurnScheduler(states, () => new Promise<void>(() => {}), () => {});
    scheduler.enqueue({
      conversationId: room.id,
      memberId: alice.id,
      reason: 'escalation',
      triggerSequence: 3,
    });

    const lost = states.findLostWakes().filter((wake) => wake.conversationId === room.id);
    assert.equal(lost.length, 1, 'queued 的唤醒应该被恢复出来');
    assert.equal(
      lost[0].reason,
      'escalation',
      '降级成 open_discussion 的话，负责人重启后拿到的是「你可以沉默」—— 兜底白设',
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
