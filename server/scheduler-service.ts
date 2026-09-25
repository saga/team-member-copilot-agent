import { config } from './config.js';
import { now } from './db.js';
import type { TeamService } from './team-service.js';
import type { TeamStructureService } from './team-structure-service.js';

/**
 * Scheduled Wake：只做 once + interval，不做 Calendar/RRULE。
 *
 * 执行链：tick → 到期 active schedule → 事务内 INSERT run（UNIQUE 幂等）+
 * 建 execution → 更新 next_run_at → COMMIT → TeamService.enqueueScheduledWork。
 * 周期任务不补历史，只执行一次并跳到下一个 future slot。
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
        // paused 成员不执行自动唤醒（@ 点名仍走聊天路径）。
        const presence = this.structure.getPresence(schedule.teamId, 'agent', schedule.memberId);
        if (presence.availability === 'paused') continue;
        const scheduledFor = schedule.nextRunAt;
        let runId: string;
        try {
          const run = this.structure.insertScheduleRun(schedule.id, scheduledFor);
          runId = run.id;
        } catch {
          // 同一时间点已有一条 run：幂等跳过，并把 next 推到未来避免反复撞。
          this.structure.markFired(schedule, scheduledFor, 'duplicate skipped');
          continue;
        }
        try {
          this.structure.updateScheduleRun(runId, { status: 'running' });
          const executionId = await this.team().enqueueScheduledWork({
            conversationId: schedule.conversationId,
            memberId: schedule.memberId,
            prompt: schedule.prompt,
            workItemId: schedule.workItemId,
            projectId: schedule.projectId,
          });
          this.structure.updateScheduleRun(runId, { status: 'completed', executionId });
          this.structure.markFired(schedule, scheduledFor);
          fired += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.structure.updateScheduleRun(runId, { status: 'failed', error: message });
          this.structure.markFired(schedule, scheduledFor, message);
        }
      }
      return fired;
    } finally {
      this.running = false;
    }
  }

  recoverQueuedRuns(): void {
    // queued/running 的 run：没有 execution 的重新建 execution，有的不动。
    // 依靠 UNIQUE(schedule_id, scheduled_for) 不会重复 fire。
    for (const run of this.structure.recoverQueuedRuns()) {
      try {
        const schedule = this.structure.getSchedule(run.scheduleId);
        if (schedule.status !== 'active') {
          this.structure.updateScheduleRun(run.id, { status: 'failed', error: 'schedule 已非 active' });
          continue;
        }
        if (run.executionId) continue;
        void this.team()
          .enqueueScheduledWork({
            conversationId: schedule.conversationId,
            memberId: schedule.memberId,
            prompt: schedule.prompt,
            workItemId: schedule.workItemId,
            projectId: schedule.projectId,
          })
          .then((executionId) => {
            this.structure.updateScheduleRun(run.id, { status: 'completed', executionId });
          })
          .catch((error: unknown) => {
            this.structure.updateScheduleRun(run.id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } catch {
        // schedule 已被删（CASCADE 会清 run，这里只剩孤儿）：标记失败即可。
        this.structure.updateScheduleRun(run.id, { status: 'failed', error: 'schedule 不存在' });
      }
    }
    void now;
  }
}
