import type { DatabaseSync } from 'node:sqlite';
import type { Conversation, ConversationMessage, Member } from './domain.js';
import type { SendMessageResult, TeamService } from './team-service.js';
import { badRequest } from './http-error.js';

/**
 * Member ↔ Member 的私聊（DM）。
 *
 * ── 为什么复用 `direct` 而不新增一个 kind ───────────────────────────────
 *
 * 一个 direct 房间有两种含义，靠 roster 大小区分：
 *
 *   1 个 Member  —— 用户 ↔ 该 Member
 *   2 个 Member  —— Member ↔ Member，没有用户参与
 *
 * 这样不需要动 `conversation.kind` 的 CHECK 约束（SQLite 改不了，只能重建表，
 * 而这张表被 6 张表 FK 引用），也不需要改 GroupDispatcher：DM 的每条消息都带
 * `targetMemberId`，dispatch 时会命中「显式收件人」分支（该分支在 kind 判断
 * **之前**），拿到 `reason = 'direct'`，且天然绕过静音过滤。
 *
 * `turnMode` 也就自然是对的值 —— runWake 里 `kind === 'group' ? 'discussion' : 'direct'`，
 * DM 拿到的是「你在跟一个人说话，必须回答」，而不是 group 的「你可以选择不发言」。
 *
 * ── 为什么 DM 里的回复不自动唤醒对方 ───────────────────────────────────
 *
 * 唤醒的唯一触发点是「**显式发一条 DM**」（本服务的 send / team.sendMemberMessage）。
 * Member 在自己的 turn 里发言后的自动派发，对 DM 房间是关闭的（见 team-service
 * 的 executeMemberTurn）。
 *
 * 否则 A 问 → B 答 → 唤醒 A → A 答 → 唤醒 B → ... 是一个没有终点的循环：
 * 没有人在旁边看着，两个 Member 会一直对话到把 token 烧完。断掉自动闭环之后，
 * DM 就是真正的异步消息 —— 对方回没回，由 inbox 的未读状态回答（lastSeenMessageSequence），
 * 想继续就再显式发一条。
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
  ) {}

  /**
   * 找 (a, b) 之间已有的 DM 房间。顺序无关：a↔b 和 b↔a 是同一个房间。
   *
   * 必须校验房间里**恰好**两个人：用户 ↔ Member 的单聊也是 `kind = 'direct'`，
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

    // title 显式写成双方，避免落到 createConversation 的默认值（非 group 时取
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

    const result = await this.team.sendMemberMessage({
      conversationId: conversation.id,
      fromMemberId: input.fromMemberId,
      targetMemberId: input.toMemberId,
      content,
    });

    return { ...result, conversation, peer };
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
