import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Conversation, ConversationMessage, Member, PendingWake } from './domain.js';
import type { SendMessageResult, TeamService, WakePlan } from './team-service.js';
import { now } from './db.js';
import { badRequest } from './http-error.js';
import type { TeamInternals } from './team-internals.js';

/**
 * Member ↔ Member 的私聊（DM）。
 *
 * direct 只剩一种含义：两个 Member 的私聊，没有用户参与。
 * 用户的工作统一走 Task 工作区，不再有用户 ↔ 单个 Member 的单聊房间。
 *
 * 唤醒的唯一触发点是「**显式发一条 DM**」（本服务的 send / team.sendMemberMessage）。
 * 否则 A 问 → B 答 → 唤醒 A → A 答 → 唤醒 B → ... 是一个没有终点的循环。
 */

/** 两个 Member 的 direct 房间 = Member 私聊（没有用户参与）。 */
export function isMemberDm(conversation: Conversation): boolean {
  return conversation.kind === 'direct' && conversation.members.length === 2;
}

/** 用户 ↔ 单个 Member 的 direct 房间。UI 上「点某个 Member 的 Chat」找的是这个。 */
export function isUserDirect(conversation: Conversation): boolean {
  return conversation.kind === 'direct' && conversation.members.length === 1;
}

export interface MemberDirectMessage {
  conversation: Conversation;
  /** 对话的另一方。 */
  peer: Member;
  lastMessage: ConversationMessage | null;
  /** 从 `memberId` 的视角看，还没读到的消息数。 */
  unread: number;
}

export class MemberConversationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly team: TeamService,
    private readonly getInternals: () => TeamInternals,
  ) {}

  /** buildInternals 捕获本服务，早于 internals 就绪只能晚绑定（SchedulerService 同款）。 */
  private get internals(): TeamInternals {
    return this.getInternals();
  }

  /**
   * 找 (a, b) 之间已有的 DM 房间。顺序无关：a↔b 和 b↔a 是同一个房间。
   *
   * 必须校验房间里**恰好**两个人：direct 只允许两个成员，
   * 但 roster 只有一个人，不能把它当成 DM。
   */
  find(a: string, b: string): Conversation | null {
    const row = this.db
      .prepare(
        `
        SELECT c.id
        FROM conversation c
        JOIN conversation_member me
          ON me.conversation_id = c.id AND me.member_id = ?
        JOIN conversation_member peer
          ON peer.conversation_id = c.id AND peer.member_id = ?
        WHERE c.kind = 'direct'
          AND (
            SELECT COUNT(*)
            FROM conversation_member cm
            WHERE cm.conversation_id = c.id
          ) = 2
        ORDER BY c.created_at
        LIMIT 1
        `,
      )
      .get(a, b) as unknown as { id: string } | undefined;

    return row ? this.team.getConversation(row.id) : null;
  }

  /**
   * 拿到 (a, b) 的 DM 房间，没有就建一个。
   *
   * 「查 → 建」之间没有 await，且 node:sqlite 是同步 API，所以整段是一个不可
   * 分割的同步块：两个 Member 同时给对方发第一条消息时，只会有一个人真的建出房间。
   * （和 delegation 的「检测 → 建 child」同理。）
   */
  open(a: string, b: string): Conversation {
    if (a === b) throw badRequest('Member 不能和自己建立私聊');

    const from = this.team.getMember(a);
    const to = this.team.getMember(b);
    if (from.status !== 'active' || to.status !== 'active') {
      throw badRequest('归档的 Member 不能建立新的私聊');
    }

    const existing = this.find(a, b);
    if (existing) return existing;

    // title 显式写成双方，避免落到 createConversation 的默认值（取
    // members[0].name）—— 那会让人分不清这是「和 Alice 单聊」还是「Alice 和 Bob 在聊」。
    return this.team.createConversation({
      kind: 'direct',
      title: `${from.name} · ${to.name}`,
      memberIds: [from.id, to.id],
    });
  }

  /**
   * 以 `fromMemberId` 的身份给 `toMemberId` 发一条消息。
   *
   * 房间不存在就建 —— 对调用方（Member 的 message_member tool / REST）来说，
   * 「找到人并说话」是一步，不该暴露「先开房间再发消息」两段式。
   */
  async send(input: {
    fromMemberId: string;
    toMemberId: string;
    content: string;
  }): Promise<SendMessageResult & { conversation: Conversation; peer: Member }> {
    // 先校验内容，再建房间：空消息不该留下一个空房间。
    const content = input.content.trim();
    if (!content) throw badRequest('消息内容不能为空');

    const conversation = this.open(input.fromMemberId, input.toMemberId);
    const peer = this.team.getMember(input.toMemberId);

    const result = await this.sendMemberMessage({
      conversationId: conversation.id,
      fromMemberId: input.fromMemberId,
      targetMemberId: input.toMemberId,
      content,
    });

    return { ...result, conversation, peer };
  }

  /**
   * 以某个 Member 的身份发一条消息 —— Member ↔ Member 私聊的写入路径。
   *
   * 私聊直接唤醒对端，不经过任何 dispatcher。
   *
   * 刻意不复用 delegateMember：那条路是**阻塞**的（父 execution 进
   * waiting_for_member，一直等到子 execution 跑完并返回结果），适合 ask_member
   * 的「我必须拿到答案才能继续」。DM 是一条消息，发出去就该返回。
   */
  async sendMemberMessage(input: {
    conversationId: string;
    fromMemberId: string;
    targetMemberId: string;
    content: string;
  }): Promise<SendMessageResult> {
    const conversation = this.internals.getConversation(input.conversationId);
    const content = input.content.trim();
    if (!content) throw badRequest('消息内容不能为空');

    const from = this.internals.requireActiveMember(conversation, input.fromMemberId);
    const target = this.internals.requireActiveMember(conversation, input.targetMemberId);
    if (from.id === target.id) throw badRequest('不能给自己发消息');

    const message: ConversationMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      messageSequence: this.internals.nextMessageSequence(conversation.id),
      senderType: 'member',
      senderId: from.id,
      replyToMessageId: null,
      taskId: null,
      // DM 是「发出去就该返回」的一条消息，没有重试语义，也就不需要幂等键
      clientRequestId: null,
      content,
      executionId: null,
      files: [],
      createdAt: now(),
    };

    this.internals.insertMessage(message);
    this.internals.touchConversation(conversation.id);
    this.internals.emit(conversation.id, { type: 'message.created', data: message });

    // 私聊直接唤醒对端，不经过任何 dispatcher。忙也不丢：scheduler 自己负责
    // idle → 立即执行、busy → pending、pending → coalesce。
    // 私聊是 member_message，不是 Lead turn：对端按自己的 Member 身份回话。
    const state = this.internals.states.get(conversation.id, target.id);
    const wakes: WakePlan[] = [];
    if (!state.muted) {
      const wake: PendingWake = {
        conversationId: conversation.id,
        memberId: target.id,
        taskId: null,
        reason: 'member_message',
        triggerSequence: message.messageSequence,
      };
      this.internals.scheduler.enqueue(wake);
      wakes.push({ memberId: target.id, reason: 'member_message', taskId: null, triggerSequence: message.messageSequence });
    }

    return {
      message,
      wakes,
      deduplicated: false,
    };
  }

  /** 某个 Member 参与的全部 DM，按房间最后活动时间倒序。 */
  list(memberId: string): MemberDirectMessage[] {
    this.team.getMember(memberId);

    const rows = this.db
      .prepare(
        `
        SELECT c.id
        FROM conversation c
        JOIN conversation_member me
          ON me.conversation_id = c.id AND me.member_id = ?
        WHERE c.kind = 'direct'
          AND (
            SELECT COUNT(*)
            FROM conversation_member cm
            WHERE cm.conversation_id = c.id
          ) = 2
        ORDER BY c.updated_at DESC
        `,
      )
      .all(memberId) as unknown as Array<{ id: string }>;

    return rows.map((row) => {
      const conversation = this.team.getConversation(row.id);
      const peer = conversation.members.find((member) => member.id !== memberId);
      if (!peer) throw badRequest(`conversation ${row.id} 不是合法的 Member 私聊`);

      return {
        conversation,
        peer,
        lastMessage: this.team.listMessages(conversation.id, 1)[0] ?? null,
        unread: this.unreadCount(conversation.id, memberId),
      };
    });
  }

  private unreadCount(conversationId: string, memberId: string): number {
    const state = this.db
      .prepare(
        `
        SELECT last_seen_message_sequence
        FROM conversation_member_state
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(conversationId, memberId) as unknown as
      | { last_seen_message_sequence: number }
      | undefined;

    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM conversation_message
        WHERE conversation_id = ?
          AND message_sequence > ?
        `,
      )
      .get(conversationId, state?.last_seen_message_sequence ?? 0) as unknown as { n: number };

    return row.n;
  }
}
