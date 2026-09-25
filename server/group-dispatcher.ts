import type { DatabaseSync } from 'node:sqlite';
import type { Conversation, ConversationMessage, Member, WakeReason } from './domain.js';
import type { ConversationMemberService } from './conversation-member-service.js';

/**
 * Group Dispatcher：一条新消息落库后，决定**哪些 Member 需要被唤醒**。
 *
 * 这里是确定性规则，不是 LLM routing。第一版刻意不上模型决策：
 * 「谁该接这个问题」用代码回答得了，就不该引入一层概率性判断。
 *
 * 规则：
 *
 *   direct / work   → 房间里的那一个 Member（显式 targetMemberId 优先）
 *   group + @mention → 被 @ 到的 active 成员
 *   group + 无 mention
 *     用户发的     → 所有 active 且未静音的成员（open discussion）
 *     Member 发的  → 同上，但受 groupAutoWakeRounds 限制（follow_up）
 *
 * 三条边界值得单独说：
 *
 * 1. **作者不会被自己的消息唤醒。** 否则 Member 一发言就把自己再唤醒一次。
 * 2. **member 消息的自动唤醒有上限。** A 发言 → 唤醒 B → B 发言 → 唤醒 A → …
 *    是个没有天然终点的循环，会一直烧 token。用户消息重置计数；连续 N 条
 *    member 消息之后，只有 @mention 还能唤醒别人（mention 永远有效）。
 * 3. **@ 了但没匹配到人时，不广播。** 用户明确想找某个人，把消息广播给全员
 *    是更糟的误解。这里返回 unresolvedMentions，由 API 如实告诉调用方。
 */
export class GroupDispatcher {
  constructor(
    private readonly db: DatabaseSync,
    private readonly states: ConversationMemberService,
    private readonly autoWakeRounds: number,
  ) {}

  plan(input: {
    conversation: Conversation;
    message: ConversationMessage;
    /** 消息作者（如果是某个 Member）—— 它不该被自己的消息唤醒。 */
    authorMemberId?: string;
  }): DispatchPlan {
    const { conversation, message } = input;
    const active = conversation.members.filter((member) => member.status === 'active');

    if (active.length === 0) return { wakes: [], unresolvedMentions: [] };

    // 显式 targetMemberId（API 调用方指定的收件人）等价于一次 mention。
    if (message.targetMemberId) {
      const target = active.find((member) => member.id === message.targetMemberId);
      if (target) {
        return {
          wakes: [{ memberId: target.id, reason: 'direct', triggerSequence: message.messageSequence }],
          unresolvedMentions: [],
        };
      }
    }

    if (conversation.kind !== 'group') {
      // direct / work：房间里只有一个成员，消息就是给它的。
      const sole = active[0];
      if (sole.id === input.authorMemberId) return { wakes: [], unresolvedMentions: [] };
      return {
        wakes: [{ memberId: sole.id, reason: 'direct', triggerSequence: message.messageSequence }],
        unresolvedMentions: [],
      };
    }

    const { matched, unresolved } = resolveMentions(message.content, active);

    if (matched.length > 0) {
      return {
        wakes: matched
          .filter((member) => !this.states.get(conversation.id, member.id).muted)
          .filter((member) => member.id !== input.authorMemberId)
          .map((member) => ({
            memberId: member.id,
            reason: 'mention' as WakeReason,
            triggerSequence: message.messageSequence,
          })),
        unresolvedMentions: unresolved,
      };
    }

    // 提到了人但一个都没匹配上 —— 不广播，交给调用方提示。
    if (unresolved.length > 0) return { wakes: [], unresolvedMentions: unresolved };

    const reason: WakeReason = message.senderType === 'member' ? 'follow_up' : 'open_discussion';

    // member 消息的自动唤醒有轮次上限；超了就只有 @mention 能唤醒人。
    if (reason === 'follow_up' && this.consecutiveMemberMessages(conversation.id) > this.autoWakeRounds) {
      return { wakes: [], unresolvedMentions: [] };
    }

    const wakes: WakePlan[] = active
      .filter((member) => member.id !== input.authorMemberId)
      .filter((member) => !this.states.get(conversation.id, member.id).muted)
      // 已经读过这条消息的成员不需要再被唤醒（coalescing 的最后一道闸）。
      .filter(
        (member) =>
          this.states.get(conversation.id, member.id).lastSeenMessageSequence <
          message.messageSequence,
      )
      .map((member) => ({
        memberId: member.id,
        reason,
        triggerSequence: message.messageSequence,
      }));

    return { wakes, unresolvedMentions: [] };
  }

  /**
   * 从最新往前数，连续有多少条消息是 Member 发的。
   *
   * 用「数一下尾部连续段」而不是存一个计数器：没有额外状态，重启后依然正确。
   * 只取 autoWakeRounds + 1 条就够了（只要判断「是否超过上限」）。
   */
  private consecutiveMemberMessages(conversationId: string): number {
    const rows = this.db
      .prepare(
        `
        SELECT sender_type
        FROM conversation_message
        WHERE conversation_id = ?
        ORDER BY message_sequence DESC
        LIMIT ?
        `,
      )
      .all(conversationId, this.autoWakeRounds + 1) as unknown as Array<{
      sender_type: string;
    }>;

    let count = 0;
    for (const row of rows) {
      if (row.sender_type !== 'member') break;
      count += 1;
    }
    return count;
  }
}

export interface WakePlan {
  memberId: string;
  reason: WakeReason;
  triggerSequence: number;
}

export interface DispatchPlan {
  wakes: WakePlan[];
  /** 消息里 @ 了但不属于这个房间的 handle / name（原样回传，供 UI 提示）。 */
  unresolvedMentions: string[];
}

/**
 * `@` 后面允许的字符：非空白、非标点。
 *
 * 刻意不写 `[a-zA-Z0-9_-]+` —— Member 的 name 可以带空格和中文，
 * `@Alice Chen` / `@张三` 都得认。
 */
const MENTION_PATTERN = /@([^\s@,，。；;：:！!？?、()（）[\]【】<>《》"'`]+)/g;

/**
 * 把消息里的 @ 解析成 Member。
 *
 * 匹配顺序（都是大小写不敏感的确定性比较）：
 *   1. handle 全等          @alice      → handle "alice"
 *   2. name 全等            @Alice Chen → name "Alice Chen"
 *   3. name 去掉空格后全等  @AliceChen  → name "Alice Chen"
 *
 * 同一个 Member 被多次 @ 只算一次。返回的 `unresolved` 是没匹配上的原文。
 */
export function resolveMentions(
  content: string,
  members: Member[],
): { matched: Member[]; unresolved: string[] } {
  const matched = new Map<string, Member>();
  const unresolved: string[] = [];

  const index = members.map((member) => ({
    member,
    keys: [member.handle, member.name, member.name.replace(/\s+/g, '')]
      .map((key) => key.trim().toLowerCase())
      .filter(Boolean),
  }));

  for (const match of content.matchAll(MENTION_PATTERN)) {
    const raw = match[1];
    const token = raw.toLowerCase();

    const hit = index.find((entry) => entry.keys.includes(token));
    if (hit) {
      matched.set(hit.member.id, hit.member);
      continue;
    }

    // `@AliceChen` 这种把 name 的空格去掉的写法：取最长匹配，避免
    // 「Alice」把「Alice Chen」的前缀吃掉（同名前缀的两个 Member 也能区分）。
    const prefixHit = index
      .filter((entry) => entry.keys.some((key) => token.startsWith(key)))
      .sort((a, b) => longestKey(b) - longestKey(a))[0];
    if (prefixHit) {
      matched.set(prefixHit.member.id, prefixHit.member);
      continue;
    }

    unresolved.push(raw);
  }

  return { matched: [...matched.values()], unresolved: [...new Set(unresolved)] };
}

function longestKey(entry: { keys: string[] }): number {
  return entry.keys.reduce((max, key) => Math.max(max, key.length), 0);
}
