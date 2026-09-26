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

  rememberMember(input: { memberId: string; content: string }): Promise<string>;

  listWorkItems(input: {
    memberId: string;
    scope?: 'mine' | 'available' | 'all';
    projectId?: string;
    status?: string;
  }): Promise<string>;

  claimWorkItem(input: { memberId: string; executionId: string; workItemId: string }): Promise<string>;

  updateWorkItem(input: {
    memberId: string;
    workItemId: string;
    status?: string;
    title?: string;
    description?: string;
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
        description: 'Persist a durable memory that belongs to the current Team Member.',
        risk: 'self-write',
        parameters: z.object({
          content: z.string().min(1).max(8000).describe('The memory to persist'),
        }),
        execute: (context, args) =>
          this.host.rememberMember({
            memberId: context.memberId,
            content: String(args.content),
          }),
      },
      {
        providerId: this.id,
      implementation: 'app' as const,
        kind: 'custom',
        name: 'list_work_items',
        description:
          'List team work items you can work on. Prefer this over asking the user what to do next.',
        risk: 'read',
        parameters: z.object({
          scope: z.enum(['mine', 'available', 'all']).optional().describe('mine = assigned to you or claimed by you; available = unclaimed and unblocked; all = team open items'),
          projectId: z.string().min(1).optional().describe('Filter by project'),
          status: z.string().min(1).optional().describe('Filter by status'),
        }),
        execute: (context, args) =>
          this.host.listWorkItems({
            memberId: context.memberId,
            ...(args.scope === undefined ? {} : { scope: args.scope as 'mine' | 'available' | 'all' }),
            ...(args.projectId === undefined ? {} : { projectId: String(args.projectId) }),
            ...(args.status === undefined ? {} : { status: String(args.status) }),
          }),
      },
      {
        providerId: this.id,
      implementation: 'app' as const,
        kind: 'custom',
        name: 'claim_work_item',
        description:
          'Atomically claim a work item so no other member starts the same work. Claim sets it to in_progress.',
        risk: 'coordination',
        parameters: z.object({
          workItemId: z.string().min(1).describe('The work item to claim'),
        }),
        execute: (context, args) =>
          this.host.claimWorkItem({
            memberId: context.memberId,
            executionId: context.executionId,
            workItemId: String(args.workItemId),
          }),
      },
      {
        providerId: this.id,
      implementation: 'app' as const,
        kind: 'custom',
        name: 'update_work_item',
        description:
          'Update a work item you claimed (status/title/description). Only the claimer or a team admin can mark done/cancelled.',
        risk: 'coordination',
        parameters: z.object({
          workItemId: z.string().min(1).describe('The work item to update'),
          status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
          title: z.string().min(1).max(300).optional(),
          description: z.string().max(8000).optional(),
        }),
        execute: (context, args) =>
          this.host.updateWorkItem({
            memberId: context.memberId,
            workItemId: String(args.workItemId),
            ...(args.status === undefined ? {} : { status: String(args.status) }),
            ...(args.title === undefined ? {} : { title: String(args.title) }),
            ...(args.description === undefined ? {} : { description: String(args.description) }),
          }),
      },
    ];
  }
}
