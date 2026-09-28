import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { now } from './db.js';

/**
 * Worker Lease —— 多副本部署下「谁在跑这一轮」的唯一仲裁点。
 *
 * ── 为什么进程内的 pending Map / inFlight Set 不够 ────────────────────
 *
 * 那两样东西的前提是「只有我一个进程」。多副本之后它们各自成立、合起来失效：
 * 两个进程都认为自己是 owner，于是同一轮 execution 跑两遍。而这里最不能接受的
 * 就是「跑两遍」—— 一次 Jira 评论、一次流转、一次外部写入的副作用是不可撤销的。
 *
 * ── 为什么是租约不是锁 ───────────────────────────────────────────────
 *
 * 锁需要有人来解，而持锁的进程崩溃时没人能解 —— 系统会永久卡住，还得人来介入。
 * 租约到期自动可抢：进程没了，TTL 一到别人接手。代价是「TTL 内可能出现双跑」，
 * 所以 TTL 要显著大于一次 heartbeat 间隔（见 heartbeat 的调用方）。
 *
 * ── claim 的关键在 WHERE 子句 ────────────────────────────────────────
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE worker_lease.lease_expires_at < ?`
 * 让「抢」这件事在**一条 SQL 里**完成判定与写入。拆成「先 SELECT 看过期没有，
 * 再 UPDATE」会有一个经典窗口：两个进程同时看到「已过期」，然后都去写。
 * 放进一条语句之后，SQLite 的行锁 + 这个 WHERE 保证了只有一个 changes=1。
 *
 * 返回 `changes === 1` 而不是看有没有报错：SQLite 的 upsert 在 WHERE 不成立时
 * 是**静默不更新**（不抛异常），只看异常会把「没抢到」当成「抢到了」。
 */
/**
 * 租约保护的资源类型。
 *
 * 常量定义在这里而不是各调用方：租约的语义是「同一把锁的名字」，名字写错一个
 * 字母就是两把互不相干的锁 —— 两个进程各自 claim 成功，然后都以为自己是唯一
 * owner。集中定义让「有哪些锁」是可见的，而不是散落在 claim 调用点。
 *
 *   execution     一条 execution 正在被某个进程跑
 *   runtime       某个 Member 在某房间的 runtime 是单写者
 *   wake          某个 Member 在某房间的唤醒正在被处理
 *
 * wake 的 resource_id 是 `conversation_id || ':' || member_id`：唤醒是「某个
 * Member 在某个房间里的状态」，单独一个 member_id 表达不出它在哪个房间。
 */
export const LEASE_RESOURCE_EXECUTION = 'execution';
export const LEASE_RESOURCE_RUNTIME = 'runtime';
export const LEASE_RESOURCE_WAKE = 'wake';

/** wake 租约的资源键。写和读（RecoveryService 的 SQL）必须用同一个拼法。 */
export function wakeLeaseId(conversationId: string, memberId: string): string {
  return `${conversationId}:${memberId}`;
}

export class WorkerLeaseService {
  /** 本进程的身份。每个实例不同 —— 同机多进程也是两个 owner。 */
  readonly owner = randomUUID();

  constructor(
    private readonly db: DatabaseSync,
    private readonly ttlMs = 30_000,
    /**
     * 心跳间隔。默认取 TTL 的三分之一 —— 留出两次重试的余量，一次抖动不会让
     * 租约在自己手里过期。
     *
     * 定义在这里而不是各调用点各算一遍：心跳间隔和 TTL 是一对**必须一起看**的
     * 参数（间隔 ≥ TTL 等于租约永不续期），分开写就会出现「两处各有一套换算」，
     * 而其中一处迟早会被改错。
     */
    private readonly heartbeatMs = Math.max(1_000, Math.floor(ttlMs / 3)),
  ) {}

  /** 心跳间隔（毫秒）。调用方自己起定时器时用它，不要再算一遍。 */
  get heartbeatIntervalMs(): number {
    return this.heartbeatMs;
  }

  /**
   * 尝试取得租约。
   *
   * true = 现在归我（无论是新拿的还是从过期的别人手里接过来的）。
   * false = 别人正持有且没过期，调用方应当**跳过**这一项，而不是等待。
   */
  claim(resourceType: string, resourceId: string): boolean {
    const current = Date.now();
    const expires = new Date(current + this.ttlMs).toISOString();

    const result = this.db
      .prepare(
        `
        INSERT INTO worker_lease (
          resource_type,
          resource_id,
          lease_owner,
          lease_expires_at,
          heartbeat_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(resource_type, resource_id)
        DO UPDATE SET
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at,
          heartbeat_at = excluded.heartbeat_at
        WHERE worker_lease.lease_expires_at < ?
        `,
      )
      .run(resourceType, resourceId, this.owner, expires, now(), now());

    return Number(result.changes) === 1;
  }

  /**
   * 续租。
   *
   * `lease_owner = this.owner` 这个条件不能省：它保证续的**是自己**的租约。
   * 少了它，一个已经失去租约的进程会把别人的 TTL 往后推 —— 表现是两边都以为
   * 自己在跑，而且都不会超时。
   */
  heartbeat(resourceType: string, resourceId: string): void {
    this.db
      .prepare(
        `
        UPDATE worker_lease
        SET lease_expires_at = ?,
            heartbeat_at = ?
        WHERE resource_type = ?
          AND resource_id = ?
          AND lease_owner = ?
        `,
      )
      .run(
        new Date(Date.now() + this.ttlMs).toISOString(),
        now(),
        resourceType,
        resourceId,
        this.owner,
      );
  }

  /** 主动释放。同样只删自己的 —— 不能替别人解锁。 */
  release(resourceType: string, resourceId: string): void {
    this.db
      .prepare(
        `
        DELETE FROM worker_lease
        WHERE resource_type = ?
          AND resource_id = ?
          AND lease_owner = ?
        `,
      )
      .run(resourceType, resourceId, this.owner);
  }

  /**
   * 清理已过期的租约行。
   *
   * 只是打扫，不是解锁 —— 过期的租约本来就能被 claim 覆盖，所以清不掉也不会
   * 影响正确性，只会让这张表随时间变大。
   */
  sweepExpired(): number {
    const result = this.db
      .prepare(`DELETE FROM worker_lease WHERE lease_expires_at < ?`)
      .run(now());
    return Number(result.changes);
  }

  /** 这个资源现在有没有一个未过期的持有者。恢复流程用它区分「有人正跑」和「是遗留」。 */
  isHeld(resourceType: string, resourceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS held FROM worker_lease
         WHERE resource_type = ? AND resource_id = ? AND lease_expires_at >= ?`,
      )
      .get(resourceType, resourceId, now());
    return row !== undefined;
  }

  /**
   * 这个资源是不是**本进程**持有（且未过期）。
   *
   * ── 为什么需要它 ─────────────────────────────────────────────────────
   *
   * `claim` 的 WHERE 是 `lease_expires_at < ?` —— 它对**自己**的未过期租约
   * 同样返回 false（因为「没过期」这个条件不成立）。于是同一个进程里的嵌套
   * 调用会把自己当成「别人」：外层抢到了，内层再抢一次就失败，整轮被静默跳过。
   *
   * 真实场景就是它：SchedulerService 在启动 execution 前抢一次租约，而它调用的
   * runScheduledExecution → executeMemberTurn 里还会再抢一次。没有这个方法，
   * 加了内层保护之后所有 scheduled execution 都会「抢不到租约」而什么都不做。
   */
  heldByMe(resourceType: string, resourceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS held FROM worker_lease
         WHERE resource_type = ? AND resource_id = ? AND lease_owner = ? AND lease_expires_at >= ?`,
      )
      .get(resourceType, resourceId, this.owner, now());
    return row !== undefined;
  }

  /**
   * 在租约保护下跑一段逻辑。
   *
   * 返回 `{ ran: false }` 表示**别人正在跑**，调用方应当跳过 —— 不等待、不重试
   * （等待会让当前这轮卡住，重试在 TTL 内也不会成功）。持有者跑完会自己释放，
   * 下一轮再看。
   *
   * 嵌套调用（本进程已持有）直接跑，并且**不释放**外层的租约：释放了外层的
   * 租约等于提前把资源让出去，而外层还在跑。
   *
   * 心跳与释放都收在这里，是为了让三个调用点（execution / runtime / wake）
   * 共用同一份时序。分开写的话，「忘了在 finally 里释放」这种 bug 会在其中
   * 一处出现，而它的表现是「这条记录要等到 TTL 到期才有人能接手」。
   */
  async runWithLease<T>(
    resourceType: string,
    resourceId: string,
    fn: () => Promise<T>,
  ): Promise<{ ran: false } | { ran: true; value: T }> {
    if (this.heldByMe(resourceType, resourceId)) {
      return { ran: true, value: await fn() };
    }

    if (!this.claim(resourceType, resourceId)) return { ran: false };

    const heartbeat = setInterval(() => {
      this.heartbeat(resourceType, resourceId);
    }, this.heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      return { ran: true, value: await fn() };
    } finally {
      clearInterval(heartbeat);
      this.release(resourceType, resourceId);
    }
  }
}
