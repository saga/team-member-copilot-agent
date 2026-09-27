import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.js';
import type { ConversationTask } from './domain.js';
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

  ensureLeadWake(conversationId: string, leadMemberId: string | null, triggerSequence: number): boolean {
    if (!leadMemberId) return false;
    if (this.scheduler.isBusy(conversationId, leadMemberId)) return false;
    const state = this.states.get(conversationId, leadMemberId);
    if (state.muted) return false;
    this.scheduler.enqueue({
      conversationId,
      memberId: leadMemberId,
      taskId: null,
      reason: 'lead_message',
      triggerSequence,
    });
    return true;
  }

  startReadyTasks(conversationId: string): ConversationTask[] {
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

  onTaskCompleted(taskId: string): void {
    const task = this.tasks.get(taskId);
    this.tasks.refreshReady(this.db, task.conversationId);
    this.startReadyTasks(task.conversationId);
    const conversation = this.readConversation(task.conversationId);
    if (conversation?.leadMemberId) {
      this.ensureLeadWake(task.conversationId, conversation.leadMemberId, conversation.messageSequence);
    }
    const status = this.tasks.recomputeConversationStatus(task.conversationId);
    if (status) this.events.onConversation(task.conversationId);
    this.events.onTask(this.tasks.get(taskId));
  }

  /**
   * Task 状态变化的统一入口：按最新 status 分发，一个 Task 只推进一次。
   * 调用方不要再按「完成/失败」各调一遍 —— 终态以 DB 里读到的为准。
   */
  onTaskChanged(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task.status === 'completed' || task.status === 'cancelled') {
      this.onTaskCompleted(taskId);
    } else if (task.status === 'blocked' || task.status === 'failed') {
      this.onTaskBlocked(taskId);
    } else {
      this.events.onTask(task);
    }
  }

  /** blocked / failed：刷新受影响的下游、启动新的 ready、唤醒 Lead、重算状态。 */
  onTaskBlocked(taskId: string): void {
    this.onTaskBlockedOrFailed(taskId);
  }

  onTaskFailed(taskId: string): void {
    this.onTaskBlockedOrFailed(taskId);
  }

  private onTaskBlockedOrFailed(taskId: string): void {
    const task = this.tasks.get(taskId);
    this.tasks.refreshReady(this.db, task.conversationId);
    this.startReadyTasks(task.conversationId);
    const conversation = this.readConversation(task.conversationId);
    if (conversation?.leadMemberId) {
      this.ensureLeadWake(task.conversationId, conversation.leadMemberId, conversation.messageSequence);
    }
    const status = this.tasks.recomputeConversationStatus(task.conversationId);
    if (status) this.events.onConversation(task.conversationId);
    this.events.onTask(this.tasks.get(taskId));
  }

  onTaskInterrupted(taskId: string, reason: string): void {
    this.tasks.markBlocked(taskId, reason);
    this.tasks.recomputeConversationStatus(this.tasks.get(taskId).conversationId);
    this.events.onTask(this.tasks.get(taskId));
    this.events.onConversation(this.tasks.get(taskId).conversationId);
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
