import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopilotService } from '../copilot.js';
import type { Member } from '../domain.js';

/**
 * 数据正确性测试。
 *
 * 这一组关心的不是「功能有没有」，而是「写进去的东西是不是真的等于调用方说的
 * 那个意思」：
 *
 *   replyToMessageId   引用必须指得着，而且是同一个房间里的
 *   幂等键             同一次发送重试不会变成两条消息、两次唤醒
 *   记忆乐观并发       人保存记忆时不会把 Agent 刚写的那句覆盖掉
 *   上下文上限         沉默很久之后被唤醒，不会把整个房间历史灌进一轮
 *   配置快照           execution 记录「当时用的是哪份人格、哪份记忆」
 *   @mention 精确匹配  猜错收件人比报「没匹配到」糟
 *
 * 同样不碰真实 Copilot runtime：临时 DATA_DIR + stub Copilot。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-integrity-'));
// 必须在 import config.ts 之前设好，否则 db 会落到仓库的 .data/
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { resolveMentions } = await import('../group-dispatcher.js');
const { singleExecutionId, muteAllMembers, createTestStack } = await import('./support.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

interface TurnInput {
  runtime: { id: string; conversationId: string; memberId: string };
  member: { id: string };
  executionId: string;
}

class StubCopilot {
  readonly turns: TurnInput[] = [];

  async runMemberTurn(input: TurnInput): Promise<string> {
    this.turns.push(input);
    return `stub reply from ${input.member.id}`;
  }
}

const stub = new StubCopilot();
const memberService = new MemberService(db);
// 与 app.ts 相同的装配（Copilot 换成 stub），见 support.ts 的 createTestStack。
const { team } = createTestStack(db, memberService, stub as unknown as CopilotService);

function makeMember(name: string, handle: string): Member {
  return memberService.create({ name, handle, role: 'Analyst', style: 'concise' });
}

async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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

function countMessages(conversationId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_message WHERE conversation_id = ?`)
      .get(conversationId) as unknown as { n: number }
  ).n;
}

/**
 * 只数用户发的消息。
 *
 * 房间里的 message 表同时装着「用户说了什么」和「Member 回了什么」，而这一组
 * 用例关心的是前者 —— 用总数断言会变成「Member 回没回」的间接测试，
 * 一条无关的回复就让断言变红。
 */
function countUserMessages(conversationId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_message WHERE conversation_id = ? AND sender_type = 'user'`,
      )
      .get(conversationId) as unknown as { n: number }
  ).n;
}

function messageSequences(conversationId: string): number[] {
  return (
    db
      .prepare(
        `SELECT message_sequence FROM conversation_message WHERE conversation_id = ? ORDER BY message_sequence`,
      )
      .all(conversationId) as unknown as Array<{ message_sequence: number }>
  ).map((row) => row.message_sequence);
}

function countExecutions(conversationId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ?`)
      .get(conversationId) as unknown as { n: number }
  ).n;
}

// -------------------------------------------------------- 1. replyToMessageId

describe('replyToMessageId 必须指得着，而且是同一个房间里的', () => {
  it('不存在 / 属于别的房间 → 400，一条消息都不落库', async () => {
    const alice = makeMember('Reply Alice', 'reply-alice');
    const bob = makeMember('Reply Bob', 'reply-bob');

    const room = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    const other = team.createConversation({ kind: 'direct', memberIds: [bob.id] });

    await muteAllMembers(team, room.id);
    await muteAllMembers(team, other.id);

    const elsewhere = await team.sendMessage({ conversationId: other.id, content: '别的房间' });

    await assert.rejects(
      () =>
        team.sendMessage({
          conversationId: room.id,
          content: '引用一条不存在的消息',
          replyToMessageId: 'no-such-message',
        }),
      /replyToMessageId 指向的消息不存在/,
    );

    await assert.rejects(
      () =>
        team.sendMessage({
          conversationId: room.id,
          content: '引用别的房间的消息',
          replyToMessageId: elsewhere.message.id,
        }),
      /不属于这个 conversation/,
    );

    // 校验必须在落库之前：被拒的请求不该留下任何痕迹
    assert.equal(countMessages(room.id), 0);

    await waitForConversationIdle(room.id);
    await waitForConversationIdle(other.id);
  });

});

// ------------------------------------------------------------ 2. 幂等键

describe('POST /messages 的幂等键', () => {
  it('同一个 key 第二次到达：不落新消息、不再唤醒、把第一条原样返回', async () => {
    const alice = makeMember('Idem Alice', 'idem-alice');
    const room = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    await muteAllMembers(team, room.id);

    const key = 'req-0001';

    const first = await team.sendMessage({
      conversationId: room.id,
      content: '只应该出现一次',
      clientRequestId: key,
    });
    await waitForConversationIdle(room.id);

    const executionsAfterFirst = countExecutions(room.id);

    const retry = await team.sendMessage({
      conversationId: room.id,
      content: '只应该出现一次',
      clientRequestId: key,
    });

    assert.equal(retry.deduplicated, true);
    assert.equal(retry.message.id, first.message.id);
    assert.equal(retry.message.messageSequence, first.message.messageSequence);
    // 唤醒早就发生过了，重派一次就是一轮多余的 execution
    assert.deepEqual(retry.wakes, []);

    assert.equal(countUserMessages(room.id), 1);
    assert.equal(countExecutions(room.id), executionsAfterFirst);

    await waitForConversationIdle(room.id);
  });

  it('幂等命中不消费 message_sequence，也不留空号', async () => {
    const alice = makeMember('Idem2 Alice', 'idem2-alice');
    const room = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    await muteAllMembers(team, room.id);

    await team.sendMessage({ conversationId: room.id, content: 'a', clientRequestId: 'k1' });
    await waitForConversationIdle(room.id);
    await team.sendMessage({ conversationId: room.id, content: 'a', clientRequestId: 'k1' });
    await team.sendMessage({ conversationId: room.id, content: 'b', clientRequestId: 'k2' });
    await waitForConversationIdle(room.id);

    assert.equal(countUserMessages(room.id), 2);

    // 幂等命中不消费序号：整张表必须仍然是 1..N 连续无洞。
    // 有洞就意味着「按序号推断」的东西（未读数、checkpoint 比较）会看到一个
    // 永远不存在的消息。
    const sequences = messageSequences(room.id);
    assert.deepEqual(
      sequences,
      Array.from({ length: sequences.length }, (_, index) => index + 1),
    );
  });

});

// --------------------------------------------------- 3. Member 记忆并发

describe('Member 长期记忆的乐观并发', () => {
  it('版本不匹配 → 409 且不写盘；带上新版本才写得进去', () => {
    const member = makeMember('Memory Alice', 'memory-alice');

    const loaded = team.getMemberMemory(member.id);
    assert.equal(typeof loaded.version, 'string');
    assert.ok(loaded.version.length >= 32);

    // Agent 在这一轮里写了一句（remember_member）
    memberService.appendMemory(member.id, 'Agent 在干活时记下的');

    const afterAgentWrite = team.getMemberMemory(member.id);
    assert.notEqual(afterAgentWrite.version, loaded.version, 'Agent 写完版本必须变');

    // 用户拿着旧版本保存 —— 必须被拦住，否则 Agent 那句被无声覆盖
    try {
      team.replaceMemberMemory(member.id, '# Long-term Memory\n\n用户写的', loaded.version);
      assert.fail('应该因为版本不匹配被拒绝');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
    }
    assert.ok(
      team.getMemberMemory(member.id).content.includes('Agent 在干活时记下的'),
      '被拒绝的保存不能改动文件',
    );

    // 重新加载后再保存，成功
    const reloaded = team.getMemberMemory(member.id);
    const saved = team.replaceMemberMemory(
      member.id,
      '# Long-term Memory\n\n用户写的',
      reloaded.version,
    );
    assert.equal(saved.version, team.getMemberMemory(member.id).version);
    assert.ok(!saved.content.includes('Agent 在干活时记下的'));
  });

});

// -------------------------------------------------------- 4. 上下文上限

describe('ContextAssembler 的单轮上限', () => {
  it('超出 MAX_CONTEXT_MESSAGES 时保留最新的那些，并显式说明略过了多少条', async () => {
    const alice = makeMember('Ctx Alice', 'ctx-alice');
    const bob = makeMember('Ctx Bob', 'ctx-bob');

    // group 房间：bob 被静音，alice 不发言，这样房间里能攒下一批消息而
    // 没有人被唤醒，制造出「沉默很久」的现场。
    const room = team.createConversation({
      kind: 'group',
      title: 'Context',
      memberIds: [alice.id, bob.id],
    });
    await muteAllMembers(team, room.id);

    const total = 12;
    for (let index = 1; index <= total; index += 1) {
      await team.sendMessage({ conversationId: room.id, content: `消息 ${index}` });
    }
    await waitForConversationIdle(room.id);

    const originalLimit = config.maxContextMessages;
    config.maxContextMessages = 3;
    try {
      // 直接问 assembler：这一轮会看到什么
      const { ContextAssembler } = await import('../context-assembler.js');
      const assembler = new ContextAssembler(db);

      const runtime = {
        id: 'runtime-x',
        conversationId: room.id,
        memberId: alice.id,
        copilotSessionId: 'sess-x',
        workspacePath: '/tmp/x',
        status: 'idle' as const,
        activeExecutionId: null,
        lastContextMessageSequence: 0,
        lastUsedAt: null,
      };

      const context = assembler.assemble({
        runtime,
        conversation: team.getConversation(room.id),
        member: team.getMember(alice.id),
        turnMode: 'discussion',
        triggerMessageSequence: total,
        wakeReason: 'mention',
        currentPrompt: 'hello',
      });

      assert.equal(context.sharedMessages.length, 3);
      // 留的是**最新**的三条，不是最旧的三条 —— 唤醒它的是刚刚发生的事
      assert.deepEqual(
        context.sharedMessages.map((message) => message.content),
        ['消息 10', '消息 11', '消息 12'],
      );
      assert.equal(context.elidedMessageCount, total - 3);
      assert.equal(context.elidedFromSequence, 1);

      // checkpoint 仍然推到读到的最后一条（否则同一批消息每轮重放），
      // 但 prompt 里必须写明被略过的那一段 —— 不写的话模型会把 transcript
      // 当成房间的全部，据此下「没人提过这个」的错误结论。
      assert.equal(context.consumedThroughSequence, total);
      assert.match(context.prompt, /9 earlier messages .* were omitted/);
      assert.match(context.prompt, /消息 12/);
      assert.doesNotMatch(context.prompt, /消息 9/);
    } finally {
      config.maxContextMessages = originalLimit;
    }
  });

  it('MAX_CONTEXT_CHARS 同样生效，且至少注入一条（不把一轮变成空的）', async () => {
    const alice = makeMember('Chars Alice', 'chars-alice');
    const bob = makeMember('Chars Bob', 'chars-bob');

    // group 房间 + 全员静音：这样攒下来的都是**用户**消息，不会混进 Member 的
    // 回复（那些会被当成「自己说过的话」过滤掉，让这个用例测不到字符预算）。
    const room = team.createConversation({
      kind: 'group',
      title: 'Chars',
      memberIds: [alice.id, bob.id],
    });
    await muteAllMembers(team, room.id);

    await team.sendMessage({ conversationId: room.id, content: 'x'.repeat(4000) });
    await team.sendMessage({ conversationId: room.id, content: 'y'.repeat(4000) });
    await waitForConversationIdle(room.id);

    const originalChars = config.maxContextChars;
    // 预算比单条消息还小：仍然必须注入一条，否则 discussion 模式会对着
    // 空房间判断「要不要发言」，而它明明是被这条消息唤醒的。
    config.maxContextChars = 100;
    try {
      const { ContextAssembler } = await import('../context-assembler.js');
      const assembler = new ContextAssembler(db);
      const context = assembler.assemble({
        runtime: {
          id: 'runtime-y',
          conversationId: room.id,
          memberId: alice.id,
          copilotSessionId: 'sess-y',
          workspacePath: '/tmp/y',
          status: 'idle' as const,
          activeExecutionId: null,
          lastContextMessageSequence: 0,
          lastUsedAt: null,
        },
        conversation: team.getConversation(room.id),
        member: team.getMember(alice.id),
        turnMode: 'discussion',
        triggerMessageSequence: 2,
        wakeReason: 'open_discussion',
        currentPrompt: '',
      });

      // 超预算也至少留一条，且留的是最新的那条
      assert.equal(context.sharedMessages.length, 1);
      assert.equal(context.sharedMessages[0].content, 'y'.repeat(4000));
      assert.equal(context.elidedMessageCount, 1);
      assert.equal(context.consumedThroughSequence, 2);
      assert.match(context.prompt, /1 earlier message in this room/);
    } finally {
      config.maxContextChars = originalChars;
    }
  });
});

// -------------------------------------------------------- 5. 配置快照

describe('execution 记录当时用的配置', () => {
  it('跑完一轮后有快照；改了 Member 身份之后 retry 的快照跟着变', async () => {
    const alice = makeMember('Snapshot Alice', 'snapshot-alice');
    const room = team.createConversation({ kind: 'direct', memberIds: [alice.id] });
    await muteAllMembers(team, room.id);

    const sent = await team.sendMessage({ conversationId: room.id, content: '第一轮' });
    const executionId = singleExecutionId(db, room.id, sent.wakes);
    await waitForConversationIdle(room.id);

    const first = team.getExecution(executionId);
    const firstSnapshot = first.configSnapshot;
    assert.ok(firstSnapshot, '跑完一轮必须留下配置快照');
    assert.equal(firstSnapshot.memberRevision, team.getMember(alice.id).updatedAt);
    assert.equal(firstSnapshot.model, config.defaultModel);
    assert.equal(firstSnapshot.hostToolsEnabled, config.allowHostCodingTools);
    assert.match(firstSnapshot.systemPromptHash, /^[\da-f]{64}$/);
    assert.match(firstSnapshot.memoryHash, /^[\da-f]{64}$/);
    // 能力组成的指纹：这一轮到底用了哪个 skill / knowledge / tool 实现
    assert.match(firstSnapshot.capabilityManifestHash, /^[\da-f]{64}$/);

    // 换人格 + 加记忆，然后 retry 同一条 execution
    team.updateMember(alice.id, {
      role: 'Risk Reviewer',
      systemPrompt: 'Always argue the downside first.',
    });
    memberService.appendMemory(alice.id, '现在偏好先看风险');

    const { executionId: retryId } = team.retryExecution(executionId);
    await waitForConversationIdle(room.id);

    const retry = team.getExecution(retryId);
    assert.equal(retry.retryOfExecutionId, executionId);

    const retrySnapshot = retry.configSnapshot;
    assert.ok(retrySnapshot, 'retry 也要有自己的快照（不是继承原记录）');
    assert.notEqual(retrySnapshot.memberRevision, firstSnapshot.memberRevision);
    assert.notEqual(retrySnapshot.systemPromptHash, firstSnapshot.systemPromptHash);
    assert.notEqual(retrySnapshot.memoryHash, firstSnapshot.memoryHash);
    // 原记录的快照不被改写：它是「当时」的事实
    assert.deepEqual(team.getExecution(executionId).configSnapshot, firstSnapshot);
  });

  it('历史 execution 没有快照时读出来是 null，不是坏掉的 JSON', () => {
    const alice = makeMember('Snapshot2 Alice', 'snapshot2-alice');
    const room = team.createConversation({ kind: 'direct', memberIds: [alice.id] });

    db.prepare(
      `
      INSERT INTO execution (id, conversation_id, member_id, delegation_path, kind, status, prompt, created_at)
      VALUES ('legacy-exec', ?, ?, '[]', 'interactive', 'completed', 'p', 't')
      `,
    ).run(room.id, alice.id);

    assert.equal(team.getExecution('legacy-exec').configSnapshot, null);
  });
});

// -------------------------------------------- 6. 房间状态的实时（durable）事件

describe('conversation_member_state.updated', () => {
  it('状态变化会落库并广播，且广播时 DB 里已经是新状态', async () => {
    const alice = makeMember('State Alice', 'state-alice');
    const room = team.createConversation({ kind: 'direct', memberIds: [alice.id] });

    const received: Array<{
      memberId: string;
      wakeStatus: string;
      pendingWake: boolean;
      /** 在订阅回调里当场读 DB 得到的状态 —— 用来验证「先落库、后广播」 */
      persisted: string;
    }> = [];

    const unsubscribe = team.subscribe(room.id, (event) => {
      if (event.type !== 'conversation_member_state.updated') return;
      const change = event.data as { memberId: string; state: { wakeStatus: string } | null };
      if (!change.state) return;

      const row = db
        .prepare(
          `SELECT wake_status FROM conversation_member_state WHERE conversation_id = ? AND member_id = ?`,
        )
        .get(room.id, change.memberId) as unknown as { wake_status: string };

      received.push({
        memberId: change.memberId,
        wakeStatus: change.state.wakeStatus,
        pendingWake: false,
        persisted: row.wake_status,
      });
    });

    try {
      await team.sendMessage({ conversationId: room.id, content: '跑一轮' });
      await waitForConversationIdle(room.id);
    } finally {
      unsubscribe();
    }

    assert.ok(received.length > 0, '一个 turn 至少会产生几次状态变化（排队 → 在跑 → 读游标）');

    // 收到的每一条，DB 里都已经是它说的那个值。
    // 事务里的状态翻转（execution 落库 + beginWake）尤其重要：反过来的话，
    // 一次回滚会留下「前端看到过、DB 不承认」的状态。
    for (const item of received) {
      assert.equal(item.wakeStatus, item.persisted);
    }

    // 走过 queued 与 running 两个阶段，最后回到 idle
    const statuses = received.map((item) => item.wakeStatus);
    assert.ok(statuses.includes('queued'), `没见过 queued：${statuses.join(',')}`);
    assert.ok(statuses.includes('running'), `没见过 running：${statuses.join(',')}`);
    assert.equal(statuses[statuses.length - 1], 'idle');
  });

  it('回放全部状态事件，得到的就是当前状态（重连不会看到旧值）', async () => {
    const alice = makeMember('State2 Alice', 'state2-alice');
    const bob = makeMember('State2 Bob', 'state2-bob');

    const room = team.createConversation({
      kind: 'group',
      title: 'State',
      memberIds: [alice.id, bob.id],
    });
    // 只静音 bob：alice 会被正常唤醒，于是回放里真的包含 queued / running / idle
    // 这些状态翻转，而不只是建房间时那一条「状态行出现了」。
    team.setMemberMuted(room.id, bob.id, true);

    await team.sendMessage({ conversationId: room.id, content: '一条用户消息' });
    await waitForConversationIdle(room.id);

    // 从 0 回放（就是浏览器刷新页面时走的那条路），按顺序应用每一条状态事件。
    // 这里的「应用」逻辑刻意和前端 applyStateChanged 保持一致：
    // state 为 null 就是删掉，否则整体替换。
    const replayed = new Map<string, { wakeStatus: string; lastSeenMessageSequence: number }>();
    for (const event of team.listEventsSince(room.id, 0, 5000)) {
      if (event.type !== 'conversation_member_state.updated') continue;
      const change = event.data as {
        memberId: string;
        state: { wakeStatus: string; lastSeenMessageSequence: number } | null;
      };
      assert.ok(change.memberId, 'payload 必须带 memberId');
      if (change.state) replayed.set(change.memberId, change.state);
      else replayed.delete(change.memberId);
    }

    // 回放出来的状态必须至少经历过一次「在跑」，否则这条用例没测到真正的翻转
    assert.ok(
      [...replayed.values()].some((state) => state.lastSeenMessageSequence > 0),
      `回放里没有任何读游标前进：${JSON.stringify([...replayed])}`,
    );

    const current = team.listConversationState(room.id);
    assert.equal(replayed.size, current.length);
    for (const state of current) {
      const fromReplay = replayed.get(state.memberId);
      assert.ok(fromReplay, `${state.memberId} 在回放里没有状态`);
      assert.equal(fromReplay.wakeStatus, state.wakeStatus);
      assert.equal(fromReplay.lastSeenMessageSequence, state.lastSeenMessageSequence);
    }
  });

  it('成员被移出房间时广播 state=null（前端据此删掉本地那份）', () => {
    const alice = makeMember('State3 Alice', 'state3-alice');
    const bob = makeMember('State3 Bob', 'state3-bob');
    const carol = makeMember('State3 Carol', 'state3-carol');

    const room = team.createConversation({
      kind: 'group',
      title: 'Removal',
      memberIds: [alice.id, bob.id, carol.id],
    });

    const seen: Array<{ memberId: string; state: unknown }> = [];
    const unsubscribe = team.subscribe(room.id, (event) => {
      if (event.type !== 'conversation_member_state.updated') return;
      seen.push(event.data as { memberId: string; state: unknown });
    });

    try {
      team.removeMember(room.id, carol.id);
    } finally {
      unsubscribe();
    }

    const removal = seen.filter((item) => item.memberId === carol.id && item.state === null);
    assert.equal(removal.length, 1, `应当广播恰好一条 state=null：${JSON.stringify(seen)}`);
    assert.ok(
      !team.listConversationState(room.id).some((state) => state.memberId === carol.id),
      '移出后不该再出现在状态列表里',
    );
  });
});

// -------------------------------------------------------- 7. @mention 解析
describe('@mention 只做精确匹配', () => {
  const members = [
    { id: 'm1', handle: 'alice', name: 'Alice' },
    { id: 'm2', handle: 'anna', name: 'Anna' },
    { id: 'm3', handle: 'chen', name: 'Alice Chen' },
  ] as unknown as Member[];

  it('@ann 不再匹配到 @anna（前缀猜测是最容易搞错收件人的那种）', () => {
    const result = resolveMentions('@ann 看一下', members);
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unresolved, ['ann']);
  });

  it('token 比 handle 长时不再被前缀吃掉（@alicexyz ≠ @alice）', () => {
    // 这是前缀兜底真正会猜错的那个方向：旧实现是 `token.startsWith(key)`，
    // 所以任何以某个 handle / name 开头的字符串都会被算成命中 ——
    // `@Bobby`（在喊一个不在房间里的人）会被解析成 `@Bob`，
    // `@annax` 会被解析成 `@anna`。消息发给错误的人，而且没有任何提示。
    for (const text of ['@alicexyz 看一下', '@annax 看一下', '@AliceChenExtra 看一下']) {
      const result = resolveMentions(text, members);
      assert.deepEqual(result.matched, [], `${text} 不该命中任何人`);
      assert.equal(result.unresolved.length, 1, `${text} 应当报「没匹配到」`);
    }

    // 精确写法照常命中
    assert.deepEqual(
      resolveMentions('@anna', members).matched.map((member) => member.id),
      ['m2'],
    );
  });

  it('带空格的 name 被空格截断后，只认精确命中，不再靠前缀猜到别人头上', () => {
    // `@Alice Chen` 取出来的 token 是 `Alice`。以前这里会走前缀匹配，
    // 命中的是**谁**取决于索引顺序和谁的名字更长 —— 也就是「猜」。
    //
    // 现在只有两个确定性结果：精确命中某个 handle / name，或者报没匹配到。
    const withHandle = resolveMentions('@Alice Chen 看下', members);
    // members 里有一个 handle 恰好是 `alice`，所以这条是**精确命中**，
    // 不是猜错：用户写出来的 token 就是它。
    assert.deepEqual(
      withHandle.matched.map((member) => member.id),
      ['m1'],
    );

    // 换成没有 handle 冲突的 roster，同样的写法就只能报「没匹配到」
    const noConflict = members.filter((member) => member.handle !== 'alice');
    const rejected = resolveMentions('@Alice Chen 看下', noConflict);
    assert.deepEqual(rejected.matched, []);
    assert.deepEqual(rejected.unresolved, ['Alice']);

    // 去掉空格写就能命中 name（这是 name 索引里真实存在的 key）
    const compact = resolveMentions('@AliceChen 看下', noConflict);
    assert.deepEqual(
      compact.matched.map((member) => member.id),
      ['m3'],
    );
  });

});
