import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.js';

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
 * 注意：这个实现假设单进程独占 DB。多副本部署时需要把「谁是 owner」升级成
 * DB 层的 lease，否则第二个进程的恢复会误伤第一个进程正在跑的 execution。
 */

export interface RecoveryReport {
  interrupted: number;
  interruptedOrphanChildren: number;
  /** 需要调用方真正重新提交的 root execution id。 */
  requeuedExecutionIds: string[];
  runtimesReset: number;
  activeExecutionCleared: number;
}

const INTERRUPTED_REASON = '进程重启，execution 在运行中被中断（未自动重跑）';

export class RecoveryService {
  constructor(private readonly db: DatabaseSync) {}

  recover(): RecoveryReport {
    const report: RecoveryReport = {
      interrupted: 0,
      interruptedOrphanChildren: 0,
      requeuedExecutionIds: [],
      runtimesReset: 0,
      activeExecutionCleared: 0,
    };

    const timestamp = now();

    this.db.exec('BEGIN');
    try {
      // 1. running / waiting_for_member → interrupted
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
          `,
        )
        .run(INTERRUPTED_REASON, timestamp);
      report.interrupted = Number(interrupted.changes);

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

      // 3. runtime 单写者状态复位：running execution 已经全部变成 interrupted，
      //    所以任何还挂着 active_execution_id 的 runtime 都是陈旧状态。
      const cleared = this.db
        .prepare(
          `
          UPDATE member_runtime
          SET active_execution_id = NULL
          WHERE active_execution_id IS NOT NULL
          `,
        )
        .run();
      report.activeExecutionCleared = Number(cleared.changes);

      const reset = this.db
        .prepare(
          `
          UPDATE member_runtime
          SET status = 'idle'
          WHERE status = 'running'
          `,
        )
        .run();
      report.runtimesReset = Number(reset.changes);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return report;
  }
}
