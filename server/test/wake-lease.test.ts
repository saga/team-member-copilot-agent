import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * MemberTurnScheduler 的 **DB 级 wake 租约** —— 多副本下同一个唤醒只能跑一次。
 *
 * ── 为什么进程内的 pending / inFlight 不够 ────────────────────────────
 *
 * 那两样东西的前提是「只有我一个进程」。多副本之后它们各自成立、合起来失效：
 * 两个副本都从恢复流程里拿到同一个「丢失的唤醒」，各自 enqueue、各自 pump ——
 * 同一个 (conversation, member) 上跑了两轮。而这里最不能接受的就是「跑两遍」：
 * 一次外部写入的副作用不可撤销。
 *
 * ── 跳过时的三条约束 ─────────────────────────────────────────────────
 *
 *   1. 不执行          —— 抢不到就是抢不到
 *   2. 不碰 durable 行 —— 那是对方的在途状态，替它写会把它那一轮覆盖掉
 *   3. 不算错误        —— 走 onError 会让多副本下每个正常轮次都留一条「失败」
 *
 * 第 2 条是最容易漏的：把 wake_status 回 idle 看起来只是「收尾」，实际上等于
 * 把对方正在处理的那一轮标成了「空闲」，下一个 turn 立刻就能挤进来。
 *
 * ── 为什么这一组不经过 TeamService ───────────────────────────────────
 *
 * 调度器的输入是「一个 wake + 一个 run 回调」，租约是它的**入参**。走完整链路
 * 会把「谁抢到了租约」埋在一堆无关的副作用里；这里直接给它两个副本实例，
 * 断言的就是「谁跑了」这一件事。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-wake-lease-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { WorkerLeaseService, LEASE_RESOURCE_WAKE, wakeLeaseId } = await import(
  '../worker-lease.js'
);
const { MemberTurnScheduler } = await import('../member-turn-scheduler.js');
import type { ConversationMemberService } from '../conversation-member-service.js';
import type { PendingWake } from '../domain.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const CONVERSATION = 'conv-1';
const MEMBER = 'member-1';

function wake(): PendingWake {
  return {
    conversationId: CONVERSATION,
    memberId: MEMBER,
    triggerSequence: 1,
    reason: 'user_mention',
    taskId: null,
  };
}

/** 记账用的 states 替身：只关心「谁被动了」。 */
function recordingStates() {
  const calls: {
    pendingWake: Array<{ conversationId: string; memberId: string; pending: boolean }>;
    wakeStatus: Array<{ conversationId: string; memberId: string; status: string }>;
    abandoned: number;
  } = { pendingWake: [], wakeStatus: [], abandoned: 0 };

  const states = {
    setPendingWake: (conversationId: string, memberId: string, pending: boolean) => {
      calls.pendingWake.push({ conversationId, memberId, pending });
    },
    setWakeStatus: (conversationId: string, memberId: string, status: string) => {
      calls.wakeStatus.push({ conversationId, memberId, status });
    },
    abandonPendingWake: () => {
      calls.abandoned += 1;
    },
  } as unknown as ConversationMemberService;

  return { states, calls };
}

/** 一个副本：自己的租约身份 + 自己的调度器。 */
function replica(leases?: InstanceType<typeof WorkerLeaseService>) {
  const { states, calls } = recordingStates();
  const ran: PendingWake[] = [];
  const errors: unknown[] = [];

  const scheduler = new MemberTurnScheduler(
    states,
    async (pending, markStarted) => {
      ran.push(pending);
      // 真实实现里这一句与 execution 的落库同一个事务。
      markStarted();
    },
    (pending, error) => {
      errors.push({ pending, error });
    },
    leases,
  );

  return { scheduler, calls, ran, errors };
}

describe('MemberTurnScheduler：wake 租约挡住跨副本的重复执行', () => {
  it('另一个副本正持有该唤醒时：不执行、不碰 durable 行、不算错误', async () => {
    const leaseA = new WorkerLeaseService(db, 30_000);
    const leaseB = new WorkerLeaseService(db, 30_000);

    // A 正在处理这个唤醒。
    const aGrant = leaseA.claim(LEASE_RESOURCE_WAKE, wakeLeaseId(CONVERSATION, MEMBER));
    assert.ok(aGrant, 'A 必须抢到');

    const b = replica(leaseB);
    b.scheduler.enqueue(wake());
    await b.scheduler.drain();

    assert.equal(b.ran.length, 0, '抢不到就不能跑 —— 否则同一个唤醒跑了两轮');
    assert.equal(b.errors.length, 0, '跳过是预期行为，不是错误');
    assert.equal(b.calls.abandoned, 0, '不能放弃对方的在途状态');

    const idleCalls = b.calls.wakeStatus.filter((call) => call.status === 'idle');
    assert.deepEqual(
      idleCalls,
      [],
      '把 wake_status 回 idle 等于把对方正在跑的那一轮标成「空闲」，下一个 turn 立刻能挤进来',
    );

    leaseA.release(aGrant);
  });

  it('持有者跑完释放之后，另一个副本能接手', async () => {
    const leaseA = new WorkerLeaseService(db, 30_000);
    const leaseB = new WorkerLeaseService(db, 30_000);
    const resourceId = wakeLeaseId(CONVERSATION, MEMBER);

    const aGrant = leaseA.claim(LEASE_RESOURCE_WAKE, resourceId);
    assert.ok(aGrant);

    const b = replica(leaseB);
    b.scheduler.enqueue(wake());
    await b.scheduler.drain();
    assert.equal(b.ran.length, 0);

    // A 那一轮结束，释放。下一次唤醒 B 必须能接手 —— 否则这个 Member 的
    // 唤醒会被永久卡住。
    leaseA.release(aGrant);

    b.scheduler.enqueue(wake());
    await b.scheduler.drain();

    assert.equal(b.ran.length, 1);
    assert.equal(b.errors.length, 0);
  });

  it('跑完之后释放自己的租约（下一个副本不用等 TTL）', async () => {
    const leaseB = new WorkerLeaseService(db, 30_000);
    const b = replica(leaseB);

    b.scheduler.enqueue(wake());
    await b.scheduler.drain();

    assert.equal(b.ran.length, 1);
    assert.equal(
      leaseB.isHeld(LEASE_RESOURCE_WAKE, wakeLeaseId(CONVERSATION, MEMBER)),
      false,
      '释放漏掉的话，要等 TTL 到期才有人能接手 —— 表现是「唤醒偶尔慢一分钟」',
    );
  });

  it('单进程（不传 leases）：照常执行，不引入任何跳过语义', async () => {
    const b = replica();
    b.scheduler.enqueue(wake());
    await b.scheduler.drain();

    assert.equal(b.ran.length, 1);
    assert.equal(
      b.calls.wakeStatus.filter((call) => call.status === 'idle').length,
      1,
      '正常跑完要回到 idle',
    );
  });

  it('同一个副本重复 enqueue 不会因为租约把自己挡住', async () => {
    // claim 对自己的未过期租约返回 false，所以 runWithLease 必须靠 heldByMe
    // 短路 —— 少了它，同一个副本的第二次 pump 会把自己当别人，整轮被静默跳过。
    const leases = new WorkerLeaseService(db, 30_000);
    const { states, calls } = recordingStates();
    let concurrent = 0;
    let maxConcurrent = 0;

    const scheduler = new MemberTurnScheduler(
      states,
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
      () => {},
      leases,
    );

    scheduler.enqueue(wake());
    scheduler.enqueue({ ...wake(), triggerSequence: 2 });
    await scheduler.drain();

    assert.equal(maxConcurrent, 1, '同一个 (conversation, member) 上只能有一轮在跑');
    assert.equal(
      calls.wakeStatus.filter((call) => call.status === 'idle').length >= 1,
      true,
      '串行跑完之后必须回到 idle',
    );
  });

  it('run 抛错且没 markStarted：放弃 durable 的排队项，循环不卡死', async () => {
    const { states, calls } = recordingStates();
    const errors: unknown[] = [];
    const scheduler = new MemberTurnScheduler(
      states,
      async () => {
        throw new Error('成员在这中间被归档了');
      },
      (_pending, error) => {
        errors.push(error);
      },
    );

    scheduler.enqueue(wake());
    await scheduler.drain();

    assert.equal(errors.length, 1);
    assert.equal(
      calls.abandoned,
      1,
      '从来没开始跑的唤醒不能一直占着「有个唤醒在排队」，否则每次恢复都会重派它',
    );
  });
});
