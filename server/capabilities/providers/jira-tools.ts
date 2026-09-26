import { z } from 'zod';
import type { CapabilityBinding } from '../../domain.js';
import type { RuntimeTool, ToolProvider, ToolProviderContext } from '../types.js';
import type { JiraClient } from '../../jira/client.js';

/**
 * Jira 工具：业务工作的读写入口。
 *
 * 本地不存工单 —— WorkItem 表已经删了。Agent 看到的工单状态永远来自 Jira，
 * 改状态走 Jira workflow（transition 是否合法由 Jira 判定，本地不复制状态机）。
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
 * 不做 jira_assign_issue：改负责人是更强的业务动作，需要真正的 Policy
 * 服务在位之后才应该对 Agent 开放。
 */
export class JiraToolProvider implements ToolProvider {
  readonly id = 'atlassian.jira-tools';
  readonly version = '1';

  constructor(private readonly client: JiraClient) {}

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
          const result = await this.client.search(String(args.jql), typeof args.limit === 'number' ? args.limit : 10);
          return JSON.stringify(
            result.issues.map((issue) => ({
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status?.name,
              assignee: issue.fields.assignee?.displayName ?? null,
            })),
          );
        },
      },
      {
        providerId: this.id,
        implementation: 'http',
        kind: 'custom',
        name: 'jira_get_issue',
        description: 'Get one Jira issue by key (e.g. ABC-123): summary, description, status, assignee.',
        risk: 'read',
        parameters: z.object({
          issueKey: z.string().min(3).max(30).describe('Issue key, e.g. ABC-123'),
        }),
        execute: async (_context, args) => {
          const issue = await this.client.getIssue(String(args.issueKey));
          return JSON.stringify({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status?.name,
            assignee: issue.fields.assignee?.displayName ?? null,
            description: issue.fields.description,
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
          await this.client.addComment(String(args.issueKey), String(args.body));
          return `Comment added to ${String(args.issueKey)}.`;
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
          if (args.transitionId === undefined) {
            const result = await this.client.listTransitions(String(args.issueKey));
            return JSON.stringify(
              result.transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name })),
            );
          }
          await this.client.transition(String(args.issueKey), String(args.transitionId));
          return `Issue ${String(args.issueKey)} transitioned.`;
        },
      },
    ];
  }
}
