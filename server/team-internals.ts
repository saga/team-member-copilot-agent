import { DatabaseSync } from 'node:sqlite';
import { BudgetService } from './budget-service.js';
import type { BudgetUsage } from './budget-service.js';
import { ConversationFileService } from './conversation-file-service.js';
import { ConversationMemberService } from './conversation-member-service.js';
import { CopilotService } from './copilot.js';
import type { Conversation, ConversationEvent, ConversationFile, ConversationMessage, ExecutionConfigSnapshot, ExecutionDecision, ExecutionRecord, ExecutionStatus, Member, MemberRuntime, TurnMode, WakeReason } from './domain.js';
import { ExperienceStore } from './experience-store.js';
import { MemberConversationService } from './member-conversation-service.js';
import { MemberService } from './member-service.js';
import { MemberTurnScheduler } from './member-turn-scheduler.js';
import { TaskOrchestrator } from './task-orchestrator.js';
import { TaskService } from './task-service.js';
import type { AuthorizationRevisions } from './team-service.js';
import type { ConversationRow } from './team-shared.js';
import { TeamStructureService } from './team-structure-service.js';
import type { LeaseGrant, WorkerLeaseService } from './worker-lease.js';
import type { ExternalWorkRef, ExternalWorkSnapshot } from './work-management/types.js';

/**
 * TeamService 与四个拆分出去的领域服务之间的共享内部表面。
 *
 * ── 为什么是「一个对象」而不是把成员改成 public ──────────────────────
 *
 * 这四个服务（conversation / task-application / execution / collaboration）
 * 原本是 TeamService 的方法，它们共享同一份基础设施：DB、事务、durable 事件、
 * execution 的读写、runtime 的查找与串行锁。
 *
 * 拆文件时有两个选择：把 TeamService 的私有成员改成 public 让服务直接访问，
 * 或者把它们显式收成一个表面交出去。选后者 —— public 会把「内部记账」
 * （insertExecution / emit / transaction）变成任何人都能调用的 API，
 * 而它们恰恰是最不该被外部碰的。这里列出来的每一项都是「这四个服务确实需要」
 * 的最小集合，多一项都不加。
 *
 * ── 它是活的，不是快照 ──────────────────────────────────────────────
 *
 * 方法一律是**闭包**而不是绑定好的函数引用：服务在构造时拿到这个对象，
 * 而 TeamService 的字段（states / tasks / scheduler / orchestrator）在构造
 * 过程中才陆续就位。闭包在调用时才解析 this，所以装配顺序不影响正确性。
 */
export interface TeamInternals {
  alignRuntimeCheckpoint(conversationId: string, memberId: string, sequence: number): void;
  assertMemberNotBusy(memberId: string, action: string, conversationId?: string): void;
  readonly authorization: AuthorizationRevisions | undefined;
  readonly budget: BudgetService;
  budgetUsage(execution: ExecutionRecord): BudgetUsage;
  cancelExecutionTree(executionId: string, visited?: Set<string>): Promise<void>;
  cancelLeadBootstrap(conversation: Conversation): Promise<void>;
  readonly cancelRequests: Set<string>;
  readonly conversationFiles: ConversationFileService | undefined;
  readonly copilot: CopilotService;
  currentGoalRevision(conversationId: string): number;
  readonly db: DatabaseSync;
  defaultTeam(): { id: string };
  detectDelegationWaitCycle(parentRuntimeId: string, targetRuntimeId: string): boolean;
  emit(conversationId: string, event: ConversationEvent): void;
  emitExecution(execution: ExecutionRecord): void;
  ensureRuntime(conversation: Conversation, member: Member): MemberRuntime;
  executeMemberTurn(input: {
    conversation: Conversation;
    member: Member;
    execution: ExecutionRecord;
    prompt: string;
    sourceMemberId?: string;
    taskId?: string | null;
    triggerMessageSequence: number | null;
    turnMode: TurnMode;
    wakeReason: WakeReason | null;
    /**
     * 本轮的租约凭证（见 worker-lease.ts）。可能是 execution 租约（retry /
     * 恢复 / scheduler）或 wake 租约（聊天唤醒）—— `runTurn` 用它做 assertHeld，
     * 所以必须是整张凭证而不是一个裸 token：两者的资源键不同。
     *
     * null / 不传 = 单进程部署，这一层保护不适用。
     */
    lease?: LeaseGrant | null;
  }): Promise<string>;
  readonly experiences: ExperienceStore;
  findExecution(id: string): ExecutionRecord | null;
  findMessageByClientRequestId(conversationId: string, clientRequestId: string): ConversationMessage | null;
  findMessageBySequence(conversationId: string, sequence: number | null | undefined): ConversationMessage | null;
  findRuntime(conversationId: string, memberId: string): MemberRuntime | null;
  getConversation(id: string): Conversation;
  getExecution(id: string): ExecutionRecord;
  hydrateConversation(row: ConversationRow, progress?: Map<string, { total: number; completed: number }>): Conversation;
  insertExecution(execution: ExecutionRecord): void;
  insertMemberMessage(input: {
    conversationId: string;
    memberId: string;
    content: string;
    executionId: string;
    taskId?: string | null;
    replyToMessageId?: string | null;
  }): ConversationMessage;
  insertMessage(message: ConversationMessage): void;
  latestExecutionFor(conversationId: string, memberId: string): string | null;
  /**
   * Worker 租约。多副本部署下「谁在跑这一轮」的唯一仲裁点。
   *
   * undefined = 单进程语义（不抢、不挡）。执行链上的租约保护必须走这里，
   * 而不是让四个服务各自 new 一个 —— 租约的 owner 是**本进程的身份**，
   * 换一个实例就等于换一个身份，恢复流程会把自己正在跑的活当成别人的。
   */
  readonly leases?: WorkerLeaseService;
  readonly memberConversations: MemberConversationService;
  readonly members: MemberService;
  nextMessageSequence(conversationId: string): number;
  readonly orchestrator: TaskOrchestrator;
  relationForNewMessage(conversationId: string, message: ConversationMessage, fileId: string): 'attachment' | 'reference';
  requireActiveMember(conversation: Conversation, memberId: string): Member;
  requireConversationFiles(conversationId: string, fileIds: string[]): ConversationFile[];
  requireConversationMember(conversation: Conversation, memberId: string): Member;
  requireMessageInConversation(conversationId: string, messageId: string | undefined): string | null;
  resolveExternalWorkRef(input: { provider?: string | null; key: string; externalId?: string | null } | null | undefined): ExternalWorkRef | null;
  retireRuntime(conversationId: string, memberId: string): void;
  runTurn(input: {
    conversation: Conversation;
    member: Member;
    execution: ExecutionRecord;
    prompt: string;
    sourceMemberId?: string;
    taskId?: string | null;
    triggerMessageSequence: number | null;
    turnMode: TurnMode;
    wakeReason: WakeReason | null;
    runtime: MemberRuntime;
    lease?: LeaseGrant | null;
  }): Promise<string>;
  readonly scheduler: MemberTurnScheduler;
  readonly states: ConversationMemberService;
  readonly structure: TeamStructureService | undefined;
  readonly tasks: TaskService;
  touchConversation(conversationId: string): void;
  transaction<T>(fn: () => T): T;
  turnModeFor(_conversation: Conversation, execution: ExecutionRecord): TurnMode;
  updateExecution(id: string, patch: Partial<{
      runtimeId: string | null;
      status: ExecutionStatus;
      response: string | null;
      error: string | null;
      waitingForRuntimeId: string | null;
      decision: ExecutionDecision | null;
      configSnapshot: ExecutionConfigSnapshot | null;
      externalWorkSnapshot: ExternalWorkSnapshot | null;
      startedAt: string | null;
      endedAt: string | null;
    }>, fencingToken?: number | null): boolean;
  waitForRuntimeIdle(runtimeId: string): Promise<void>;
  withMessageFiles(messages: ConversationMessage[]): ConversationMessage[];
  withRuntimeLock<T>(runtimeId: string, fn: () => Promise<T>): Promise<T>;
}
