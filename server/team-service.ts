import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now } from './db.js';
import {
  MemberService,
  type CreateMemberInput,
  type UpdateMemberInput,
} from './member-service.js';
import type { CopilotService } from './copilot.js';
import type {
  Conversation,
  ConversationEvent,
  ConversationMessage,
  ExecutionKind,
  ExecutionRecord,
  ExecutionStatus,
  Member,
  MemberRuntime,
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
 */

interface ConversationRow {
  id: string;
  title: string;
  kind: 'direct' | 'group' | 'work';
  default_member_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
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

export interface CreateConversationInput {
  title?: string;
  kind?: 'direct' | 'group' | 'work';
  memberIds: string[];
  defaultMemberId?: string;
}

type Listener = (event: ConversationEvent) => void;

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

  constructor(
    private readonly db: DatabaseSync,
    private readonly members: MemberService,
    private readonly copilot: CopilotService,
  ) {}

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
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
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
   * 返回最近 limit 条消息，按时间正序。
   * 先 DESC 取尾部再反转：聊天场景要的是「最新 N 条」，不是「最旧 N 条」。
   */
  listMessages(conversationId: string, limit = 100): ConversationMessage[] {
    this.getConversation(conversationId);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_message
        WHERE conversation_id = ?
        ORDER BY created_at DESC, rowid DESC
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

    const message: ConversationMessage = {
      id: messageId,
      conversationId: input.conversationId,
      senderType: 'user',
      senderId: config.localUserId,
      targetMemberId: target.id,
      replyToMessageId: input.replyToMessageId ?? null,
      content: input.content.trim(),
      executionId,
      createdAt,
    };

    this.db
      .prepare(
        `
        INSERT INTO conversation_message (
          id,
          conversation_id,
          sender_type,
          sender_id,
          target_member_id,
          reply_to_message_id,
          content,
          execution_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        message.id,
        message.conversationId,
        message.senderType,
        message.senderId,
        message.targetMemberId,
        message.replyToMessageId,
        message.content,
        message.executionId,
        message.createdAt,
      );

    const execution: ExecutionRecord = {
      id: executionId,
      conversationId: conversation.id,
      memberId: target.id,
      runtimeId: null,
      parentExecutionId: null,
      delegationPath: [target.id],
      kind: conversation.kind === 'work' ? 'member_work' : 'interactive',
      status: 'queued',
      prompt: input.content.trim(),
      response: null,
      error: null,
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
      prompt: input.content.trim(),
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
      throw new Error('parent execution 不属于当前 Member');
    }
    if (parent.conversationId !== conversation.id) {
      throw new Error('parent execution 不属于当前 conversation');
    }
    // 防 A → B → C → A
    if (parent.delegationPath.includes(targetMember.id)) {
      throw new Error(
        `检测到 Member delegation cycle：${[...parent.delegationPath, targetMember.id].join(' -> ')}`,
      );
    }
    // 防 A → B → C → D → ...
    if (parent.delegationPath.length >= config.maxDelegationDepth) {
      throw new Error(`超过最大 delegation depth：${config.maxDelegationDepth}`);
    }

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
      startedAt: null,
      endedAt: null,
      createdAt: now(),
    };
    this.insertExecution(childExecution);

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
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  rememberMember(input: { memberId: string; content: string }): Promise<string> {
    return Promise.resolve(this.members.appendMemory(input.memberId, input.content));
  }

  // ------------------------------------------------------------ SSE 订阅

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

  // ------------------------------------------------------------- 内部实现

  private async executeMemberTurn(input: {
    conversation: Conversation;
    member: Member;
    execution: ExecutionRecord;
    prompt: string;
    sourceMemberId?: string;
  }): Promise<string> {
    const runtime = this.ensureRuntime(input.conversation, input.member);

    this.updateRuntime(runtime.id, { status: 'running', lastUsedAt: now() });
    this.updateExecution(input.execution.id, {
      runtimeId: runtime.id,
      status: 'running',
      startedAt: now(),
      endedAt: null,
      error: null,
    });
    this.emitExecution(this.getExecution(input.execution.id));

    try {
      const systemPrompt = this.buildMemberSystemPrompt(input.conversation, input.member);

      const result = await this.copilot.runMemberTurn({
        runtime,
        member: input.member,
        systemPrompt,
        prompt: this.buildPrompt(input.conversation.id, input.member, input.prompt),
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

      this.updateRuntime(runtime.id, { status: 'idle', lastUsedAt: now() });
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

      this.updateRuntime(runtime.id, { status: 'error', lastUsedAt: now() });
      this.updateExecution(input.execution.id, {
        status: 'failed',
        error: message,
        endedAt: now(),
      });
      this.emitExecution(this.getExecution(input.execution.id));

      throw error;
    }
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
      '',
      'Long-term memory:',
      memory || '(no stored memory yet)',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildPrompt(conversationId: string, member: Member, prompt: string): string {
    const recent = this.listMessages(conversationId, 24);
    const transcript = recent
      .map((message) => {
        const actor =
          message.senderType === 'member'
            ? this.members.get(message.senderId).name
            : message.senderType === 'user'
              ? 'User'
              : 'System';
        return `[${actor}] ${message.content}`;
      })
      .join('\n\n');

    return [
      'Shared conversation context:',
      '',
      transcript,
      '',
      'Current task:',
      prompt,
      '',
      `You are replying as ${member.name}.`,
    ].join('\n');
  }

  /**
   * Runtime = 某 Member 在某 Conversation 中的运行实例。
   * 同一 (conversation, member) 永远复用同一个 Copilot session，
   * 换 conversation 就换一个 runtime，上下文天然隔离。
   */
  private ensureRuntime(conversation: Conversation, member: Member): MemberRuntime {
    const existing = this.db
      .prepare(
        `
        SELECT *
        FROM member_runtime
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(conversation.id, member.id) as unknown as RuntimeRow | undefined;
    if (existing) return mapRuntime(existing);

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
          last_used_at
        )
        VALUES (?, ?, ?, ?, ?, 'idle', NULL)
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
      senderType: 'member',
      senderId: input.memberId,
      targetMemberId: null,
      replyToMessageId: input.replyToMessageId,
      content: input.content,
      executionId: input.executionId,
      createdAt: now(),
    };

    this.db
      .prepare(
        `
        INSERT INTO conversation_message (
          id,
          conversation_id,
          sender_type,
          sender_id,
          target_member_id,
          reply_to_message_id,
          content,
          execution_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        message.id,
        message.conversationId,
        message.senderType,
        message.senderId,
        message.targetMemberId,
        message.replyToMessageId,
        message.content,
        message.executionId,
        message.createdAt,
      );

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
          started_at,
          ended_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        execution.startedAt,
        execution.endedAt,
        execution.createdAt,
      );
  }

  private getExecution(id: string): ExecutionRecord {
    const row = this.db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
      | ExecutionRow
      | undefined;
    if (!row) throw new Error(`Execution 不存在：${id}`);

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
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    };
  }

  private updateExecution(
    id: string,
    patch: Partial<{
      runtimeId: string | null;
      status: ExecutionStatus;
      response: string | null;
      error: string | null;
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
          started_at = ?,
          ended_at = ?
        WHERE id = ?
        `,
      )
      .run(
        patch.runtimeId ?? current.runtimeId,
        patch.status ?? current.status,
        patch.response ?? current.response,
        patch.error ?? current.error,
        patch.startedAt ?? current.startedAt,
        patch.endedAt ?? current.endedAt,
        id,
      );
  }

  private emitExecution(execution: ExecutionRecord): void {
    this.emit(execution.conversationId, { type: 'execution.updated', data: execution });
  }

  private updateRuntime(
    runtimeId: string,
    patch: { status?: MemberRuntime['status']; lastUsedAt?: string },
  ): void {
    const current = this.db
      .prepare(`SELECT * FROM member_runtime WHERE id = ?`)
      .get(runtimeId) as unknown as RuntimeRow;

    this.db
      .prepare(
        `
        UPDATE member_runtime
        SET
          status = ?,
          last_used_at = ?
        WHERE id = ?
        `,
      )
      .run(patch.status ?? current.status, patch.lastUsedAt ?? current.last_used_at, runtimeId);
  }

  private touchConversation(conversationId: string): void {
    this.db
      .prepare(`UPDATE conversation SET updated_at = ? WHERE id = ?`)
      .run(now(), conversationId);
  }

  private emit(conversationId: string, event: ConversationEvent): void {
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
}

function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    targetMemberId: row.target_member_id,
    replyToMessageId: row.reply_to_message_id,
    content: row.content,
    executionId: row.execution_id,
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
    lastUsedAt: row.last_used_at,
  };
}
