import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now } from './db.js';
import { ContextAssembler } from './context-assembler.js';
import {
  MemberService,
  type CreateMemberInput,
  type UpdateMemberInput,
} from './member-service.js';
import type { CopilotService } from './copilot.js';
import type {
  Conversation,
  ConversationEvent,
  ConversationEventType,
  ConversationMessage,
  ExecutionKind,
  ExecutionRecord,
  ExecutionStatus,
  Member,
  MemberRuntime,
  StoredConversationEvent,
  ToolProfile,
} from './domain.js';

/**
 * 项目的核心：把 Member / Conversation / Runtime / Execution 串起来。
 *
 * Member → Member 的协作不是「Agent A 直接 new Agent B」，而是：
 *
 *   Copilot Session
 *     → ask_member (custom tool)
 *     → TeamService.delegateMember()
 *     → target Member Runtime
 *
 * 所以每一次协作都会在服务端留下 Execution.parent_execution_id +
 * delegation_path，而不是散落成无法关联的 Copilot 日志。
 *
 * 可靠性相关的三件事都在这个文件里收口：
 *
 *   1. 单写者    —— per-runtime 串行锁 + member_runtime.active_execution_id
 *   2. 增量上下文 —— ContextAssembler + last_context_message_sequence checkpoint
 *   3. 可靠事件   —— conversation_event 落库后再广播（SSE replay 的 source of truth）
 */

interface ConversationRow {
  id: string;
  title: string;
  kind: 'direct' | 'group' | 'work';
  default_member_id: string | null;
  created_by: string;
  event_sequence: number;
  message_sequence: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  message_sequence: number;
  sender_type: 'user' | 'member' | 'system';
  sender_id: string;
  target_member_id: string | null;
  reply_to_message_id: string | null;
  content: string;
  execution_id: string | null;
  created_at: string;
}

interface ExecutionRow {
  id: string;
  conversation_id: string;
  member_id: string;
  runtime_id: string | null;
  parent_execution_id: string | null;
  delegation_path: string;
  kind: ExecutionKind;
  status: ExecutionStatus;
  prompt: string;
  response: string | null;
  error: string | null;
  waiting_for_runtime_id: string | null;
  retry_of_execution_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface RuntimeRow {
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

interface MemberRow {
  id: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  style: string;
  system_prompt: string;
  model: string | null;
  tool_profile: ToolProfile;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  conversation_id: string;
  sequence: number;
  event_type: ConversationEventType;
  payload: string;
  created_at: string;
}

export interface CreateConversationInput {
  title?: string;
  kind?: 'direct' | 'group' | 'work';
  memberIds: string[];
  defaultMemberId?: string;
}

/**
 * 订阅回调拿到的是 **落库后** 的事件。
 *
 * `message.delta` 例外：它是 token 级高频事件，不落库，所以 id / sequence 为 null，
 * SSE 帧也不带 `id:`，浏览器不会因此推进 Last-Event-ID。
 */
type Listener = (event: StoredConversationEvent) => void;

/** 回放分页大小。 */
const REPLAY_BATCH = 500;
/**
 * 单次回放的事件上限。超过就截断并告警 —— 继续翻页会长时间阻塞事件循环，
 * 而客户端本来就有 `GET /messages` 这条完整状态的兜底路径。
 */
const REPLAY_MAX_EVENTS = 5000;

/** 业务校验失败统一带 400，由 middleware/errorHandler 的 sendError 翻译成 HTTP。 */
function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/** 资源不存在统一带 404。 */
function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 });
}

export class TeamService {
  private readonly listeners = new Map<string, Set<Listener>>();
  /**
   * per-runtime 串行锁。一个 MemberRuntime 同时只能跑一个 turn，
   * 否则同一个 Copilot session 会被并发 sendAndWait 撕裂。
   */
  private readonly runtimeLocks = new Map<string, Promise<unknown>>();
  private readonly contextAssembler: ContextAssembler;

  constructor(
    private readonly db: DatabaseSync,
    private readonly members: MemberService,
    private readonly copilot: CopilotService,
  ) {
    this.contextAssembler = new ContextAssembler(db);
  }

  // ---------------------------------------------------------------- Member

  listMembers(): Member[] {
    return this.members.list();
  }

  getMember(id: string): Member {
    return this.members.get(id);
  }

  createMember(input: CreateMemberInput): Member {
    return this.members.create(input);
  }

  updateMember(id: string, input: UpdateMemberInput): Member {
    return this.members.update(id, input);
  }

  // ---------------------------------------------------------- Conversation

  listConversations(): Conversation[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation
        ORDER BY updated_at DESC
        `,
      )
      .all() as unknown as ConversationRow[];
    return rows.map((row) => this.hydrateConversation(row));
  }

  getConversation(id: string): Conversation {
    const row = this.db.prepare(`SELECT * FROM conversation WHERE id = ?`).get(id) as unknown as
      | ConversationRow
      | undefined;
    if (!row) {
      throw notFound(`Conversation 不存在：${id}`);
    }
    return this.hydrateConversation(row);
  }

  createConversation(input: CreateConversationInput): Conversation {
    const memberIds = [...new Set(input.memberIds)];
    if (memberIds.length === 0) throw badRequest('至少需要一个 Member');

    const members = memberIds.map((id) => this.members.get(id));

    const id = randomUUID();
    const createdAt = now();
    const kind = input.kind ?? (memberIds.length > 1 ? 'group' : 'direct');
    const defaultMemberId = input.defaultMemberId ?? (memberIds.length === 1 ? memberIds[0] : null);

    if (defaultMemberId && !memberIds.includes(defaultMemberId)) {
      throw badRequest('defaultMemberId 必须属于 conversation member');
    }

    const title =
      input.title?.trim() ||
      (kind === 'group' ? members.map((m) => m.name).join(' · ') : members[0].name);

    this.db
      .prepare(
        `
        INSERT INTO conversation (
          id,
          title,
          kind,
          default_member_id,
          created_by,
          event_sequence,
          message_sequence,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
        `,
      )
      .run(id, title, kind, defaultMemberId, config.localUserId, createdAt, createdAt);

    const insertMember = this.db.prepare(
      `
      INSERT INTO conversation_member (
        conversation_id,
        member_id,
        joined_at
      )
      VALUES (?, ?, ?)
      `,
    );
    for (const memberId of memberIds) {
      insertMember.run(id, memberId, createdAt);
    }

    return this.getConversation(id);
  }

  addMember(conversationId: string, memberId: string): Conversation {
    this.getConversation(conversationId);
    this.members.get(memberId);

    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO conversation_member (
          conversation_id,
          member_id,
          joined_at
        )
        VALUES (?, ?, ?)
        `,
      )
      .run(conversationId, memberId, now());

    this.touchConversation(conversationId);
    return this.getConversation(conversationId);
  }

  removeMember(conversationId: string, memberId: string): Conversation {
    const conversation = this.getConversation(conversationId);
    if (conversation.members.length <= 1) {
      throw badRequest('Conversation 至少保留一个 Member');
    }

    this.db
      .prepare(
        `
        DELETE FROM conversation_member
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(conversationId, memberId);

    this.db
      .prepare(
        `
        UPDATE conversation
        SET
          default_member_id = CASE
            WHEN default_member_id = ? THEN NULL
            ELSE default_member_id
          END,
          updated_at = ?
        WHERE id = ?
        `,
      )
      .run(memberId, now(), conversationId);

    return this.getConversation(conversationId);
  }

  // ------------------------------------------------------------- Messages

  /**
   * 返回最近 limit 条消息，按 message_sequence 正序。
   *
   * 先 DESC 取尾部再反转：聊天场景要的是「最新 N 条」，不是「最旧 N 条」。
   * 排序用 message_sequence 而不是 created_at —— 同一毫秒内的多条消息
   * created_at 会打平，只有 sequence 是严格全序。
   */
  listMessages(conversationId: string, limit = 100): ConversationMessage[] {
    this.getConversation(conversationId);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_message
        WHERE conversation_id = ?
        ORDER BY message_sequence DESC
        LIMIT ?
        `,
      )
      .all(conversationId, limit) as unknown as MessageRow[];

    return rows.reverse().map(mapMessage);
  }

  async sendMessage(input: {
    conversationId: string;
    content: string;
    targetMemberId?: string;
    replyToMessageId?: string;
  }): Promise<{ message: ConversationMessage; executionId: string }> {
    const conversation = this.getConversation(input.conversationId);
    const target = this.resolveTargetMember(conversation, input.targetMemberId);

    const messageId = randomUUID();
    const executionId = randomUUID();
    const createdAt = now();
    const content = input.content.trim();
    const messageSequence = this.nextMessageSequence(conversation.id);

    const message: ConversationMessage = {
      id: messageId,
      conversationId: input.conversationId,
      messageSequence,
      senderType: 'user',
      senderId: config.localUserId,
      targetMemberId: target.id,
      replyToMessageId: input.replyToMessageId ?? null,
      content,
      executionId,
      createdAt,
    };

    this.insertMessage(message);

    const execution: ExecutionRecord = {
      id: executionId,
      conversationId: conversation.id,
      memberId: target.id,
      runtimeId: null,
      parentExecutionId: null,
      delegationPath: [target.id],
      kind: conversation.kind === 'work' ? 'member_work' : 'interactive',
      status: 'queued',
      prompt: content,
      response: null,
      error: null,
      waitingForRuntimeId: null,
      retryOfExecutionId: null,
      startedAt: null,
      endedAt: null,
      createdAt,
    };
    this.insertExecution(execution);

    this.touchConversation(conversation.id);
    this.emit(conversation.id, { type: 'message.created', data: message });
    this.emitExecution(execution);

    // 异步执行，不阻塞 202 响应；状态全部通过 SSE + execution 表对外暴露。
    void this.executeMemberTurn({
      conversation,
      member: target,
      execution,
      prompt: content,
    }).catch((error: unknown) => {
      // executeMemberTurn 内部已经把 execution 标记为 failed 并广播，
      // 这里只是防止 fire-and-forget 变成 unhandled rejection。
      // eslint-disable-next-line no-console
      console.error(
        '[team] interactive execution failed:',
        error instanceof Error ? error.message : error,
      );
    });

    return { message, executionId };
  }

  // ----------------------------------------------------------- Delegation

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
    const conversation = this.getConversation(input.conversationId);
    const fromMember = this.requireConversationMember(conversation, input.fromMemberId);
    const targetMember = this.requireConversationMember(conversation, input.targetMemberId);

    const parent = this.getExecution(input.parentExecutionId);

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
    const existingTargetRuntime = this.findRuntime(conversation.id, targetMember.id);
    if (
      parentRuntimeId &&
      existingTargetRuntime &&
      this.detectDelegationWaitCycle(parentRuntimeId, existingTargetRuntime.id)
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
    const targetRuntime = this.ensureRuntime(conversation, targetMember);

    const childExecution: ExecutionRecord = {
      id: randomUUID(),
      conversationId: conversation.id,
      memberId: targetMember.id,
      runtimeId: null,
      parentExecutionId: parent.id,
      delegationPath: [...parent.delegationPath, targetMember.id],
      kind: 'member_delegate',
      status: 'queued',
      prompt: input.task.trim(),
      response: null,
      error: null,
      waitingForRuntimeId: null,
      retryOfExecutionId: null,
      startedAt: null,
      endedAt: null,
      createdAt: now(),
    };
    this.insertExecution(childExecution);

    if (parentRuntimeId) {
      this.updateExecution(parent.id, {
        status: 'waiting_for_member',
        waitingForRuntimeId: targetRuntime.id,
      });
      this.emitExecution(this.getExecution(parent.id));
    }
    this.emit(conversation.id, {
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
      const result = await this.executeMemberTurn({
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
      });

      this.emit(conversation.id, {
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
      this.emit(conversation.id, {
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
      const current = this.findExecution(parent.id);
      if (current && current.status === 'waiting_for_member') {
        this.updateExecution(parent.id, {
          status: parentPreviousStatus,
          waitingForRuntimeId: null,
        });
        this.emitExecution(this.getExecution(parent.id));
      }
    }
  }

  rememberMember(input: { memberId: string; content: string }): Promise<string> {
    return Promise.resolve(this.members.appendMemory(input.memberId, input.content));
  }

  // ------------------------------------------------------------- Execution

  getExecution(id: string): ExecutionRecord {
    const row = this.db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
      | ExecutionRow
      | undefined;
    if (!row) throw notFound(`Execution 不存在：${id}`);
    return mapExecution(row);
  }

  /**
   * 显式 retry。绝不自动重跑被中断的 execution：
   * Copilot session 可能已经执行完工具但没来得及落库，自动重跑会重复执行。
   *
   * retry 生成一条全新的 execution，并用 retry_of_execution_id 指回原记录，
   * 审计链不会断。
   */
  retryExecution(executionId: string): { executionId: string } {
    const original = this.getExecution(executionId);
    if (
      original.status === 'queued' ||
      original.status === 'running' ||
      original.status === 'waiting_for_member'
    ) {
      throw badRequest(`execution 仍在进行中（${original.status}），不能 retry`);
    }

    const conversation = this.getConversation(original.conversationId);
    const member = this.requireConversationMember(conversation, original.memberId);

    const retry: ExecutionRecord = {
      id: randomUUID(),
      conversationId: original.conversationId,
      memberId: original.memberId,
      runtimeId: null,
      parentExecutionId: original.parentExecutionId,
      delegationPath: [...original.delegationPath],
      kind: original.kind,
      status: 'queued',
      prompt: original.prompt,
      response: null,
      error: null,
      waitingForRuntimeId: null,
      retryOfExecutionId: original.id,
      startedAt: null,
      endedAt: null,
      createdAt: now(),
    };
    this.insertExecution(retry);
    this.emitExecution(retry);

    void this.executeMemberTurn({
      conversation,
      member,
      execution: retry,
      prompt: retry.prompt,
    }).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(
        '[team] retry execution failed:',
        error instanceof Error ? error.message : error,
      );
    });

    return { executionId: retry.id };
  }

  /**
   * 启动恢复用：把一条从未真正跑过的 root execution 重新提交。
   * RecoveryService 只负责把 id 挑出来，真正重新提交由这里做（它需要 CopilotService）。
   */
  async resumeQueuedExecution(executionId: string): Promise<void> {
    const execution = this.findExecution(executionId);
    if (!execution || execution.status !== 'queued') return;

    let conversation: Conversation;
    let member: Member;
    try {
      conversation = this.getConversation(execution.conversationId);
      member = this.requireConversationMember(conversation, execution.memberId);
    } catch (error) {
      this.updateExecution(executionId, {
        status: 'interrupted',
        error: `无法恢复：${error instanceof Error ? error.message : String(error)}`,
        endedAt: now(),
      });
      return;
    }

    try {
      await this.executeMemberTurn({
        conversation,
        member,
        execution,
        prompt: execution.prompt,
      });
    } catch (error) {
      // executeMemberTurn 已经把 execution 置为 failed 并广播过，这里只是收口。
      // eslint-disable-next-line no-console
      console.error(
        '[team] resume queued execution failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  // ------------------------------------------------------- Durable events

  /** 从 sinceSequence（不含）开始回放 durable events，时间正序。 */
  listEventsSince(
    conversationId: string,
    sinceSequence: number,
    limit = 500,
  ): StoredConversationEvent[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_event
        WHERE conversation_id = ?
          AND sequence > ?
        ORDER BY sequence
        LIMIT ?
        `,
      )
      .all(conversationId, sinceSequence, limit) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  /** 只订阅实时事件（不回放）。 */
  subscribe(conversationId: string, listener: Listener): () => void {
    this.getConversation(conversationId);

    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(listener);

    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(conversationId);
    };
  }

  /**
   * 回放 + 订阅，且两者之间不留缝。
   *
   * 先挂上实时监听并缓冲，再回放 DB，最后把缓冲里「比回放水位更新」的事件补发。
   * 这样重连期间产生的事件不会既不在回放里、也不在实时流里。
   * 重复投递由 sequence 去重（message.delta 没有 sequence，永远透传）。
   *
   * 回放按 batch 翻页而不是一次 `LIMIT 500` 了事：一次截断会在「回放末尾」和
   * 「实时流开头」之间留下一段**静默空洞**，比不回放更糟。
   */
  replayAndSubscribe(
    conversationId: string,
    sinceSequence: number,
    listener: Listener,
  ): () => void {
    this.getConversation(conversationId);

    const buffered: StoredConversationEvent[] = [];
    let live = false;
    let highWater = sinceSequence;

    const deliver = (event: StoredConversationEvent): void => {
      if (event.sequence !== null) {
        if (event.sequence <= highWater) return;
        highWater = event.sequence;
      }
      listener(event);
    };

    const unsubscribe = this.subscribe(conversationId, (event) => {
      if (!live) {
        buffered.push(event);
        return;
      }
      deliver(event);
    });

    let replayed = 0;
    let cursor = sinceSequence;
    for (;;) {
      const batch = this.listEventsSince(conversationId, cursor, REPLAY_BATCH);
      if (batch.length === 0) break;

      for (const event of batch) deliver(event);
      replayed += batch.length;

      if (batch.length < REPLAY_BATCH) break;
      if (replayed >= REPLAY_MAX_EVENTS) {
        // 极端情况：离线太久，事件量超过回放上限。这里主动放弃「无缝」，
        // 因为继续翻页会长时间阻塞事件循环。durable 的 message.created 仍在，
        // 前端可以再拉一次 GET /messages 拿到完整状态。
        // eslint-disable-next-line no-console
        console.warn(
          `[team] conversation ${conversationId} 回放事件超过 ${REPLAY_MAX_EVENTS} 条，已截断；客户端应重新拉取完整消息列表`,
        );
        break;
      }

      const last = batch[batch.length - 1].sequence;
      if (last === null) break;
      cursor = last;
    }

    live = true;
    for (const event of buffered) {
      deliver(event);
    }

    return unsubscribe;
  }

  // ------------------------------------------------------------- 内部实现

  private async executeMemberTurn(input: {
    conversation: Conversation;
    member: Member;
    execution: ExecutionRecord;
    prompt: string;
    sourceMemberId?: string;
  }): Promise<string> {
    const runtime = this.ensureRuntime(input.conversation, input.member);
    // 整个 turn（含 DB 写入）都在 runtime 锁内，保证单写者。
    return this.withRuntimeLock(runtime.id, () => this.runTurn({ ...input, runtime }));
  }

  private async runTurn(input: {
    conversation: Conversation;
    member: Member;
    execution: ExecutionRecord;
    prompt: string;
    sourceMemberId?: string;
    runtime: MemberRuntime;
  }): Promise<string> {
    const runtime = input.runtime;
    const startedAt = now();

    this.updateRuntime(runtime.id, {
      status: 'running',
      activeExecutionId: input.execution.id,
      lastUsedAt: startedAt,
    });
    this.updateExecution(input.execution.id, {
      runtimeId: runtime.id,
      status: 'running',
      startedAt,
      endedAt: null,
      error: null,
    });
    this.emitExecution(this.getExecution(input.execution.id));

    // 只注入「自该 runtime 上次成功 turn 以来新增的 shared messages」。
    // Copilot session 自己已经记着这个 Member 的历史，整段重放会重复。
    const context = this.contextAssembler.assemble({
      runtime,
      currentExecutionId: input.execution.id,
      currentPrompt: input.prompt,
    });

    try {
      const systemPrompt = this.buildMemberSystemPrompt(input.conversation, input.member);

      const result = await this.copilot.runMemberTurn({
        runtime,
        member: input.member,
        systemPrompt,
        prompt: context.prompt,
        sourceMemberId: input.sourceMemberId,
        executionId: input.execution.id,
        conversationId: input.conversation.id,
        onDelta: (delta) => {
          this.emit(input.conversation.id, {
            type: 'message.delta',
            data: {
              executionId: input.execution.id,
              memberId: input.member.id,
              delta,
            },
          });
        },
      });

      const message = this.insertMemberMessage({
        conversationId: input.conversation.id,
        memberId: input.member.id,
        content: result,
        executionId: input.execution.id,
        replyToMessageId: null,
      });

      // checkpoint 只在成功后才推进；失败时保持不变，下一轮重新注入，
      // 宁可重复也不要丢上下文。
      this.updateRuntime(runtime.id, {
        status: 'idle',
        activeExecutionId: null,
        lastContextMessageSequence: context.consumedThroughSequence,
        lastUsedAt: now(),
      });
      this.updateExecution(input.execution.id, {
        status: 'completed',
        response: result,
        endedAt: now(),
      });

      this.emit(input.conversation.id, { type: 'message.created', data: message });
      this.emitExecution(this.getExecution(input.execution.id));
      this.touchConversation(input.conversation.id);

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.updateRuntime(runtime.id, {
        status: 'error',
        activeExecutionId: null,
        lastUsedAt: now(),
      });
      this.updateExecution(input.execution.id, {
        status: 'failed',
        error: message,
        endedAt: now(),
      });
      this.emitExecution(this.getExecution(input.execution.id));

      throw error;
    }
  }

  /**
   * runtime 等待图：runtime → 它正在等的 runtime。
   * 只认 waiting_for_member 状态的 execution，running 不算等待。
   */
  private waitingForRuntime(runtimeId: string): string | null {
    const row = this.db
      .prepare(
        `
        SELECT waiting_for_runtime_id
        FROM execution
        WHERE runtime_id = ?
          AND status = 'waiting_for_member'
          AND waiting_for_runtime_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
        `,
      )
      .get(runtimeId) as unknown as { waiting_for_runtime_id: string | null } | undefined;
    return row?.waiting_for_runtime_id ?? null;
  }

  /**
   * 从 target 出发沿着等待边往前走，看会不会绕回 parent。
   * parent 即将等待 target，所以 target 一旦（传递地）等待 parent 就是环。
   */
  private detectDelegationWaitCycle(parentRuntimeId: string, targetRuntimeId: string): boolean {
    if (parentRuntimeId === targetRuntimeId) return true;

    const seen = new Set<string>([parentRuntimeId]);
    let cursor: string | null = targetRuntimeId;

    while (cursor) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = this.waitingForRuntime(cursor);
    }

    return false;
  }

  private buildMemberSystemPrompt(conversation: Conversation, member: Member): string {
    const otherMembers = conversation.members
      .filter((item) => item.id !== member.id)
      .map((item) => `- ${item.name} (@${item.handle}, ${item.role}, id=${item.id})`)
      .join('\n');

    const memory = this.members.readMemory(member.id);

    return [
      `You are ${member.name}.`,
      '',
      `Role: ${member.role}`,
      `Description: ${member.description}`,
      `Style: ${member.style}`,
      '',
      member.systemPrompt,
      '',
      'Authorization rule:',
      'Your role is an identity and behavior definition only.',
      'It does not grant authorization to access protected data,',
      'execute privileged operations, approve actions,',
      'or bypass application policy.',
      '',
      `Current conversation: ${conversation.id}`,
      `Conversation title: ${conversation.title}`,
      '',
      'Other Team Members:',
      otherMembers || '(none)',
      '',
      'Delegation:',
      'Use ask_member when another Member is better suited to a subtask.',
      'Do not directly simulate another Member.',
      'ask_member is synchronous: you will block until that Member finishes,',
      'so keep delegated tasks focused.',
      '',
      'Long-term memory:',
      memory || '(no stored memory yet)',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Runtime = 某 Member 在某 Conversation 中的运行实例。
   * 同一 (conversation, member) 永远复用同一个 Copilot session，
   * 换 conversation 就换一个 runtime，上下文天然隔离。
   */
  private ensureRuntime(conversation: Conversation, member: Member): MemberRuntime {
    const existing = this.findRuntime(conversation.id, member.id);
    if (existing) return existing;

    const id = randomUUID();
    const copilotSessionId = `member-${member.id}-${randomUUID()}`;
    const workspacePath = path.join(config.workspaceRoot, conversation.id, member.id);

    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'AGENTS.md'),
      [
        `# ${member.name}`,
        '',
        `Role: ${member.role}`,
        `Member ID: ${member.id}`,
        `Conversation ID: ${conversation.id}`,
        '',
        'This workspace belongs only to this Member in this Conversation.',
        '',
      ].join('\n'),
      'utf8',
    );

    // INSERT OR IGNORE + 回读：并发首轮时不会撞 UNIQUE(conversation_id, member_id)
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO member_runtime (
          id,
          conversation_id,
          member_id,
          copilot_session_id,
          workspace_path,
          status,
          active_execution_id,
          last_context_message_sequence,
          last_used_at
        )
        VALUES (?, ?, ?, ?, ?, 'idle', NULL, 0, NULL)
        `,
      )
      .run(id, conversation.id, member.id, copilotSessionId, workspacePath);

    const row = this.db
      .prepare(
        `
        SELECT *
        FROM member_runtime
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(conversation.id, member.id) as unknown as RuntimeRow;

    return mapRuntime(row);
  }

  private findRuntime(conversationId: string, memberId: string): MemberRuntime | null {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM member_runtime
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(conversationId, memberId) as unknown as RuntimeRow | undefined;
    return row ? mapRuntime(row) : null;
  }

  private findRuntimeById(runtimeId: string): MemberRuntime | null {
    const row = this.db
      .prepare(`SELECT * FROM member_runtime WHERE id = ?`)
      .get(runtimeId) as unknown as RuntimeRow | undefined;
    return row ? mapRuntime(row) : null;
  }

  private insertMessage(message: ConversationMessage): void {
    this.db
      .prepare(
        `
        INSERT INTO conversation_message (
          id,
          conversation_id,
          message_sequence,
          sender_type,
          sender_id,
          target_member_id,
          reply_to_message_id,
          content,
          execution_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        message.id,
        message.conversationId,
        message.messageSequence,
        message.senderType,
        message.senderId,
        message.targetMemberId,
        message.replyToMessageId,
        message.content,
        message.executionId,
        message.createdAt,
      );
  }

  private insertMemberMessage(input: {
    conversationId: string;
    memberId: string;
    content: string;
    executionId: string;
    replyToMessageId: string | null;
  }): ConversationMessage {
    const message: ConversationMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      messageSequence: this.nextMessageSequence(input.conversationId),
      senderType: 'member',
      senderId: input.memberId,
      targetMemberId: null,
      replyToMessageId: input.replyToMessageId,
      content: input.content,
      executionId: input.executionId,
      createdAt: now(),
    };

    this.insertMessage(message);
    return message;
  }

  private resolveTargetMember(conversation: Conversation, targetMemberId?: string): Member {
    if (targetMemberId) return this.requireConversationMember(conversation, targetMemberId);
    if (conversation.defaultMemberId) {
      return this.requireConversationMember(conversation, conversation.defaultMemberId);
    }
    if (conversation.members.length === 1) return conversation.members[0];

    throw badRequest('group conversation 必须指定 targetMemberId');
  }

  private requireConversationMember(conversation: Conversation, memberId: string): Member {
    const member = conversation.members.find((item) => item.id === memberId);
    if (!member) {
      throw badRequest(`Member ${memberId} 不属于 conversation ${conversation.id}`);
    }
    return member;
  }

  private hydrateConversation(row: ConversationRow): Conversation {
    const memberRows = this.db
      .prepare(
        `
        SELECT m.*
        FROM member m
        JOIN conversation_member cm
          ON cm.member_id = m.id
        WHERE cm.conversation_id = ?
          AND m.status = 'active'
        ORDER BY cm.joined_at
        `,
      )
      .all(row.id) as unknown as MemberRow[];

    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      defaultMemberId: row.default_member_id,
      createdBy: row.created_by,
      eventSequence: row.event_sequence,
      messageSequence: row.message_sequence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      members: memberRows.map((member) => ({
        id: member.id,
        handle: member.handle,
        name: member.name,
        role: member.role,
        description: member.description,
        style: member.style,
        systemPrompt: member.system_prompt,
        model: member.model,
        toolProfile: member.tool_profile,
        status: member.status,
        createdAt: member.created_at,
        updatedAt: member.updated_at,
      })),
    };
  }

  private insertExecution(execution: ExecutionRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO execution (
          id,
          conversation_id,
          member_id,
          runtime_id,
          parent_execution_id,
          delegation_path,
          kind,
          status,
          prompt,
          response,
          error,
          waiting_for_runtime_id,
          retry_of_execution_id,
          started_at,
          ended_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        execution.id,
        execution.conversationId,
        execution.memberId,
        execution.runtimeId,
        execution.parentExecutionId,
        JSON.stringify(execution.delegationPath),
        execution.kind,
        execution.status,
        execution.prompt,
        execution.response,
        execution.error,
        execution.waitingForRuntimeId,
        execution.retryOfExecutionId,
        execution.startedAt,
        execution.endedAt,
        execution.createdAt,
      );
  }

  private findExecution(id: string): ExecutionRecord | null {
    const row = this.db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
      | ExecutionRow
      | undefined;
    return row ? mapExecution(row) : null;
  }

  /**
   * 用 `!== undefined` 而不是 `??`：这两个语义不同。
   * `??` 会让「显式清空为 null」失效，而 waiting_for_runtime_id /
   * active_execution_id 恰恰需要能被显式清空。
   */
  private updateExecution(
    id: string,
    patch: Partial<{
      runtimeId: string | null;
      status: ExecutionStatus;
      response: string | null;
      error: string | null;
      waitingForRuntimeId: string | null;
      startedAt: string | null;
      endedAt: string | null;
    }>,
  ): void {
    const current = this.getExecution(id);
    this.db
      .prepare(
        `
        UPDATE execution
        SET
          runtime_id = ?,
          status = ?,
          response = ?,
          error = ?,
          waiting_for_runtime_id = ?,
          started_at = ?,
          ended_at = ?
        WHERE id = ?
        `,
      )
      .run(
        patch.runtimeId !== undefined ? patch.runtimeId : current.runtimeId,
        patch.status !== undefined ? patch.status : current.status,
        patch.response !== undefined ? patch.response : current.response,
        patch.error !== undefined ? patch.error : current.error,
        patch.waitingForRuntimeId !== undefined
          ? patch.waitingForRuntimeId
          : current.waitingForRuntimeId,
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.endedAt !== undefined ? patch.endedAt : current.endedAt,
        id,
      );
  }

  private emitExecution(execution: ExecutionRecord): void {
    this.emit(execution.conversationId, { type: 'execution.updated', data: execution });
  }

  private updateRuntime(
    runtimeId: string,
    patch: Partial<{
      status: MemberRuntime['status'];
      activeExecutionId: string | null;
      lastContextMessageSequence: number;
      lastUsedAt: string | null;
    }>,
  ): void {
    const current = this.findRuntimeById(runtimeId);
    if (!current) throw notFound(`Runtime 不存在：${runtimeId}`);

    this.db
      .prepare(
        `
        UPDATE member_runtime
        SET
          status = ?,
          active_execution_id = ?,
          last_context_message_sequence = ?,
          last_used_at = ?
        WHERE id = ?
        `,
      )
      .run(
        patch.status !== undefined ? patch.status : current.status,
        patch.activeExecutionId !== undefined ? patch.activeExecutionId : current.activeExecutionId,
        patch.lastContextMessageSequence !== undefined
          ? patch.lastContextMessageSequence
          : current.lastContextMessageSequence,
        patch.lastUsedAt !== undefined ? patch.lastUsedAt : current.lastUsedAt,
        runtimeId,
      );
  }

  private touchConversation(conversationId: string): void {
    this.db
      .prepare(`UPDATE conversation SET updated_at = ? WHERE id = ?`)
      .run(now(), conversationId);
  }

  /** 会话内单调递增的 message 游标。同步 SQL，天然原子。 */
  private nextMessageSequence(conversationId: string): number {
    this.db
      .prepare(`UPDATE conversation SET message_sequence = message_sequence + 1 WHERE id = ?`)
      .run(conversationId);

    const row = this.db
      .prepare(`SELECT message_sequence FROM conversation WHERE id = ?`)
      .get(conversationId) as unknown as { message_sequence: number } | undefined;
    if (!row) throw notFound(`Conversation 不存在：${conversationId}`);
    return row.message_sequence;
  }

  /** 会话内单调递增的 event 游标，SSE Last-Event-ID 就是它。 */
  private nextEventSequence(conversationId: string): number {
    this.db
      .prepare(`UPDATE conversation SET event_sequence = event_sequence + 1 WHERE id = ?`)
      .run(conversationId);

    const row = this.db
      .prepare(`SELECT event_sequence FROM conversation WHERE id = ?`)
      .get(conversationId) as unknown as { event_sequence: number } | undefined;
    if (!row) throw notFound(`Conversation 不存在：${conversationId}`);
    return row.event_sequence;
  }

  /**
   * DB 是 source of truth，广播只是投递手段：
   * 先落 conversation_event，再 fan-out 给内存里的 SSE consumer。
   *
   * message.delta 是唯一例外 —— token 级高频，落库会把 DB 写爆。
   * 它没有 id / sequence，浏览器不会推进 Last-Event-ID，重连时无需回放；
   * 丢掉的增量文本由 durable 的 message.created（含完整内容）收敛。
   */
  private emit(conversationId: string, event: ConversationEvent): void {
    if (event.type === 'message.delta') {
      this.broadcast(conversationId, {
        id: null,
        conversationId,
        sequence: null,
        type: event.type,
        data: event.data,
        createdAt: now(),
      });
      return;
    }

    this.broadcast(conversationId, this.persistEvent(conversationId, event));
  }

  private persistEvent(
    conversationId: string,
    event: ConversationEvent,
  ): StoredConversationEvent {
    const stored: StoredConversationEvent = {
      id: randomUUID(),
      conversationId,
      sequence: this.nextEventSequence(conversationId),
      type: event.type,
      data: event.data,
      createdAt: now(),
    };

    this.db
      .prepare(
        `
        INSERT INTO conversation_event (
          id,
          conversation_id,
          sequence,
          event_type,
          payload,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        stored.id,
        conversationId,
        stored.sequence,
        stored.type,
        JSON.stringify(stored.data),
        stored.createdAt,
      );

    return stored;
  }

  private broadcast(conversationId: string, event: StoredConversationEvent): void {
    const listeners = this.listeners.get(conversationId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 一个 SSE consumer 挂掉不能影响其它 consumer
      }
    }
  }

  private async withRuntimeLock<T>(runtimeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.runtimeLocks.get(runtimeId) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => {}).then(() => gate);
    this.runtimeLocks.set(runtimeId, current);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.runtimeLocks.get(runtimeId) === current) this.runtimeLocks.delete(runtimeId);
    }
  }
}

function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageSequence: row.message_sequence,
    senderType: row.sender_type,
    senderId: row.sender_id,
    targetMemberId: row.target_member_id,
    replyToMessageId: row.reply_to_message_id,
    content: row.content,
    executionId: row.execution_id,
    createdAt: row.created_at,
  };
}

function mapExecution(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    memberId: row.member_id,
    runtimeId: row.runtime_id,
    parentExecutionId: row.parent_execution_id,
    delegationPath: JSON.parse(row.delegation_path) as string[],
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
    response: row.response,
    error: row.error,
    waitingForRuntimeId: row.waiting_for_runtime_id,
    retryOfExecutionId: row.retry_of_execution_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

function mapRuntime(row: RuntimeRow): MemberRuntime {
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

function mapEvent(row: EventRow): StoredConversationEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    type: row.event_type,
    data: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}
