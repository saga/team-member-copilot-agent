import type { DatabaseSync } from 'node:sqlite';
import type { ConversationMessage, MemberRuntime } from './domain.js';

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
    /** 触发本次 turn 的 execution；它对应的那条 user message 要排除。 */
    currentExecutionId: string;
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

    const sharedMessages = messages.filter(
      (message) =>
        message.executionId !== input.currentExecutionId &&
        !(message.senderType === 'member' && message.senderId === input.runtime.memberId),
    );

    return {
      sharedMessages,
      consumedThroughSequence,
      prompt: this.buildPrompt(sharedMessages, input.currentPrompt),
    };
  }

  private buildPrompt(sharedMessages: ConversationMessage[], currentPrompt: string): string {
    if (sharedMessages.length === 0) {
      return ['Current task:', currentPrompt].join('\n');
    }

    const names = this.memberNames();
    const transcript = sharedMessages
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

    return [
      'Shared conversation context (new since your last turn):',
      '',
      transcript,
      '',
      'Current task:',
      currentPrompt,
    ].join('\n');
  }

  private memberNames(): Map<string, string> {
    const rows = this.db.prepare(`SELECT id, name FROM member`).all() as unknown as Array<{
      id: string;
      name: string;
    }>;
    return new Map(rows.map((row) => [row.id, row.name]));
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
