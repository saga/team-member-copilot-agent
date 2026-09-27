import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.js';
import type { ConversationTask, WakeReason } from './domain.js';
import { TaskService } from './task-service.js';
import type { ConversationMemberService } from './conversation-member-service.js';
import type { MemberTurnScheduler } from './member-turn-scheduler.js';

export interface TaskEvents {
  onTask(task: ConversationTask): void;
  onConversation(conversationId: string): void;
}

/**
 * Task 的推进器：只做状态之间的衔接，不跑 Agent。
 *
 *   用户消息 → Lead 唤醒
 *   plan 后 → 找 ready → 按执行人入队
 *   Task 完成 → 刷新依赖 → 找下一批 ready → 重算工作区状态
 *   Task 阻塞/失败 → 唤醒 Lead 做整体判断
 *
 * 同一个 Member 同时只跑一个 Task：入队前看 scheduler.isBusy。
 */
export class TaskOrchestrator {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: TaskService,
    private readonly states: ConversationMemberService,
    private readonly scheduler: MemberTurnScheduler,
    private readonly events: TaskEvents,
  ) {}

  ensureLeadWake(
    conversationId: string,
    leadMemberId: string | null,
    triggerSequence: number,
    reason: Extract<WakeReason, 'lead_message' | 'lead_clarification' | 'lead_recovery'> = 'lead_message',
  ): boolean {
    if (!leadMemberId) return false;
    // 用户消息 / clarification：Lead 正忙时不重复入队，消息本身会通过
    // message checkpoint 被下一轮看到。
    //
    // recovery 例外：Task 失败不产生新消息，错过这一次就永远没人处理 blocked。
    // scheduler 本来就支持 inFlight + pending，忙时入队只是排着，当前 turn
    // 完成后接着跑，不需要新状态。
    if (this.scheduler.isBusy(conversationId, leadMemberId) && reason !== 'lead_recovery') {
      return false;
    }
    const state = this.states.get(conversationId, leadMemberId);
    if (state.muted) return false;
    this.scheduler.enqueue({
      conversationId,
      memberId: leadMemberId,
      taskId: null,
      reason,
      triggerSequence,
    });
    return true;
  }

  startReadyTasks(conversationId: string): ConversationTask[] {
    // 依赖链的状态变化（ready / blocked）在这里统一广播：只发触发任务自己的
    // 变化，下游从 pending 翻成的 blocked 会静默丢掉，前端就永远是旧状态。
    const changed = this.tasks.refreshReady(this.db, conversationId);
    for (const task of changed.ready) this.events.onTask(task);
    for (const task of changed.blocked) this.events.onTask(task);
    const started: ConversationTask[] = [];
    for (const task of this.tasks.findReady(conversationId)) {
      if (this.scheduler.isBusy(conversationId, task.assigneeMemberId)) continue;
      if (this.hasActiveExecution(conversationId, task.assigneeMemberId)) continue;
      const state = this.states.get(conversationId, task.assigneeMemberId);
      if (state.muted) continue;
      this.scheduler.enqueue({
        conversationId,
        memberId: task.assigneeMemberId,
        taskId: task.id,
        reason: 'task_ready',
        triggerSequence: null,
      });
      started.push(task);
    }
    return started;
  }

  /**
   * Task 状态变化：
   *
   * completed / cancelled → 自动推进下游，不唤醒 Lead
   * blocked / failed     → 刷新依赖，唤醒 Lead 做整体判断（recovery 原因）
   * 其它                 → 只广播
   */
  onTaskChanged(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task.status === 'completed' || task.status === 'cancelled') {
      this.startReadyTasks(task.conversationId);
      this.recomputeAndEmit(task.conversationId);
      this.events.onTask(this.tasks.get(taskId));
      return;
    }
    if (task.status === 'blocked' || task.status === 'failed') {
      this.startReadyTasks(task.conversationId);
      const conversation = this.readConversation(task.conversationId);
      if (conversation?.leadMemberId) {
        this.ensureLeadWake(task.conversationId, conversation.leadMemberId, conversation.messageSequence, 'lead_recovery');
      }
      this.recomputeAndEmit(task.conversationId);
      this.events.onTask(this.tasks.get(taskId));
      return;
    }
    this.events.onTask(task);
  }

  private recomputeAndEmit(conversationId: string): void {
    const status = this.tasks.recomputeConversationStatus(conversationId);
    if (status) this.events.onConversation(conversationId);
  }

  onTaskInterrupted(taskId: string, reason: string): void {
    this.tasks.markBlocked(taskId, reason);
    this.onTaskChanged(taskId);
  }

  private hasActiveExecution(conversationId: string, memberId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM execution WHERE conversation_id = ? AND member_id = ?
         AND status IN ('queued', 'running', 'waiting_for_member') LIMIT 1`,
      )
      .get(conversationId, memberId) as unknown as { present: number } | undefined;
    return Boolean(row);
  }

  private readConversation(conversationId: string): {
    leadMemberId: string | null;
    messageSequence: number;
  } | null {
    const row = this.db
      .prepare(`SELECT lead_member_id, message_sequence FROM conversation WHERE id = ?`)
      .get(conversationId) as unknown as { lead_member_id: string | null; message_sequence: number } | undefined;
    if (!row) return null;
    return { leadMemberId: row.lead_member_id, messageSequence: row.message_sequence };
  }

  touchConversation(conversationId: string): void {
    this.db.prepare(`UPDATE conversation SET updated_at = ? WHERE id = ?`).run(now(), conversationId);
  }
}
