import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 恢复流程里三处**租约保护曾经缺失**的地方。
 *
 * ── 为什么这三处要单独一组用例 ───────────────────────────────────────
 *
 * 前一组（recovery-lease.test.ts）证明的是「execution 不会被误回收」。但
 * RecoveryService 一共打了三张表，而租约只按 execution 抢 —— 另外两张表要么
 * 完全不认租约，要么**认错了列**。三种失败形态各不相同，也都不报错：
 *
 *   1. conversation_task  running → blocked
 *      无条件置 blocked 会把别人正在做的活标成「需要重试」。
 *
 *   2. member_runtime.active_execution_id 的清理
 *      判定写成 `status = 'running'` 时，`waiting_for_member` 会被当成
 *      「已经结束」——而它是一条**还挂在半空中**的链：runtime 指针被提前清掉，
 *      下一个 turn 就能在同一条链恢复之前抢进这个 runtime，单写者保证失效。
 *
 *   3. findLostWakes 挑「需要重派」的唤醒
 *      保护只加在复位那一步是不够的：挑出来的行会被 index.ts 拿去 redispatch，
 *      于是副本 B 把副本 A 正持有的唤醒重派一遍，A 那一轮的结果稍后写回来。
 *
 * 第 1 条还有个**静默失效**的陷阱：租约是按 execution 抢的，而
 * `conversation_task` 的 id 列是 Task 的 id —— 直接复用 `leaseFree('conversation_task', 'id')`
 * 会永远查不到租约，SQL 语法正确、跑得通、保护为零。所以判定必须跨一层指向
 * `current_execution_id`。下面第一条用例就是钉这个的。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-leasegaps-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db, now } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { WorkerLeaseService, LEASE_RESOURCE_EXECUTION, wakeLeaseId } = await import(
  '../worker-lease.js'
);
const { RecoveryService, LEASE_RESOURCE_WAKE } = await import('../recovery-service.js');
const { ConversationMemberService } = await import('../conversation-member-service.js');
const { createTestStack, StubCopilot } = await import('./support.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memberService = new MemberService(db);
const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);

let conversationId = '';
let memberId = '';
/** 一条真实的 execution 行（FK 要求它存在）。 */
let executionId = '';

before(async () => {
  const member = stack.team.createMember({ name: 'GapSubject', role: 'Engineer' });
  memberId = member.id;
  const room = stack.team.createConversation({
    kind: 'task',
    title: 'Lease gaps',
    memberIds: [member.id],
  });
  conversationId = room.id;

  const sent = await stack.team.sendMessage({
    actorId: 'test-user',
    conversationId: room.id,
    content: '起一轮',
  });
  const { singleExecutionId } = await import('./support.js');
  executionId = singleExecutionId(db, room.id, sent.wakes);

  // 这一轮已经跑完了，别让它干扰后面手工造的中间态。
  db.prepare(`UPDATE execution SET status = 'completed', ended_at = ? WHERE id = ?`).run(
    now(),
    executionId,
  );
});

/** 把租约写成「已过期」——比 sleep 一个 TTL 稳定得多。 */
function forceExpire(resourceType: string, resourceId: string): void {
  db.prepare(
    `UPDATE worker_lease SET lease_expires_at = ? WHERE resource_type = ? AND resource_id = ?`,
  ).run(new Date(Date.now() - 60_000).toISOString(), resourceType, resourceId);
}

function worker(): InstanceType<typeof WorkerLeaseService> {
  return new WorkerLeaseService(db, 30_000);
}

/**
 * 每个用例都从「一个租约都没有」开始。
 *
 * 上一个用例 claim 出来的活租约会一直躺在表里，而同一个资源上只有一个 owner ——
 * 下一个用例的 `claim` 会静默失败，于是断言变成在测残留状态而不是它自己造的场景。
 * 这类失败最难查：用例单独跑是绿的，一起跑就红。
 */
function clearLeases(): void {
  db.prepare(`DELETE FROM worker_lease`).run();
}

function recover(leases?: InstanceType<typeof WorkerLeaseService>) {
  return new RecoveryService(db, new ConversationMemberService(db), leases).recover();
}

// ------------------------------------------------------- 1. Task 的租约保护

describe('恢复流程：running 的 Task 不能被误置 blocked', () => {
  /** 造一条 running 且挂着 executionId 的 Task。 */
  function seedRunningTask(): string {
    clearLeases();
    const taskId = randomUUID();
    const timestamp = now();
    db.prepare(
      `INSERT INTO conversation_task (
         id, conversation_id, goal_revision, title, description, assignee_member_id,
         status, dependencies_json, acceptance_criteria_json, current_execution_id,
         sort_order, created_at, updated_at
       ) VALUES (?, ?, 1, 'Gap task', '', ?, 'running', '[]', '[]', ?, 0, ?, ?)`,
    ).run(taskId, conversationId, memberId, executionId, timestamp, timestamp);
    db.prepare(
      `UPDATE execution SET status = 'running', ended_at = NULL, error = NULL WHERE id = ?`,
    ).run(executionId);
    return taskId;
  }

  function taskStatus(taskId: string): string {
    return (
      db.prepare(`SELECT status FROM conversation_task WHERE id = ?`).get(taskId) as unknown as {
        status: string;
      }
    ).status;
  }

  it('这条 Task 的 execution 有活跃租约时不置 blocked', () => {
    const taskId = seedRunningTask();
    const holder = worker();
    holder.claim(LEASE_RESOURCE_EXECUTION, executionId);

    const report = recover(holder);

    assert.equal(report.blockedTasks, 0, '别人正跑着的 Task 不能被标成「需要重试」');
    assert.equal(taskStatus(taskId), 'running');

    db.prepare(`DELETE FROM conversation_task WHERE id = ?`).run(taskId);
  });

  it('租约过期后置 blocked，并把条数报出来', () => {
    const taskId = seedRunningTask();
    const holder = worker();
    holder.claim(LEASE_RESOURCE_EXECUTION, executionId);
    forceExpire(LEASE_RESOURCE_EXECUTION, executionId);

    const report = recover(holder);

    assert.equal(report.blockedTasks, 1, '持有者已经没了，这条 Task 必须被收口');
    assert.equal(taskStatus(taskId), 'blocked');
    assert.equal(
      (db.prepare(`SELECT blocker FROM conversation_task WHERE id = ?`).get(taskId) as unknown as {
        blocker: string;
      }).blocker.length > 0,
      true,
      'blocked 必须带原因，否则前端只能显示「被阻塞了」',
    );

    db.prepare(`DELETE FROM conversation_task WHERE id = ?`).run(taskId);
  });

  it('单进程语义（不传 leases）：无条件收口', () => {
    const taskId = seedRunningTask();
    const holder = worker();
    holder.claim(LEASE_RESOURCE_EXECUTION, executionId);

    const report = recover();

    assert.equal(report.blockedTasks, 1, '单进程时「running」必然属于刚崩掉的自己');

    db.prepare(`DELETE FROM conversation_task WHERE id = ?`).run(taskId);
  });
});

// ------------------------------- 2. active_execution_id 要认 waiting_for_member

describe('恢复流程：waiting_for_member 的 runtime 指针不能被提前清掉', () => {
  let runtimeId = '';

  /**
   * 把真实的 runtime 行改成「正挂在一条 waiting_for_member 的链上」。
   *
   * 用 UPDATE 而不是 INSERT：runtime 在 before() 里那轮真实 turn 中已经建出来了
   * （`UNIQUE(conversation_id, member_id)` 挡着，而且「同一个 Member 在一个房间里
   * 只有一个 runtime」本来就是这张表的语义）。造第二个只会让人以为单写者不存在。
   */
  function seedRuntimePointingAtWaitingExecution(): void {
    clearLeases();
    runtimeId = (
      db
        .prepare(`SELECT id FROM member_runtime WHERE conversation_id = ? AND member_id = ?`)
        .get(conversationId, memberId) as unknown as { id: string }
    ).id;

    db.prepare(
      `UPDATE member_runtime
       SET status = 'running', active_execution_id = ?, last_context_message_sequence = 0
       WHERE id = ?`,
    ).run(executionId, runtimeId);

    db.prepare(
      `UPDATE execution SET status = 'waiting_for_member', ended_at = NULL, error = NULL WHERE id = ?`,
    ).run(executionId);
  }

  function activeExecutionId(): string | null {
    return (
      db.prepare(`SELECT active_execution_id FROM member_runtime WHERE id = ?`).get(runtimeId) as
        unknown as { active_execution_id: string | null }
    ).active_execution_id;
  }

  it('这条链被租约持有（还在半空中）时指针保留', () => {
    seedRuntimePointingAtWaitingExecution();
    const holder = worker();
    holder.claim(LEASE_RESOURCE_EXECUTION, executionId);

    const report = recover(holder);

    assert.equal(
      report.activeExecutionCleared,
      0,
      'waiting_for_member 是「还活着」：漏掉它会让单写者保证失效',
    );
    assert.equal(activeExecutionId(), executionId, '指针必须还在');
  });

  it('这条链已经结束（无租约、被回收）时指针被清掉', () => {
    seedRuntimePointingAtWaitingExecution();
    const holder = worker();

    const report = recover(holder);

    assert.equal(report.activeExecutionCleared, 1, '真正结束的链必须清掉指针');
    assert.equal(activeExecutionId(), null);
  });
});

// ------------------------------------------- 3. findLostWakes 也要认 wake 租约

describe('恢复流程：别人正持有的唤醒不能被重派', () => {
  function seedQueuedWake(): void {
    clearLeases();
    db.prepare(
      `UPDATE conversation_member_state
       SET wake_status = 'queued',
           pending_wake = 1,
           pending_wake_trigger_sequence = 1,
           pending_wake_reason = 'user_mention',
           pending_wake_task_id = NULL,
           updated_at = ?
       WHERE conversation_id = ? AND member_id = ?`,
    ).run(now(), conversationId, memberId);
  }

  function wakeRow(): { wake_status: string; pending_wake: number } {
    return db
      .prepare(
        `SELECT wake_status, pending_wake FROM conversation_member_state
         WHERE conversation_id = ? AND member_id = ?`,
      )
      .get(conversationId, memberId) as unknown as { wake_status: string; pending_wake: number };
  }

  it('被活跃 wake 租约持有时既不挑出来、也不复位', () => {
    seedQueuedWake();
    const holder = worker();
    holder.claim(LEASE_RESOURCE_WAKE, wakeLeaseId(conversationId, memberId));

    const report = recover(holder);

    assert.deepEqual(
      report.lostWakes,
      [],
      '挑出来就会被 index.ts 重派 —— 副本 B 会把 A 正持有的唤醒再跑一遍',
    );
    assert.equal(report.wakesReset, 0, '复位同样不能碰');
    assert.equal(wakeRow().wake_status, 'queued', '在途状态必须原样保留');
    assert.equal(wakeRow().pending_wake, 1);
  });

  it('租约过期后挑出来并复位（持有者已经没了）', () => {
    seedQueuedWake();
    const holder = worker();
    holder.claim(LEASE_RESOURCE_WAKE, wakeLeaseId(conversationId, memberId));
    forceExpire(LEASE_RESOURCE_WAKE, wakeLeaseId(conversationId, memberId));

    const report = recover(holder);

    assert.equal(report.lostWakes.length, 1, '持有者没了，这一轮必须重派');
    assert.equal(report.lostWakes[0].conversationId, conversationId);
    assert.equal(report.lostWakes[0].memberId, memberId);
    assert.equal(report.wakesReset, 1);
    assert.equal(wakeRow().wake_status, 'idle');
    assert.equal(wakeRow().pending_wake, 0);
  });

  it('单进程语义（不传 leases）：全部重派', () => {
    seedQueuedWake();
    const holder = worker();
    holder.claim(LEASE_RESOURCE_WAKE, wakeLeaseId(conversationId, memberId));

    const report = recover();

    assert.equal(report.lostWakes.length, 1, '单进程时没有「别人」这个概念');
    assert.equal(report.wakesReset, 1);
  });

  it('wake 租约的键必须带 conversationId（只按 memberId 会在多房间里串台）', () => {
    seedQueuedWake();
    const holder = worker();
    // 同一个 Member、**另一个房间**的租约 —— 不该挡住这一间。
    holder.claim(LEASE_RESOURCE_WAKE, wakeLeaseId('some-other-room', memberId));

    const report = recover(holder);

    assert.equal(
      report.lostWakes.length,
      1,
      '唤醒是「某个 Member 在某个房间里的状态」，单独一个 memberId 表达不出它在哪个房间',
    );
  });
});
