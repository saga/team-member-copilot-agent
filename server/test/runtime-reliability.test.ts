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
const { KnowledgeService } = await import('../knowledge-service.js');
const { TeamService } = await import('../team-service.js');
const { ContextAssembler } = await import('../context-assembler.js');
const { RecoveryService } = await import('../recovery-service.js');
const { ConversationMemberService } = await import('../conversation-member-service.js');
const { singleExecutionId, muteAllMembers } = await import('./support.js');
const { migrate, getUserVersion, SCHEMA_VERSION } = await import(
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

// ------------------------------------------------------ 1. schema 就位

describe('schema 就位（PRAGMA user_version）', () => {
  function openFixture(name: string): DatabaseSync {
    const handle = new DatabaseSync(path.join(dataDir, `${name}.db`));
    handle.exec('PRAGMA foreign_keys = ON;');
    return handle;
  }

  it('空库建出当前 schema 并登记 user_version', () => {
    const handle = openFixture('fresh');
    try {
      const result = migrate(handle);
      assert.equal(result.created, true);
      assert.equal(result.from, 0);
      assert.equal(result.to, SCHEMA_VERSION);
      assert.equal(getUserVersion(handle), SCHEMA_VERSION);

      // 新状态必须被 CHECK 接受
      handle.exec(`
        INSERT INTO member (id, handle, name, role, created_at, updated_at)
        VALUES ('m', 'm', 'M', 'R', 't', 't');
        INSERT INTO conversation (id, title, kind, created_by, created_at, updated_at)
        VALUES ('c', 'C', 'direct', 'u', 't', 't');
        INSERT INTO execution (id, conversation_id, member_id, kind, status, prompt, created_at)
        VALUES ('e', 'c', 'm', 'interactive', 'interrupted', 'p', 't');
      `);

      // 幂等键的唯一性真的落在库里，而不是只活在 service 的判断里。
      //
      // 这里同时验证 NULL 的语义：SQLite 的唯一索引把 NULL 视为互不相等，
      // 所以「不带幂等键」的消息可以无限多条 —— 少了这一条，任何一条没带
      // 幂等键的消息都会把后面所有同类消息堵死。
      handle.exec(`
        INSERT INTO conversation_message (id, conversation_id, message_sequence, sender_type, sender_id, client_request_id, content, created_at)
        VALUES ('a', 'c', 1, 'user', 'u', 'req-1', 'first', 't'),
               ('b', 'c', 2, 'user', 'u', NULL, 'no key 1', 't'),
               ('d', 'c', 3, 'user', 'u', NULL, 'no key 2', 't');
      `);
      assert.throws(
        () =>
          handle.exec(`
            INSERT INTO conversation_message (id, conversation_id, message_sequence, sender_type, sender_id, client_request_id, content, created_at)
            VALUES ('dup', 'c', 4, 'user', 'u', 'req-1', 'retry', 't');
          `),
        /UNIQUE constraint failed/i,
      );

      // 同一房间内 message_sequence 唯一
      assert.throws(
        () =>
          handle.exec(`
            INSERT INTO conversation_message (id, conversation_id, message_sequence, sender_type, sender_id, content, created_at)
            VALUES ('dup-seq', 'c', 1, 'user', 'u', 'again', 't');
          `),
        /UNIQUE constraint failed/i,
      );

      // 自引用外键真的生效（execution.parent_execution_id）
      assert.throws(
        () =>
          handle.exec(`
            INSERT INTO execution (id, conversation_id, member_id, parent_execution_id, kind, status, prompt, created_at)
            VALUES ('bad', 'c', 'm', 'does-not-exist', 'member_delegate', 'queued', 'p', 't');
          `),
        /FOREIGN KEY/i,
      );

      assert.deepEqual(handle.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      handle.close();
    }
  });

  /**
   * SCHEMA_SQL 现在是唯一一份形状定义，没有任何迁移代码在别处再描述一遍它。
   * 所以「形状本身就是契约」这件事只能靠这条用例守住 —— 改 SCHEMA_SQL 时
   * 如果忘了同步域模型，这里必须变红。
   */
  it('schema 形状（列清单 + 索引清单）', () => {
    const handle = openFixture('shape');
    try {
      migrate(handle);

      const tables = [
        'member',
        'conversation',
        'conversation_member',
        'conversation_member_state',
        'conversation_message',
        'conversation_event',
        'member_runtime',
        'execution',
        'knowledge_base',
        'member_team_knowledge_base',
        'knowledge_document',
        'knowledge_document_fts',
      ];
      assert.deepEqual(
        Object.fromEntries(tables.map((table) => [table, tableColumns(handle, table)])),
        {
          member: [
            'id',
            'handle',
            'name',
            'role',
            'description',
            'style',
            'system_prompt',
            'model',
            'tool_profile',
            'status',
            'seed_key',
            'created_at',
            'updated_at',
          ],
          conversation: [
            'id',
            'title',
            'kind',
            'default_member_id',
            'created_by',
            'event_sequence',
            'message_sequence',
            'created_at',
            'updated_at',
          ],
          conversation_member: ['conversation_id', 'member_id', 'joined_at'],
          conversation_member_state: [
            'conversation_id',
            'member_id',
            'last_seen_message_sequence',
            'last_replied_message_sequence',
            'wake_status',
            'pending_wake',
            'pending_wake_trigger_sequence',
            'pending_wake_reason',
            'muted',
            'updated_at',
          ],
          conversation_message: [
            'id',
            'conversation_id',
            'message_sequence',
            'sender_type',
            'sender_id',
            'target_member_id',
            'reply_to_message_id',
            'content',
            'execution_id',
            'client_request_id',
            'created_at',
          ],
          conversation_event: [
            'id',
            'conversation_id',
            'sequence',
            'event_type',
            'payload',
            'created_at',
          ],
          member_runtime: [
            'id',
            'conversation_id',
            'member_id',
            'copilot_session_id',
            'workspace_path',
            'status',
            'active_execution_id',
            'last_context_message_sequence',
            'last_used_at',
          ],
          execution: [
            'id',
            'conversation_id',
            'member_id',
            'runtime_id',
            'parent_execution_id',
            'delegation_path',
            'kind',
            'status',
            'prompt',
            'response',
            'error',
            'waiting_for_runtime_id',
            'retry_of_execution_id',
            'decision',
            'trigger_message_sequence',
            'wake_reason',
            'config_snapshot',
          'started_at',
          'ended_at',
          'created_at',
        ],
        knowledge_base: [
          'id',
          'scope',
          'key',
          'name',
          'description',
          'member_id',
          'created_at',
          'updated_at',
        ],
        member_team_knowledge_base: ['member_id', 'knowledge_base_id', 'created_at'],
        knowledge_document: [
          'id',
          'knowledge_base_id',
          'title',
          'relative_path',
          'content_hash',
          'source_uri',
          'updated_at',
        ],
        knowledge_document_fts: ['document_id', 'title', 'content'],
      },
    );

      const indexes = (
        handle
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as unknown as Array<{ name: string }>
      ).map((row) => row.name);
      assert.deepEqual(indexes, [
        'idx_conversation_event_replay',
        'idx_conversation_member_state_wake',
        'idx_execution_conversation_created',
        'idx_execution_parent',
        'idx_execution_status',
        'idx_knowledge_document_kb',
        'idx_member_seed_key',
        'idx_member_team_knowledge_base_member',
        'idx_message_client_request',
        'idx_message_conversation_created',
        'idx_message_conversation_sequence',
      ]);
    } finally {
      handle.close();
    }
  });

  it('已经是对的库：再跑一次什么都不做', () => {
    const handle = openFixture('idempotent');
    try {
      assert.equal(migrate(handle).created, true);
      const second = migrate(handle);
      assert.equal(second.created, false);
      assert.equal(second.from, SCHEMA_VERSION);
      assert.equal(second.to, SCHEMA_VERSION);
    } finally {
      handle.close();
    }
  });

  it('拒绝打开更旧的 schema，并且不假装能升上来', () => {
    const handle = openFixture('older');
    try {
      migrate(handle);
      handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
      assert.throws(() => migrate(handle), /没有升级代码/);
    } finally {
      handle.close();
    }
  });

  /**
   * 库比程序新时**不能**建议删库重建 —— 那是用户的数据，而且换回新 build 就好了。
   * 两个方向的错都指向同一个动作是最省事的写法，也是最容易毁数据的那种。
   */
  it('拒绝打开更新的 schema，且不给「删库重建」这种建议', () => {
    const handle = openFixture('future');
    try {
      migrate(handle);
      handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

      let message = '';
      assert.throws(
        () => migrate(handle),
        (error: Error) => {
          message = error.message;
          return true;
        },
      );
      assert.match(message, /比本程序支持的/);
      assert.doesNotMatch(message, /删掉数据目录/);
    } finally {
      handle.close();
    }
  });

  it('有表但没有 user_version 登记：拒绝，不当成空库建表', () => {
    const handle = openFixture('untracked');
    try {
      handle.exec('CREATE TABLE something (id TEXT PRIMARY KEY);');

      assert.throws(() => migrate(handle), /没有 user_version 登记/);

      // 拒绝必须是「什么都没做」：既没有加新表，也没有登记版本
      const tables = (
        handle
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as unknown as Array<{ name: string }>
      ).map((row) => row.name);
      assert.deepEqual(tables, ['something']);
      assert.equal(getUserVersion(handle), 0);
    } finally {
      handle.close();
    }
  });

  /**
   * SCHEMA_SQL 执行到一半失败时必须什么都不留下。
   *
   * 刻意让失败发生在最后一张表上：前面 7 张表和 4 个索引都已经建好了，
   * 所以「整段回滚」和「建到一半留在那儿」是能区分开的。
   */
  it('建表中途失败：整段回滚，不留半成品，也不登记版本', () => {
    const handle = openFixture('partial');
    try {
      // 一个同名 view 就够：它在 sqlite_master 里是 type='view'，不会触发
      // 「有表但没有 user_version 登记」那道闸门，但最后的
      // CREATE TABLE execution 会撞名失败。
      handle.exec('CREATE VIEW execution AS SELECT 1 AS x');

      assert.throws(() => migrate(handle), /already exists/i);

      const left = (
        handle
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as unknown as Array<{ name: string }>
      ).map((row) => row.name);
      assert.deepEqual(left, [], '回滚之后不该留下任何表');
      assert.equal(getUserVersion(handle), 0);
    } finally {
      handle.close();
    }
  });
});

// ---------------------------------------------- 2/3/4. runtime reliability

const stub = new StubCopilot();
const memberService = new MemberService(db);
const knowledgeService = new KnowledgeService(db);
const team = new TeamService(db, memberService, stub as unknown as CopilotService, knowledgeService);

const alice = team.createMember({ name: 'Alice', role: 'Analyst' });
const bob = team.createMember({ name: 'Bob', role: 'Reviewer' });

const sendRaw = team.sendMessage.bind(team);

/**
 * `POST /messages` 返回 `wakes[]`，不再有单个 executionId —— group 房间里
 * 一条消息可以唤醒多个 Member。这个文件的用例都是单收件人场景，包一层
 * 把那条 execution 找回来。（并发发多条的那个用例只用 message 字段。）
 */
async function sendMessage(input: {
  conversationId: string;
  content: string;
  targetMemberId?: string;
  replyToMessageId?: string;
}) {
  const result = await sendRaw(input);
  return { ...result, executionId: singleExecutionId(db, input.conversationId, result.wakes) };
}

describe('message_sequence 是会话内严格全序', () => {
  it('同一毫秒内的多条消息也不会撞序号', async () => {
    const solo = team.createConversation({
      kind: 'direct',
      memberIds: [bob.id],
      defaultMemberId: bob.id,
    });

    // 不 await，让三条 sendMessage 在同一个 tick 里排队写入。
    // 用 sendRaw：这个用例只关心 message_sequence，而同一 Member 上并发的
    // 唤醒会被 scheduler 合并成排队轮次，第二条的 execution 此刻还不存在。
    const results = await Promise.all([
      sendRaw({ conversationId: solo.id, content: 'a' }),
      sendRaw({ conversationId: solo.id, content: 'b' }),
      sendRaw({ conversationId: solo.id, content: 'c' }),
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
    });
    // 四轮都由显式 targetMemberId 驱动；自动唤醒只会在中间插进额外的 turn，
    // 让「谁在什么时候读到了什么」没法断言。
    muteAllMembers(team, conv.id);

    // 1) Alice 先说话
    const first = await sendMessage({
      conversationId: conv.id,
      content: 'ALICE-FIRST',
      targetMemberId: alice.id,
    });
    await waitForStatus(first.executionId, 'completed');

    // 2) Bob 第一次发言：应该看到 Alice 的回复
    const bobFirst = await sendMessage({
      conversationId: conv.id,
      content: 'BOB-FIRST',
      targetMemberId: bob.id,
    });
    await waitForStatus(bobFirst.executionId, 'completed');

    const bobTurn1 = stub.turnsFor(bob.id).at(-1);
    assert.ok(bobTurn1);
    assert.match(bobTurn1.prompt, /stub reply from/, 'Bob 应该看到 Alice 的回复');
    // group 房间走 discussion 模式：房间活动以 transcript 形式给出，
    // 触发消息本身也在 transcript 里（不像 direct 那样单独拎成 Current message）
    assert.match(bobTurn1.prompt, /Room activity since you last read it/);
    assert.match(bobTurn1.prompt, /ALICE-FIRST/, '也应该看到触发 Alice 的那条用户消息');
    assert.match(bobTurn1.prompt, /BOB-FIRST/);

    // 3) Alice 再说一句
    const second = await sendMessage({
      conversationId: conv.id,
      content: 'ALICE-SECOND',
      targetMemberId: alice.id,
    });
    await waitForStatus(second.executionId, 'completed');

    // 4) Bob 第二次发言：只应该看到 Alice 的第二句
    const bobSecond = await sendMessage({
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
      triggerMessageSequence: 2,
      wakeReason: 'direct',
      conversation: conv,
      member: alice,
      turnMode: 'direct',
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

    const ok = await sendMessage({ conversationId: conv.id, content: 'OK-1' });
    await waitForStatus(ok.executionId, 'completed');
    const afterSuccess = runtimeRow(conv.id, bob.id);
    assert.ok(afterSuccess);
    const watermark = afterSuccess.last_context_message_sequence;
    assert.ok(watermark > 0);

    stub.failWith = 'boom';
    try {
      const failed = await sendMessage({ conversationId: conv.id, content: 'WILL-FAIL' });
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
    // 用 sendRaw：同一个 Member 上并发的两条唤醒会被 scheduler 合并成
    // 「先跑一轮、再补一轮」，第二条的 execution 在返回时还没被创建。
    await Promise.all([
      sendRaw({ conversationId: conv.id, content: 'one' }),
      sendRaw({ conversationId: conv.id, content: 'two' }),
    ]);
    await waitForConversationIdle(conv.id);

    // 两条消息各自留下一条 execution（只是先后出现，不是同时)
    const executions = team.listExecutions(conv.id, 100);
    assert.equal(executions.length, 2, '两条消息应该各留下一条 execution');
    assert.deepEqual(
      executions.map((execution) => execution.triggerMessageSequence),
      [1, 2],
    );
    assert.equal(new Set(executions.map((execution) => execution.memberId)).size, 1);
    for (const execution of executions) {
      assert.equal(execution.status, 'completed');
    }

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
    });
    muteAllMembers(team, conv.id);

    const aliceRun = await sendMessage({
      conversationId: conv.id,
      content: 'A',
      targetMemberId: alice.id,
    });
    await waitForStatus(aliceRun.executionId, 'completed');

    const bobRun = await sendMessage({
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
    });
    muteAllMembers(team, conv.id);

    const parent = await sendMessage({
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

    // 建房间本身也会产生事件（成员状态行是一行真实的状态），所以比较的是
    // **订阅窗口内**的落库条数 —— 断言的是「落库与广播没有丢一条」，
    // 而不是「这条房间里一共发生过几件事」。
    const countEvents = () =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM conversation_event WHERE conversation_id = ?`)
          .get(conv.id) as unknown as { n: number }
      ).n;
    const baseline = countEvents();

    const seen: Array<{ type: string; sequence: number | null }> = [];
    const unsubscribe = team.subscribe(conv.id, (event) => {
      seen.push({ type: event.type, sequence: event.sequence });
    });

    try {
      const sent = await sendMessage({ conversationId: conv.id, content: 'hello' });
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

    // 订阅期间落的每一条都广播出来了，且 broadcast 的就是落库的那一串
    assert.equal(countEvents() - baseline, sequences.length);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, i) => baseline + i + 1));

    // event_sequence 计数器必须和落库总条数严格相等：它是 SSE 的 Last-Event-ID，
    // 差一条就意味着「重连时会漏掉一条」或「会重复回放一条」。
    assert.equal(
      (db.prepare(`SELECT event_sequence AS n FROM conversation WHERE id = ?`).get(conv.id) as {
        n: number;
      }).n,
      countEvents(),
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

    const first = await sendMessage({ conversationId: conv.id, content: 'one' });
    await waitForStatus(first.executionId, 'completed');

    const all = team.listEventsSince(conv.id, 0);
    assert.ok(all.length > 0);
    const highWater = all[all.length - 1].sequence;
    assert.ok(highWater !== null);

    const second = await sendMessage({ conversationId: conv.id, content: 'two' });
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

    const first = await sendMessage({ conversationId: conv.id, content: 'history' });
    await waitForStatus(first.executionId, 'completed');

    const history = team.listEventsSince(conv.id, 0);
    const highWater = history[history.length - 1].sequence as number;

    const received: Array<number | null> = [];
    const unsubscribe = team.replayAndSubscribe(conv.id, highWater, (event) => {
      received.push(event.sequence);
    });

    try {
      // 订阅建立后立刻产生的新事件必须被推送到
      const second = await sendMessage({ conversationId: conv.id, content: 'live' });
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

    const sent = await sendMessage({ conversationId: conv.id, content: 'rebuild' });
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
      const sent = await sendMessage({ conversationId: conv.id, content: text });
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

    const report = new RecoveryService(handle, new ConversationMemberService(handle)).recover();

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
    const second = new RecoveryService(handle, new ConversationMemberService(handle)).recover();
    assert.equal(second.interrupted, 0);
    assert.equal(second.interruptedOrphanChildren, 0);
    assert.deepEqual(second.requeuedExecutionIds, ['e-qroot']);

    handle.close();
  });

  it('被进程带走的排队唤醒：连同触发消息与原因一起重派，不是猜一个', () => {
    const handle = new DatabaseSync(path.join(dataDir, 'recovery-wakes.db'));
    handle.exec('PRAGMA foreign_keys = ON;');
    migrate(handle);

    handle.exec(`
      INSERT INTO member (id, handle, name, role, created_at, updated_at)
      VALUES ('m1', 'alice', 'Alice', 'Analyst', 't', 't'),
             ('m2', 'bob', 'Bob', 'Engineer', 't', 't');

      INSERT INTO conversation (id, title, kind, created_by, message_sequence, created_at, updated_at)
      VALUES ('c', 'Room', 'group', 'u', 23, 't', 't');

      INSERT INTO conversation_member (conversation_id, member_id, joined_at)
      VALUES ('c', 'm1', 't'), ('c', 'm2', 't');
    `);

    // Alice：排队中被进程带走 —— 触发消息是 17，原因是 mention。
    // 房间现在已经走到 23；旧实现会拿 23 + open_discussion 重放，等于换了一轮。
    //
    // pending_wake 与 wake_status 是两次写（调度器分开调，因为「正在跑」时不该
    // 把状态压回 queued），这里手动复现「刚入队就被进程带走」那一刻。
    const states = new ConversationMemberService(handle);
    states.ensure('c', 'm1', 0);
    states.setPendingWake('c', 'm1', true, { triggerSequence: 17, reason: 'mention' });
    states.setWakeStatus('c', 'm1', 'queued');

    // Bob：已经进过引擎（wake_status = running），不能被重派
    handle.prepare(
      `
      INSERT INTO conversation_member_state (
        conversation_id, member_id, last_seen_message_sequence,
        last_replied_message_sequence, wake_status, pending_wake,
        pending_wake_trigger_sequence, pending_wake_reason, muted, updated_at
      )
      VALUES ('c', 'm2', 0, 0, 'running', 1, 9, 'direct', 0, 't')
      `,
    ).run();

    const report = new RecoveryService(handle, new ConversationMemberService(handle)).recover();

    assert.deepEqual(
      report.lostWakes.map((wake) => ({ ...wake })),
      [{ conversationId: 'c', memberId: 'm1', reason: 'mention', triggerSequence: 17 }],
      '只有「排队中」的那条可重派，且必须带上原来的 trigger + reason',
    );

    // 复位把 pending 与元数据一起清掉，不留幽灵记录
    const rows = (
      handle
        .prepare(
          `
          SELECT member_id, wake_status, pending_wake, pending_wake_trigger_sequence, pending_wake_reason
          FROM conversation_member_state
          ORDER BY member_id
          `,
        )
        .all() as unknown as Array<{
        member_id: string;
        wake_status: string;
        pending_wake: number;
        pending_wake_trigger_sequence: number | null;
        pending_wake_reason: string | null;
      }>
    ).map((row) => ({ ...row }));

    assert.deepEqual(rows, [
      {
        member_id: 'm1',
        wake_status: 'idle',
        pending_wake: 0,
        pending_wake_trigger_sequence: null,
        pending_wake_reason: null,
      },
      {
        member_id: 'm2',
        wake_status: 'idle',
        pending_wake: 0,
        pending_wake_trigger_sequence: null,
        pending_wake_reason: null,
      },
    ]);

    handle.close();
  });
});

describe('redispatchWake：恢复出来的是同一轮', () => {
  it('用落库的 trigger + reason 重放，而不是拿房间当前水位猜一个', async () => {
    const room = team.createConversation({
      kind: 'group',
      title: 'Crash Room',
      memberIds: [alice.id, bob.id],
    });
    muteAllMembers(team, room.id);

    // 只点名 Bob。Alice 从头到尾没被唤醒，读游标停在 0。
    const first = await sendMessage({
      conversationId: room.id,
      content: 'Bob 先看这个',
      targetMemberId: bob.id,
    });
    await waitForStatus(first.executionId, 'completed');
    await waitForConversationIdle(room.id);

    // 再堆一条，把房间水位推高 —— 这样「原样重放」和「猜一个」会明显不同
    const second = await sendMessage({
      conversationId: room.id,
      content: 'Bob 再补一条',
      targetMemberId: bob.id,
    });
    await waitForStatus(second.executionId, 'completed');
    await waitForConversationIdle(room.id);

    const watermark = team.getConversation(room.id).messageSequence;
    assert.ok(watermark > 1, '前置条件：房间水位应该已经超过第 1 条');

    // 模拟「Alice 的唤醒在排队时进程被 kill」。
    //
    // 这个状态没法通过公开 API 造出来（正常路径下一入队就立刻开跑），所以直接
    // 把 durable 那几个字段写成崩溃那一刻的样子 —— 这正是 RecoveryService
    // 重启后看到的东西。
    const states = new ConversationMemberService(db);
    states.setPendingWake(room.id, alice.id, true, { triggerSequence: 1, reason: 'mention' });
    states.setWakeStatus(room.id, alice.id, 'queued');

    const lost = states.findLostWakes();
    assert.deepEqual(
      lost.filter((wake) => wake.memberId === alice.id).map((wake) => ({ ...wake })),
      [{ conversationId: room.id, memberId: alice.id, reason: 'mention', triggerSequence: 1 }],
    );

    for (const wake of lost) team.redispatchWake(wake);
    await waitForConversationIdle(room.id);

    const aliceRuns = (
      db
        .prepare(
          `
          SELECT trigger_message_sequence, wake_reason
          FROM execution
          WHERE conversation_id = ? AND member_id = ?
          ORDER BY rowid
          `,
        )
        .all(room.id, alice.id) as unknown as Array<{
        trigger_message_sequence: number | null;
        wake_reason: string | null;
      }>
    ).map((row) => ({ ...row }));

    assert.deepEqual(
      aliceRuns,
      [{ trigger_message_sequence: 1, wake_reason: 'mention' }],
      // 旧实现会产出 { trigger_message_sequence: watermark, wake_reason: 'open_discussion' }：
      // 对着另一条消息、以另一个理由重新判断要不要发言。
      '重放出来的必须是当时那一轮',
    );
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
      const failed = await sendMessage({ conversationId: conv.id, content: 'try' });
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
      const running = await sendMessage({ conversationId: conv.id, content: 'again' });
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
