import type { ConversationKind, ConversationMessage, ConversationStatus, ExecutionActor, ExecutionActorType, ExecutionConfigSnapshot, ExecutionDecision, ExecutionKind, ExecutionRecord, ExecutionSessionMode, ExecutionStatus, MemberRuntime, WakeReason } from './domain.js';
import { badRequest } from './http-error.js';
import { parseExternalWorkRef, parseExternalWorkSnapshot } from './work-management/types.js';

/**
 * TeamService 与它拆分出的四个服务共用的底层词汇。
 *
 * 行形状（*Row）、行 → 领域对象的映射、execution 状态集合、取消语义 ——
 * 这些既不属于某一个服务，也不该留在 TeamService 里：留在那里会让拆分出去的
 * 服务反向 import TeamService，形成运行时循环依赖。放这里，两边都向下依赖。
 */

/**
 * 这一轮要不要开一个全新的 Copilot session。
 *
 * 两个判据：任务标了 independentContext，或者这一轮本身就是委托下级
 * （delegation）。后者也隔离，是因为「帮我看一眼这个」不该让下级的 session
 * 里堆着委托方自己的推理过程 —— 那等于把答案塞进题目。
 */
export function sessionModeOf(input: {
  kind: ExecutionKind;
  independentContext?: boolean;
}): ExecutionSessionMode {
  return input.kind === 'member_delegate' || input.independentContext === true
    ? 'isolated'
    : 'persistent';
}

/**
 * 谁发起的这一轮。
 *
 * 有触发消息时以**消息的发送者**为准：那条消息就是这一轮存在的理由，它的作者
 * 就是发起人。没有触发消息（定时任务 / 恢复 / Goal 变更）时按系统原因记，
 * 把原因本身写进 id —— 「系统」太粗，事后看不出是调度器还是恢复逻辑。
 */
export function actorFromTrigger(
  trigger: { senderType: 'user' | 'member' | 'system'; senderId: string } | null,
  systemId: string,
): ExecutionActor {
  if (trigger?.senderType === 'user') return { type: 'human', id: trigger.senderId };
  if (trigger?.senderType === 'member') return { type: 'agent', id: trigger.senderId };
  return { type: 'system', id: systemId };
}

/** 还在推进中的 execution 状态。 */
export const ACTIVE_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  'queued',
  'running',
  'waiting_for_member',
]);

export const CANCEL_REASON = '已被用户取消';

export interface ConversationRow {
  id: string;
  team_id: string;
  external_work_ref: string | null;
  title: string;
  kind: 'task' | 'direct';
  objective: string;
  goal_revision: number;
  lead_member_id: string | null;
  status: ConversationStatus;
  requirements_json: string | null;
  open_questions_json: string | null;
  created_by: string;
  event_sequence: number;
  message_sequence: number;
  created_at: string;
  updated_at: string;
}

/**
 * 一条 execution 在真正开跑前发现「自己不该跑了」时抛这个。
 * 和 failed 区分开：取消不是故障，UI / 日志不该按错误处理。
 */
export class ExecutionCancelledError extends Error {
  constructor(message: string = CANCEL_REASON) {
    super(message);
    this.name = 'ExecutionCancelledError';
  }
}

export interface ExecutionRow {
  id: string;
  conversation_id: string;
  member_id: string;
  goal_revision: number;
  task_id: string | null;
  external_work_ref: string | null;
  external_work_snapshot: string | null;
  runtime_id: string | null;
  /** 这一轮由哪个租约代次跑（见 worker-lease.ts）。单进程时为 NULL。 */
  worker_fencing_token: number | null;
  parent_execution_id: string | null;
  delegation_path: string;
  kind: ExecutionKind;
  session_mode: ExecutionSessionMode;
  initiated_by_type: ExecutionActorType;
  initiated_by_id: string;
  status: ExecutionStatus;
  prompt: string;
  response: string | null;
  error: string | null;
  waiting_for_runtime_id: string | null;
  retry_of_execution_id: string | null;
  decision: ExecutionDecision | null;
  trigger_message_sequence: number | null;
  wake_reason: string | null;
  config_snapshot: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  message_sequence: number;
  sender_type: 'user' | 'member' | 'system';
  sender_id: string;
  reply_to_message_id: string | null;
  task_id: string | null;
  client_request_id: string | null;
  content: string;
  execution_id: string | null;
  created_at: string;
}

/** 已经结束、不会再变的 execution 状态。 */
export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * Conversation 的 kind 决定 roster 形状。这条约束必须在 Service 层 enforce：
 * HTTP API 是公开的，不能靠 UI 替业务规则兜底。
 */
export function assertConversationKindShape(kind: ConversationKind, memberCount: number): void {
  switch (kind) {
    case 'task':
      if (memberCount < 1 || memberCount > 20) {
        throw badRequest('Task 工作区需要 1~20 个成员');
      }
      return;
    case 'direct':
      if (memberCount !== 2) {
        throw badRequest('成员私聊必须恰好两个成员');
      }
      return;
  }
}

/**
 * 判断一个异常是不是 UNIQUE 约束冲突。
 *
 * node:sqlite 把它包成普通 Error，稳定的判据是消息里的
 * `UNIQUE constraint failed: <table>.<columns>`；errcode 字段的取值在不同
 * Node 版本间不保证一致，所以作为次选。
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/UNIQUE constraint failed/i.test(error.message)) return true;
  return (error as { errcode?: number }).errcode === 2067; // SQLITE_CONSTRAINT_UNIQUE
}

export function mapExecution(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    memberId: row.member_id,
    goalRevision: row.goal_revision ?? 0,
    taskId: row.task_id,
    externalWorkRef: parseExternalWorkRef(row.external_work_ref),
    externalWorkSnapshot: parseExternalWorkSnapshot(row.external_work_snapshot),
    runtimeId: row.runtime_id,
    workerFencingToken: row.worker_fencing_token ?? null,
    parentExecutionId: row.parent_execution_id,
    delegationPath: JSON.parse(row.delegation_path) as string[],
    kind: row.kind,
    sessionMode: row.session_mode,
    initiatedBy: { type: row.initiated_by_type, id: row.initiated_by_id },
    status: row.status,
    prompt: row.prompt,
    response: row.response,
    error: row.error,
    waitingForRuntimeId: row.waiting_for_runtime_id,
    retryOfExecutionId: row.retry_of_execution_id,
    decision: row.decision ?? null,
    triggerMessageSequence: row.trigger_message_sequence ?? null,
    wakeReason: (row.wake_reason as WakeReason | null) ?? null,
    configSnapshot: parseConfigSnapshot(row.config_snapshot),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

export function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageSequence: row.message_sequence,
    senderType: row.sender_type,
    senderId: row.sender_id,
    replyToMessageId: row.reply_to_message_id,
    taskId: row.task_id,
    clientRequestId: row.client_request_id,
    content: row.content,
    executionId: row.execution_id,
    // 附件不由这一层查：调用方用 ConversationFileService.filesForMessages 批量
    // 装配（一条 SQL 拿一页），逐条查会变成 N+1。
    files: [],
    createdAt: row.created_at,
  };
}

export interface RuntimeRow {
  id: string;
  conversation_id: string;
  member_id: string;
  copilot_session_id: string;
  workspace_path: string;
  status: MemberRuntime['status'];
  active_execution_id: string | null;
  last_context_message_sequence: number;
  last_used_at: string | null;
}

export function mapRuntime(row: RuntimeRow): MemberRuntime {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    memberId: row.member_id,
    copilotSessionId: row.copilot_session_id,
    workspacePath: row.workspace_path,
    status: row.status,
    activeExecutionId: row.active_execution_id,
    lastContextMessageSequence: row.last_context_message_sequence,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * 读回配置快照。
 *
 * 两种「没有」都要按 null 处理：老数据的 NULL，以及内容坏掉的 JSON。
 * 快照是排查用的旁证，为了它让整个 execution 读不出来是本末倒置。
 */
export function parseConfigSnapshot(raw: string | null): ExecutionConfigSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExecutionConfigSnapshot;
  } catch {
    return null;
  }
}
