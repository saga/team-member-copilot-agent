import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { now } from './db.js';
import type { Conversation, ExecutionRecord, Member } from './domain.js';
import { badRequest } from './http-error.js';
import { sessionModeOf } from './team-shared.js';
import type { TeamInternals } from './team-internals.js';
import type { SendMessageResult } from './team-service.js';

/**
 * CollaborationService
 *
 * 原先是 TeamService 的一组方法，按 §31 拆出来。共享基础设施由 TeamInternals
 * 注入 —— 这个类不认识 TeamService，只认识那张表面。
 */
export class CollaborationService {
  constructor(private readonly internals: TeamInternals) {}

  /**
   * Member → Member 协作的唯一入口（由 ask_member custom tool 调用）。
   *
   * 两道保护：
   *
   *   delegation_path 环检测 —— 同一个 delegation 树里不能 A → B → C → A
   *   wait-for 环检测        —— 跨树的 runtime 互相等待（A 等 B 的 runtime，
   *                             B 又等 A 的 runtime）会死锁，必须在这里拦掉
   */
  async delegateMember(input: {
    conversationId: string;
    fromMemberId: string;
    parentExecutionId: string;
    targetMemberId: string;
    task: string;
    reason?: string;
  }): Promise<string> {
    const conversation = this.internals.getConversation(input.conversationId);
    // fromMember 用宽松版：这一轮已经在跑了，中途被归档不该把正在进行的 turn 打断。
    const fromMember = this.internals.requireConversationMember(conversation, input.fromMemberId);
    // targetMember 用严格版：归档的 Member 不能再接新活。
    const targetMember = this.internals.requireActiveMember(conversation, input.targetMemberId);

    const parent = this.internals.getExecution(input.parentExecutionId);

    if (parent.memberId !== fromMember.id) {
      throw badRequest('parent execution 不属于当前 Member');
    }
    if (parent.conversationId !== conversation.id) {
      throw badRequest('parent execution 不属于当前 conversation');
    }
    // 防 A → B → C → A
    if (parent.delegationPath.includes(targetMember.id)) {
      throw badRequest(
        `检测到 Member delegation cycle：${[...parent.delegationPath, targetMember.id].join(' -> ')}`,
      );
    }
    // 防 A → B → C → D → ...
    if (parent.delegationPath.length >= config.maxDelegationDepth) {
      throw badRequest(`超过最大 delegation depth：${config.maxDelegationDepth}`);
    }

    // 注意：下面这段（检测 → 建 child → 标记父为 waiting）之间 **不能有 await**，
    // 否则两个方向的委托可能同时通过检测，双双进入等待，形成真死锁。
    // node:sqlite 是同步 API，所以整段天然是一个不可分割的同步块。
    //
    // 先只查目标 runtime 是否已存在：不存在就说明从没跑过，不可能在等任何人，
    // 环检测可以跳过。这样被拒绝的 delegation 不留下任何副作用（runtime 行 /
    // workspace 目录都不会被建出来）。
    const parentRuntimeId = parent.runtimeId;
    const existingTargetRuntime = this.internals.findRuntime(conversation.id, targetMember.id);
    if (
      parentRuntimeId &&
      existingTargetRuntime &&
      this.internals.detectDelegationWaitCycle(parentRuntimeId, existingTargetRuntime.id)
    ) {
      throw badRequest(
        `delegation 会形成 runtime 等待环：${parentRuntimeId} → ${existingTargetRuntime.id}`,
      );
    }

    // 真实流程里 ask_member 是在父 execution 的 turn 内被调用的，所以这里通常是
    // running；结束时必须还原成它本来的状态，而不是硬编码回 running ——
    // 否则一条已经 completed 的 execution 会被「复活」成 waiting_for_member。
    const parentPreviousStatus = parent.status;

    // 目标 runtime 落库，这样父 execution 的 waiting_for_runtime_id 才有指向
    const targetRuntime = this.internals.ensureRuntime(conversation, targetMember);

    const childExecution: ExecutionRecord = {
      id: randomUUID(),
      conversationId: conversation.id,
      memberId: targetMember.id,
      goalRevision: conversation.goalRevision,
      taskId: null,
      // delegation 继承父的外部工作引用：同一项业务工作的审计链不断。
      // 快照**不继承** —— 它是「这一轮开跑时取证的结果」，子轮次会自己取证一次。
      externalWorkRef: parent.externalWorkRef,
      externalWorkSnapshot: null,
      runtimeId: null,
      workerFencingToken: null,
      parentExecutionId: parent.id,
      delegationPath: [...parent.delegationPath, targetMember.id],
      kind: 'member_delegate',
      sessionMode: sessionModeOf({ kind: 'member_delegate' }),
      // 发起人是委托方那个 Agent，不是「系统」：ask_member 是它自己的决定，
      // 审计要能回答「是谁让它跑的」。
      initiatedBy: { type: 'agent', id: fromMember.id },
      status: 'queued',
      prompt: input.task.trim(),
      response: null,
      error: null,
      waitingForRuntimeId: null,
      retryOfExecutionId: null,
      decision: null,
      // delegation 没有触发消息、也没有房间讨论语义：它是一道明确的任务。
      triggerMessageSequence: null,
      wakeReason: null,
      configSnapshot: null,
      startedAt: null,
      endedAt: null,
      createdAt: now(),
    };
    this.internals.insertExecution(childExecution);

    if (parentRuntimeId) {
      this.internals.updateExecution(parent.id, {
        status: 'waiting_for_member',
        waitingForRuntimeId: targetRuntime.id,
      });
      this.internals.emitExecution(this.internals.getExecution(parent.id));
    }
    this.internals.emit(conversation.id, {
      type: 'delegation.started',
      data: {
        executionId: childExecution.id,
        parentExecutionId: parent.id,
        fromMemberId: fromMember.id,
        targetMemberId: targetMember.id,
        task: input.task,
        reason: input.reason ?? null,
      },
    });

    try {
      const result = await this.internals.executeMemberTurn({
        conversation,
        member: targetMember,
        execution: childExecution,
        prompt: [
          `You have been asked by ${fromMember.name}.`,
          '',
          'Task:',
          input.task.trim(),
          '',
          input.reason ? `Reason: ${input.reason}` : '',
          '',
          'Return a concise, useful result to the requesting Member.',
        ]
          .filter(Boolean)
          .join('\n'),
        sourceMemberId: fromMember.id,
        // delegation 没有触发消息，也没有房间讨论语义：它是一道明确的任务。
        triggerMessageSequence: null,
        turnMode: 'delegation',
        wakeReason: null,
      });

      this.internals.emit(conversation.id, {
        type: 'delegation.finished',
        data: {
          executionId: childExecution.id,
          parentExecutionId: parent.id,
          fromMemberId: fromMember.id,
          targetMemberId: targetMember.id,
        },
      });

      return result;
    } catch (error) {
      this.internals.emit(conversation.id, {
        type: 'delegation.finished',
        data: {
          executionId: childExecution.id,
          parentExecutionId: parent.id,
          fromMemberId: fromMember.id,
          targetMemberId: targetMember.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    } finally {
      // 父 execution 必须从 waiting_for_member 恢复，否则它的 runtime 会永久
      // 停在等待态，后续发给它的消息全部排队不执行。
      const current = this.internals.findExecution(parent.id);
      if (current && current.status === 'waiting_for_member') {
        this.internals.updateExecution(parent.id, {
          status: parentPreviousStatus,
          waitingForRuntimeId: null,
        });
        this.internals.emitExecution(this.internals.getExecution(parent.id));
      }
    }
  }

  /** CopilotHost 的实现：Member 在自己 turn 里调 message_member tool 时走这里。 */
  async messageMember(input: {
    teamId: string;
    fromMemberId: string;
    targetMemberId: string;
    content: string;
  }): Promise<{ conversationId: string; messageId: string }> {
    const result = await this.internals.memberConversations.send({
      teamId: input.teamId,
      fromMemberId: input.fromMemberId,
      toMemberId: input.targetMemberId,
      content: input.content,
    });
    return { conversationId: result.conversation.id, messageId: result.message.id };
  }

  /** 以某个 Member 的身份给另一个 Member 发消息（UI / REST 侧）。 */
  sendDirectMessage(input: {
    teamId: string;
    fromMemberId: string;
    toMemberId: string;
    content: string;
  }): Promise<SendMessageResult & { conversation: Conversation; peer: Member }> {
    return this.internals.memberConversations.send(input);
  }

  /** CoreToolHost：Lead 请用户补充信息。 */
  async requestClarification(input: {
    conversationId: string;
    memberId: string;
    questions: string[];
    assumptions?: string[];
    summary?: string;
  }): Promise<string> {
    const conversation = this.internals.getConversation(input.conversationId);
    this.internals.requireActiveMember(conversation, input.memberId);
    this.internals.tasks.requestClarification({
      conversationId: conversation.id,
      memberId: input.memberId,
      questions: input.questions,
      assumptions: input.assumptions,
      summary: input.summary,
      leadMemberId: conversation.leadMemberId,
      requirements: conversation.requirements,
    });
    const message = this.internals.insertMemberMessage({
      conversationId: conversation.id,
      memberId: input.memberId,
      content: input.summary?.trim() || `需要补充 ${input.questions.length} 个信息才能继续推进`,
      executionId: this.internals.latestExecutionFor(conversation.id, input.memberId) ?? input.memberId,
    });
    this.internals.emit(conversation.id, { type: 'message.created', data: message });
    this.internals.emit(conversation.id, { type: 'conversation.updated', data: this.internals.getConversation(conversation.id) });
    return `已记录 ${input.questions.length} 个待确认问题，工作区进入 waiting_user`;
  }

  rememberMember(input: {
    memberId: string;
    teamId: string;
    content: string;
  }): Promise<string> {
    const teamId = input.teamId;
    if (this.internals.structure) this.internals.structure.getTeam(teamId);
    return Promise.resolve(this.internals.members.appendTeamMemory(input.memberId, teamId, input.content));
  }
}
