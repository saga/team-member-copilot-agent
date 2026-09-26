import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
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
 * 单轮注入量有上限（MAX_CONTEXT_MESSAGES / MAX_CONTEXT_CHARS）。没有上限时
 * 有一个很具体的事故：一个 Member 沉默很久之后第一次被唤醒，checkpoint 停在
 * 很久以前，整段房间历史被一次性灌进 prompt。截断的策略见 selectWindow()：
 * **保留最新的，明确说出略过了多少条**，而不是悄悄砍掉一截再假装读全了。
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
  /**
   * 因为超出上限而没有进 prompt 的更旧的消息条数。
   *
   * 它被显式带出来，是因为「截断」和「这一轮只看到这些」是两件事：不把它说
   * 出来，模型就会以为 transcript 就是房间的全部，据此下「没人提过这个」的结论。
   */
  elidedMessageCount: number;
  /** 被略过的那一段里最旧的序号，纯为排查（没有就是 null）。 */
  elidedFromSequence: number | null;
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
  client_request_id: string | null;
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
    /** conversation 挂了 Jira 工单时才带的引用；工单元数据本身在 Jira。 */
    work?: { issueKey: string } | null;
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
    //
    // 注意它取的是**读到的**最后一条，而不是注入窗口的最后一条：窗口是按大小
    // 截的，截法是保留最新的那些，所以两者在正常情况下重合；但即使不重合，
    // checkpoint 也必须是「这一轮真的处理到哪」——否则同一批消息每轮重放。
    const consumedThroughSequence =
      messages.length > 0
        ? messages[messages.length - 1].messageSequence
        : input.runtime.lastContextMessageSequence;

    const relevant = messages.filter((message) => {
      // 当前 runtime 自己产出的历史消息已经在 session history 里（assistant turn）
      if (message.senderType === 'member' && message.senderId === input.runtime.memberId) {
        return false;
      }
      // 讨论模式下触发消息**不**排除：它就是房间活动的最后一条，会被排进
      // transcript。direct / delegation 才把它单独拎出来当「当前消息 / 任务」。
      if (input.turnMode === 'discussion') return true;
      return message.messageSequence !== input.triggerMessageSequence;
    });

    const { included, elided } = selectWindow(
      relevant,
      config.maxContextMessages,
      config.maxContextChars,
    );

    return {
      sharedMessages: included,
      consumedThroughSequence,
      elidedMessageCount: elided.length,
      elidedFromSequence: elided.length > 0 ? elided[0].messageSequence : null,
      prompt: this.buildPrompt(included, elided.length, input),
    };
  }

  private buildPrompt(
    sharedMessages: ConversationMessage[],
    elidedCount: number,
    input: {
      conversation: Conversation;
      member: Member;
      turnMode: TurnMode;
      wakeReason: WakeReason | null;
      currentPrompt: string;
      work?: { issueKey: string } | null;
    },
  ): string {
    const sections: string[] = [];

    // 最小工作上下文：只给工单引用。标题/状态/负责人是 Jira 的数据，不复制，
    // Agent 要细节就调 jira_get_issue。
    if (input.work) {
      sections.push(`Current Jira Issue: ${input.work.issueKey}`);
    }

    if (input.turnMode === 'discussion') {
      sections.push(this.roomHeader(input.conversation, input.member));
    }

    if (sharedMessages.length > 0) {
      const header =
        input.turnMode === 'discussion'
          ? 'Room activity since you last read it:'
          : 'Shared conversation context (new since your last turn):';

      // 略过的部分必须说出来。不说的话，模型会把 transcript 当成房间的全部，
      // 然后给出「没有人提过 X」这种被截断本身制造出来的结论。
      const notice =
        elidedCount > 0
          ? `(${elidedCount} earlier message${elidedCount === 1 ? '' : 's'} in this room ` +
            `were omitted to stay within the context size limit. Only the most recent ` +
            `${sharedMessages.length} are shown. If something looks missing, say so ` +
            `instead of assuming it was never discussed.)`
          : '';

      sections.push(header, [notice, this.transcript(sharedMessages)].filter(Boolean).join('\n\n'));
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
 * 从新增消息里挑出这一轮真正注入的那一段。
 *
 * 规则只有一条：**从最新往前取**，取到条数或字符数上限为止。
 *
 * 为什么不从最旧往前取（也就是丢掉最新的那些）：那等于把「刚刚发生的讨论」
 * 换成「很久以前的讨论」，而被唤醒的原因恰恰是刚刚发生的事。丢掉最新的一条
 * 更荒谬 —— 触发消息在 discussion 模式下就在里面。
 *
 * 也不做「保留头 + 保留尾、中间省略」那种截法：模型看到的两段之间没有因果
 * 关系，比少看到一点更容易产生错误结论。
 *
 * 至少注入一条：一条都没有时，discussion 模式会对着空房间判断「要不要发言」，
 * 而它明明是被这条消息唤醒的。单条消息超长时也照注入 —— 上限是用来防事故的，
 * 不是用来把一轮变成空的。
 */
function selectWindow(
  messages: ConversationMessage[],
  maxMessages: number,
  maxChars: number,
): { included: ConversationMessage[]; elided: ConversationMessage[] } {
  if (messages.length === 0) return { included: [], elided: [] };

  const included: ConversationMessage[] = [];
  // 每条消息在 transcript 里还要带说话人和分隔符，按固定开销粗略计入
  const PER_MESSAGE_OVERHEAD = 32;
  let chars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = message.content.length + PER_MESSAGE_OVERHEAD;

    if (included.length > 0 && (included.length >= maxMessages || chars + cost > maxChars)) {
      break;
    }

    included.push(message);
    chars += cost;
  }

  included.reverse();
  return { included, elided: messages.slice(0, messages.length - included.length) };
}

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
    clientRequestId: row.client_request_id,
    content: row.content,
    executionId: row.execution_id,
    createdAt: row.created_at,
  };
}
