import { config } from './config.js';
import type { ScheduledWakeRun } from './domain.js';
import type { TeamService } from './team-service.js';
import type { TeamStructureService } from './team-structure-service.js';
import type { WorkerLeaseService } from './worker-lease.js';
import { LEASE_RESOURCE_EXECUTION } from './recovery-service.js';

/**
 * Scheduled Wake：只做 once + interval，不做 Calendar/RRULE。
 *
 * 执行链：tick → 到期 active schedule → INSERT run（UNIQUE 幂等）→
 * TeamService.enqueueScheduledWork（建 execution 并绑定 run）→
 * 更新 next_run_at。周期任务不补历史，只执行一次并跳到下一个 future slot。
 *
 * ── 多副本：启动 execution 前先抢租约 ────────────────────────────────
 *
 * 传入 `leases` 时，每个 execution 在真正开跑前先 `claim` 一次，抢不到就跳过。
 * 这是 §25 的 worker loop，也是「两个副本各自 tick 一次、同一条 schedule 被
 * 跑两遍」的唯一防线 —— `scheduled_wake_run` 的 UNIQUE 只保证**一行**，
 * 不保证只有一个进程去执行它。
 *
 * 租约而不是「进程内 running 标记」：后者的前提是只有一个进程，多副本时
 * 两边各自成立、合起来失效，而这里最不能接受的就是同一个 schedule 跑两遍。
 *
 * `leases` 不传 = 单进程语义（照常执行，不抢）。用「传没传」而不是一个
 * 布尔开关，是为了让「单机模式」和「多副本模式」共用同一条代码路径 ——
 * 分叉出一条从来没被跑过的单机分支是更糟的选择。
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly structure: TeamStructureService,
    private readonly team: () => TeamService,
    private readonly leases?: WorkerLeaseService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[scheduler] tick 失败:', error instanceof Error ? error.message : error);
      });
    }, config.schedulerIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.structure.dueSchedules(new Date().toISOString());
      let fired = 0;
      for (const schedule of due) {
        const presence = this.structure.getPresence(schedule.teamId, 'agent', schedule.memberId);
        if (presence.availability === 'paused') continue;
        const scheduledFor = schedule.nextRunAt;
        let run: ScheduledWakeRun;
        try {
          run = this.structure.insertScheduleRun(schedule.id, scheduledFor);
        } catch (error) {
          // 只有 409 才是幂等命中：数据库故障不能当成 duplicate skipped。
          if (isConflict(error)) {
            this.structure.markFired(schedule, scheduledFor, 'duplicate skipped');
            continue;
          }
          throw error;
        }
        try {
          const executionId = await this.team().enqueueScheduledWork({
            scheduleRunId: run.id,
            conversationId: schedule.conversationId,
            memberId: schedule.memberId,
            prompt: schedule.prompt,
          });
          // 顺序固定：run 标 running、schedule 推进到下一次，**之后**才启动
          // execution。反过来（enqueue 内部就启动）会让一轮极快的 execution 在
          // tick 返回前完成并收口 run，随后这里的 'running' 又把终态顶回去 ——
          // 留下「Execution completed / run running」这种 durable scheduler
          // 最不该出现的状态。
          this.structure.updateScheduleRun(run.id, { status: 'running', executionId });
          this.structure.markFired(schedule, scheduledFor);
          fired += 1;
          this.startExecution(executionId, (error) => {
            // runScheduledExecution 自己会收口 run（settleScheduleRun），
            // 这里只是别让拒绝变成 unhandled rejection。
            // eslint-disable-next-line no-console
            console.error(
              `[scheduler] scheduled execution ${executionId} failed:`,
              error instanceof Error ? error.message : error,
            );
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.structure.updateScheduleRun(run.id, { status: 'failed', error: message });
          this.structure.markFired(schedule, scheduledFor, message);
        }
      }
      return fired;
    } finally {
      this.running = false;
    }
  }

  recoverQueuedRuns(): void {
    for (const run of this.structure.recoverQueuedRuns()) {
      let schedule: ReturnType<TeamStructureService['getSchedule']>;
      try {
        schedule = this.structure.getSchedule(run.scheduleId);
      } catch {
        // schedule 已被删（CASCADE 会清 run，这里只剩孤儿）：标记失败即可。
        this.structure.updateScheduleRun(run.id, { status: 'failed', error: 'schedule 不存在' });
        continue;
      }
      if (run.executionId) {
        const execution = this.team().getExecution(run.executionId);
        if (execution.status === 'completed') {
          this.structure.updateScheduleRun(run.id, { status: 'completed' });
          continue;
        }
        if (
          execution.status === 'failed' ||
          execution.status === 'cancelled' ||
          execution.status === 'interrupted'
        ) {
          this.structure.updateScheduleRun(run.id, {
            status: 'failed',
            error: execution.error ?? execution.status,
          });
          continue;
        }
        if (execution.status === 'queued') {
          this.startExecution(execution.id, (error) => {
            this.structure.updateScheduleRun(run.id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          });
          continue;
        }
        // running / waiting_for_member：引擎侧由 RecoveryService 收口，这里不动。
        continue;
      }
      // 无 executionId：重建 execution。enqueue 现在只建不跑，所以这里要像
      // tick 一样先标 running 再启动 —— 两边共用同一份顺序，恢复出来才不会
      // 与正常路径行为不同。
      void this.team()
        .enqueueScheduledWork({
          scheduleRunId: run.id,
          conversationId: schedule.conversationId,
          memberId: schedule.memberId,
          prompt: schedule.prompt,
        })
        .then((executionId) => {
          this.structure.updateScheduleRun(run.id, { status: 'running', executionId });
          this.startExecution(executionId, (error) => {
            this.structure.updateScheduleRun(run.id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          });
        })
        .catch((error: unknown) => {
          this.structure.updateScheduleRun(run.id, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  /**
   * 启动一条 execution，并按需持有租约。
   *
   * 抢不到 = 另一个副本正在跑它，**直接跳过**（不等待、不重试）：等待会让这个
   * tick 卡住，而重试在 TTL 内也不会成功。跳过是对的 —— 持有者跑完会自己释放，
   * 下一轮 tick 再看。
   *
   * 心跳间隔取租约服务自己的定义（TTL 的三分之一，或 WORKER_LEASE_HEARTBEAT_MS）。
   * 以前这里内联算一遍，而 RecoveryService / 执行链那边各有一份 —— 三处换算
   * 只要有一处改错（间隔 ≥ TTL），租约就会在持有者手里过期。
   *
   * 释放只在 finally 里做：中途抛异常时租约必须回到可用状态，否则这条
   * execution 会被自己的失败卡住，直到 TTL 到期才有人能接手。
   *
   * ── 心跳失败 = 立刻停掉这一轮 ────────────────────────────────────────
   *
   * 心跳返回 false 说明租约已经不在自己手里（过期被别人接手，或代次变了）。
   * 此时**不能**让这一轮继续跑下去：另一个副本已经在跑同一件事，两边同时产出
   * 结果就是双写。所以这里主动 cancel 掉这条 execution（abort 引擎 + 等它收尾），
   * 让「我们不再产出结果」成为可观测事实，而不是指望它自然结束。
   */
  private startExecution(executionId: string, onError: (error: unknown) => void): void {
    const grant = this.leases?.claim(LEASE_RESOURCE_EXECUTION, executionId) ?? null;
    if (this.leases && !grant) return;

    let lost = false;
    let stopRequested = false;
    const heartbeat = grant
      ? setInterval(() => {
          if (lost) return;
          let ok = false;
          try {
            ok = this.leases!.heartbeat(grant);
          } catch {
            ok = false;
          }
          // 取消请求是 DB 上的权威信号，可能来自另一个副本：本进程没见过它，
          // 但这一轮仍然必须停。心跳是执行期间唯一稳定的周期点。
          if (ok) {
            if (stopRequested) return;
            let requested = false;
            try {
              requested = this.team().isCancellationRequested(executionId);
            } catch {
              requested = false;
            }
            if (!requested) return;
            stopRequested = true;
            void this.team()
              .cancelExecution(executionId, 'lease-heartbeat')
              .catch(() => {
                // 已经收尾 / 状态不允许取消 —— 那正是想要的结果。
              });
            return;
          }
          // 只触发一次：心跳是周期性的，租约丢了之后每一次都会失败，重复
          // abort 只会把日志淹没在一堆同样的告警里。
          lost = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[scheduler] execution ${executionId} 的租约已丢失（token=${grant.fencingToken}），` +
              '停止这一轮：另一个副本已经接手',
          );
          void this.team()
            .cancelExecution(executionId)
            .catch(() => {
              // 引擎可能已经收尾 / 状态已不允许取消 —— 那说明它已经停了，
              // 正是我们想要的结果。
            });
        }, this.leases!.heartbeatIntervalMs)
      : null;
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();

    void this.team()
      .runScheduledExecution(executionId, grant)
      .catch(onError)
      .finally(() => {
        if (heartbeat) clearInterval(heartbeat);
        if (grant) this.leases?.release(grant);
      });
  }
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 409
  );
}
