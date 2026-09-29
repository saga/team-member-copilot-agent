import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { now } from './db.js';
import type { Conversation, ConversationMemberState, ConversationMessage, ConversationParticipant, ConversationPrincipalType, GoalChangeKind, GoalRevision, TaskRequirements } from './domain.js';
import { badRequest, conflict, notFound } from './http-error.js';
import { isMemberDm } from './member-conversation-service.js';
import { findMentionedMembers } from './member-mentions.js';
import { parseRequirements } from './task-service.js';
import type { TeamInternals } from './team-internals.js';
import type { CreateConversationInput, SendMessageResult, WakePlan } from './team-service.js';
import { assertConversationKindShape, isUniqueViolation, mapMessage } from './team-shared.js';
import type { ConversationRow, MessageRow } from './team-shared.js';
import { serializeExternalWorkRef } from './work-management/types.js';

/**
 * ConversationService
 *
 * 原先是 TeamService 的一组方法，按 §31 拆出来。共享基础设施由 TeamInternals
 * 注入 —— 这个类不认识 TeamService，只认识那张表面。
 */
export class ConversationService {
  constructor(private readonly internals: TeamInternals) {}

  getConversation(id: string): Conversation {
    const row = this.internals.db.prepare(`SELECT * FROM conversation WHERE id = ?`).get(id) as unknown as
      | ConversationRow
      | undefined;
    if (!row) {
      throw notFound(`Conversation 不存在：${id}`);
    }
    return this.internals.hydrateConversation(row);
  }

  // ------------------------------------------------- Conversation Participant
  //
  // 谁可以进这间房。和 conversation_member（哪些 Agent 是成员）是两张表，
  // 理由见 domain.ts 的 ConversationParticipant 注释。
  //
  // 这些方法刻意都很薄：ACL 的判定必须只有一处（middleware/conversationAccess.ts），
  // 这里只提供「读这一行 / 写这一行」。在服务层再包一层「能不能进」的判断，
  // 就会出现两套判据各自漂移 —— 而漂移的表现是「房间进不去但执行记录看得见」。

  /** 这个 principal 是不是这间房的参与者。 */
  isConversationParticipant(
    conversationId: string,
    principalType: ConversationPrincipalType,
    principalId: string,
  ): boolean {
    const row = this.internals.db
      .prepare(
        `SELECT 1 AS ok FROM conversation_participant
         WHERE conversation_id = ? AND principal_type = ? AND principal_id = ?
         LIMIT 1`,
      )
      .get(conversationId, principalType, principalId);
    return row !== undefined;
  }

  /**
   * 加一个参与者。幂等 —— 重复添加不报错。
   *
   * 用 `ON CONFLICT DO NOTHING` 而不是先查后插：并发添加同一个人（两次点击、
   * 或者建房的自动加入与显式邀请撞在一起）会走成主键冲突异常，而「把已经在
   * 房里的人再加一次」显然不该是一次失败。
   */
  addConversationParticipant(input: {
    conversationId: string;
    principalType: ConversationPrincipalType;
    principalId: string;
    addedBy?: string | null;
  }): void {
    // 房间不存在时直接报 404，而不是靠外键抛一个「FOREIGN KEY constraint failed」：
    // 后者在日志里看不出是哪个 id 错了。
    this.getConversation(input.conversationId);

    this.internals.db
      .prepare(
        `INSERT INTO conversation_participant (
           conversation_id, principal_type, principal_id, added_by, added_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, principal_type, principal_id) DO NOTHING`,
      )
      .run(
        input.conversationId,
        input.principalType,
        input.principalId,
        input.addedBy ?? null,
        now(),
      );
  }

  removeConversationParticipant(
    conversationId: string,
    principalType: ConversationPrincipalType,
    principalId: string,
  ): void {
    this.internals.db
      .prepare(
        `DELETE FROM conversation_participant
         WHERE conversation_id = ? AND principal_type = ? AND principal_id = ?`,
      )
      .run(conversationId, principalType, principalId);
  }

  listConversationParticipants(conversationId: string): ConversationParticipant[] {
    this.getConversation(conversationId);
    const rows = this.internals.db
      .prepare(
        `SELECT * FROM conversation_participant
         WHERE conversation_id = ?
         ORDER BY added_at, principal_id`,
      )
      .all(conversationId) as unknown as Array<{
      conversation_id: string;
      principal_type: ConversationPrincipalType;
      principal_id: string;
      added_by: string | null;
      added_at: string;
    }>;

    return rows.map((row) => ({
      conversationId: row.conversation_id,
      principalType: row.principal_type,
      principalId: row.principal_id,
      addedBy: row.added_by,
      addedAt: row.added_at,
    }));
  }

  /**
   * Conversation 列表。
   *
   * 传 `teamId` 时只返回**这个 Team 的**房间。不传 = 全部（单 Team 部署与
   * 内部工具用）。
   *
   * conversation 表上有 team_id，所以过滤是一条 WHERE —— 但以前这里没有它，
   * 于是多 Team 部署下侧栏会把所有 Team 的房间一起列出来。这是最容易被忽略的
   * 一类越权：它不报错、不 403，只是**多显示了几行**，而用户会以为那就是
   * 自己该看到的全部。
   */
  listConversations(teamId?: string): Conversation[] {
    const rows = this.internals.db
      .prepare(
        teamId
          ? `
        SELECT *
        FROM conversation
        WHERE team_id = ?
        ORDER BY updated_at DESC
        `
          : `
        SELECT *
        FROM conversation
        ORDER BY updated_at DESC
        `,
      )
      .all(...(teamId ? [teamId] : [])) as unknown as ConversationRow[];
    // 一次聚合拿全列表的任务进度：每个工作区再调一次 Task API 是 N+1。
    // 只看当前 Goal：v1 的 5/5 不能和 v2 的 1/3 加成 6/8。
    const progressRows = this.internals.db
      .prepare(
        `
        SELECT t.conversation_id AS conversation_id,
               COUNT(*) AS total,
               SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed
        FROM conversation_task t
        JOIN conversation c ON c.id = t.conversation_id
        WHERE t.goal_revision = c.goal_revision
        GROUP BY t.conversation_id
        `,
      )
      .all() as unknown as Array<{ conversation_id: string; total: number; completed: number }>;
    const progress = new Map(
      progressRows.map((row) => [row.conversation_id, { total: row.total, completed: row.completed }]),
    );
    return rows.map((row) => this.internals.hydrateConversation(row, progress));
  }

  /**
   * 建工作区。Task 工作区默认让 Lead 主动先开口（`autoStartLead`）：
   * 用户建完不用先想第一句话，Lead 会先看 Jira 和上下文，缺信息就直接问。
   *
   * 关掉它只为了测试装配：开了会导致每个新建房间都多一轮 Lead turn，
   * 数 execution / 消息条数的断言会全崩。线上 HTTP 建工作区一律开着。
   */
  createConversation(input: CreateConversationInput, opts?: { autoStartLead?: boolean }): Conversation {
    const memberIds = [...new Set(input.memberIds)];
    if (memberIds.length === 0) throw badRequest('至少需要一个 Member');

    const members = memberIds.map((id) => this.internals.members.get(id));

    const id = randomUUID();
    const createdAt = now();
    const kind = input.kind ?? 'task';

    assertConversationKindShape(kind, memberIds.length);

    // 归档的 Member 是历史事实，不能作为新工作区的成员
    const archived = members.filter((member) => member.status !== 'active');
    if (archived.length > 0) {
      throw badRequest(
        `不能把已归档的 Member 加入 conversation：${archived.map((m) => m.name).join(', ')}`,
      );
    }

    const leadMemberId = kind === 'task' ? (input.leadMemberId ?? memberIds[0]) : null;
    if (leadMemberId && !memberIds.includes(leadMemberId)) {
      throw badRequest('指定的 Lead 必须在这个工作区里');
    }

    const title =
      input.title?.trim() ||
      (kind === 'task' ? `工作-${createdAt.slice(0, 10)}` : members.map((m) => m.name).join(' · '));

    // Team 归属：显式 teamId 优先（多 Team 部署下由请求决定），否则取默认 Team。
    // 成员不在 Team 里则自动补 membership（provisioning/旧库路径），
    // 已在但 inactive 的仍拒绝。
    let teamId = '';
    const externalWorkRef = this.internals.resolveExternalWorkRef(input.externalWorkRef);
    try {
      const team = input.teamId
        ? this.internals.structure?.getTeam(input.teamId) ?? this.internals.defaultTeam()
        : this.internals.defaultTeam();
      teamId = team.id;
      for (const memberId of memberIds) {
        try {
          this.internals.structure?.requireActiveMembership(teamId, 'agent', memberId);
        } catch {
          this.internals.structure?.ensureAgentMembership(teamId, memberId);
          this.internals.structure?.requireActiveMembership(teamId, 'agent', memberId);
        }
      }
    } catch (error) {
      // structure 未装配时退回无 Team 校验（旧测试路径）；有 structure 则错误向上传。
      if (this.internals.structure) throw error;
      const fallback = this.internals.db.prepare(`SELECT id FROM team ORDER BY created_at LIMIT 1`).get() as unknown as
        | { id: string }
        | undefined;
      if (!fallback) throw badRequest('Team 尚未初始化');
      teamId = fallback.id;
    }

    this.internals.db
      .prepare(
        `
        INSERT INTO conversation (
          id,
          team_id,
          external_work_ref,
          title,
          kind,
          objective,
          lead_member_id,
          status,
          requirements_json,
          open_questions_json,
          created_by,
          event_sequence,
          message_sequence,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, '', ?, 'intake', '{"facts":[],"assumptions":[],"constraints":[],"successCriteria":[]}', '[]', ?, 0, 0, ?, ?)
        `,
      )
      .run(
        id,
        teamId,
        serializeExternalWorkRef(externalWorkRef),
        title,
        kind,
        leadMemberId,
        config.localUserId,
        createdAt,
        createdAt,
      );

    const insertMember = this.internals.db.prepare(
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
      // 新房间没有历史，房间读游标从 0 开始
      this.internals.states.ensure(id, memberId, 0);
    }

    // 建房者自动成为参与者。
    //
    // 这一步是 ACL 收紧之后**必须**有的：human 的访问判据从「你是这个 Team 的
    // 成员」改成「你是这间房的参与者」，而这张表一开始是空的 —— 不在这里写入，
    // 建完房的人立刻进不去自己刚建的房间。
    //
    // 落的是 `createdBy`（HTTP 层传进来的真实 principalId，即 OIDC 的 sub），
    // 不是 `config.localUserId`：后者是「本机单用户」的占位，在生产里永远不会
    // 出现在任何一张 token 上 —— 用它写入等于给一个不存在的人开门。
    this.addConversationParticipant({
      conversationId: id,
      principalType: 'human',
      principalId: input.createdBy ?? config.localActorId,
      addedBy: null,
    });

    // Lead 主动先开口：落一条 system 开场（触发消息），再唤醒 Lead。
    // 用户看到的第一条就是 Lead 的回应，而不是一个等他先说话的空房间。
    if (kind === 'task' && leadMemberId && opts?.autoStartLead) {
      const opener: ConversationMessage = {
        id: randomUUID(),
        conversationId: id,
        messageSequence: this.internals.nextMessageSequence(id),
        senderType: 'system',
        senderId: 'system',
        replyToMessageId: null,
        taskId: null,
        clientRequestId: null,
        content:
          `新工作区已创建：${title}。` +
          `参与：${members.map((member) => member.name).join('、')}。` +
          (externalWorkRef ? `挂钩业务：${externalWorkRef.key}。` : '') +
          '请主动推进：先看清目标，缺信息就直接问用户。',
        executionId: null,
        files: [],
        createdAt: now(),
      };
      this.internals.insertMessage(opener);
      this.internals.touchConversation(id);
      this.internals.emit(id, { type: 'message.created', data: opener });
      // 自动首轮不再伪装成 lead_message：它是可丢弃的启动动作，用户一旦
      // 开始交互就会被取消；独立原因才能在竞态里认出它、停掉它。
      this.internals.orchestrator.ensureLeadWake(id, leadMemberId, opener.messageSequence, 'lead_bootstrap');
    }

    return this.getConversation(id);
  }

  addMember(conversationId: string, memberId: string): Conversation {
    const conversation = this.getConversation(conversationId);
    if (conversation.kind !== 'task') {
      throw badRequest('只有 Task 工作区允许增减成员');
    }
    // 任务一旦开始，roster 就冻结：中途换人会让 Task 归属无法解释。
    if (conversation.status !== 'intake' && conversation.status !== 'waiting_user') {
      throw conflict('任务已经开始，不能修改成员');
    }

    const member = this.internals.members.get(memberId);
    if (member.status !== 'active') {
      throw badRequest(`不能把已归档的 Member 加入 conversation：${member.name}`);
    }
    // 必须是 active Team 成员：Team 之外的人不能被拉进房间。
    if (this.internals.structure) {
      this.internals.structure.requireActiveMembership(conversation.teamId, 'agent', memberId);
    }

    this.internals.db
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

    // 加入已有 group 的新成员：房间游标直接推到当前水位。
    // 从 0 开始的话，它第一次被唤醒时「未读」是整个历史。
    this.internals.states.ensure(conversationId, memberId, conversation.messageSequence);
    // runtime 的上下文水位同样要对齐。被移出后重新加入的成员会命中「已有 runtime」
    // 这条分支（它的 session 在移出时已经退休），水位如果还停在离开时的位置，
    // 第一轮就会把离开期间的全部消息塞进 prompt。
    this.internals.alignRuntimeCheckpoint(conversationId, memberId, conversation.messageSequence);

    this.internals.touchConversation(conversationId);
    return this.getConversation(conversationId);
  }

  removeMember(conversationId: string, memberId: string): Conversation {
    const conversation = this.getConversation(conversationId);
    if (conversation.kind !== 'task') {
      throw badRequest('只有 Task 工作区允许增减成员');
    }
    if (conversation.status !== 'intake' && conversation.status !== 'waiting_user') {
      throw conflict('任务已经开始，不能修改成员');
    }

    // 移出前必须没有在飞的活。否则 scheduler 手里的那条 queued wake 会在
    // runWake 里撞上 requireActiveMember / requireConversationMember 抛错，
    // 于是「消息留着、execution 没有」。
    this.internals.assertMemberNotBusy(memberId, '移出 Team', conversationId);

    // 移出后 roster 仍要满足 kind 的形状约束，否则会造出不合法的工作区。
    const remaining = conversation.members.filter((member) => member.id !== memberId);
    assertConversationKindShape(conversation.kind, remaining.length);

    this.internals.db
      .prepare(
        `
        DELETE FROM conversation_member
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(conversationId, memberId);

    this.internals.db
      .prepare(
        `
        UPDATE conversation
        SET
          lead_member_id = CASE
            WHEN lead_member_id = ? THEN ?
            ELSE lead_member_id
          END,
          updated_at = ?
        WHERE id = ?
        `,
      )
      // Lead 被移除时自动由剩下成员的第一个接替：Task 工作区不能没有 Lead。
      .run(memberId, remaining[0]?.id ?? null, now(), conversationId);

    // 房间状态跟着 roster 一起走：人走了，它的读游标 / 唤醒状态也不该留下
    this.internals.states.remove(conversationId, memberId);
    // 引擎侧也要断代
    this.internals.retireRuntime(conversationId, memberId);

    return this.getConversation(conversationId);
  }

  async sendMessage(input: {
    conversationId: string;
    /** 当前登录用户（OIDC sub）。用户消息的归属，不再是写死的 local user。 */
    actorId: string;
    content: string;
    replyToMessageId?: string;
    clientRequestId?: string;
    fileIds?: string[];
  }): Promise<SendMessageResult> {
    const conversation = this.getConversation(input.conversationId);
    const content = input.content.trim();
    if (!content) throw badRequest('消息内容不能为空');

    if (isMemberDm(conversation)) {
      throw badRequest('这是 Member 之间的私聊，可以直接看，但不能以用户身份发言');
    }
    if (conversation.kind !== 'task') {
      throw badRequest('只有 Task 工作区接受用户消息');
    }
    // 结束的工作区不再接受普通消息：已完成的工作不会被一句话重新点燃，
    // 要做新工作就新建一个工作区。
    if (conversation.status === 'completed' || conversation.status === 'cancelled') {
      throw conflict('这个工作已经结束，不能再发消息：要继续做事请新建一个工作区');
    }

    const clientRequestId = input.clientRequestId?.trim() || null;
    if (clientRequestId) {
      const existing = this.internals.findMessageByClientRequestId(conversation.id, clientRequestId);
      if (existing) {
        return { message: existing, wakes: [], deduplicated: true };
      }
    }

    const replyToMessageId = this.internals.requireMessageInConversation(
      conversation.id,
      input.replyToMessageId,
    );
    const files = this.internals.requireConversationFiles(conversation.id, input.fileIds ?? []);

    const message: ConversationMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      messageSequence: this.internals.nextMessageSequence(conversation.id),
      senderType: 'user',
      senderId: input.actorId,
      replyToMessageId,
      taskId: null,
      clientRequestId,
      content,
      executionId: null,
      files: [],
      createdAt: now(),
    };

    try {
      this.internals.transaction(() => {
        this.internals.insertMessage(message);
        files.forEach((file, index) => {
          this.internals.conversationFiles?.attachToMessage(
            message.id,
            file.id,
            this.internals.relationForNewMessage(conversation.id, message, file.id),
            index,
          );
        });
      });
    } catch (error) {
      if (clientRequestId && isUniqueViolation(error)) {
        const existing = this.internals.findMessageByClientRequestId(conversation.id, clientRequestId);
        if (existing) {
          return { message: existing, wakes: [], deduplicated: true };
        }
      }
      throw error;
    }

    this.internals.touchConversation(conversation.id);
    const created = { ...message, files };
    this.internals.emit(conversation.id, { type: 'message.created', data: created });

    const wakes: WakePlan[] = [];
    const fresh = this.getConversation(conversation.id);
    const mentionedMembers = findMentionedMembers(created.content, fresh.members);
    const leadIsMentioned =
      !!fresh.leadMemberId && mentionedMembers.some((member) => member.id === fresh.leadMemberId);

    // 用户真正开始交互时，取消尚未完成的自动 bootstrap。
    await this.cancelLeadBootstrap(fresh);

    // @别的 Member 不是在回答 Lead 的澄清问题：waiting_user 和 openQuestions
    // 都保留。只有普通消息、或明确 @Lead，才算把 Lead 等的那轮问题接过去。
    const resolvesLeadWaiting =
      fresh.status === 'waiting_user' && (mentionedMembers.length === 0 || leadIsMentioned);
    if (resolvesLeadWaiting) {
      this.internals.db
        .prepare(
          `
          UPDATE conversation
          SET
            status = 'running',
            open_questions_json = '[]',
            updated_at = ?
          WHERE id = ?
          `,
        )
        .run(now(), conversation.id);
      this.internals.emit(conversation.id, {
        type: 'conversation.updated',
        data: this.getConversation(conversation.id),
      });
    }

    // @A @B @C 直接并行唤醒，不做隐式串行工作流：crash / retry /
    // partial completion 下串行链很难正确恢复。真要严格顺序用 Task 依赖表达。
    if (mentionedMembers.length > 0) {
      for (const member of mentionedMembers) {
        // muted 是明确的控制面设置，@mention 也不能绕过。
        if (this.internals.states.get(conversation.id, member.id).muted) continue;
        this.internals.scheduler.enqueue({
          conversationId: conversation.id,
          memberId: member.id,
          taskId: null,
          reason: 'user_mention',
          triggerSequence: created.messageSequence,
        });
        wakes.push({
          memberId: member.id,
          reason: 'user_mention',
          taskId: null,
          triggerSequence: created.messageSequence,
        });
      }
    } else if (fresh.leadMemberId) {
      // 没有明确点名：保持原来的 Lead-first 行为。
      // 唤醒原因按这条消息到达前的状态定：waiting_user 下的普通回答是澄清回复，
      // 阻塞里追问是恢复，其余是普通消息。翻转之后再看就看不出来了。
      const leadWakeReason =
        conversation.status === 'waiting_user'
          ? 'lead_clarification'
          : conversation.status === 'blocked'
            ? 'lead_recovery'
            : 'lead_message';
      const enqueued = this.internals.orchestrator.ensureLeadWake(
        conversation.id,
        fresh.leadMemberId,
        created.messageSequence,
        leadWakeReason,
      );
      if (enqueued) {
        wakes.push({
          memberId: fresh.leadMemberId,
          reason: leadWakeReason,
          taskId: null,
          triggerSequence: created.messageSequence,
        });
      }
    }

    return { message: created, wakes, deduplicated: false };
  }

  /**
   * 返回最近 limit 条消息，按 message_sequence 正序。
   *
   * 先 DESC 取尾部再反转：聊天场景要的是「最新 N 条」，不是「最旧 N 条」。
   * 排序用 message_sequence 而不是 created_at —— 同一毫秒内的多条消息
   * created_at 会打平，只有 sequence 是严格全序。
   */
  listMessages(conversationId: string, limit = 100): ConversationMessage[] {
    this.getConversation(conversationId);

    const rows = this.internals.db
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

    return this.withMessageFiles(rows.reverse().map(mapMessage));
  }

  /** 房间里每个 Member 的读游标 / 唤醒状态 / 未读数。 */
  listConversationState(conversationId: string): ConversationMemberState[] {
    const conversation = this.getConversation(conversationId);
    // 归档的成员也保留状态（历史事实），但 ensure 只对 roster 里的人做
    for (const member of conversation.members) this.internals.states.ensure(conversationId, member.id);
    return this.internals.states.list(conversationId);
  }

  /** 静音 / 解除静音。静音的 Member 不会被 dispatcher 唤醒（@ 也唤不醒）。 */
  setMemberMuted(conversationId: string, memberId: string, muted: boolean): ConversationMemberState {
    const conversation = this.getConversation(conversationId);
    this.internals.requireConversationMember(conversation, memberId);
    this.internals.states.ensure(conversationId, memberId);
    this.internals.states.setMuted(conversationId, memberId, muted);
    return this.internals.states.get(conversationId, memberId);
  }

  /**
   * 改 Goal：记一条不可变历史，旧版本未完成的任务全部 cancelled，
   * 活着的 execution 级联停掉（调用者自己的那轮除外），再唤醒 Lead 重新规划。
   *
   * actorType user = 人在 UI / API 上点的；member = Lead 调 update_goal 工具。
   * Lead 检查只对 member 做：user 走 HTTP 门禁，不走 Member 身份。
   */
  async updateGoal(input: {
    conversationId: string;
    actorType: 'user' | 'member' | 'system';
    actorId: string;
    executionId?: string | null;
    objective: string;
    requirements?: TaskRequirements;
    changeKind:
      | 'clarification'
      | 'scope_change'
      | 'success_criteria_change'
      | 'correction';
    reason?: string;
  }): Promise<{
    conversation: Conversation;
    revision: GoalRevision;
  }> {
    const conversation = this.getConversation(input.conversationId);
    if (input.actorType === 'member') {
      this.internals.requireActiveMember(conversation, input.actorId);
      if (conversation.leadMemberId !== input.actorId) {
        throw badRequest('只有 Lead 可以修改 Goal');
      }
    }

    const result = this.internals.tasks.reviseGoal({
      conversationId: conversation.id,
      objective: input.objective,
      requirements: input.requirements,
      changedByType: input.actorType,
      changedById: input.actorId,
      changeKind: input.changeKind,
      reason: input.reason,
    });

    for (const taskId of result.cancelledTaskIds) {
      this.internals.emit(conversation.id, {
        type: 'task.updated',
        data: this.internals.tasks.get(taskId),
      });
    }

    const handledExecutionIds = new Set<string>(result.executionIds);
    for (const executionId of result.executionIds) {
      if (executionId === input.executionId) continue;
      try {
        await this.internals.cancelExecutionTree(executionId);
      } catch {
        // Goal revision 已经提交。如果执行引擎已经收尾或 cancellation race，
        // 不能回滚 Goal —— 旧任务行已经是 cancelled，引擎侧自己收尾即可。
      }
    }

    if (input.actorType === 'user') {
      // Lead 自己的 execution 不属于任何 Task，不在 result.executionIds 里。
      // 用户改 Goal 时它可能正在 running：不先停掉，它会带着旧 Goal 跑完，
      // 还可能继续调工具。调用者自己的 execution 除外 —— Lead 调 update_goal
      // 工具时那一轮就是当前 turn，停掉等于自杀；那一轮由收尾的版本号守卫兜底。
      const active = this.internals.db
        .prepare(
          `SELECT id FROM execution
           WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_for_member')`,
        )
        .all(conversation.id) as Array<{ id: string }>;
      for (const row of active) {
        if (row.id === input.executionId || handledExecutionIds.has(row.id)) continue;
        try {
          await this.internals.cancelExecutionTree(row.id);
        } catch {
          // 同上：Goal 已提交，cancellation race 不能回滚。
        }
      }
    }

    const latest = this.getConversation(conversation.id);
    this.internals.emit(conversation.id, {
      type: 'conversation.updated',
      data: latest,
    });

    if (
      input.actorType === 'user' &&
      latest.leadMemberId
    ) {
      this.internals.orchestrator.ensureLeadWake(
        latest.id,
        latest.leadMemberId,
        latest.messageSequence,
        'goal_changed',
      );
    }

    return {
      conversation: latest,
      revision: result.revision,
    };
  }

  /** CoreToolHost：Lead 修改 Goal（update_goal 工具）。 */
  async updateGoalTool(input: {
    conversationId: string;
    memberId: string;
    executionId: string;
    objective: string;
    requirements?: TaskRequirements;
    changeKind:
      | 'clarification'
      | 'scope_change'
      | 'success_criteria_change'
      | 'correction';
    reason?: string;
  }): Promise<string> {
    const conversation = this.getConversation(input.conversationId);
    this.internals.requireActiveMember(conversation, input.memberId);
    if (conversation.leadMemberId !== input.memberId) {
      throw badRequest('只有 Lead 可以修改 Goal');
    }
    const result = await this.updateGoal({
      conversationId: conversation.id,
      actorType: 'member',
      actorId: input.memberId,
      executionId: input.executionId,
      objective: input.objective,
      requirements: input.requirements,
      changeKind: input.changeKind,
      reason: input.reason,
    });
    return `Goal 已更新为 v${result.revision.revision}。旧任务计划已失效，请继续调用 replan_tasks 创建新计划。`;
  }

  /**
   * 用户真正开始交互时，取消尚未完成的自动 bootstrap。
   *
   * bootstrap 是可丢弃的启动动作（“房间空着，Lead 先开口”），用户消息才是
   * 真正的工作输入：旧 Lead 那一轮带着 opener 跑完，只会往 Activity 里多写
   * 一条没人要的回复。分两步停 —— pending 的直接删，在跑的走正常取消。
   */
  private async cancelLeadBootstrap(conversation: Conversation): Promise<void> {
    const leadMemberId = conversation.leadMemberId;
    if (!leadMemberId) return;

    this.internals.scheduler.cancelPending(
      conversation.id,
      leadMemberId,
      (wake) => wake.reason === 'lead_bootstrap',
    );

    const active = this.internals.db
      .prepare(
        `SELECT id FROM execution
         WHERE conversation_id = ?
           AND member_id = ?
           AND wake_reason = 'lead_bootstrap'
           AND status IN ('queued', 'running', 'waiting_for_member')
         ORDER BY created_at DESC`,
      )
      .all(conversation.id, leadMemberId) as Array<{ id: string }>;
    for (const row of active) {
      try {
        await this.internals.cancelExecutionTree(row.id);
      } catch {
        // 用户消息已经提交；cancellation race 不应阻塞真正的用户消息。
      }
    }
  }

  private withMessageFiles(messages: ConversationMessage[]): ConversationMessage[] {
    if (!this.internals.conversationFiles || messages.length === 0) return messages;
    const byMessage = this.internals.conversationFiles.filesForMessages(messages.map((m) => m.id));
    return messages.map((message) => ({
      ...message,
      files: byMessage.get(message.id) ?? [],
    }));
  }

  /** Goal 版本历史（倒序）：v1 永不修改，只能往前加。 */
  listGoalRevisions(conversationId: string): GoalRevision[] {
    this.getConversation(conversationId);
    const rows = this.internals.db
      .prepare(
        `
        SELECT *
        FROM conversation_goal_revision
        WHERE conversation_id = ?
        ORDER BY revision DESC
        `,
      )
      .all(conversationId) as unknown as Array<{
        id: string;
        conversation_id: string;
        revision: number;
        objective: string;
        requirements_json: string;
        changed_by_type: 'user' | 'member' | 'system';
        changed_by_id: string;
        change_kind: GoalChangeKind;
        reason: string;
        created_at: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      revision: row.revision,
      objective: row.objective,
      requirements: parseRequirements(row.requirements_json),
      changedByType: row.changed_by_type,
      changedById: row.changed_by_id,
      changeKind: row.change_kind,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }
}
