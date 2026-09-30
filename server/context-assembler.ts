import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import type {
  Conversation,
  ConversationMessage,
  ConversationTask,
  Member,
  MemberRuntime,
  TurnMode,
  WakeReason,
} from './domain.js';


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
  reply_to_message_id: string | null;
  task_id: string | null;
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
    /** 本次要处理的内容（lead = 用户那条消息；task = 任务描述；delegation = 任务）。 */
    currentPrompt: string;
    currentTask?: ConversationTask | null;
    tasks?: ConversationTask[];
    memberNames?: Map<string, string>;
    /**
     * 这间房间挂了外部工作（Jira 工单）时才带的引用。
     *
     * 只有 provider / key / url 三样 —— 工单的标题、状态、负责人不在这里，
     * 它们是外部系统的数据。要细节就调 jira_get_issue。
     */
    work?: { provider: string; key: string; url: string | null } | null;
    /**
     * 触发这条 turn 的消息引用的会话文件。
     *
     * 只列名字，不插正文：原文件已经作为 attachment 交给引擎了，把它再抄一份
     * 进 prompt 是同一份内容付两次 token。列出来的作用是**说清楚这一轮该看
     * 什么** —— 房间里的其它文件是搜索的结果，不是默认上下文。
     */
    referencedFiles?: Array<{ originalName: string }>;
    /**
     * 这个 Member 的持久 session 是**新建的**：它里面一条历史都没有。
     *
     * 两件事一起变：
     *
     *   1. checkpoint 失效。`lastContextMessageSequence` 记的是「旧 session
     *      已经看过哪条消息」，而新 session 一条都没看过 —— 从它往后读，
     *      checkpoint 之前那段历史就悄悄没了。所以从 0 读。
     *   2. 自己发过的消息不能再过滤。那条过滤的前提是「它们已经在 session
     *      history 里」，新 session 里没有，滤掉就等于这个人看不到自己之前
     *      说过什么。
     */
    freshSession?: boolean;
  }): MemberContext {
    const checkpoint = input.freshSession ? 0 : input.runtime.lastContextMessageSequence;
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
      .all(input.runtime.conversationId, checkpoint) as unknown as MessageRow[];

    const messages = rows.map(mapMessage);
    // 独立分析的 Task（independentContext）与 delegation 不读共享房间记录：
    // 第二意见不能先被第一意见锚定。delegation 只拿 task 包里的结构化事实。
    const isolatedTask =
      input.turnMode === 'delegation' ||
      (input.turnMode === 'task' && input.currentTask?.independentContext === true);

    // 水位线要覆盖「读到的全部消息」，包括被过滤掉的那两类：
    // 它们的内容确实已经进了 session history。
    //
    // 注意它取的是**读到的**最后一条，而不是注入窗口的最后一条：窗口是按大小
    // 截的，截法是保留最新的那些，所以两者在正常情况下重合；但即使不重合，
    // checkpoint 也必须是「这一轮真的处理到哪」——否则同一批消息每轮重放。
    //
    // 独立 Task 例外：没读过的消息不能标成已消费，否则等于把没看过的房间
    // 记录悄悄丢掉，水位线只会单调吞掉它们。
    const consumedThroughSequence = isolatedTask
      ? input.runtime.lastContextMessageSequence
      : messages.length > 0
        ? messages[messages.length - 1].messageSequence
        : checkpoint;

    const relevant = isolatedTask
      ? []
      : messages.filter((message) => {
          // 当前 runtime 自己产出的历史消息已经在 session history 里（assistant turn）。
          // 全新 session 例外：它里面没有，滤掉就丢了。
          if (
            !input.freshSession &&
            message.senderType === 'member' &&
            message.senderId === input.runtime.memberId
          ) {
            return false;
          }
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
    /** mention chain 绑定到哪条 User message（找前序回答用，其它模式忽略）。 */
    triggerMessageSequence: number | null;
    currentPrompt: string;
    currentTask?: ConversationTask | null;
      tasks?: ConversationTask[];
      work?: { provider: string; key: string; url: string | null } | null;
      referencedFiles?: Array<{ originalName: string }>;
    },
  ): string {
    const sections: string[] = [];

    // 最小工作上下文：只给引用 + 深链。标题/状态/负责人是外部系统的数据，
    // 不复制也不复述 —— Agent 要细节就调 jira_get_issue。
    if (input.work) {
      sections.push(
        [
          `Current work item: ${input.work.key} (${input.work.provider})`,
          input.work.url ? `Link: ${input.work.url}` : '',
          'Its title, status and assignee live in the external system, not here. ' +
            'Use the jira_* tools if you need them.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    sections.push(this.workspaceHeader(input.conversation, input.member, input.tasks ?? [], input.currentTask ?? null));

    const referenced = input.referencedFiles ?? [];
    if (referenced.length > 0) {
      sections.push(
        [
          'Files attached to the current message:',
          ...referenced.map((file) => `- ${file.originalName}`),
          'Read them directly. Other files shared in this room are NOT part of this ' +
            'message — use search_conversation_files / open_conversation_file if you ' +
            'need them, and cite a file by its name when you rely on it.',
        ].join('\n'),
      );
    }

    if (sharedMessages.length > 0) {
      const header = 'Recent relevant updates (new since your last turn):';

      // 略过的部分必须说出来。不说的话，模型会把 transcript 当成房间的全部，
      // 然后给出「没有人提过 X」这种被截断本身制造出来的结论。
      //
      // 这里的措辞刻意把三件事分开讲清楚：
      //   · 这是**有界的窗口**，不是房间的全部 —— 省略是设计，不是事故；
      //   · Goal / Task status / approvals 是**结构化事实**，不受这个截断影响，
      //     所以它们比「从消息里推断出来的东西」更可信；
      //   · 省略 ≠ 没发生过。缺细节时去取或去问，而不是假设不存在。
      // 最后一条是这个 notice 存在的全部理由：截断本身会制造「从没人提过」的
      // 假结论，而模型不会自己意识到它看到的是残缺的。
      const notice =
        elidedCount > 0
          ? `(This is a bounded window of the shared room history: ${elidedCount} earlier ` +
            `message${elidedCount === 1 ? '' : 's'} in this room were omitted because the ` +
            `shared-room context is bounded, and only the most recent ` +
            `${sharedMessages.length} are shown. The Goal, Task status, and approvals are ` +
            `tracked as structured facts and are authoritative — they are not affected by ` +
            `this truncation, so trust them over anything you might infer from the ` +
            `messages below. Do not treat omitted history as evidence that something was ` +
            `never discussed: if an older detail matters, retrieve it (e.g. search the ` +
            `room or its files) or ask, instead of assuming it does not exist.)`
          : '';

      sections.push(header, [notice, this.transcript(sharedMessages)].filter(Boolean).join('\n\n'));
    }

    if (input.turnMode === 'delegation') {
      sections.push('Task:', input.currentPrompt);
      return sections.join('\n\n');
    }

    if (input.turnMode === 'task') {
      sections.push('User message:', input.currentPrompt, TASK_INSTRUCTION);
      return sections.join('\n\n');
    }

    if (input.turnMode === 'mention') {
      sections.push('User message:', input.currentPrompt, MEMBER_MENTION_INSTRUCTION);
      return sections.join('\n\n');
    }

    // 私聊回话：按自己的 Member 身份直接回对端。绝不能拿 Lead 的指令
    // （“你是这个工作区的 Lead”“缺信息就问用户”），否则私聊对端会
    // 开始协调一个它根本不负责的工作区。
    if (input.turnMode === 'member_message') {
      sections.push('User message:', input.currentPrompt, MEMBER_DM_INSTRUCTION);
      return sections.join('\n\n');
    }

    sections.push('User message:', input.currentPrompt, LEAD_INSTRUCTION);
    return sections.join('\n\n');
  }

  private workspaceHeader(
    conversation: Conversation,
    member: Member,
    tasks: ConversationTask[],
    currentTask: ConversationTask | null,
  ): string {
    const lines: string[] = [
      `Current task workspace: ${conversation.title}`,
      `Goal revision: v${conversation.goalRevision}`,
      `Objective: ${conversation.objective || '(not yet defined)'}`,
      `Status: ${conversation.status}`,
    ];
    if (conversation.requirements.successCriteria.length > 0) {
      lines.push(`Success criteria: ${conversation.requirements.successCriteria.join('; ')}`);
    }
    if (conversation.requirements.constraints.length > 0) {
      lines.push(`Constraints: ${conversation.requirements.constraints.join('; ')}`);
    }
    if (conversation.openQuestions.length > 0) {
      lines.push(`Open questions: ${conversation.openQuestions.join('; ')}`);
    }
    if (tasks.length > 0) {
      const names = this.memberNames();
      lines.push(
        'Current tasks:',
        ...tasks.map((task) => {
          const marker = task.id === currentTask?.id ? '>> ' : '';
          const name = names.get(task.assigneeMemberId) ?? task.assigneeMemberId;
          return `${marker}[${task.status}] ${task.title} — ${name}`;
        }),
      );
    }
    if (currentTask) {
      lines.push(
        `Your assigned task: ${currentTask.title}`,
        `Description: ${currentTask.description || '(none)'}`,
        currentTask.acceptanceCriteria.length > 0
          ? `Acceptance criteria: ${currentTask.acceptanceCriteria.join('; ')}`
          : '',
      );
    }
    void member;
    return lines.filter(Boolean).join('\n');
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
        // 历史消息的附件这里不标注：ContextAssembler 只读消息文本，附件归
        // ConversationFileService。这一轮该看哪些文件由 referencedFiles 说清楚，
        // 更早的文件用 search_conversation_files 找。
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

const MEMBER_MENTION_INSTRUCTION = [
  'You were directly addressed by the user.',
  'Answer independently from your assigned role, available capabilities, and evidence.',
  '',
  'Other Members may provide different answers.',
  'Do not treat another Member conclusion as evidence.',
  'Do not anchor on another Member conclusion unless the user explicitly asks for a comparison or review.',
  'Focus on your own analysis and the evidence available to you.',
  '',
  'DIRECT RESPONSE:',
  'Answer the user directly.',
  'Do not act as the coordinator unless explicitly asked.',
  'Do not create or re-plan the workspace task plan.',
].join('\n');

const MEMBER_DM_INSTRUCTION = [
  'You are replying in a direct conversation with another Member.',
  'Answer directly from your own role, expertise, and available capabilities.',
  'Do not act as a coordinator: you are not the Lead of any workspace here.',
  'Do not create or re-plan any task plan.',
  'Keep the answer focused on what the other Member asked.',
].join('\n');

const LEAD_INSTRUCTION = [
  'You are the Lead of this task workspace.',
  'Your job is to advance the work toward completion.',
  'Do not chat socially. Do not repeat known information. Do not ask unnecessary questions.',
  '',
  'WORK INTAKE:',
  'First understand the actual objective and the current state of the workspace.',
  'Use request_clarification when materially missing information prevents correct execution.',
  'Ask at most 3 questions at a time.',
  'Do not invent critical requirements when the user or external work item does not provide them.',
  '',
  'JIRA / EXTERNAL WORK:',
  'When a Jira work item is attached to this workspace, inspect it before planning work.',
  'Use jira_get_issue to read the Jira issue summary, description, status and assignee.',
  'Use jira_search with JQL such as `parent = ABC-123` to inspect existing Jira subtasks.',
  'Treat Jira as the external source of truth for the issue itself.',
  'Do not assume the Jira issue is complete just because it exists.',
  'Check the available description, acceptance criteria, current status, existing subtasks and dependencies.',
  'If the Jira information is materially incomplete, ask the user instead of inventing missing business requirements.',
  '',
  'MULTI-AGENT ROUTING:',
  'Start with the smallest number of workers that can complete the work correctly.',
  'Do not create multiple Members merely because different roles exist.',
  'Prefer a single strong worker when the work is sequential, tightly coupled, ' +
    'based on the same context, difficult to split cleanly, or unlikely to benefit ' +
    'from independent verification.',
  'Use multiple workers only when there is a real reason: independent parallel ' +
    'workstreams, independent second opinion, different data or authorization ' +
    'boundaries, different tools or runtime capabilities, context size requires ' +
    'separation, or long-running independent execution.',
  'Different personas are not a reason to create another task.',
  'Different names are not a reason to create another task.',
  '',
  'TASK PLANNING:',
  'If the workspace has no tasks, create the initial execution plan with plan_tasks.',
  'Assign each task to the Team Member whose capabilities and role best match the work.',
  'Different tasks may be assigned to different Members and may run in parallel when dependencies allow.',
  'The Lead may assign a task to itself when that is the appropriate owner.',
  '',
  'If tasks already exist, DO NOT call plan_tasks again.',
  'Do not recreate or replace the existing task plan.',
  'Reuse tasks that already cover the required work.',
  'If a genuinely missing piece of work is discovered, use add_task.',
  'Do not add a duplicate merely because the same work also exists as a Jira subtask.',
  'If an existing unstarted task has the wrong Agent Member, use reassign_task.',
  'Do not reassign a task that is already ready, running, completed or cancelled.',
  '',
  'The current Goal revision is authoritative for this workspace.',
  'If the user materially changes the objective, scope, requirements, or success criteria, use update_goal.',
  'After update_goal, use replan_tasks to create the new task plan.',
  'Do not continue executing tasks from an older Goal revision.',
  '',
  'JIRA SUBTASKS ARE NOT AUTOMATIC AGENT TASKS:',
  'An existing Jira subtask is input to planning, not an instruction to create another copy.',
  'The Agent execution task is an internal Conversation Task.',
  'Do not create or modify Jira subtasks merely to mirror the internal task plan.',
  'Use Jira write tools only when the user request and tool authorization explicitly require changing Jira.',
  '',

  'EXECUTION:',
  'The platform starts ready tasks automatically.',
  'Do not manually simulate another Member doing the work.',
  'Do not use ask_member as a substitute for the persistent task plan when the work should be tracked as a Task.',
  'Use ask_member only for a focused temporary consultation or delegation that does not need persistent task tracking.',
  'Do not recreate completed work.',
  'The goal is task completion, not conversation continuation.',
].join('\n');

const TASK_INSTRUCTION = [
  'You are responsible for completing your assigned task.',
  'Do the work. Use available tools and knowledge.',
  "When your assigned work is complete, call update_task with status completed.",
  "If you cannot proceed, call update_task with status blocked and explain the blocker.",
  'Do not return generic conversational commentary.',
].join('\n');

/**
 * 从新增消息里挑出这一轮真正注入的那一段。
 *
 * 规则只有一条：**从最新往前取**，取到条数或字符数上限为止。
 *
 * 为什么不从最旧往前取（也就是丢掉最新的那些）：那等于把「刚刚发生的讨论」
 * 换成「很久以前的讨论」，而被唤醒的原因恰恰是刚刚发生的事。
 *
 * 也不做「保留头 + 保留尾、中间省略」那种截法：模型看到的两段之间没有因果
 * 关系，比少看到一点更容易产生错误结论。
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

function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageSequence: row.message_sequence,
    senderType: row.sender_type,
    senderId: row.sender_id,
    replyToMessageId: row.reply_to_message_id,
    taskId: row.task_id,
    clientRequestId: row.client_request_id,
    content: row.content,
    executionId: row.execution_id,
    // 附件由调用方在需要时单独装配（ContextAssembler 只读文本）。
    files: [],
    createdAt: row.created_at,
  };
}
