import { z } from 'zod';
import type { CapabilityBinding } from '../../domain.js';
import type { RuntimeTool, ToolProvider, ToolProviderContext } from '../types.js';

/**
 * 团队协作工具（原来硬编码在 CopilotService 里的三个 custom tool）。
 *
 * 它们被搬到这里，是因为它们跟 Copilot 没关系：`ask_member` 最终调的是
 * TeamService 的编排逻辑，换掉引擎（Copilot → 别的 Agent SDK）它们一个字都
 * 不用改。留在 CopilotService 里等于把「引擎」和「业务编排」又粘回去了。
 *
 * ── 反向依赖 ──────────────────────────────────────────────────────────
 *
 * 这个 Provider 需要调 TeamService，而 TeamService 要花 capabilities 才跑得
 * 起来 —— 循环依赖。用 host 接口 + 惰性闭包打断：装配时传箭头函数，调用发生
 * 在真正执行工具的那一刻，那时 TeamService 早就构造完了。
 */
export interface CoreToolHost {
  delegateMember(input: {
    conversationId: string;
    fromMemberId: string;
    parentExecutionId: string;
    targetMemberId: string;
    task: string;
    reason?: string;
  }): Promise<string>;

  rememberMember(input: {
    memberId: string;
    teamId: string;
    content: string;
  }): Promise<string>;

  /**
   * 给另一个 Member 发一条私聊消息。
   *
   * 返回的是「消息已送达」，不是对方的回答 —— 这正是它和 delegateMember 的分界：
   * delegateMember 会阻塞到对方交付结果（父 execution 进 waiting_for_member），
   * 这里只是投递。要对方回了才推进当前工作，就该用 ask_member。
   */
  messageMember(input: {
    fromMemberId: string;
    targetMemberId: string;
    content: string;
  }): Promise<{ conversationId: string; messageId: string }>;

  requestClarification(input: {
    conversationId: string;
    memberId: string;
    questions: string[];
    assumptions?: string[];
    summary?: string;
  }): Promise<string>;

  planTasks(input: {
    conversationId: string;
    memberId: string;
    objective: string;
    requirements: {
      facts: Array<{ key: string; value: string; source: 'user' | 'jira' | 'knowledge' | 'conversation' | 'agent'; confirmed: boolean }>;
      assumptions: string[];
      constraints: string[];
      successCriteria: string[];
    };
    tasks: Array<{
      key: string;
      title: string;
      description?: string;
      assigneeMemberId?: string;
      dependencies?: string[];
      acceptanceCriteria?: string[];
    }>;
  }): Promise<string>;

  updateTask(input: {
    conversationId: string;
    memberId: string;
    taskId: string;
    status: 'running' | 'completed' | 'blocked';
    summary: string;
    blocker?: string;
  }): Promise<string>;
}

export class CoreTeamToolProvider implements ToolProvider {
  readonly id = 'team.core-tools';
  readonly version = '1';

  constructor(private readonly host: CoreToolHost) {}

  async resolve(
    _context: ToolProviderContext,
    _binding: CapabilityBinding,
  ): Promise<RuntimeTool[]> {
    return [
      {
        providerId: this.id,
        implementation: 'app' as const,
        kind: 'custom',
        name: 'ask_member',
        description:
          'Ask another Team Member to perform a focused piece of work. ' +
          'This creates a delegated execution in the current conversation.',
        risk: 'coordination',
        parameters: z.object({
          memberId: z.string().describe('Target Team Member ID'),
          task: z.string().min(1).max(8000).describe('The specific task for the other member'),
          reason: z.string().max(2000).optional().describe('Why this delegation is useful'),
        }),
        execute: (context, args) =>
          this.host.delegateMember({
            conversationId: context.conversationId,
            fromMemberId: context.memberId,
            parentExecutionId: context.executionId,
            targetMemberId: String(args.memberId),
            task: String(args.task),
            ...(args.reason === undefined ? {} : { reason: String(args.reason) }),
          }),
      },
      {
        providerId: this.id,
        implementation: 'app' as const,
        kind: 'custom',
        name: 'message_member',
        description:
          'Send a private message to another Team Member. The two of you then share a persistent ' +
          '1:1 conversation. Use this to hand over context, ask for an opinion, or follow up — ' +
          'without blocking your own turn. It returns as soon as the message is delivered: ' +
          'it does NOT wait for a reply and does NOT give you the answer. ' +
          'Use ask_member instead when you need their result before you can continue working.',
        risk: 'coordination',
        parameters: z.object({
          memberId: z.string().describe('Target Team Member ID'),
          content: z.string().min(1).max(8000).describe('The message to send'),
        }),
        execute: async (context, args) => {
          const result = await this.host.messageMember({
            fromMemberId: context.memberId,
            targetMemberId: String(args.memberId),
            content: String(args.content),
          });
          return `Delivered to ${String(args.memberId)} in conversation ${result.conversationId}. They will see it in their own inbox.`;
        },
      },
      {
        providerId: this.id,
        implementation: 'app' as const,
        kind: 'custom',
        name: 'remember_member',
        description:
          'Save something this Member should remember for the current Team. ' +
          'Use this for Team workflows, relationships, project facts, and local working conventions. ' +
          'Do not use this as a global personality or preference store.',
        risk: 'self-write',
        parameters: z.object({
          content: z
            .string()
            .min(1)
            .max(8000)
            .describe('Information to remember for the current Team.'),
        }),
        execute: (context, args) =>
          this.host.rememberMember({
            memberId: context.memberId,
            teamId: context.teamId,
            content: String(args.content),
          }),
      },
      {
        providerId: this.id,
        implementation: 'app' as const,
        kind: 'custom',
        name: 'request_clarification',
        description:
          'Lead only. Ask the user for missing information that blocks progress. ' +
          'At most 3 questions at a time. The workspace moves to waiting_user.',
        risk: 'coordination',
        parameters: z.object({
          questions: z.array(z.string().min(1).max(1000)).min(1).max(3),
          assumptions: z.array(z.string().min(1).max(1000)).max(10).optional(),
          summary: z.string().max(4000).optional(),
        }),
        execute: (context, args) =>
          this.host.requestClarification({
            conversationId: context.conversationId,
            memberId: context.memberId,
            questions: (args.questions as string[]).map(String),
            ...((args as { assumptions?: string[] }).assumptions === undefined
              ? {}
              : { assumptions: ((args as { assumptions?: string[] }).assumptions ?? []).map(String) }),
            ...((args as { summary?: string }).summary === undefined
              ? {}
              : { summary: String((args as { summary?: string }).summary) }),
          }),
      },
      {
        providerId: this.id,
        implementation: 'app' as const,
        kind: 'custom',
        name: 'plan_tasks',
        description:
          'Lead only. Define the objective and the concrete task list for this workspace. ' +
          'Tasks start automatically once dependencies are met.',
        risk: 'coordination',
        parameters: z.object({
          objective: z.string().min(1).max(4000),
          requirements: z.object({
            facts: z
              .array(
                z.object({
                  key: z.string().min(1).max(200),
                  value: z.string().min(1).max(4000),
                  source: z.enum(['user', 'jira', 'knowledge', 'conversation', 'agent']),
                  confirmed: z.boolean(),
                }),
              )
              .max(50)
              .default([]),
            assumptions: z.array(z.string().max(1000)).max(20).default([]),
            constraints: z.array(z.string().max(1000)).max(20).default([]),
            successCriteria: z.array(z.string().max(1000)).max(20).default([]),
          }),
          tasks: z
            .array(
              z.object({
                key: z.string().regex(/^[a-zA-Z0-9_-]+$/),
                title: z.string().min(1).max(300),
                description: z.string().max(8000).default(''),
                assigneeMemberId: z.string().min(1),
                dependencies: z.array(z.string()).max(20).default([]),
                acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(20).default([]),
              }),
            )
            .min(1)
            .max(20),
        }),
        execute: (context, args) =>
          this.host.planTasks({
            conversationId: context.conversationId,
            memberId: context.memberId,
            objective: String((args as { objective: string }).objective),
            requirements: (args as { requirements: never }).requirements,
            tasks: (args as { tasks: never }).tasks as never as Parameters<CoreToolHost['planTasks']>[0]['tasks'],
          }),
      },
      {
        providerId: this.id,
        implementation: 'app' as const,
        kind: 'custom',
        name: 'update_task',
        description:
          'Report progress on your assigned task. Only the assignee can update it. ' +
          'Call with completed when done, blocked when you cannot proceed.',
        risk: 'coordination',
        parameters: z.object({
          taskId: z.string().min(1),
          status: z.enum(['running', 'completed', 'blocked']),
          summary: z.string().min(1).max(10000),
          blocker: z.string().max(4000).optional(),
        }),
        execute: (context, args) =>
          this.host.updateTask({
            conversationId: context.conversationId,
            memberId: context.memberId,
            taskId: String((args as { taskId: string }).taskId),
            status: (args as { status: 'running' | 'completed' | 'blocked' }).status,
            summary: String((args as { summary: string }).summary),
            ...((args as { blocker?: string }).blocker === undefined
              ? {}
              : { blocker: String((args as { blocker?: string }).blocker) }),
          }),
      },
    ];
  }
}
