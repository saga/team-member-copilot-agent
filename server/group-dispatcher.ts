import type {
  Conversation,
  ConversationMessage,
  Member,
  WakeReason,
} from './domain.js';
import type { ConversationMemberService } from './conversation-member-service.js';

/**
 * Group Dispatcher 只负责确定性收件人选择。
 *
 * 规则：
 *
 * direct / work
 *   -> 唯一 Member
 *
 * group + targetMemberId
 *   -> 指定 Member
 *
 * group + @mention
 *   -> 被 @ 的 Member
 *
 * group + 无 mention
 *   -> 用户消息：Everyone
 *   -> Member 消息：不自动唤醒任何人
 *
 * Member 之间的后续协作只能显式使用：
 *   message_member
 *   ask_member
 *
 * 不做自动 follow-up / open discussion / round limit / lead fallback。
 */
export class GroupDispatcher {
  constructor(
    private readonly states: ConversationMemberService,
  ) {}

  plan(input: {
    conversation: Conversation;
    message: ConversationMessage;
    authorMemberId?: string;
  }): DispatchPlan {
    const { conversation, message, authorMemberId } = input;

    const active = conversation.members.filter(
      (member) => member.status === 'active',
    );

    if (active.length === 0) {
      return {
        wakes: [],
        unresolvedMentions: [],
      };
    }

    // API 明确指定 targetMemberId。
    if (message.targetMemberId) {
      const target = active.find(
        (member) => member.id === message.targetMemberId,
      );

      if (!target) {
        return {
          wakes: [],
          unresolvedMentions: [],
        };
      }

      if (target.id === authorMemberId) {
        return {
          wakes: [],
          unresolvedMentions: [],
        };
      }

      if (this.states.get(conversation.id, target.id).muted) {
        return {
          wakes: [],
          unresolvedMentions: [],
        };
      }

      return {
        wakes: [
          {
            memberId: target.id,
            reason: 'direct',
            triggerSequence: message.messageSequence,
          },
        ],
        unresolvedMentions: [],
      };
    }

    // direct / work：只有一个 Member。
    if (conversation.kind !== 'group') {
      const target = active[0];

      if (!target || target.id === authorMemberId) {
        return {
          wakes: [],
          unresolvedMentions: [],
        };
      }

      if (this.states.get(conversation.id, target.id).muted) {
        return {
          wakes: [],
          unresolvedMentions: [],
        };
      }

      return {
        wakes: [
          {
            memberId: target.id,
            reason: 'direct',
            triggerSequence: message.messageSequence,
          },
        ],
        unresolvedMentions: [],
      };
    }

    // group：先处理 @mention。
    const { matched, unresolved } = resolveMentions(
      message.content,
      active,
    );

    if (matched.length > 0) {
      const targets = matched
        .filter((member) => member.id !== authorMemberId)
        .filter(
          (member) =>
            !this.states.get(conversation.id, member.id).muted,
        );

      return {
        wakes: targets.map((member) => ({
          memberId: member.id,
          reason: 'mention',
          triggerSequence: message.messageSequence,
        })),
        unresolvedMentions: unresolved,
      };
    }

    // 明确 @ 了不存在的人，不广播。
    if (unresolved.length > 0) {
      return {
        wakes: [],
        unresolvedMentions: unresolved,
      };
    }

    // Member 发言，不自动接龙。
    if (message.senderType === 'member') {
      return {
        wakes: [],
        unresolvedMentions: [],
      };
    }

    // 用户没有 @，就是 Everyone。
    const targets = active
      .filter((member) => member.id !== authorMemberId)
      .filter(
        (member) =>
          !this.states.get(conversation.id, member.id).muted,
      )
      .filter(
        (member) =>
          this.states.get(conversation.id, member.id)
            .lastSeenMessageSequence <
          message.messageSequence,
      );

    return {
      wakes: targets.map((member) => ({
        memberId: member.id,
        reason: 'everyone',
        triggerSequence: message.messageSequence,
      })),
      unresolvedMentions: [],
    };
  }
}

export interface WakePlan {
  memberId: string;
  reason: Exclude<WakeReason, 'schedule'>;
  triggerSequence: number;
}

export interface DispatchPlan {
  wakes: WakePlan[];
  unresolvedMentions: string[];
}

const MENTION_PATTERN =
  /@([^\s@,，。；;：:！!？?、()（）[\]【】<>《》"'`]+)/g;

export function resolveMentions(
  content: string,
  members: Member[],
): {
  matched: Member[];
  unresolved: string[];
} {
  const matched = new Map<string, Member>();
  const unresolved: string[] = [];

  const byHandle = new Map<string, Member>();
  const byName = new Map<string, Member>();

  for (const member of members) {
    const handle = member.handle.trim().toLowerCase();

    if (handle && !byHandle.has(handle)) {
      byHandle.set(handle, member);
    }

    for (const key of [
      member.name,
      member.name.replace(/\s+/g, ''),
    ]) {
      const normalized = key.trim().toLowerCase();

      if (normalized && !byName.has(normalized)) {
        byName.set(normalized, member);
      }
    }
  }

  for (const match of content.matchAll(MENTION_PATTERN)) {
    const raw = match[1];
    const token = raw.toLowerCase();

    const hit = byHandle.get(token) ?? byName.get(token);

    if (hit) {
      matched.set(hit.id, hit);
    } else {
      unresolved.push(raw);
    }
  }

  return {
    matched: [...matched.values()],
    unresolved: [...new Set(unresolved)],
  };
}
