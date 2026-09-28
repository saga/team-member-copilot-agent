import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Worker Lease —— 多副本部署下「谁在跑这一轮」的唯一仲裁点。
 *
 * ── 这一组用例真正在锁的东西 ──────────────────────────────────────────
 *
 * 租约的全部价值在**一条 SQL 的 WHERE 子句**上：
 *
 *   ON CONFLICT ... DO UPDATE ... WHERE worker_lease.lease_expires_at < ?
 *
 * 拆成「先 SELECT 看过期没有，再 UPDATE」会有一个经典窗口：两个进程同时看到
 * 「已过期」，然后都去写。所以下面反复断言的是「同一个资源上只有一个 owner
 * 能成功」，而不是「租约表里有什么」。
 *
 * 第二个容易写错的地方是**静默失败**：SQLite 的 upsert 在 WHERE 不成立时是
 * 静默不更新（不抛异常），只看异常会把「没抢到」当成「抢到了」。所以 claim
 * 必须返回 `changes === 1`，这里逐条验证。
 *
 * ── 为什么还要测 RecoveryService ─────────────────────────────────────
 *
 * 租约只在恢复流程里才有意义。单进程时「running 的 execution」必然属于刚崩掉
 * 的自己，全部标 interrupted 是对的；多副本时那个前提不成立 —— 一起打掉等于
 * 把别人的活干掉，而它自己还不知道，会继续跑完然后写进一条已经中断的记录里。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-lease-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { WorkerLeaseService } = await import('../worker-lease.js');
const { RecoveryService, LEASE_RESOURCE_EXECUTION } = await import('../recovery-service.js');
const { ConversationMemberService } = await import('../conversation-member-service.js');
const { createTestStack, StubCopilot } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 两个「进程」。owner 在构造时就分开了，正是多副本的样子。 */
function worker(ttlMs = 30_000): InstanceType<typeof WorkerLeaseService> {
  return new WorkerLeaseService(db, ttlMs);
}

/** 把租约行直接写成「已过期」——比 sleep 一个 TTL 稳定得多。 */
function forceExpire(resourceType: string, resourceId: string): void {
  db.prepare(
    `UPDATE worker_lease SET lease_expires_at = ? WHERE resource_type = ? AND resource_id = ?`,
  ).run(new Date(Date.now() - 60_000).toISOString(), resourceType, resourceId);
}

describe('Worker Lease：同一资源上只有一个 owner', () => {
  it('A 拿到之后 B 抢不到（未过期）', () => {
    const a = worker();
    const b = worker();

    assert.equal(a.claim('execution', 'exec-1'), true, '第一个必须拿到');
    assert.equal(b.claim('execution', 'exec-1'), false, '未过期时第二个必须抢不到');
    assert.equal(a.isHeld('execution', 'exec-1'), true);
    assert.equal(a.owner === b.owner, false, '两个实例必须是两个身份');
  });

  it('A 的租约过期后 B 能接手（这就是「崩溃不需要解锁」的实现）', () => {
    const a = worker();
    const b = worker();

    a.claim('execution', 'exec-2');
    forceExpire('execution', 'exec-2');

    assert.equal(b.isHeld('execution', 'exec-2'), false, '过期就不再算持有');
    assert.equal(b.claim('execution', 'exec-2'), true, '过期租约必须能被抢');
  });

  it('A 续租之后 B 抢不到（heartbeat 只续自己的）', () => {
    const a = worker();
    const b = worker();

    a.claim('execution', 'exec-3');
    // 先让它接近过期，再续租 —— 否则「续租生效」和「本来就没过期」分不开。
    forceExpire('execution', 'exec-3');
    a.heartbeat('execution', 'exec-3');

    assert.equal(a.isHeld('execution', 'exec-3'), true, '续租之后必须重新有效');
    assert.equal(b.claim('execution', 'exec-3'), false, '续过租的不能被抢');
  });

  it('A 释放之后 B 能接手', () => {
    const a = worker();
    const b = worker();

    a.claim('execution', 'exec-4');
    a.release('execution', 'exec-4');

    assert.equal(b.claim('execution', 'exec-4'), true);
  });

  it('B 释放不掉 A 的租约（release 只删自己的）', () => {
    const a = worker();
    const b = worker();

    a.claim('execution', 'exec-5');
    b.release('execution', 'exec-5');

    assert.equal(a.isHeld('execution', 'exec-5'), true, '替别人解锁会让两个进程都以为自己在跑');
  });

  it('B 续不到 A 的租约（否则会把别人的 TTL 往后推，两边都不过期）', () => {
    const a = worker();
    const b = worker();

    a.claim('execution', 'exec-6');
    forceExpire('execution', 'exec-6');
    b.heartbeat('execution', 'exec-6');

    assert.equal(a.isHeld('execution', 'exec-6'), false, 'B 的 heartbeat 不该让 A 的租约复活');
  });

  it('sweepExpired 只打扫，不影响正确性', () => {
    const a = worker();
    a.claim('execution', 'exec-7');
    forceExpire('execution', 'exec-7');

    assert.equal(a.sweepExpired() >= 1, true);
    // 打扫完照样能被抢 —— 过期的租约本来就能被覆盖，清理只是别让表无限长大。
    assert.equal(worker().claim('execution', 'exec-7'), true);
  });
});

describe('RecoveryService：多副本时不能回收别人正在跑的活', () => {
  const memberService = new MemberService(db);
  const stack = createTestStack(
    db,
    memberService,
    new StubCopilot().asCopilot as unknown as CopilotService,
  );

  let executionId = '';

  before(async () => {
    const member = stack.team.createMember({ name: 'Lease Subject', role: 'Lead' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Lease',
      memberIds: [member.id],
      leadMemberId: member.id,
    });
    const sent = await stack.team.sendMessage({
      actorId: 'test-user',
      conversationId: room.id,
      content: '起一轮',
    });
    const { singleExecutionId } = await import('./support.js');
    executionId = singleExecutionId(db, room.id, sent.wakes);

    // 手工把它钉成 running —— 恢复流程只看这个状态。
    db.prepare(`UPDATE execution SET status = 'running', ended_at = NULL WHERE id = ?`).run(executionId);
  });

  it('有未过期租约时不回收，并把跳过的条数报出来', () => {
    const holder = worker();
    holder.claim(LEASE_RESOURCE_EXECUTION, executionId);

    const report = new RecoveryService(
      db,
      new ConversationMemberService(db),
      holder,
    ).recover();

    assert.equal(report.interrupted, 0, '别人正跑着的 execution 不能被标成 interrupted');
    assert.equal(report.skippedLeased >= 1, true, '跳过了几条必须报出来，否则「莫名没被回收」查不出来');
    assert.equal(
      db.prepare(`SELECT status FROM execution WHERE id = ?`).get(executionId)!.status,
      'running',
    );
  });

  it('租约过期后回收（持有者已经没了，必须能接手）', () => {
    const holder = worker();
    holder.claim(LEASE_RESOURCE_EXECUTION, executionId);
    forceExpire(LEASE_RESOURCE_EXECUTION, executionId);

    const report = new RecoveryService(
      db,
      new ConversationMemberService(db),
      holder,
    ).recover();

    assert.equal(report.interrupted, 1);
    assert.equal(
      db.prepare(`SELECT status FROM execution WHERE id = ?`).get(executionId)!.status,
      'interrupted',
    );
  });

  it('不传 leases = 单进程语义：全部回收', () => {
    db.prepare(`UPDATE execution SET status = 'running', ended_at = NULL, error = NULL WHERE id = ?`).run(
      executionId,
    );
    const holder = worker();
    holder.claim(LEASE_RESOURCE_EXECUTION, executionId);

    const report = new RecoveryService(db, new ConversationMemberService(db)).recover();

    assert.equal(report.interrupted, 1, '单进程时「running」必然属于刚崩掉的自己');
    assert.equal(report.skippedLeased, 0, '不传 leases 就没有「跳过」这个概念');
  });
});
