import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CopilotService, MemberTurnResult } from '../copilot.js';

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

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { RecoveryService } = await import('../recovery-service.js');
const { ConversationMemberService } = await import('../conversation-member-service.js');
const { singleExecutionId, createTestStack } = await import('./support.js');
const { migrate, getUserVersion, SCHEMA_VERSION } = await import(
  '../db-migrations.js'
);

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

interface TurnInput {
  runtime: {
    id: string;
    conversationId: string;
    memberId: string;
    /** (conversation, member) 的长期 session。persistent 轮次用它。 */
    copilotSessionId: string;
  };
  member: { id: string };
  prompt: string;
  executionId: string;
  /** isolated 轮次才有：execution 专属的 session。 */
  sessionId?: string;
  releaseSession?: boolean;
}

class StubCopilot {
  readonly turns: TurnInput[] = [];
  /** 让下一次（或接下来每一次）turn 抛错，用来验证失败路径。 */
  failWith: string | null = null;
  /** 挂住 turn，用来把 execution 稳定地停在 running 状态做断言。 */
  hold: Promise<void> | null = null;
  /** 「这些 session 已经不在引擎里了」——模拟 idle TTL 回收 / COPILOT_HOME 被清。 */
  readonly missingSessionIds = new Set<string>();
  /** 让 turn 报告「session 是本轮新建的」——模拟探针与 resume 之间的窗口。 */
  reportSessionCreated = false;

  persistentSessionExists(sessionId: string): Promise<boolean> {
    return Promise.resolve(!this.missingSessionIds.has(sessionId));
  }

  async runMemberTurn(input: TurnInput): Promise<MemberTurnResult> {
    this.turns.push(input);
    if (this.hold) await this.hold;
    if (this.failWith) throw new Error(this.failWith);
    return {
      content: `stub reply from ${input.member.id}`,
      sessionCreated: this.reportSessionCreated,
    };
  }

  /** 这一轮真正交给引擎的 session id（不传 = 复用 runtime 上的长期 session）。 */
  sessionIdOf(turn: TurnInput): string {
    return turn.sessionId ?? turn.runtime.copilotSessionId;
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
        copilot_session_id: string;
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
        INSERT INTO team (id, name, created_by, created_at, updated_at)
        VALUES ('t1', 'T', 'u', 't', 't');
        INSERT INTO conversation (id, team_id, title, kind, created_by, created_at, updated_at)
        VALUES ('c', 't1', 'C', 'direct', 'u', 't', 't');
        INSERT INTO execution (id, conversation_id, member_id, goal_revision, kind, status, prompt, created_at)
        VALUES ('e', 'c', 'm', 0, 'interactive', 'interrupted', 'p', 't');
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
            INSERT INTO execution (id, conversation_id, member_id, goal_revision, parent_execution_id, kind, status, prompt, created_at)
            VALUES ('bad', 'c', 'm', 0, 'does-not-exist', 'member_delegate', 'queued', 'p', 't');
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
        'team',
        'team_event',
        'mcp_server',
        'team_membership',
        'team_presence',
        'scheduled_wake',
        'scheduled_wake_run',
        'conversation',
        'conversation_goal_revision',
        'conversation_member',
        'conversation_member_state',
        'conversation_message',
        'conversation_task',
        'conversation_event',
        'member_runtime',
        'execution',
        'knowledge_base',
        'capability_scope',
        'capability_binding',
        'knowledge_document',
        'knowledge_document_fts',
        'conversation_file',
        'conversation_message_file',
        'conversation_file_fts',
        // 授权与证据链（见 db-migrations.ts 的对应段落）：
        //   data_entitlement        能碰什么数据
        //   policy_decision_audit   谁批的（含拒绝）
        //   tool_execution_audit    批了之后真的调了什么
        //   command / approval      真正要执行的业务动作 + 审批
        //   worker_lease            多副本下「谁在跑这一轮」
        'data_entitlement',
        'policy_decision_audit',
        'tool_execution_audit',
        'command',
        'approval',
        // Command 的生命周期事件（requested / policy_decided / approval_* /
        // executing / completed|failed）—— command 行上只有**当前**状态，
        // 过程在这里。
        'command_audit',
        // 每一次真正打出去的尝试。「外部结果未知」靠它 + 对账收敛。
        'command_attempt',
        'worker_lease',
        // 谁可以进这间房（human ACL）。conversation_member 只装 Agent。
        'conversation_participant',
        // 依据链：这一轮的依据强度与审核状态，以及它真的检索过哪些引用。
        'execution_evidence',
        'execution_evidence_seen',
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
            'system_prompt',
            'model',
            'status',
            'seed_key',
            'created_at',
            'updated_at',
          ],
          team: ['id', 'name', 'description', 'created_by', 'event_sequence', 'created_at', 'updated_at'],
          team_event: ['id', 'team_id', 'sequence', 'event_type', 'payload', 'created_at'],
          mcp_server: [
            'id',
            'display_name',
            'description',
            'type',
            'url',
            'headers_json',
            'command',
            'args_json',
            'env_json',
            'cwd',
            'timeout',
            'tools_json',
            'version',
            'enabled',
            // 凭证只留引用名 + 认证方式提示，值在运行时从密钥库取。
            'secret_ref',
            'auth_type',
            'last_test_at',
            'last_test_ok',
            'last_test_error',
            'created_at',
            'updated_at',
          ],
          team_membership: [
            'team_id',
            'kind',
            'principal_id',
            'role',
            'status',
            'joined_at',
            'updated_at',
          ],
          team_presence: [
            'team_id',
            'kind',
            'principal_id',
            'availability',
            'last_seen_at',
            'updated_at',
          ],
          scheduled_wake: [
            'id',
            'team_id',
            'member_id',
            'conversation_id',
            'prompt',
            'type',
            'run_at',
            'interval_seconds',
            'next_run_at',
            'status',
            'last_fired_at',
            'last_error',
            'created_by',
            'created_at',
            'updated_at',
          ],
          scheduled_wake_run: [
            'id',
            'schedule_id',
            'scheduled_for',
            'status',
            'execution_id',
            'created_at',
            'started_at',
            'ended_at',
            'error',
          ],
          conversation: [
            'id',
            'team_id',
            'external_work_ref',
            'title',
            'kind',
            'objective',
            'goal_revision',
            'lead_member_id',
            'status',
            'requirements_json',
            'open_questions_json',
            'created_by',
            'event_sequence',
            'message_sequence',
            'created_at',
            'updated_at',
          ],
          conversation_goal_revision: [
            'id',
            'conversation_id',
            'revision',
            'objective',
            'requirements_json',
            'changed_by_type',
            'changed_by_id',
            'change_kind',
            'reason',
            'created_at',
          ],
          conversation_task: [
            'id',
            'conversation_id',
            'goal_revision',
            'title',
            'description',
            'assignee_member_id',
            'status',
            'dependencies_json',
            'acceptance_criteria_json',
            'result',
            'blocker',
            'current_execution_id',
            'model_tier',
            'independent_context',
            'requires_human_review',
            'sort_order',
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
            'pending_wake_task_id',
            'muted',
            'updated_at',
          ],
          conversation_message: [
            'id',
            'conversation_id',
            'message_sequence',
            'sender_type',
            'sender_id',
            'reply_to_message_id',
            'task_id',
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
            'goal_revision',
            'external_work_ref',
            'external_work_snapshot',
            'runtime_id',
            // 跑这一轮的租约代次（fencing token）。旧 worker 的写回带上它之后
            // 会命中 0 行 —— 「租约」管谁能跑，「代次」管谁还能写。
            'worker_fencing_token',
            'parent_execution_id',
            'delegation_path',
            'kind',
            // 这一轮开新 session 还是复用长期的那个
            'session_mode',
            // 谁发起的这一轮（human / agent / system）
            'initiated_by_type',
            'initiated_by_id',
            // 取消请求：DB 是权威信号，进程内的 Set 只是快路径
            'cancel_requested_at',
            'cancel_requested_by',
            'status',
            'prompt',
            'response',
            'error',
            'waiting_for_runtime_id',
            'retry_of_execution_id',
            'task_id',
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
          'authority',
          'member_id',
          'created_at',
          'updated_at',
        ],
        capability_scope: ['scope_type', 'scope_id', 'seed_key', 'created_at'],
        capability_binding: [
          'scope_type',
          'scope_id',
          'capability_type',
          'provider_id',
          'selector',
          'created_at',
        ],
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
        conversation_file: [
          'id',
          'conversation_id',
          'team_id',
          'uploaded_by',
          'original_name',
          'content_type',
          'size_bytes',
          'storage_path',
          'content_hash',
          'status',
          'extracted_text',
          'extraction_error',
          'created_at',
          'updated_at',
        ],
        conversation_message_file: ['message_id', 'file_id', 'relation_type', 'position'],
        conversation_file_fts: ['file_id', 'title', 'content'],
        data_entitlement: [
          'id',
          'team_id',
          'member_id',
          'provider_id',
          'resource_type',
          'resource_pattern',
          'actions_json',
          'active',
          'created_at',
          'updated_at',
        ],
        policy_decision_audit: [
          'id',
          'execution_id',
          'tool_name',
          'policy_revision',
          'decision',
          'reason',
          'input_hash',
          'created_at',
        ],
        tool_execution_audit: [
          'id',
          'execution_id',
          'conversation_id',
          'member_id',
          'tool_name',
          'provider_id',
          'implementation',
          'args_hash',
          'args_redacted_json',
          'allowed',
          'policy_decision_id',
          'entitlement_id',
          'started_at',
          'ended_at',
          'result_hash',
          'error',
        ],
        command: [
          'id',
          'execution_id',
          'conversation_id',
          'member_id',
          'actor_type',
          'actor_id',
          'action',
          'target',
          'args_hash',
          // 冻结的规范化参数原文。执行时从这里读，不接受调用方再传一遍 ——
          // 否则「批准时看到的」和「真正执行的」可以是两份。
          'args_json',
          'idempotency_key',
          // 这一笔**外部业务动作**的身份。它刻意不是 execution_id：retry 会铸出
          // 一条新的 execution，而「同一笔 Jira 评论」不能因此变成两笔。
          // UNIQUE + 对账时拿它去外部系统查，见 command-service.ts。
          'operation_id',
          'resource_version',
          'policy_decision_id',
          'approval_id',
          'status',
          'created_at',
          'executed_at',
          'result_hash',
        ],
        approval: [
          'id',
          'command_id',
          'requested_by_type',
          'requested_by_id',
          'decision',
          'decided_by',
          'created_at',
          'decided_at',
        ],
        worker_lease: [
          'resource_type',
          'resource_id',
          'lease_owner',
          // 每次重新夺取 +1。持有者拿到它之后，所有写回都带这个条件。
          'fencing_token',
          'lease_expires_at',
          'heartbeat_at',
        ],
        // 每一次真正打出去的尝试。`command` 行上只有**当前**状态，而
        // 「同一笔动作被尝试了几次、每次结果是什么」必须能查 —— 外部结果
        // 未知（unknown）时，对账靠的就是这张表。
        command_attempt: [
          'id',
          'command_id',
          'attempt_no',
          'operation_id',
          'status',
          'started_at',
          'ended_at',
          'error',
          'result_hash',
        ],
        command_audit: [
          'id',
          'command_id',
          'execution_id',
          'event',
          'actor_type',
          'actor_id',
          'detail',
          'created_at',
        ],
        conversation_participant: [
          'conversation_id',
          'principal_type',
          'principal_id',
          'added_by',
          'added_at',
        ],
        execution_evidence: [
          'execution_id',
          'evidence_score',
          'evidence_level',
          'verification_level',
          'review_required',
          'review_status',
          'claims_json',
          'review_note',
          'reviewed_by',
          'reviewed_at',
          'created_at',
          'updated_at',
        ],
        execution_evidence_seen: ['execution_id', 'citation', 'provider_id', 'seen_at'],
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
        'idx_capability_binding_provider',
        'idx_capability_binding_scope',
        'idx_command_attempt_command',
        'idx_command_attempt_operation',
        'idx_command_audit_command',
        'idx_command_execution',
        'idx_conversation_event_replay',
        'idx_conversation_external_work_key',
        'idx_conversation_file_conversation',
        'idx_conversation_file_hash',
        'idx_conversation_file_status',
        'idx_conversation_goal_revision',
        'idx_conversation_member_state_wake',
        'idx_conversation_participant_principal',
        'idx_conversation_task_assignee',
        'idx_conversation_task_conversation',
        'idx_conversation_task_revision',
        'idx_conversation_task_status',
        'idx_conversation_team',
        'idx_data_entitlement_lookup',
        'idx_execution_conversation_created',
        'idx_execution_evidence_review',
        'idx_execution_external_work_key',
        'idx_execution_goal_revision',
        'idx_execution_parent',
        'idx_execution_status',
        'idx_execution_task',
        'idx_knowledge_document_kb',
        'idx_member_seed_key',
        'idx_message_client_request',
        'idx_message_conversation_created',
        'idx_message_conversation_sequence',
        'idx_message_file_file',
        'idx_message_task',
        'idx_policy_decision_execution',
        'idx_scheduled_wake_due',
        'idx_scheduled_wake_member',
        'idx_scheduled_wake_run_execution',
        'idx_team_event_team_sequence',
        'idx_team_membership_principal',
        'idx_team_membership_team',
        'idx_tool_execution_audit_execution',
      ]);
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
const { team } = createTestStack(db, memberService, stub as unknown as CopilotService);

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
  actorId: string;
  content: string;
  replyToMessageId?: string;
}) {
  const result = await sendRaw(input);
  return { ...result, executionId: singleExecutionId(db, input.conversationId, result.wakes) };
}

describe('message_sequence 是会话内严格全序', () => {
});

describe('ContextAssembler：增量上下文而不是整段重放', () => {
  it('只注入「上次成功 turn 之后新增」的消息，并排除自己与触发消息', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'Incremental',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    // Task 工作区里用户消息只唤醒 Lead：两轮都是 Alice 处理，
    // 「谁在什么时候读到了什么」可断言。

    const first = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'LEAD-FIRST' });
    await waitForStatus(first.executionId, 'completed');

    const turn1 = stub.turnsFor(alice.id).at(-1);
    assert.ok(turn1);
    assert.match(turn1.prompt, /Recent relevant updates|LEAD-FIRST/);

    const second = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'LEAD-SECOND' });
    await waitForStatus(second.executionId, 'completed');

    const turn2 = stub.turnsFor(alice.id).at(-1);
    assert.ok(turn2);
    assert.match(turn2.prompt, /LEAD-SECOND/, '新消息必须注入');
    assert.doesNotMatch(
      turn2.prompt,
      /LEAD-FIRST/,
      '老消息不能重复注入 —— 它在 Lead 的 Copilot session history 里已经有了',
    );

    // checkpoint 覆盖了被过滤掉的消息（否则下一轮还会重复读到它们）
    const runtime = runtimeRow(conv.id, alice.id);
    assert.ok(runtime);
    assert.ok(runtime.last_context_message_sequence > 0);
  });

});

describe('独立 Task 不读共享房间上下文', () => {
  it('independent task 不读取 shared conversation messages，也不推进水位线', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'Isolated',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    // 先让房间里有讨论内容，再建独立任务：普通任务会看到这些，
    // independent 任务必须看不到。
    await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'ROOM-CHATTER-MARKER' });
    await team.planTasks({
      conversationId: conv.id,
      memberId: alice.id,
      objective: '独立审查',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [{ key: 'iso', title: 'IsoTask', assigneeMemberId: bob.id, independentContext: true }],
    });
    await waitForConversationIdle(conv.id);

    const bobTurns = stub.turnsFor(bob.id);
    assert.ok(bobTurns.length > 0, '独立任务也要执行');
    const bobPrompt = bobTurns.at(-1)!.prompt;
    assert.match(bobPrompt, /IsoTask/, '自己的任务描述必须在 prompt 里');
    assert.doesNotMatch(
      bobPrompt,
      /ROOM-CHATTER-MARKER/,
      '房间讨论不能进独立任务的 prompt，否则第二意见就被第一意见锚定了',
    );

    // 没读过的消息不能标成已消费：水位线必须原地不动。
    const runtime = runtimeRow(conv.id, bob.id);
    assert.ok(runtime);
    assert.equal(
      runtime.last_context_message_sequence,
      0,
      '独立任务没读房间消息，水位线不能推进',
    );
  });

  it('独立任务连 Copilot session 也换掉，并且跑完即释放', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'IsolatedSession',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await team.planTasks({
      conversationId: conv.id,
      memberId: alice.id,
      objective: '独立审查',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [{ key: 'iso2', title: 'IsoTask2', assigneeMemberId: bob.id, independentContext: true }],
    });
    await waitForConversationIdle(conv.id);

    const execution = db
      .prepare(
        `SELECT id, session_mode FROM execution WHERE conversation_id = ? AND member_id = ?`,
      )
      .get(conv.id, bob.id) as unknown as { id: string; session_mode: string } | undefined;
    assert.ok(execution, '独立任务要留下 execution');
    assert.equal(execution.session_mode, 'isolated');

    const turn = stub.turns.find((item) => item.executionId === execution.id);
    assert.ok(turn, '这一轮要真的跑到引擎');
    // 只挡住 prompt 不换 session 是不够的：同一个 session 里上一轮的 assistant
    // 消息还在，「独立复核」照样读得到被复核对象的推理过程。
    assert.equal(
      stub.sessionIdOf(turn),
      `execution-${execution.id}`,
      '独立任务必须开一个 execution 专属的 session',
    );
    assert.equal(turn.releaseSession, true, '独立 session 跑完必须释放，否则下次会被 resume 回来');
  });

  it('普通 Task 与 Lead 仍复用长期 session', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'SharedSession',
      memberIds: [alice.id, bob.id],
      leadMemberId: alice.id,
    });
    await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'NORMAL-1' });
    await waitForConversationIdle(conv.id);
    await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'NORMAL-2' });
    await waitForConversationIdle(conv.id);

    const aliceTurns = stub
      .turnsFor(alice.id)
      .filter((turn) => turn.runtime.conversationId === conv.id);
    assert.ok(aliceTurns.length >= 2, '同一个 Lead 至少跑了两轮');
    const ids = new Set(aliceTurns.map((turn) => stub.sessionIdOf(turn)));
    assert.equal(ids.size, 1, '普通轮次必须复用同一个长期 session');
    assert.equal(
      aliceTurns.every((turn) => !turn.releaseSession),
      true,
      '长期 session 不能在轮次结束时被删掉',
    );
  });
});

describe('execution 上的发起人', () => {
  it('人发的消息 → human，id 是发消息的那个人', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'ActorHuman',
      memberIds: [alice.id],
      leadMemberId: alice.id,
    });
    const { executionId } = await sendMessage({
      actorId: 'user-42',
      conversationId: conv.id,
      content: '看一下这个方案',
    });
    await waitForStatus(executionId, 'completed');

    const row = db
      .prepare(`SELECT initiated_by_type, initiated_by_id FROM execution WHERE id = ?`)
      .get(executionId) as unknown as
      | { initiated_by_type: string; initiated_by_id: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.initiated_by_type, 'human');
    assert.equal(row.initiated_by_id, 'user-42', '记发消息的人，不记一个全局的 localUserId');
  });
});

describe('checkpoint 只在 turn 成功后推进', () => {
  it('turn 失败时 last_context_message_sequence 保持不变', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'Failure',
      memberIds: [bob.id],
      leadMemberId: bob.id,
    });

    const ok = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'OK-1' });
    await waitForStatus(ok.executionId, 'completed');
    const afterSuccess = runtimeRow(conv.id, bob.id);
    assert.ok(afterSuccess);
    const watermark = afterSuccess.last_context_message_sequence;
    assert.ok(watermark > 0);

    stub.failWith = 'boom';
    try {
      const failed = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'WILL-FAIL' });
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

describe('session 丢失后 checkpoint 归零，历史重新注入', () => {
  /**
   * 造一个「房间里有旧消息、checkpoint 已经推进过」的状态。
   *
   * 用 task 房间 + Lead 单成员：用户消息只唤醒 Lead，所以「谁在什么时候读到
   * 了什么」是确定的。
   */
  async function conversationWithHistory(title: string) {
    const conv = team.createConversation({
      kind: 'task',
      title,
      memberIds: [bob.id],
      leadMemberId: bob.id,
    });
    const first = await sendMessage({
      actorId: 'test-user',
      conversationId: conv.id,
      content: 'HISTORY-MARKER',
    });
    await waitForStatus(first.executionId, 'completed');

    const second = await sendMessage({
      actorId: 'test-user',
      conversationId: conv.id,
      content: 'SECOND-MARKER',
    });
    await waitForStatus(second.executionId, 'completed');

    // 第二轮里 HISTORY-MARKER 不该再出现：它在 session history 里已经有了。
    assert.doesNotMatch(
      stub.turnsFor(bob.id).at(-1)!.prompt,
      /HISTORY-MARKER/,
      '前提：增量注入正常工作，否则这组用例证明不了任何事',
    );

    const runtime = runtimeRow(conv.id, bob.id);
    assert.ok(runtime);
    assert.ok(runtime.last_context_message_sequence > 0, '前提：checkpoint 已经推进');
    return { conv, runtime };
  }

  it('引擎里的 session 不在了 → 从 0 重读，自己发过的消息也不再被过滤', async () => {
    const { conv, runtime } = await conversationWithHistory('LostSession');
    stub.missingSessionIds.add(runtime.copilot_session_id);

    const third = await sendMessage({
      actorId: 'test-user',
      conversationId: conv.id,
      content: 'AFTER-LOSS',
    });
    await waitForStatus(third.executionId, 'completed');

    const prompt = stub.turnsFor(bob.id).at(-1)!.prompt;
    assert.match(
      prompt,
      /HISTORY-MARKER/,
      '新 session 里一条历史都没有，checkpoint 之前那段必须重新注入',
    );
    assert.match(
      prompt,
      new RegExp(`stub reply from ${bob.id}`),
      '自己之前发过的消息也不能再过滤 —— 过滤的前提是「已经在 session history 里」，而新 session 里没有',
    );

    // checkpoint 重新回到「真的处理到哪」，而不是停在旧值上。
    const after = runtimeRow(conv.id, bob.id);
    assert.ok(after);
    assert.ok(
      after.last_context_message_sequence > runtime.last_context_message_sequence,
      '重读之后 checkpoint 必须重新覆盖整段历史',
    );
  });

  it('session 是本轮新建的、但没按「全新 session」组装 → checkpoint 退回 0', async () => {
    // 探针说 session 还在、resume 时才发现已经没了：这一轮只拿到了 checkpoint
    // 之后的尾部。checkpoint 这时不能往前推 —— 推了，前面那段历史就永久留在
    // 洞外，而且没有任何地方看得出来。
    const { conv } = await conversationWithHistory('RaceSession');

    stub.reportSessionCreated = true;
    try {
      const third = await sendMessage({
        actorId: 'test-user',
        conversationId: conv.id,
        content: 'RACE-TURN',
      });
      await waitForStatus(third.executionId, 'completed');
    } finally {
      stub.reportSessionCreated = false;
    }

    const afterRace = runtimeRow(conv.id, bob.id);
    assert.ok(afterRace);
    assert.equal(
      afterRace.last_context_message_sequence,
      0,
      '不能证明这个 session 见过前面的记录时，checkpoint 必须退回 0',
    );

    // 下一轮从 0 重放，把洞补回来。
    const fourth = await sendMessage({
      actorId: 'test-user',
      conversationId: conv.id,
      content: 'HEAL-TURN',
    });
    await waitForStatus(fourth.executionId, 'completed');

    assert.match(
      stub.turnsFor(bob.id).at(-1)!.prompt,
      /HISTORY-MARKER/,
      '下一轮必须把整段房间记录重放一遍，否则那个洞就永久留下了',
    );
    const healed = runtimeRow(conv.id, bob.id);
    assert.ok(healed);
    assert.ok(healed.last_context_message_sequence > 0, '补回来之后 checkpoint 正常推进');
  });
});

describe('wait-for 环检测（跨 delegation 树的死锁保护）', () => {
  it('目标 runtime 正在等自己时，delegation 被拒绝', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'WaitFor',
      memberIds: [alice.id, bob.id],
    });

    const aliceRun = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'A' });
    await waitForStatus(aliceRun.executionId, 'completed');

    // Bob 的 execution 走 Task 建出来：用户消息只唤醒 Lead，
    // 这里需要的是「Bob 有一条独立 root execution + runtime」
    //（delegation 建出来的 child 自带 path，前置的 path 环检测会先拦住，
    // 考不到 wait-for 这条分支）。
    await team.planTasks({
      conversationId: conv.id,
      memberId: alice.id,
      objective: 'wait-for setup',
      requirements: { facts: [], assumptions: [], constraints: [], successCriteria: [] },
      tasks: [{ key: 't1', title: 'T', assigneeMemberId: bob.id }],
    });
    let bobRunId = '';
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const row = db
        .prepare(
          `SELECT id FROM execution WHERE conversation_id = ? AND member_id = ? AND kind = 'member_work'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(conv.id, bob.id) as unknown as { id: string } | undefined;
      if (row) {
        bobRunId = row.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(bobRunId, '前置条件：Bob 应该有一条 task execution');
    const bobRun = { executionId: bobRunId };
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
});

describe('durable conversation_event 与 SSE 回放', () => {
  it('durable 事件带递增 sequence，message.delta 不落库', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'Events',
      memberIds: [bob.id],
      leadMemberId: bob.id,
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
      const sent = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'hello' });
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

  it('replayAndSubscribe 先补历史再推实时，且不重复投递', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'ReplaySubscribe',
      memberIds: [bob.id],
      leadMemberId: bob.id,
    });

    const first = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'history' });
    await waitForStatus(first.executionId, 'completed');

    const history = team.listEventsSince(conv.id, 0);
    const highWater = history[history.length - 1].sequence as number;

    const received: Array<number | null> = [];
    const unsubscribe = team.replayAndSubscribe(conv.id, highWater, (event) => {
      received.push(event.sequence);
    });

    try {
      // 订阅建立后立刻产生的新事件必须被推送到
      const second = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'live' });
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

});

describe('RecoveryService', () => {
  it('running/waiting_for_member → interrupted，queued root 重新提交，queued child 中断', () => {
    const handle = new DatabaseSync(path.join(dataDir, 'recovery.db'));
    handle.exec('PRAGMA foreign_keys = ON;');
    migrate(handle);

    handle.exec(`
      INSERT INTO member (id, handle, name, role, created_at, updated_at)
      VALUES ('m', 'm', 'M', 'R', 't', 't');

      INSERT INTO team (id, name, created_by, created_at, updated_at)
      VALUES ('t1', 'T', 'u', 't', 't');

      -- 两个 conversation：member_runtime 有 UNIQUE(conversation_id, member_id)，
      -- 同一个 Member 在同一 conversation 里只能有一个 runtime
      INSERT INTO conversation (id, team_id, title, kind, created_by, created_at, updated_at)
      VALUES ('c', 't1', 'C', 'direct', 'u', 't', 't'),
             ('c2', 't1', 'C2', 'direct', 'u', 't', 't');

      INSERT INTO conversation_member (conversation_id, member_id, joined_at)
      VALUES ('c', 'm', 't'), ('c2', 'm', 't');

      INSERT INTO member_runtime (id, conversation_id, member_id, copilot_session_id, workspace_path, status, active_execution_id, last_context_message_sequence)
      VALUES ('r-running', 'c',  'm', 's1', '/tmp/1', 'running', 'e-running', 3),
             ('r-idle',    'c2', 'm', 's2', '/tmp/2', 'idle',    NULL,        0);

      INSERT INTO execution (id, conversation_id, member_id, goal_revision, runtime_id, parent_execution_id, delegation_path, kind, status, prompt, waiting_for_runtime_id, created_at)
      VALUES ('e-running', 'c',  'm', 0, 'r-running', NULL,     '["m"]',     'interactive',     'running',            'p', NULL,         '1'),
             ('e-waiting', 'c2', 'm', 0, 'r-idle',    NULL,     '["m"]',     'interactive',     'waiting_for_member', 'p', 'r-running',  '2'),
             ('e-qroot',   'c2', 'm', 0, 'r-idle',    NULL,     '["m"]',     'interactive',     'queued',             'p', NULL,         '3'),
             ('e-qchild',  'c2', 'm', 0, 'r-idle',    'e-qroot','["m","m"]', 'member_delegate', 'queued',             'p', NULL,         '4'),
             ('e-done',    'c2', 'm', 0, 'r-idle',    NULL,     '["m"]',     'interactive',     'completed',          'p', NULL,         '5');
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

      INSERT INTO team (id, name, created_by, created_at, updated_at)
      VALUES ('t1', 'T', 'u', 't', 't');

      INSERT INTO conversation (id, team_id, title, kind, lead_member_id, status, created_by, message_sequence, created_at, updated_at)
      VALUES ('c', 't1', 'Room', 'task', 'm1', 'running', 'u', 23, 't', 't');

      INSERT INTO conversation_member (conversation_id, member_id, joined_at)
      VALUES ('c', 'm1', 't'), ('c', 'm2', 't');
    `);

    // Alice：排队中被进程带走 —— 触发消息是 17，原因是 lead_message。
    // 房间现在已经走到 23；拿当前水位重放等于换了一轮。
    //
    // pending_wake 与 wake_status 是两次写（调度器分开调，因为「正在跑」时不该
    // 把状态压回 queued），这里手动复现「刚入队就被进程带走」那一刻。
    const states = new ConversationMemberService(handle);
    states.ensure('c', 'm1', 0);
    states.setPendingWake('c', 'm1', true, { triggerSequence: 17, reason: 'lead_message' });
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
      [{ conversationId: 'c', memberId: 'm1', taskId: null, reason: 'lead_message', triggerSequence: 17 }],
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
      kind: 'task',
      title: 'Crash Room',
      memberIds: [alice.id, bob.id],
    });

    // 用户消息只唤醒 Lead（Alice）。Bob 从头到尾没被唤醒，读游标停在 0。
    const first = await sendMessage({ actorId: 'test-user', conversationId: room.id, content: '先看这个' });
    await waitForStatus(first.executionId, 'completed');
    await waitForConversationIdle(room.id);

    // 再堆一条，把房间水位推高 —— 这样「原样重放」和「猜一个」会明显不同
    const second = await sendMessage({ actorId: 'test-user', conversationId: room.id, content: '再补一条' });
    await waitForStatus(second.executionId, 'completed');
    await waitForConversationIdle(room.id);

    const watermark = team.getConversation(room.id).messageSequence;
    assert.ok(watermark > 1, '前置条件：房间水位应该已经超过第 1 条');

    // 模拟「Bob 的唤醒在排队时进程被 kill」。
    //
    // 这个状态没法通过公开 API 造出来（正常路径下一入队就立刻开跑），所以直接
    // 把 durable 那几个字段写成崩溃那一刻的样子 —— 这正是 RecoveryService
    // 重启后看到的东西。
    const states = new ConversationMemberService(db);
    states.setPendingWake(room.id, bob.id, true, { triggerSequence: 1, reason: 'lead_message' });
    states.setWakeStatus(room.id, bob.id, 'queued');

    const lost = states.findLostWakes();
    assert.deepEqual(
      lost.filter((wake) => wake.memberId === bob.id).map((wake) => ({ ...wake })),
      [{ conversationId: room.id, memberId: bob.id, taskId: null, reason: 'lead_message', triggerSequence: 1 }],
    );

    for (const wake of lost) team.redispatchWake(wake);
    await waitForConversationIdle(room.id);

    const bobRuns = (
      db
        .prepare(
          `
          SELECT trigger_message_sequence, wake_reason
          FROM execution
          WHERE conversation_id = ? AND member_id = ?
          ORDER BY rowid
          `,
        )
        .all(room.id, bob.id) as unknown as Array<{
        trigger_message_sequence: number | null;
        wake_reason: string | null;
      }>
    ).map((row) => ({ ...row }));

    assert.deepEqual(
      bobRuns,
      [{ trigger_message_sequence: 1, wake_reason: 'lead_message' }],
      '重放出来的必须是当时那一轮',
    );
  });
});

describe('retryExecution', () => {
  it('生成新 execution 并指回原记录，审计链不断', async () => {
    const conv = team.createConversation({
      kind: 'task',
      title: 'Retry',
      memberIds: [bob.id],
      leadMemberId: bob.id,
    });

    stub.failWith = 'transient';
    let failedId = '';
    try {
      const failed = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'try' });
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
      const running = await sendMessage({ actorId: 'test-user', conversationId: conv.id, content: 'again' });
      assert.throws(() => team.retryExecution(running.executionId), /仍在进行中/);
      release();
      await waitForStatus(running.executionId, 'completed');
    } finally {
      release();
      stub.hold = null;
    }
  });
});

// config 模块的 env 读取必须发生在这里（见上方注释），但可靠性开关的
// 默认值不单独测：那是常量断言，行为本身由上面各恢复用例覆盖。
