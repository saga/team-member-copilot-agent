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
export class WorkerLeaseService {
  /** 本进程的身份。每个实例不同 —— 同机多进程也是两个 owner。 */
  readonly owner = randomUUID();

  constructor(
    private readonly db: DatabaseSync,
    private readonly ttlMs = 30_000,
  ) {}

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
}
