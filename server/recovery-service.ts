import type { DatabaseSync } from 'node:sqlite';
import { ConversationMemberService } from './conversation-member-service.js';
import { now } from './db.js';
import type { PendingWake } from './domain.js';
import type { WorkerLeaseService } from './worker-lease.js';

/**
 * 启动恢复。
 *
 * 策略刻意保守：
 *
 *   queued（root）        → 重新提交（它从来没开始跑过）
 *   queued（child）       → interrupted（父 execution 已经没了，单独重跑没有意义）
 *   running               → interrupted
 *   waiting_for_member    → interrupted
 *   completed/failed/
 *   cancelled/interrupted → 不动
 *
 * **不自动重跑 running。** Copilot session 可能已经在进程崩溃前完成了工具执行，
 * 只是 DB 还没来得及写 execution.completed；自动重跑会造成重复执行。要重做必须
 * 显式 retry，并且生成一条新的 execution（retry_of_execution_id 指回原记录）。
 *
 * ── 单进程 vs 多副本 ─────────────────────────────────────────────────
 *
 * 单进程时「跑着的 execution」必然属于**刚崩掉的那个进程**（就是自己），
 * 所以全部标 interrupted 是对的。
 *
 * 多副本时这个前提不成立：另一个副本正跑着的 execution 也是 `running`，
 * 一起打掉等于把别人的活干掉，而它自己还不知道 —— 它会继续跑完，然后把结果
 * 写进一条已经被标成 interrupted 的记录里。
 *
 * 所以传入 `leases` 时改成「只回收**没有活跃租约**的」：
 *
 *   有未过期租约   → 别人正在跑，不动
 *   租约过期/无租约 → 持有者已经没了，可以回收
 *
 * 「无租约」也算可回收，是为了不把「进程在 claim 之前就崩了」的行永远卡住。
 * 这个判定比「租约过期」严格更宽，但方向是对的：租约表里没有活着的持有者，
 * 就没有任何进程能证明自己在跑它。
 */
export interface RecoveryReport {
  interrupted: number;
  interruptedOrphanChildren: number;
  /** 需要调用方真正重新提交的 root execution id。 */
  requeuedExecutionIds: string[];
  runtimesReset: number;
  activeExecutionCleared: number;
  /**
   * 排队中被进程带走、需要重新派发的唤醒（conversation_member_state）。
   *
   * 和 `queued` 的 root execution 同一条规则：**还没开始跑**的可以安全重派。
   * 已经开始跑的唤醒（wake_status = 'running'）不重派 —— 它对应的 execution
   * 已经被标成 interrupted，重派会让副作用跑第二遍。
   *
   * 带上 triggerSequence / reason：恢复出来必须是**当时那一轮**，
   * 不能拿房间当前水位 + 最宽松的 reason 猜一个。
   */
  lostWakes: PendingWake[];
  /** 被复位成 idle 的唤醒状态行数。 */
  wakesReset: number;
  /** 因为持有活跃租约而被跳过的行数（多副本时才有意义）。 */
  skippedLeased: number;
}

const INTERRUPTED_REASON = '进程重启，execution 在运行中被中断（未自动重跑）';

/** 租约保护的资源类型。和 claim 调用方（scheduler）用的字符串必须一致。 */
export const LEASE_RESOURCE_EXECUTION = 'execution';
export const LEASE_RESOURCE_RUNTIME = 'runtime';
export const LEASE_RESOURCE_WAKE = 'wake';

export class RecoveryService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly states: ConversationMemberService,
    /**
     * 不传 = 单进程语义（全部回收）。传了 = 只回收没有活跃租约的。
     * 见类注释：这个参数决定的是「能不能动别人正在跑的活」。
     */
    private readonly leases?: WorkerLeaseService,
  ) {}

  recover(): RecoveryReport {
    const report: RecoveryReport = {
      interrupted: 0,
      interruptedOrphanChildren: 0,
      requeuedExecutionIds: [],
      runtimesReset: 0,
      activeExecutionCleared: 0,
      lostWakes: [],
      wakesReset: 0,
      skippedLeased: 0,
    };

    const timestamp = now();

    this.db.exec('BEGIN');
    try {
      // 1. running / waiting_for_member → interrupted（多副本时跳过有租约的）
      const interrupted = this.db
        .prepare(
          `
          UPDATE execution
          SET
            status = 'interrupted',
            waiting_for_runtime_id = NULL,
            error = COALESCE(error, ?),
            ended_at = COALESCE(ended_at, ?)
          WHERE status IN ('running', 'waiting_for_member')
            AND ${this.leaseFree('execution', 'id')}
          `,
        )
        .run(INTERRUPTED_REASON, timestamp, ...this.leaseFreeArgs(LEASE_RESOURCE_EXECUTION));
      report.interrupted = Number(interrupted.changes);
      report.skippedLeased = this.countLeasedRunning();

      // 2. queued 的 root 重新提交，queued 的 child 标记 interrupted
      const orphanChildren = this.db
        .prepare(
          `
          UPDATE execution
          SET
            status = 'interrupted',
            error = COALESCE(error, ?),
            ended_at = COALESCE(ended_at, ?)
          WHERE status = 'queued'
            AND parent_execution_id IS NOT NULL
          `,
        )
        .run('进程重启，父 execution 已中断', timestamp);
      report.interruptedOrphanChildren = Number(orphanChildren.changes);

      const roots = this.db
        .prepare(
          `
          SELECT id
          FROM execution
          WHERE status = 'queued'
            AND parent_execution_id IS NULL
          ORDER BY created_at
          `,
        )
        .all() as unknown as Array<{ id: string }>;
      report.requeuedExecutionIds = roots.map((row) => row.id);

      // 3. runtime 单写者状态复位。
      //
      //    清 active_execution_id 这一步不需要租约保护：上一步已经把「可回收的
      //    running」全变成了 interrupted，剩下的 running 都属于别人。所以条件是
      //    「指向一条已经结束的 execution」—— 别人正在跑的 execution 还是
      //    running，它的 runtime 不会被动。
      const cleared = this.db
        .prepare(
          `
          UPDATE member_runtime
          SET active_execution_id = NULL
          WHERE active_execution_id IS NOT NULL
            AND active_execution_id NOT IN (SELECT id FROM execution WHERE status = 'running')
          `,
        )
        .run();
      report.activeExecutionCleared = Number(cleared.changes);

      //    status 复位要保护租约：另一个副本的 runtime 也是 'running'。
      const reset = this.db
        .prepare(
          `
          UPDATE member_runtime
          SET status = 'idle'
          WHERE status = 'running'
            AND ${this.leaseFree('member_runtime', 'id')}
          `,
        )
        .run(...this.leaseFreeArgs(LEASE_RESOURCE_RUNTIME));
      report.runtimesReset = Number(reset.changes);

      // 4. 房间唤醒状态。
      //
      //    先挑出「排队中还没开始跑」的唤醒（可以安全重派），再统一复位 ——
      //    顺序不能反，复位会把 pending_wake 清掉。
      //
      //    这两步走 ConversationMemberService 而不是在这里再写一份 SQL：
      //    「什么算 lost wake」只该有一个定义，否则恢复逻辑和调度器会各自漂移。
      //    两边都是同步语句，会加入当前这个事务。
      report.lostWakes = this.states.findLostWakes();
      report.wakesReset = this.states.resetWakeStatuses({
        leaseProtected: this.leases !== undefined,
        nowIso: timestamp,
      });

      // 5. running 的 Task 不要自动重跑：把它们置成 blocked，前端显示原因并提供重试。
      this.db
        .prepare(
          `
          UPDATE conversation_task
          SET status = 'blocked', blocker = ?, updated_at = ?
          WHERE status = 'running'
          `,
        )
        .run('服务重启导致执行中断，检查后可重试', timestamp);
      this.db
        .prepare(
          `UPDATE conversation SET status = 'blocked', updated_at = ?
           WHERE status = 'running' AND id IN (SELECT conversation_id FROM conversation_task WHERE status = 'blocked')`,
        )
        .run(timestamp);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return report;
  }

  /**
   * 「这个资源没有活跃租约」的 SQL 片段。
   *
   * 没传 leases 时返回恒真 —— 单进程语义。用恒真而不是「跳过这一步」，
   * 是为了让两条路径共用同一条 UPDATE：分叉出两个 SQL 之后，改了其中一个
   * 忘了另一个是必然会发生的。
   *
   * `table` / `idColumn` 由调用方给：execution 与 member_runtime 的 id 列名不同，
   * 而 SQL 里没法参数化标识符。
   */
  private leaseFree(table: string, idColumn: string): string {
    if (!this.leases) return '1 = 1';
    return (
      `NOT EXISTS (
         SELECT 1 FROM worker_lease l
         WHERE l.resource_type = ?
           AND l.resource_id = ${table}.${idColumn}
           AND l.lease_expires_at >= ?
       )`
    );
  }

  /** `leaseFree` 用到的绑定参数，顺序与占位符一致。 */
  private leaseFreeArgs(resourceType: string): string[] {
    if (!this.leases) return [];
    return [resourceType, now()];
  }

  /**
   * 有多少条「正在跑且被活跃租约持有」的 execution 被跳过了。
   *
   * 只数 running / waiting_for_member 的：其它状态本来就不会被回收，
   * 把它们算进「跳过」会让日志里的数字对不上实际行为。
   */
  private countLeasedRunning(): number {
    if (!this.leases) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM worker_lease l
         JOIN execution e ON e.id = l.resource_id
         WHERE l.resource_type = ?
           AND l.lease_expires_at >= ?
           AND e.status IN ('running', 'waiting_for_member')`,
      )
      .get(LEASE_RESOURCE_EXECUTION, now()) as unknown as { n: number };
    return Number(row.n);
  }
}
