import { z } from 'zod';
import type { CapabilityBinding } from '../../domain.js';
import type { RuntimeTool, ToolProvider, ToolProviderContext } from '../types.js';
import type { WorkManagementProvider } from '../../work-management/types.js';

/**
 * 外部工作系统的读写工具（当前接的是 Jira）。
 *
 * ── 本地没有「工单」这个对象 ──────────────────────────────────────────
 *
 * 没有 Project / WorkItem / JiraIssue，也没有工单状态的本地副本。Agent 看到的
 * 工单状态**永远**来自 Jira：改状态走 Jira 的 workflow（transition 合不合法由
 * Jira 的服务端状态机判定，本地不复制状态机）。
 *
 * 工具层不是唯一的调用方：控制面（execution 开始时的取证、webhook 定位房间）
 * 用**同一个 Provider 实例**直接调。区别只在「谁发起」——
 *
 *   Agent 决定要不要评论/流转   → 这里（经过 Policy）
 *   平台决定要取证/要通知       → TeamService 直连 Provider，永不经过 LLM
 *
 * 两者共用一份业务语义，所以不会出现「Agent 看到的工单」和「平台看到的工单」
 * 是两个东西。
 *
 * ── 风险分级与 Policy ────────────────────────────────────────────────
 *
 *   jira_search / jira_get_issue   risk = read
 *   jira_add_comment               risk = external-write
 *   jira_transition_issue          risk = external-write（改业务状态，比评论更重）
 *
 * external-write 的放行权在 PolicyService（见 tool-policy.ts / policy.ts）：
 * 当前部署没有配置放行通道，这两个工具在 Policy 层被拒 —— 这是刻意的。
 * 「能列出工具」和「能执行动作」是两件事，前者由 binding 决定，后者由 Policy 决定。
 *
 * ── 为什么没有 jira_assign_issue ─────────────────────────────────────
 *
 * Provider 上**有** `assign`（控制面将来要用），但刻意不暴露成工具。理由不是
 * 「危险」——评论也能改成很危险的内容；理由是**它需要人来做决定**：改负责人是
 * 一次责任转移，得有人指定 accountId。让模型从一句自然语言里猜出该派给谁，
 * 猜错的代价是把工作派给了错的人，而不是一条失败的工具调用。
 *
 * 等真正的 Policy 服务在位（谁有权改、要不要人确认）之后才该对 Agent 开放。
 * 顺带说明一件事：Provider 有这个方法，**不等于**它被授权给 Agent 用。
 * 「实现了」和「放行了」是两回事。
 */
export class JiraToolProvider implements ToolProvider {
  readonly id = 'atlassian.jira-tools';
  readonly version = '2';

  constructor(private readonly work: WorkManagementProvider) {}

  async resolve(
    _context: ToolProviderContext,
    _binding: CapabilityBinding,
  ): Promise<RuntimeTool[]> {
    return [
      {
        providerId: this.id,
        implementation: 'http',
        kind: 'custom',
        name: 'jira_search',
        description: 'Search Jira issues with JQL. Returns key, summary, status, assignee.',
        risk: 'read',
        parameters: z.object({
          jql: z.string().min(1).max(2000).describe('JQL query, e.g. "assignee = currentUser() AND status != Done"'),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        execute: async (_context, args) => {
          const issues = await this.work.search(
            String(args.jql),
            typeof args.limit === 'number' ? args.limit : 10,
          );
          return JSON.stringify(
            issues.map((issue) => ({
              key: issue.ref.key,
              summary: issue.title,
              status: issue.status,
              assignee: issue.assignee,
            })),
          );
        },
      },
      {
        providerId: this.id,
        implementation: 'http',
        kind: 'custom',
        name: 'jira_get_issue',
        description: 'Get one Jira issue by key (e.g. ABC-123): summary, status, assignee.',
        risk: 'read',
        parameters: z.object({
          issueKey: z.string().min(3).max(30).describe('Issue key, e.g. ABC-123'),
        }),
        execute: async (_context, args) => {
          const issue = await this.work.get(this.ref(String(args.issueKey)));
          return JSON.stringify({
            key: issue.ref.key,
            summary: issue.title,
            status: issue.status,
            assignee: issue.assignee,
            url: issue.ref.url,
          });
        },
      },
      {
        providerId: this.id,
        implementation: 'http',
        kind: 'custom',
        name: 'jira_add_comment',
        description: 'Add a comment to a Jira issue. Goes through Policy approval (external-write).',
        risk: 'external-write',
        parameters: z.object({
          issueKey: z.string().min(3).max(30),
          body: z.string().min(1).max(8000),
        }),
        execute: async (_context, args) => {
          const ref = this.ref(String(args.issueKey));
          await this.work.addComment(ref, String(args.body));
          return `Comment added to ${ref.key}.`;
        },
      },
      {
        providerId: this.id,
        implementation: 'http',
        kind: 'custom',
        name: 'jira_transition_issue',
        description:
          'Move a Jira issue through its workflow (e.g. In Progress → In Review). ' +
          'The transition must be valid in the Jira workflow. Goes through Policy approval (external-write).',
        risk: 'external-write',
        parameters: z.object({
          issueKey: z.string().min(3).max(30),
          /** 不确定可用 transition 时先调本工具不带 transitionId，会返回可选项。 */
          transitionId: z.string().max(30).optional().describe('Transition id; omit to list available transitions'),
        }),
        execute: async (_context, args) => {
          const ref = this.ref(String(args.issueKey));

          if (args.transitionId === undefined) {
            if (!this.work.listTransitions) {
              return `Provider ${this.work.providerId} 不支持列出可用流转，请直接给出 transitionId。`;
            }
            return JSON.stringify(await this.work.listTransitions(ref));
          }

          await this.work.transition(ref, String(args.transitionId));
          return `Issue ${ref.key} transitioned.`;
        },
      },
    ];
  }

  /**
   * 工具参数里的 issueKey 只保证「用户这么写」，不保证存在 ——
   * 存在性由 Provider 自己回答（它才知道自己的 key 规则）。
   */
  private ref(key: string) {
    return this.work.ref({ key: key.trim() });
  }
}
