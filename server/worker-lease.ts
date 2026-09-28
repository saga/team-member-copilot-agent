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
 * 放进一条语句之后，SQLite 的行锁 + 这个 WHERE 保证了只有一个拿到行。
 *
 * ── 租约不是授权：fencing token ──────────────────────────────────────
 *
 * 租约只回答「**现在**谁可以跑」。它回答不了「刚才那个以为自己还在跑的进程
 * 能不能把结果写回来」—— 而那才是真正会造成伤害的那件事：
 *
 *   A 拿到租约 → 假死（GC / 网络分区 / 长时间工具调用）
 *     → TTL 到期 → B 接手并推进了这条 execution
 *     → A 醒来，继续把它的结果写回 DB
 *
 * 只按 id 做条件更新挡不住它，因为 id 自始至终没变、`lease_owner` 在 A 眼里
 * 「还是我」（它手里是过期的快照）。
 *
 * 所以每次**重新夺取**租约时 `fencing_token` 递增，并把 token 交给持有者。
 * 之后所有的写回都带上它：A 手里永远是旧值，它的写回命中 0 行。这样
 * 「谁可以跑」（租约）和「谁还能写」（fencing）分成两件事，各自可判定。
 *
 * 这不是一个理论问题：TTL 内双跑正是租约方案**已知且接受**的代价，fencing
 * 是把那个代价从「可能写坏数据」压到「最多多打一次外部请求」的那一半。
 *
 * 返回 `LeaseGrant | null` 而不是 boolean：调用方需要 token 才能做后面所有的
 * 条件写入。只看有没有报错也不够 —— SQLite 的 upsert 在 WHERE 不成立时是
 * **静默不更新**（不抛异常），把「没抢到」当成「抢到了」是最初版本的 bug。
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
 *   command       一笔外部业务动作正在被某个进程执行
 *
 * wake 的 resource_id 是 `conversation_id || ':' || member_id`：唤醒是「某个
 * Member 在某个房间里的状态」，单独一个 member_id 表达不出它在哪个房间。
 *
 * command 单独一把锁而不是复用 execution 的：一笔外部写入可能在**完全不同的
 * 进程**里执行（人审批之后由 API 副本跑，或者恢复流程接手），它和「哪个 Agent
 * 在跑这一轮」不是同一个生命周期。见 §1 的「Execution Lease 和 Command Lease 分开」。
 */
export const LEASE_RESOURCE_EXECUTION = 'execution';
export const LEASE_RESOURCE_RUNTIME = 'runtime';
export const LEASE_RESOURCE_WAKE = 'wake';
export const LEASE_RESOURCE_COMMAND = 'command';

/** wake 租约的资源键。写和读（RecoveryService 的 SQL）必须用同一个拼法。 */
export function wakeLeaseId(conversationId: string, memberId: string): string {
  return `${conversationId}:${memberId}`;
}

/**
 * 一次成功的取得租约。
 *
 * 它同时是「我持有这个资源」的**凭证**和「我这一代」的编号。两者放在一起是
 * 刻意的：只给 token 不给 owner 时，调用方无法自己拼出可校验的条件；只给
 * owner 时，调用方无法区分「我这一代」和「上一代的我」。
 */
export interface LeaseGrant {
  resourceType: string;
  resourceId: string;
  owner: string;
  fencingToken: number;
}

/**
 * 租约已经不属于自己了。
 *
 * 单独一个类型而不是普通 Error：调用方需要把它和「业务失败」分开处理 ——
 * 租约丢失时**不应该**再把这次失败写回 DB（那是新持有者的事），也不应该
 * 重试（重试前得先重新抢租约）。
 */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
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
   * 尝试取得租约，成功时返回**带代次的凭证**。
   *
   * null = 别人正持有且没过期，调用方应当**跳过**这一项，而不是等待。
   *
   * ── 为什么用 RETURNING ──────────────────────────────────────────────
   *
   * 「写入」和「读回刚写入的代次」必须在同一条语句里。分成 `run()` + `get()`
   * 会留一个窗口：这中间另一个进程可能已经抢走并 +1，于是我们拿到的 token
   * 是**别人那一代**的 —— 之后所有带 fencing 的写入都会以为自己有效。
   * 多进程下这不是理论问题，正是租约方案里最容易忽略的一处。
   *
   * 第一次取得时 token = 1；被重新夺取时 = 上一代 + 1。于是「更新」永远单调
   * 递增，调用方不需要任何时钟或比较逻辑就能判定新旧。
   */
  claim(resourceType: string, resourceId: string): LeaseGrant | null {
    const current = Date.now();
    const expires = new Date(current + this.ttlMs).toISOString();

    const row = this.db
      .prepare(
        `
        INSERT INTO worker_lease (
          resource_type,
          resource_id,
          lease_owner,
          fencing_token,
          lease_expires_at,
          heartbeat_at
        )
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(resource_type, resource_id)
        DO UPDATE SET
          lease_owner = excluded.lease_owner,
          fencing_token = worker_lease.fencing_token + 1,
          lease_expires_at = excluded.lease_expires_at,
          heartbeat_at = excluded.heartbeat_at
        WHERE worker_lease.lease_expires_at < ?
        RETURNING lease_owner, fencing_token
        `,
      )
      .get(resourceType, resourceId, this.owner, expires, now(), now()) as unknown as
      | { lease_owner: string; fencing_token: number }
      | undefined;

    // 没有返回行 = WHERE 不成立 = 别人正持有且没过期。这里**不能**靠 catch：
    // upsert 的 WHERE 不成立是静默的，不抛异常。
    if (!row) return null;

    return {
      resourceType,
      resourceId,
      owner: row.lease_owner,
      fencingToken: row.fencing_token,
    };
  }

  /**
   * 续租。返回 false = 租约已经不属于自己了（过期被抢、或 token 对不上）。
   *
   * `lease_owner` + `fencing_token` 两个条件都不能省：
   *   · 少了 owner，一个已经失去租约的进程会把**别人的** TTL 往后推 ——
   *     表现是两边都以为自己在跑，而且都不会超时；
   *   · 少了 token，上一代的自己会以为自己续上了新租约（owner 恰好相同，
   *     比如同一个进程重新 claim 过）。
   *
   * 返回布尔而不是 void：调用方必须知道「这次心跳没成功」，因为那意味着
   * **应该立刻停止正在跑的工作**（见 runWithLease 的 onLeaseLost）。
   */
  heartbeat(grant: LeaseGrant): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE worker_lease
        SET lease_expires_at = ?,
            heartbeat_at = ?
        WHERE resource_type = ?
          AND resource_id = ?
          AND lease_owner = ?
          AND fencing_token = ?
        `,
      )
      .run(
        new Date(Date.now() + this.ttlMs).toISOString(),
        now(),
        grant.resourceType,
        grant.resourceId,
        grant.owner,
        grant.fencingToken,
      );

    return Number(result.changes) === 1;
  }

  /**
   * 断言自己**此刻仍然**持有这一代租约。不成立就抛。
   *
   * 这是所有「写回」之前的最后一道闸：写之前确认租约还在，比写之后发现
   * 数据被覆盖要便宜得多。它的判据比 heartbeat 更严 —— 除了 owner + token，
   * 还要求 `lease_expires_at >= now`：租约还在自己名下但**已经过期**同样
   * 意味着别人随时会接手，此时继续写就是在制造双写。
   */
  assertHeld(grant: LeaseGrant): void {
    const row = this.db
      .prepare(
        `
        SELECT 1 AS held
        FROM worker_lease
        WHERE resource_type = ?
          AND resource_id = ?
          AND lease_owner = ?
          AND fencing_token = ?
          AND lease_expires_at >= ?
        `,
      )
      .get(
        grant.resourceType,
        grant.resourceId,
        grant.owner,
        grant.fencingToken,
        now(),
      );

    if (!row) {
      throw new LeaseLostError(
        `${grant.resourceType}/${grant.resourceId} 的租约已失效` +
          `（owner=${grant.owner} token=${grant.fencingToken}）`,
      );
    }
  }

  /** 主动释放。同样只删自己的**这一代** —— 不能替别人解锁，也不能删掉新的一代。 */
  release(grant: LeaseGrant): void {
    this.db
      .prepare(
        `
        DELETE FROM worker_lease
        WHERE resource_type = ?
          AND resource_id = ?
          AND lease_owner = ?
          AND fencing_token = ?
        `,
      )
      .run(grant.resourceType, grant.resourceId, grant.owner, grant.fencingToken);
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
   * 同样返回 null（因为「没过期」这个条件不成立）。于是同一个进程里的嵌套
   * 调用会把自己当成「别人」：外层抢到了，内层再抢一次就失败，整轮被静默跳过。
   *
   * 真实场景就是它：SchedulerService 在启动 execution 前抢一次租约，而它调用的
   * runScheduledExecution → executeMemberTurn 里还会再抢一次。没有这个方法，
   * 加了内层保护之后所有 scheduled execution 都会「抢不到租约」而什么都不做。
   */
  heldByMe(resourceType: string, resourceId: string): boolean {
    return this.myGrant(resourceType, resourceId) !== null;
  }

  /**
   * 本进程当前持有的那一代凭证（未过期），没有则 null。
   *
   * 它是 `heldByMe` 的完整版：嵌套调用需要的不是「是不是我」，而是**「我是哪
   * 一代」** —— 内层要把同一个 grant 传下去做条件写入，否则内层的写回会
   * 因为没有 token 而失去保护。
   */
  myGrant(resourceType: string, resourceId: string): LeaseGrant | null {
    const row = this.db
      .prepare(
        `SELECT fencing_token FROM worker_lease
         WHERE resource_type = ? AND resource_id = ? AND lease_owner = ? AND lease_expires_at >= ?`,
      )
      .get(resourceType, resourceId, this.owner, now()) as unknown as
      | { fencing_token: number }
      | undefined;
    if (!row) return null;
    return {
      resourceType,
      resourceId,
      owner: this.owner,
      fencingToken: row.fencing_token,
    };
  }

  /**
   * 在租约保护下跑一段逻辑。
   *
   * 返回 `{ ran: false }` 表示**别人正在跑**，调用方应当跳过 —— 不等待、不重试
   * （等待会让当前这轮卡住，重试在 TTL 内也不会成功）。持有者跑完会自己释放，
   * 下一轮再看。
   *
   * 嵌套调用（本进程已持有）直接跑，并且**不释放**外层的租约：释放了外层的
   * 租约等于提前把资源让出去，而外层还在跑。嵌套时把**同一个** grant 传下去，
   * 所以内层的条件写入用的是同一个代次 —— 这是「内层写回也被 fencing 保护」
   * 的前提。
   *
   * ── onLeaseLost：心跳失败必须能停下来 ────────────────────────────────
   *
   * 心跳返回 false 意味着租约已经不在自己手里（过期被抢，或 token 变了）。
   * 此时**继续跑下去**就是在制造双写：另一个进程已经在跑同一件事，而这里
   * 还在产出结果。所以调用方要传一个回调，让它在心跳失败时主动把当前工作
   * 停掉（见 TeamService 传的 `() => copilot.cancelTurn(executionId)`）。
   *
   * 回调只触发一次：心跳是周期性的，租约丢了之后每一次都会失败，而重复 abort
   * 会让日志淹没在一堆同样的告警里，也会让「到底哪一刻开始失联」变得难查。
   *
   * 这是**第一道**保护。它不解决「旧 worker 已经发出的 Jira 请求」—— 那要靠
   * Command 的 unknown + 对账（见 command-service.ts）。
   */
  async runWithLease<T>(
    resourceType: string,
    resourceId: string,
    fn: (grant: LeaseGrant) => Promise<T>,
    options: {
      /**
       * 心跳失败（租约已丢失）时调用。**必须**是「停掉当前工作」而不是
       * 「记一条日志」—— 日志不能阻止双写。
       */
      onLeaseLost?: (error?: unknown) => void;
    } = {},
  ): Promise<{ ran: false } | { ran: true; value: T }> {
    const existing = this.myGrant(resourceType, resourceId);
    if (existing) {
      // 嵌套：不重复起心跳、也不释放。外层负责这两件事。
      return { ran: true, value: await fn(existing) };
    }

    const grant = this.claim(resourceType, resourceId);
    if (!grant) return { ran: false };

    let lost = false;
    const heartbeat = setInterval(() => {
      if (lost) return;
      try {
        if (!this.heartbeat(grant)) {
          lost = true;
          options.onLeaseLost?.();
        }
      } catch (error) {
        // 心跳自己抛错（库暂时不可用）同样意味着「无法证明我还持有」。
        // 按丢失处理：宁可多停一次，也不要在一个证明不了自己身份的租约上
        // 继续做外部写入。
        lost = true;
        options.onLeaseLost?.(error);
      }
    }, this.heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      return { ran: true, value: await fn(grant) };
    } finally {
      clearInterval(heartbeat);
      this.release(grant);
    }
  }
}
