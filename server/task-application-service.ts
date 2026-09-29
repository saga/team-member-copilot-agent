import type { ConversationTask, TaskRequirements } from './domain.js';
import { badRequest } from './http-error.js';
import type { TaskPlanInput } from './task-service.js';
import type { TeamInternals } from './team-internals.js';

/**
 * TaskApplicationService
 *
 * 原先是 TeamService 的一组方法，按 §31 拆出来。共享基础设施由 TeamInternals
 * 注入 —— 这个类不认识 TeamService，只认识那张表面。
 */
export class TaskApplicationService {
  constructor(private readonly internals: TeamInternals) {}

  getTask(taskId: string): ConversationTask {
    return this.internals.tasks.get(taskId);
  }

  /** 这个工作区的任务列表。TeamService 只做门面，真正逻辑在 TaskService。 */
  listTasks(conversationId: string): ConversationTask[] {
    this.internals.getConversation(conversationId);
    return this.internals.tasks.list(conversationId);
  }

  /** CoreToolHost：Lead 制定任务计划。 */
  async planTasks(input: {
    conversationId: string;
    memberId: string;
    objective: string;
    requirements: TaskRequirements;
    tasks: Array<{
      key: string;
      title: string;
      description?: string;
      assigneeMemberId?: string;
      dependencies?: string[];
      acceptanceCriteria?: string[];
      modelTier?: 'cheap' | 'standard' | 'strong';
    }>;
  }): Promise<string> {
    const conversation = this.internals.getConversation(input.conversationId);
    this.internals.requireActiveMember(conversation, input.memberId);
    for (const task of input.tasks) {
      const assignee = (task.assigneeMemberId ?? conversation.leadMemberId ?? '').trim();
      if (assignee) this.internals.requireActiveMember(conversation, assignee);
    }
    const created = this.internals.tasks.plan({
      conversationId: conversation.id,
      memberId: input.memberId,
      objective: input.objective,
      requirements: input.requirements,
      tasks: input.tasks,
      rosterMemberIds: conversation.members.map((member) => member.id),
      leadMemberId: conversation.leadMemberId,
    });
    for (const task of created) {
      this.internals.emit(conversation.id, { type: 'task.updated', data: task });
    }
    this.internals.emit(conversation.id, { type: 'conversation.updated', data: this.internals.getConversation(conversation.id) });
    // 就绪任务在这里就启动，不等 Lead turn 结束 —— worker 和 Lead 并行，
    // turn 结束时的收口再调一次 startReadyTasks 是幂等的 no-op。
    const started = this.internals.orchestrator.startReadyTasks(conversation.id);
    return `已创建 ${created.length} 个任务，${started.length} 个已开始执行`;
  }

  /** CoreToolHost：Lead 在已有计划中补充一个真正缺失的任务。 */
  async addTask(input: {
    conversationId: string;
    memberId: string;
    title: string;
    description?: string;
    assigneeMemberId: string;
    dependencies?: string[];
    acceptanceCriteria?: string[];
    modelTier?: 'cheap' | 'standard' | 'strong';
  }): Promise<string> {
    const conversation = this.internals.getConversation(input.conversationId);
    this.internals.requireActiveMember(conversation, input.memberId);
    if (conversation.leadMemberId !== input.memberId) {
      throw badRequest('只有负责这个工作的 Lead 才能增加任务');
    }
    this.internals.requireActiveMember(conversation, input.assigneeMemberId);
    const task = this.internals.tasks.add({
      conversationId: conversation.id,
      title: input.title,
      description: input.description,
      assigneeMemberId: input.assigneeMemberId,
      dependencies: input.dependencies,
      acceptanceCriteria: input.acceptanceCriteria,
      modelTier: input.modelTier,
    });
    this.internals.emit(conversation.id, { type: 'task.updated', data: task });
    this.internals.emit(conversation.id, { type: 'conversation.updated', data: this.internals.getConversation(conversation.id) });
    const started = this.internals.orchestrator.startReadyTasks(conversation.id);
    return started.some((item) => item.id === task.id)
      ? `已增加任务「${task.title}」，已经开始执行`
      : `已增加任务「${task.title}」，当前等待依赖完成`;
  }

  /** CoreToolHost：Lead 给当前 Goal 重建任务计划（replan_tasks 工具）。 */
  async replanTasks(input: {
    conversationId: string;
    memberId: string;
    tasks: TaskPlanInput[];
  }): Promise<string> {
    const conversation = this.internals.getConversation(input.conversationId);
    this.internals.requireActiveMember(conversation, input.memberId);
    if (conversation.leadMemberId !== input.memberId) {
      throw badRequest('只有 Lead 可以重新规划任务');
    }
    const created = this.internals.tasks.replan({
      conversationId: conversation.id,
      memberId: input.memberId,
      tasks: input.tasks,
      rosterMemberIds: conversation.members.map((member) => member.id),
      leadMemberId: conversation.leadMemberId,
    });
    for (const task of created) {
      this.internals.emit(conversation.id, {
        type: 'task.updated',
        data: task,
      });
    }
    const started = this.internals.orchestrator.startReadyTasks(conversation.id);
    this.internals.emit(conversation.id, {
      type: 'conversation.updated',
      data: this.internals.getConversation(conversation.id),
    });
    return `Goal v${conversation.goalRevision} 已重新规划：创建 ${created.length} 个任务，${started.length} 个已开始执行`;
  }

  retryTask(taskId: string): ConversationTask {
    const task = this.internals.tasks.retry(taskId);
    this.internals.emit(task.conversationId, { type: 'task.updated', data: task });
    this.internals.orchestrator.startReadyTasks(task.conversationId);
    this.internals.emit(task.conversationId, { type: 'conversation.updated', data: this.internals.getConversation(task.conversationId) });
    return this.internals.tasks.get(taskId);
  }

  cancelTask(taskId: string): ConversationTask {
    const task = this.internals.tasks.cancel(taskId);
    // cancelled 也要走统一入口：下游依赖它的任务在这里翻成 blocked 并广播，
    // 只重算工作区状态会漏掉这一整条链。
    this.internals.orchestrator.onTaskChanged(task.id);
    return this.internals.tasks.get(task.id);
  }

  /** CoreToolHost：执行人上报自己任务的进展。 */
  async updateTask(input: {
    conversationId: string;
    memberId: string;
    taskId: string;
    status: 'running' | 'completed' | 'blocked';
    summary: string;
    blocker?: string;
  }): Promise<string> {
    const conversation = this.internals.getConversation(input.conversationId);
    this.internals.requireActiveMember(conversation, input.memberId);
    const task = this.internals.tasks.get(input.taskId);
    if (task.conversationId !== conversation.id) throw badRequest('这个任务不属于当前工作区');
    const updated = this.internals.tasks.update({
      taskId: input.taskId,
      memberId: input.memberId,
      status: input.status,
      summary: input.summary,
      blocker: input.blocker,
    });
    // 只发 task.updated，不再插 conversation_message：Task 的进展是结构化状态，
    // 去右侧 Task 面板看。Agent 的详细执行结果在 execution.response 里。
    // 在这里同时插一条消息，会让同一个回答在 Activity 与 Task 里各出现一次。
    this.internals.emit(conversation.id, { type: 'task.updated', data: updated });
    // 完成与阻塞都走统一入口：completed 推进下游但不唤醒 Lead，
    // blocked/failed 才唤醒 Lead。running 只发 task.updated。
    if (input.status === 'completed' || input.status === 'blocked') {
      this.internals.orchestrator.onTaskChanged(updated.id);
    } else {
      const status = this.internals.tasks.recomputeConversationStatus(conversation.id);
      if (status) this.internals.emit(conversation.id, { type: 'conversation.updated', data: this.internals.getConversation(conversation.id) });
    }
    return `任务 ${updated.title} 已更新为 ${updated.status}`;
  }

  /** CoreToolHost：Lead 调整尚未开始任务的执行 Member。 */
  async reassignTask(input: {
    conversationId: string;
    memberId: string;
    taskId: string;
    assigneeMemberId: string;
  }): Promise<string> {
    const conversation = this.internals.getConversation(input.conversationId);
    this.internals.requireActiveMember(conversation, input.memberId);
    if (conversation.leadMemberId !== input.memberId) {
      throw badRequest('只有负责这个工作的 Lead 才能重新分派任务');
    }
    this.internals.requireActiveMember(conversation, input.assigneeMemberId);
    const task = this.internals.tasks.get(input.taskId);
    if (task.conversationId !== conversation.id) {
      throw badRequest('这个任务不属于当前工作区');
    }
    const updated = this.internals.tasks.reassign({ taskId: task.id, assigneeMemberId: input.assigneeMemberId });
    this.internals.emit(conversation.id, { type: 'task.updated', data: updated });
    if (updated.status === 'pending') {
      this.internals.orchestrator.startReadyTasks(conversation.id);
    }
    const status = this.internals.tasks.recomputeConversationStatus(conversation.id);
    if (status) {
      this.internals.emit(conversation.id, { type: 'conversation.updated', data: this.internals.getConversation(conversation.id) });
    }
    return `任务「${updated.title}」已分派给新的执行 Member`;
  }

  setTaskHumanReview(taskId: string, required: boolean): ConversationTask {
    const task = this.internals.tasks.setRequiresHumanReview(taskId, required);
    this.internals.emit(task.conversationId, { type: 'task.updated', data: task });
    return task;
  }
}
