import { config } from './config.js';
import type { ScheduledWakeRun } from './domain.js';
import type { TeamService } from './team-service.js';
import type { TeamStructureService } from './team-structure-service.js';

/**
 * Scheduled Wake：只做 once + interval，不做 Calendar/RRULE。
 *
 * 执行链：tick → 到期 active schedule → INSERT run（UNIQUE 幂等）→
 * TeamService.enqueueScheduledWork（建 execution 并绑定 run）→
 * 更新 next_run_at。周期任务不补历史，只执行一次并跳到下一个 future slot。
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly structure: TeamStructureService,
    private readonly team: () => TeamService,
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
            workItemId: schedule.workItemId,
            projectId: schedule.projectId,
          });
          this.structure.updateScheduleRun(run.id, { status: 'running', executionId });
          this.structure.markFired(schedule, scheduledFor);
          fired += 1;
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
          void this.team()
            .runScheduledExecution(execution.id)
            .catch((error: unknown) => {
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
      void this.team()
        .enqueueScheduledWork({
          scheduleRunId: run.id,
          conversationId: schedule.conversationId,
          memberId: schedule.memberId,
          prompt: schedule.prompt,
          workItemId: schedule.workItemId,
          projectId: schedule.projectId,
        })
        .catch((error: unknown) => {
          this.structure.updateScheduleRun(run.id, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 409
  );
}
