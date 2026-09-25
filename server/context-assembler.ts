import type { DatabaseSync } from 'node:sqlite';
import type {
  Conversation,
  ConversationMessage,
  Member,
  MemberRuntime,
  TurnMode,
  WakeReason,
} from './domain.js';
import { NO_REPLY_SENTINEL } from './member-decision.js';

/**
 * Conversation context 与 Copilot Session history 的职责划分：
 *
 *   Copilot Session      = 该 Member runtime 自己的对话历史（引擎侧）
 *   conversation_message = Team 共享历史
 *
 * 所以每轮**不能**再把「最近 N 条消息」整段塞给 Member —— 那会和 session
 * history 重复。正确做法是只注入「自该 runtime 上次运行以来新增的 shared
 * messages」，由 MemberRuntime.last_context_message_sequence 作为 checkpoint。
 *
 * 两类消息会被排除，因为它们已经在 session history 里：
 *   1. 触发本次 execution 的那条消息（它的内容就是 currentPrompt）
 *   2. 当前 runtime 自己产出的历史消息（即 session 里的 assistant turn）
 *
 * checkpoint 只在 turn 成功后才推进；失败时保持不变，让下一轮重新注入，
 * 宁可重复也不要丢上下文。
 *
 * prompt 的结尾按 TurnMode 分三种写法。**身份和房间上下文必须分开**：
 * 身份（role / style / memory）在 system prompt 里稳定不变，房间上下文每轮动态
 * 拼在 user prompt 里。把房间历史写进 persona 会让同一个 Member 在不同房间里
 * 表现出不同的「人格」。
 */

export interface MemberContext {
  /** 自上次运行以来新增、且当前 runtime 尚未看过的 shared messages（时间正序）。 */
  sharedMessages: ConversationMessage[];
  /** 本次读到的最大 message_sequence，成功后用它推进 checkpoint。 */
  consumedThroughSequence: number;
  /** 已拼好的 prompt。 */
  prompt: string;
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

export class ContextAssembler {
  constructor(private readonly db: DatabaseSync) {}

  assemble(input: {
    runtime: MemberRuntime;
    conversation: Conversation;
    member: Member;
    turnMode: TurnMode;
    /** delegation 没有触发消息，传 null。 */
    triggerMessageSequence: number | null;
    /** 为什么被唤醒；delegation 传 null。 */
    wakeReason: WakeReason | null;
    /** 本次要处理的内容（direct = 用户那条消息；discussion 只是提示；delegation = 任务）。 */
    currentPrompt: string;
  }): MemberContext {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_message
        WHERE conversation_id = ?
          AND message_sequence > ?
        ORDER BY message_sequence
        `,
      )
      .all(input.runtime.conversationId, input.runtime.lastContextMessageSequence) as unknown as
      MessageRow[];

    const messages = rows.map(mapMessage);
    // 水位线要覆盖「读到的全部消息」，包括被过滤掉的那两类：
    // 它们的内容确实已经进了 session history。
    const consumedThroughSequence =
      messages.length > 0
        ? messages[messages.length - 1].messageSequence
        : input.runtime.lastContextMessageSequence;

    const sharedMessages = messages.filter((message) => {
      // 当前 runtime 自己产出的历史消息已经在 session history 里（assistant turn）
      if (message.senderType === 'member' && message.senderId === input.runtime.memberId) {
        return false;
      }
      // 讨论模式下触发消息**不**排除：它就是房间活动的最后一条，会被排进
      // transcript。direct / delegation 才把它单独拎出来当「当前消息 / 任务」。
      if (input.turnMode === 'discussion') return true;
      return message.messageSequence !== input.triggerMessageSequence;
    });

    return {
      sharedMessages,
      consumedThroughSequence,
      prompt: this.buildPrompt(sharedMessages, input),
    };
  }

  private buildPrompt(
    sharedMessages: ConversationMessage[],
    input: {
      conversation: Conversation;
      member: Member;
      turnMode: TurnMode;
      wakeReason: WakeReason | null;
      currentPrompt: string;
    },
  ): string {
    const sections: string[] = [];

    if (input.turnMode === 'discussion') {
      sections.push(this.roomHeader(input.conversation, input.member));
    }

    if (sharedMessages.length > 0) {
      sections.push(
        input.turnMode === 'discussion'
          ? 'Room activity since you last read it:'
          : 'Shared conversation context (new since your last turn):',
        this.transcript(sharedMessages),
      );
    }

    if (input.turnMode === 'delegation') {
      sections.push('Task:', input.currentPrompt);
      return sections.join('\n\n');
    }

    if (input.turnMode === 'direct') {
      sections.push('Current message:', input.currentPrompt, DIRECT_INSTRUCTION);
      return sections.join('\n\n');
    }

    // discussion：触发消息已经在 transcript 里了，这里只说「轮到你判断」。
    sections.push(discussionInstruction(input.wakeReason));

    return sections.join('\n\n');
  }

  private roomHeader(conversation: Conversation, member: Member): string {
    const participants = conversation.members
      .map((item) => {
        const marker = item.id === member.id ? ' (you)' : '';
        const archived = item.status === 'active' ? '' : ' [archived]';
        return `- ${item.name} (@${item.handle})${marker}${archived}`;
      })
      .join('\n');

    return [
      `Room: ${conversation.title}`,
      `You are one participant in this group conversation, not the assistant of the whole room.`,
      'Participants:',
      participants,
    ].join('\n');
  }

  private transcript(messages: ConversationMessage[]): string {
    const names = this.memberNames();
    return messages
      .map((message) => {
        const actor =
          message.senderType === 'member'
            ? (names.get(message.senderId) ?? message.senderId)
            : message.senderType === 'user'
              ? 'User'
              : 'System';
        return `[${actor}] ${message.content}`;
      })
      .join('\n\n');
  }

  private memberNames(): Map<string, string> {
    const rows = this.db.prepare(`SELECT id, name FROM member`).all() as unknown as Array<{
      id: string;
      name: string;
    }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}

const DIRECT_INSTRUCTION = [
  'You are the designated responder in this conversation.',
  'Answer the message directly and concisely.',
].join('\n');

/**
 * group 房间里「要不要发言」的指令。
 *
 * 关键是把 skip 明确成**合法结果**，否则模型会为了「有问必答」而重复别人
 * 已经说过的话 —— 三个 Member 各说一遍同样的结论，是 group chat 最典型的失败形态。
 */
function discussionInstruction(reason: WakeReason | null): string {
  const mustReply = reason === 'direct' || reason === 'mention';

  if (mustReply) {
    return [
      'You were explicitly addressed, so you must respond.',
      'Do not restate what other participants already said — add what only you can add.',
      'Reply with your message directly. Keep it short.',
    ].join('\n');
  }

  return [
    'Decide whether you should contribute to this room right now.',
    '',
    `- If you have something genuinely useful that is not already covered, reply with it directly.`,
    `- If the room already covers your view, or you have nothing to add, reply with exactly: ${NO_REPLY_SENTINEL}`,
    '',
    `Do not summarize the discussion. Do not agree for the sake of it. ${NO_REPLY_SENTINEL} is a valid and expected answer.`,
  ].join('\n');
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
