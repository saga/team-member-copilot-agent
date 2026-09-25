import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CopilotService } from '../copilot.js';

/**
 * Runtime reliability 测试（Commit 1 + Commit 2）。
 *
 * 覆盖四件事：
 *   1. schema 迁移    —— PRAGMA user_version / 序号回填 / 外键完整 / 幂等
 *   2. 序号与 checkpoint —— message_sequence 全序、增量上下文、成功才推进水位
 *   3. durable event  —— 落库 + Last-Event-ID 回放 + message.delta 不落库
 *   4. 恢复与死锁保护  —— RecoveryService / wait-for 环 / retry
 *
 * 同样不碰真实 Copilot runtime：临时 DATA_DIR + stub Copilot。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-reliability-'));
// 必须在 import config.ts 之前设好，否则 db 会落到仓库的 .data/
process.env.DATA_DIR = dataDir;
process.env.MAX_DELEGATION_DEPTH = '4';
process.env.COPILOT_WARMUP = 'false';

const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { TeamService } = await import('../team-service.js');
const { ContextAssembler } = await import('../context-assembler.js');
const { RecoveryService } = await import('../recovery-service.js');
const { migrate, getUserVersion, SCHEMA_VERSION, V1_SCHEMA_SQL } = await import(
  '../db-migrations.js'
);

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

interface TurnInput {
  runtime: { id: string; conversationId: string; memberId: string };
  member: { id: string };
  prompt: string;
  executionId: string;
}

class StubCopilot {
  readonly turns: TurnInput[] = [];
  /** 让下一次（或接下来每一次）turn 抛错，用来验证失败路径。 */
  failWith: string | null = null;
  /** 挂住 turn，用来把 execution 稳定地停在 running 状态做断言。 */
  hold: Promise<void> | null = null;

  async runMemberTurn(input: TurnInput): Promise<string> {
    this.turns.push(input);
    if (this.hold) await this.hold;
    if (this.failWith) throw new Error(this.failWith);
    return `stub reply from ${input.member.id}`;
  }

  turnsFor(memberId: string): TurnInput[] {
    return this.turns.filter((turn) => turn.member.id === memberId);
  }
}

function tableColumns(handle: DatabaseSync, table: string): string[] {
  const rows = handle.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function executionRow(id: string) {
  const row = db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
    | {
        id: string;
        status: string;
        runtime_id: string | null;
        waiting_for_runtime_id: string | null;
        retry_of_execution_id: string | null;
        delegation_path: string;
        response: string | null;
      }
    | undefined;
  assert.ok(row, `execution ${id} 不存在`);
  return row;
}

function runtimeRow(conversationId: string, memberId: string) {
  return db
    .prepare(`SELECT * FROM member_runtime WHERE conversation_id = ? AND member_id = ?`)
    .get(conversationId, memberId) as unknown as
    | {
        id: string;
        status: string;
        active_execution_id: string | null;
        last_context_message_sequence: number;
      }
    | undefined;
}

async function waitForStatus(id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (executionRow(id).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`execution ${id} 未变成 ${status}（当前 ${executionRow(id).status}）`);
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

// ------------------------------------------------------------- 1. migration

describe('schema migration（PRAGMA user_version）', () => {
  function openFixture(name: string): DatabaseSync {
    const handle = new DatabaseSync(path.join(dataDir, `${name}.db`));
    handle.exec('PRAGMA foreign_keys = ON;');
    return handle;
  }

  it('全新库直接建 v2 并登记 user_version', () => {
    const handle = openFixture('fresh');
    try {
      const result = migrate(handle);
      assert.equal(result.fresh, true);
      assert.equal(result.from, 0);
      assert.equal(result.to, SCHEMA_VERSION);
      assert.equal(getUserVersion(handle), SCHEMA_VERSION);

      assert.ok(tableColumns(handle, 'conversation').includes('event_sequence'));
      assert.ok(tableColumns(handle, 'conversation').includes('message_sequence'));
      assert.ok(tableColumns(handle, 'conversation_message').includes('message_sequence'));
      assert.ok(tableColumns(handle, 'member_runtime').includes('active_execution_id'));
      assert.ok(
        tableColumns(handle, 'member_runtime').includes('last_context_message_sequence'),
      );
      assert.ok(tableColumns(handle, 'execution').includes('waiting_for_runtime_id'));
      assert.ok(tableColumns(handle, 'execution').includes('retry_of_execution_id'));
      assert.ok(tableColumns(handle, 'conversation_event').includes('sequence'));

      // 新状态必须被 CHECK 接受
      handle.exec(`
        INSERT INTO member (id, handle, name, role, created_at, updated_at)
        VALUES ('m', 'm', 'M', 'R', 't', 't');
        INSERT INTO conversation (id, title, kind, created_by, created_at, updated_at)
        VALUES ('c', 'C', 'direct', 'u', 't', 't');
        INSERT INTO execution (id, conversation_id, member_id, kind, status, prompt, created_at)
        VALUES ('e', 'c', 'm', 'interactive', 'interrupted', 'p', 't');
      `);
    } finally {
      handle.close();
    }
  });

  it('v1 旧库升级到 v2：历史数据保留、序号回填、水位线同步', () => {
    const handle = openFixture('upgrade');
    try {
      handle.exec(V1_SCHEMA_SQL);
      // 两条历史消息刻意用**同一个 created_at**：验证序号回填不依赖时间精度
      handle.exec(`
        INSERT INTO member (id, handle, name, role, created_at, updated_at)
        VALUES ('m1', 'alice', 'Alice', 'Analyst', 't', 't');

        INSERT INTO conversation (id, title, kind, default_member_id, created_by, created_at, updated_at)
        VALUES ('c1', 'Legacy', 'direct', 'm1', 'u', 't', 't');

        INSERT INTO conversation_member (conversation_id, member_id, joined_at)
        VALUES ('c1', 'm1', 't');

        INSERT INTO member_runtime (id, conversation_id, member_id, copilot_session_id, workspace_path, status)
        VALUES ('r1', 'c1', 'm1', 'sess-1', '/tmp/ws', 'idle');

        INSERT INTO conversation_message (id, conversation_id, sender_type, sender_id, content, created_at)
        VALUES ('msg1', 'c1', 'user', 'u', 'first', '2026-01-01T00:00:00.000Z'),
               ('msg2', 'c1', 'member', 'm1', 'second', '2026-01-01T00:00:00.000Z');

        INSERT INTO execution (id, conversation_id, member_id, runtime_id, delegation_path, kind, status, prompt, created_at)
        VALUES ('e1', 'c1', 'm1', 'r1', '["m1"]', 'interactive', 'completed', 'hello', 't'),
               ('e2', 'c1', 'm1', 'r1', '["m1","m1"]', 'member_delegate', 'failed', 'child', 't');
      `);

      const result = migrate(handle);
      assert.equal(result.fresh, false);
      assert.equal(result.from, 1);
      assert.equal(result.to, 2);
      assert.deepEqual(result.applied, ['v1-to-v2']);

      // 1) 消息序号按 (created_at, rowid) 回填成 1..N
      // 注意：node:sqlite 返回的是 null-prototype 对象，断言前要先摊平成普通对象
      const messages = (
        handle
          .prepare(
            `SELECT id, message_sequence FROM conversation_message WHERE conversation_id = 'c1' ORDER BY message_sequence`,
          )
          .all() as unknown as Array<{ id: string; message_sequence: number }>
      ).map((row) => ({ ...row }));
      assert.deepEqual(messages, [
        { id: 'msg1', message_sequence: 1 },
        { id: 'msg2', message_sequence: 2 },
      ]);

      // 2) conversation 计数器追上历史消息，否则下一条会撞 UNIQUE
      const conversation = handle
        .prepare(`SELECT message_sequence FROM conversation WHERE id = 'c1'`)
        .get() as unknown as { message_sequence: number };
      assert.equal(conversation.message_sequence, 2);

      // 3) runtime 水位线推到最大序号：旧实现每轮都注入最近 24 条，
      //    升级后立刻再注入一次全量会造成重复
      const runtime = handle
        .prepare(`SELECT last_context_message_sequence FROM member_runtime WHERE id = 'r1'`)
        .get() as unknown as { last_context_message_sequence: number };
      assert.equal(runtime.last_context_message_sequence, 2);

      // 4) execution 行原样保留，新列默认 NULL
      const executions = (
        handle
          .prepare(
            `SELECT id, status, waiting_for_runtime_id, retry_of_execution_id FROM execution ORDER BY id`,
          )
          .all() as unknown as Array<{
          id: string;
          status: string;
          waiting_for_runtime_id: string | null;
          retry_of_execution_id: string | null;
        }>
      ).map((row) => ({ ...row }));
      assert.deepEqual(executions, [
        {
          id: 'e1',
          status: 'completed',
          waiting_for_runtime_id: null,
          retry_of_execution_id: null,
        },
        {
          id: 'e2',
          status: 'failed',
          waiting_for_runtime_id: null,
          retry_of_execution_id: null,
        },
      ]);

      // 5) 重建 execution 后自引用外键仍然生效
      assert.throws(
        () =>
          handle.exec(`
            INSERT INTO execution (id, conversation_id, member_id, parent_execution_id, kind, status, prompt, created_at)
            VALUES ('bad', 'c1', 'm1', 'does-not-exist', 'member_delegate', 'queued', 'p', 't');
          `),
        /FOREIGN KEY/i,
      );

      // 6) 整体外键完整
      assert.deepEqual(handle.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      handle.close();
    }
  });

  it('迁移幂等：重复执行不会重复施加', () => {
    const handle = openFixture('idempotent');
    try {
      migrate(handle);
      const second = migrate(handle);
      assert.equal(second.from, SCHEMA_VERSION);
      assert.equal(second.to, SCHEMA_VERSION);
      assert.deepEqual(second.applied, []);
    } finally {
      handle.close();
    }
  });

  it('拒绝打开比本程序更新的 schema', () => {
    const handle = openFixture('future');
    try {
      migrate(handle);
      handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      assert.throws(() => migrate(handle), /高于本程序支持/);
    } finally {
      handle.close();
    }
  });
});

// ---------------------------------------------- 2/3/4. runtime reliability

const stub = new StubCopilot();
const memberService = new MemberService(db);
const team = new TeamService(db, memberService, stub as unknown as CopilotService);

const alice = team.createMember({ name: 'Alice', role: 'Analyst' });
const bob = team.createMember({ name: 'Bob', role: 'Reviewer' });

describe('message_sequence 是会话内严格全序', () => {
  it('同一毫秒内的多条消息也不会撞序号', async () => {
    const solo = team.createConversation({
      kind: 'direct',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    // 不 await，让三条 sendMessage 在同一个 tick 里排队写入
    const results = await Promise.all([
      team.sendMessage({ conversationId: solo.id, content: 'a' }),
      team.sendMessage({ conversationId: solo.id, content: 'b' }),
      team.sendMessage({ conversationId: solo.id, content: 'c' }),
    ]);
    await waitForConversationIdle(solo.id);

    const sequences = results
      .map((result) => result.message.messageSequence)
      .sort((a, b) => a - b);
    assert.deepEqual(sequences, [1, 2, 3], '序号必须是 1..3 且互不相同');

    const stored = team.listMessages(solo.id, 500);
    assert.deepEqual(
      stored.map((message) => message.messageSequence),
      stored.map((_, index) => index + 1),
      '落库后的序号必须是连续的 1..N',
    );

    const counter = db
      .prepare(`SELECT message_sequence FROM conversation WHERE id = ?`)
      .get(solo.id) as unknown as { message_sequence: number };
    assert.equal(counter.message_sequence, stored.length);
  });
});

describe('ContextAssembler：增量上下文而不是整段重放', () => {
  it('只注入「上次成功 turn 之后新增」的消息，并排除自己与触发消息', async () => {
    const conv = team.createConversation({
      kind: 'group',
      title: 'Incremental',
      memberIds: [alice.id, bob.id],
      defaultMemberId: alice.id,
    });

    // 1) Alice 先说话
    const first = await team.sendMessage({
      conversationId: conv.id,
      content: 'ALICE-FIRST',
      targetMemberId: alice.id,
    });
    await waitForStatus(first.executionId, 'completed');

    // 2) Bob 第一次发言：应该看到 Alice 的回复
    const bobFirst = await team.sendMessage({
      conversationId: conv.id,
      content: 'BOB-FIRST',
      targetMemberId: bob.id,
    });
    await waitForStatus(bobFirst.executionId, 'completed');

    const bobTurn1 = stub.turnsFor(bob.id).at(-1);
    assert.ok(bobTurn1);
    assert.match(bobTurn1.prompt, /stub reply from/, 'Bob 应该看到 Alice 的回复');
    assert.match(bobTurn1.prompt, /Shared conversation context/);
    assert.match(bobTurn1.prompt, /ALICE-FIRST/, '也应该看到触发 Alice 的那条用户消息');
    assert.match(bobTurn1.prompt, /Current task:\s*BOB-FIRST/);

    // 3) Alice 再说一句
    const second = await team.sendMessage({
      conversationId: conv.id,
      content: 'ALICE-SECOND',
      targetMemberId: alice.id,
    });
    await waitForStatus(second.executionId, 'completed');

    // 4) Bob 第二次发言：只应该看到 Alice 的第二句
    const bobSecond = await team.sendMessage({
      conversationId: conv.id,
      content: 'BOB-SECOND',
      targetMemberId: bob.id,
    });
    await waitForStatus(bobSecond.executionId, 'completed');

    const bobTurn2 = stub.turnsFor(bob.id).at(-1);
    assert.ok(bobTurn2);
    assert.match(bobTurn2.prompt, /ALICE-SECOND/, '新消息必须注入');
    assert.doesNotMatch(
      bobTurn2.prompt,
      /ALICE-FIRST/,
      '老消息不能重复注入 —— 它在 Bob 的 Copilot session history 里已经有了',
    );
    assert.doesNotMatch(
      bobTurn2.prompt,
      /BOB-FIRST/,
      'Bob 自己产出的历史消息不能回灌给自己',
    );

    // checkpoint 覆盖了被过滤掉的消息（否则下一轮还会重复读到它们）
    const runtime = runtimeRow(conv.id, bob.id);
    assert.ok(runtime);
    assert.ok(runtime.last_context_message_sequence > 0);
  });

  it('consumedThroughSequence 覆盖被过滤的消息', () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'Watermark',
      memberIds: [alice.id],
      defaultMemberId: alice.id,
    });
    const assembler = new ContextAssembler(db);

    // 直接构造两条都会被过滤掉的消息：
    //   mm1 —— 该 runtime 自己产出的（session history 里已有 assistant turn）
    //   mm2 —— 触发本次 turn 的那条（内容就是 currentPrompt）
    db.prepare(
      `INSERT INTO conversation_message (id, conversation_id, message_sequence, sender_type, sender_id, content, execution_id, created_at)
       VALUES ('mm1', ?, 1, 'member', ?, 'own', 'exec-old', 't'),
              ('mm2', ?, 2, 'user', 'u', 'trigger', 'exec-now', 't')`,
    ).run(conv.id, alice.id, conv.id);

    const result = assembler.assemble({
      runtime: {
        id: 'r',
        conversationId: conv.id,
        memberId: alice.id,
        copilotSessionId: 's',
        workspacePath: '/tmp',
        status: 'idle',
        activeExecutionId: null,
        lastContextMessageSequence: 0,
        lastUsedAt: null,
      },
      currentExecutionId: 'exec-now',
      currentPrompt: 'trigger',
    });

    assert.deepEqual(result.sharedMessages, [], '两条消息都应该被过滤掉');
    assert.equal(result.consumedThroughSequence, 2, '水位线必须覆盖被过滤的消息');
  });
});

describe('checkpoint 只在 turn 成功后推进', () => {
  it('turn 失败时 last_context_message_sequence 保持不变', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'Failure',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    const ok = await team.sendMessage({ conversationId: conv.id, content: 'OK-1' });
    await waitForStatus(ok.executionId, 'completed');
    const afterSuccess = runtimeRow(conv.id, bob.id);
    assert.ok(afterSuccess);
    const watermark = afterSuccess.last_context_message_sequence;
    assert.ok(watermark > 0);

    stub.failWith = 'boom';
    try {
      const failed = await team.sendMessage({ conversationId: conv.id, content: 'WILL-FAIL' });
      await waitForStatus(failed.executionId, 'failed');
    } finally {
      stub.failWith = null;
    }

    const afterFailure = runtimeRow(conv.id, bob.id);
    assert.ok(afterFailure);
    assert.equal(
      afterFailure.last_context_message_sequence,
      watermark,
      '失败不能推进水位线，否则那段上下文就永远丢了',
    );
    assert.equal(afterFailure.status, 'error');
    assert.equal(afterFailure.active_execution_id, null, '失败后必须释放单写者占用');
  });
});

describe('runtime 单写者', () => {
  it('并发两轮不会交叉执行，结束后 active_execution_id 归零', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'SingleWriter',
      memberIds: [alice.id],
      defaultMemberId: alice.id,
    });

    const before = stub.turns.length;
    const [a, b] = await Promise.all([
      team.sendMessage({ conversationId: conv.id, content: 'one' }),
      team.sendMessage({ conversationId: conv.id, content: 'two' }),
    ]);
    await waitForStatus(a.executionId, 'completed');
    await waitForStatus(b.executionId, 'completed');
    await waitForConversationIdle(conv.id);

    const runtime = runtimeRow(conv.id, alice.id);
    assert.ok(runtime);
    assert.equal(runtime.status, 'idle');
    assert.equal(runtime.active_execution_id, null, '跑完必须把单写者占用清掉');

    // 两轮都用同一个 runtime 串行执行
    const turns = stub.turns.slice(before);
    assert.equal(turns.length, 2);
    assert.equal(new Set(turns.map((turn) => turn.runtime.id)).size, 1);
  });
});

describe('wait-for 环检测（跨 delegation 树的死锁保护）', () => {
  it('目标 runtime 正在等自己时，delegation 被拒绝', async () => {
    const conv = team.createConversation({
      kind: 'group',
      title: 'WaitFor',
      memberIds: [alice.id, bob.id],
      defaultMemberId: alice.id,
    });

    const aliceRun = await team.sendMessage({
      conversationId: conv.id,
      content: 'A',
      targetMemberId: alice.id,
    });
    await waitForStatus(aliceRun.executionId, 'completed');

    const bobRun = await team.sendMessage({
      conversationId: conv.id,
      content: 'B',
      targetMemberId: bob.id,
    });
    await waitForStatus(bobRun.executionId, 'completed');

    const aliceRuntime = runtimeRow(conv.id, alice.id);
    const bobRuntime = runtimeRow(conv.id, bob.id);
    assert.ok(aliceRuntime);
    assert.ok(bobRuntime);

    // 手工构造：Alice 的 execution 正停在「等 Bob 的 runtime」。
    // 等价于 Alice 已经 ask_member(Bob) 且还没返回。
    db.prepare(
      `UPDATE execution SET status = 'waiting_for_member', waiting_for_runtime_id = ? WHERE id = ?`,
    ).run(bobRuntime.id, aliceRun.executionId);

    try {
      // Bob 现在想把任务委派回 Alice：Bob 会等 Alice 的 runtime，
      // 而 Alice 正在等 Bob 的 runtime → 环，必须被拦住
      await assert.rejects(
        () =>
          team.delegateMember({
            conversationId: conv.id,
            fromMemberId: bob.id,
            parentExecutionId: bobRun.executionId,
            targetMemberId: alice.id,
            task: 'deadlock',
          }),
        /等待环/,
      );

      const count = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND kind = 'member_delegate'`,
        )
        .get(conv.id) as unknown as { n: number };
      assert.equal(count.n, 0, '被拒绝的 delegation 不能写入 execution');
    } finally {
      db.prepare(
        `UPDATE execution SET status = 'completed', waiting_for_runtime_id = NULL WHERE id = ?`,
      ).run(aliceRun.executionId);
    }
  });

  it('正常 A → B 委派期间父 execution 进入 waiting_for_member，结束后还原', async () => {
    const conv = team.createConversation({
      kind: 'group',
      title: 'Waiting',
      memberIds: [alice.id, bob.id],
      defaultMemberId: alice.id,
    });

    const parent = await team.sendMessage({
      conversationId: conv.id,
      content: 'parent',
      targetMemberId: alice.id,
    });
    await waitForStatus(parent.executionId, 'completed');

    const seenWaiting: Array<{ status: string; waitingFor: string | null }> = [];
    const unsubscribe = team.subscribe(conv.id, (event) => {
      if (event.type !== 'execution.updated') return;
      const data = event.data as {
        id: string;
        status: string;
        waitingForRuntimeId: string | null;
      };
      if (data.id === parent.executionId) {
        seenWaiting.push({ status: data.status, waitingFor: data.waitingForRuntimeId });
      }
    });

    try {
      await team.delegateMember({
        conversationId: conv.id,
        fromMemberId: alice.id,
        parentExecutionId: parent.executionId,
        targetMemberId: bob.id,
        task: 'delegate',
      });
    } finally {
      unsubscribe();
    }

    const waiting = seenWaiting.find((item) => item.status === 'waiting_for_member');
    assert.ok(waiting, `父 execution 应该经过 waiting_for_member：${JSON.stringify(seenWaiting)}`);
    assert.equal(waiting.waitingFor, runtimeRow(conv.id, bob.id)?.id);

    const finalRow = executionRow(parent.executionId);
    assert.notEqual(finalRow.status, 'waiting_for_member', '结束后必须还原');
    assert.equal(finalRow.waiting_for_runtime_id, null);
  });
});

describe('durable conversation_event 与 SSE 回放', () => {
  it('durable 事件带递增 sequence，message.delta 不落库', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'Events',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    const seen: Array<{ type: string; sequence: number | null }> = [];
    const unsubscribe = team.subscribe(conv.id, (event) => {
      seen.push({ type: event.type, sequence: event.sequence });
    });

    try {
      const sent = await team.sendMessage({ conversationId: conv.id, content: 'hello' });
      await waitForStatus(sent.executionId, 'completed');
    } finally {
      unsubscribe();
    }

    assert.ok(seen.length > 0);
    // 订阅拿到的事件里 durable 的必须带 sequence，且严格递增
    const sequences = seen
      .map((event) => event.sequence)
      .filter((value): value is number => value !== null);
    assert.ok(sequences.length >= 3, `durable 事件太少：${JSON.stringify(seen)}`);
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(sequences[index] > sequences[index - 1], 'sequence 必须严格递增');
    }

    // 落库的条数与广播到的 durable 条数一致
    const stored = db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_event WHERE conversation_id = ?`)
      .get(conv.id) as unknown as { n: number };
    assert.equal(stored.n, sequences.length);
    assert.equal(
      (db.prepare(`SELECT event_sequence AS n FROM conversation WHERE id = ?`).get(conv.id) as {
        n: number;
      }).n,
      sequences.length,
    );

    // message.delta 是 token 级事件：不落库
    const deltaRows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_event WHERE conversation_id = ? AND event_type = 'message.delta'`,
      )
      .get(conv.id) as unknown as { n: number };
    assert.equal(deltaRows.n, 0);
  });

  it('listEventsSince 只返回水位之后的事件', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'Replay',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    const first = await team.sendMessage({ conversationId: conv.id, content: 'one' });
    await waitForStatus(first.executionId, 'completed');

    const all = team.listEventsSince(conv.id, 0);
    assert.ok(all.length > 0);
    const highWater = all[all.length - 1].sequence;
    assert.ok(highWater !== null);

    const second = await team.sendMessage({ conversationId: conv.id, content: 'two' });
    await waitForStatus(second.executionId, 'completed');

    const incremental = team.listEventsSince(conv.id, highWater);
    assert.ok(incremental.length > 0, '水位之后必须有新事件');
    for (const event of incremental) {
      assert.ok((event.sequence ?? 0) > highWater);
    }
    // 回放是幂等可重复的
    assert.deepEqual(
      incremental.map((event) => event.id),
      team.listEventsSince(conv.id, highWater).map((event) => event.id),
    );
  });

  it('replayAndSubscribe 先补历史再推实时，且不重复投递', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'ReplaySubscribe',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    const first = await team.sendMessage({ conversationId: conv.id, content: 'history' });
    await waitForStatus(first.executionId, 'completed');

    const history = team.listEventsSince(conv.id, 0);
    const highWater = history[history.length - 1].sequence as number;

    const received: Array<number | null> = [];
    const unsubscribe = team.replayAndSubscribe(conv.id, highWater, (event) => {
      received.push(event.sequence);
    });

    try {
      // 订阅建立后立刻产生的新事件必须被推送到
      const second = await team.sendMessage({ conversationId: conv.id, content: 'live' });
      await waitForStatus(second.executionId, 'completed');
    } finally {
      unsubscribe();
    }

    const durable = received.filter((value): value is number => value !== null);
    assert.ok(durable.length > 0, '实时事件没有被推送到');
    assert.ok(
      durable.every((sequence) => sequence > highWater),
      `不应该重复回放水位以内的事件：${durable.join(',')}`,
    );
    // 严格递增且无重复
    assert.equal(new Set(durable).size, durable.length);
    for (let index = 1; index < durable.length; index += 1) {
      assert.ok(durable[index] > durable[index - 1]);
    }
  });

  it('从 0 回放能重建整个会话事件流', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'FullReplay',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    const sent = await team.sendMessage({ conversationId: conv.id, content: 'rebuild' });
    await waitForStatus(sent.executionId, 'completed');

    const replayed: string[] = [];
    const unsubscribe = team.replayAndSubscribe(conv.id, 0, (event) => {
      if (event.sequence !== null) replayed.push(event.type);
    });
    unsubscribe();

    assert.ok(replayed.includes('message.created'));
    assert.ok(replayed.includes('execution.updated'));
  });

  it('回放覆盖全部历史事件，sequence 是连续无洞的 1..N', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'GapFreeReplay',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    for (const text of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const sent = await team.sendMessage({ conversationId: conv.id, content: text });
      await waitForStatus(sent.executionId, 'completed');
    }

    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM conversation_event WHERE conversation_id = ?`)
        .get(conv.id) as unknown as { n: number }
    ).n;
    assert.ok(total > 10, `前置条件：事件数应该足够多，实际 ${total}`);

    const seen: number[] = [];
    const unsubscribe = team.replayAndSubscribe(conv.id, 0, (event) => {
      if (event.sequence !== null) seen.push(event.sequence);
    });
    unsubscribe();

    // 分页循环不能漏事件，否则重连后 UI 会缺一段历史
    assert.deepEqual(
      seen,
      Array.from({ length: total }, (_, index) => index + 1),
      '回放必须是连续无洞的 1..N',
    );
  });
});

describe('RecoveryService', () => {
  it('running/waiting_for_member → interrupted，queued root 重新提交，queued child 中断', () => {
    const handle = new DatabaseSync(path.join(dataDir, 'recovery.db'));
    handle.exec('PRAGMA foreign_keys = ON;');
    migrate(handle);

    handle.exec(`
      INSERT INTO member (id, handle, name, role, created_at, updated_at)
      VALUES ('m', 'm', 'M', 'R', 't', 't');

      -- 两个 conversation：member_runtime 有 UNIQUE(conversation_id, member_id)，
      -- 同一个 Member 在同一 conversation 里只能有一个 runtime
      INSERT INTO conversation (id, title, kind, created_by, created_at, updated_at)
      VALUES ('c', 'C', 'direct', 'u', 't', 't'),
             ('c2', 'C2', 'direct', 'u', 't', 't');

      INSERT INTO conversation_member (conversation_id, member_id, joined_at)
      VALUES ('c', 'm', 't'), ('c2', 'm', 't');

      INSERT INTO member_runtime (id, conversation_id, member_id, copilot_session_id, workspace_path, status, active_execution_id, last_context_message_sequence)
      VALUES ('r-running', 'c',  'm', 's1', '/tmp/1', 'running', 'e-running', 3),
             ('r-idle',    'c2', 'm', 's2', '/tmp/2', 'idle',    NULL,        0);

      INSERT INTO execution (id, conversation_id, member_id, runtime_id, parent_execution_id, delegation_path, kind, status, prompt, waiting_for_runtime_id, created_at)
      VALUES ('e-running', 'c',  'm', 'r-running', NULL,     '["m"]',     'interactive',     'running',            'p', NULL,         '1'),
             ('e-waiting', 'c2', 'm', 'r-idle',    NULL,     '["m"]',     'interactive',     'waiting_for_member', 'p', 'r-running',  '2'),
             ('e-qroot',   'c2', 'm', 'r-idle',    NULL,     '["m"]',     'interactive',     'queued',             'p', NULL,         '3'),
             ('e-qchild',  'c2', 'm', 'r-idle',    'e-qroot','["m","m"]', 'member_delegate', 'queued',             'p', NULL,         '4'),
             ('e-done',    'c2', 'm', 'r-idle',    NULL,     '["m"]',     'interactive',     'completed',          'p', NULL,         '5');
    `);

    const report = new RecoveryService(handle).recover();

    assert.equal(report.interrupted, 2, 'running + waiting_for_member');
    assert.equal(report.interruptedOrphanChildren, 1);
    assert.deepEqual(report.requeuedExecutionIds, ['e-qroot']);
    assert.equal(report.activeExecutionCleared, 1);
    assert.equal(report.runtimesReset, 1);

    const statuses = handle
      .prepare(`SELECT id, status, waiting_for_runtime_id, ended_at FROM execution ORDER BY id`)
      .all() as unknown as Array<{
      id: string;
      status: string;
      waiting_for_runtime_id: string | null;
      ended_at: string | null;
    }>;

    const byId = new Map(statuses.map((row) => [row.id, row]));
    assert.equal(byId.get('e-running')?.status, 'interrupted');
    assert.equal(byId.get('e-waiting')?.status, 'interrupted');
    assert.equal(byId.get('e-waiting')?.waiting_for_runtime_id, null);
    assert.equal(byId.get('e-qchild')?.status, 'interrupted');
    assert.equal(byId.get('e-qroot')?.status, 'queued', 'root 要留给调用方重新提交');
    assert.equal(byId.get('e-done')?.status, 'completed', '终态不能被改写');
    assert.ok(byId.get('e-running')?.ended_at);

    const runtime = handle
      .prepare(`SELECT status, active_execution_id FROM member_runtime WHERE id = 'r-running'`)
      .get() as unknown as { status: string; active_execution_id: string | null };
    assert.equal(runtime.status, 'idle');
    assert.equal(runtime.active_execution_id, null);

    // 幂等：再跑一次不会重复处理
    const second = new RecoveryService(handle).recover();
    assert.equal(second.interrupted, 0);
    assert.equal(second.interruptedOrphanChildren, 0);
    assert.deepEqual(second.requeuedExecutionIds, ['e-qroot']);

    handle.close();
  });
});

describe('retryExecution', () => {
  it('生成新 execution 并指回原记录，审计链不断', async () => {
    const conv = team.createConversation({
      kind: 'direct',
      title: 'Retry',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    stub.failWith = 'transient';
    let failedId = '';
    try {
      const failed = await team.sendMessage({ conversationId: conv.id, content: 'try' });
      failedId = failed.executionId;
      await waitForStatus(failedId, 'failed');
    } finally {
      stub.failWith = null;
    }

    const { executionId } = team.retryExecution(failedId);
    assert.notEqual(executionId, failedId);
    await waitForStatus(executionId, 'completed');

    const retry = executionRow(executionId);
    assert.equal(retry.status, 'completed');
    assert.equal(retry.retry_of_execution_id, failedId);
    assert.equal(retry.response?.includes('stub reply'), true);

    // 原记录保持 failed，不被改写 —— retry 是新增审计记录，不是覆盖
    assert.equal(executionRow(failedId).status, 'failed');

    // 进行中的 execution 不允许 retry。
    // 用 hold 把 turn 挂住，保证断言时它一定还停在 queued / running。
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const running = await team.sendMessage({ conversationId: conv.id, content: 'again' });
      assert.throws(() => team.retryExecution(running.executionId), /仍在进行中/);
      release();
      await waitForStatus(running.executionId, 'completed');
    } finally {
      release();
      stub.hold = null;
    }
  });
});

describe('config 暴露的可靠性开关', () => {
  it('recoverOnStartup 默认开启', () => {
    assert.equal(config.recoverOnStartup, true);
  });
});
