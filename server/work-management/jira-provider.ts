import type { JiraClient, JiraIssue } from '../jira/client.js';
import type {
  ExternalWorkRef,
  ExternalWorkSummary,
  WorkManagementProvider,
} from './types.js';

/**
 * Jira 的 WorkManagementProvider 实现（REST 传输）。
 *
 * 它做的事只有一件：把「外部工作系统的五个动作」翻译成 Jira REST 调用，
 * 并把 Jira 的 issue 形状翻译成 ExternalWorkRef / ExternalWorkSummary。
 *
 * 这个类里**没有**「本地工单」的概念 —— 没有 id 分配、没有状态枚举、
 * 没有缓存。每一个方法都是一次真实的外部调用，这是刻意的：任何本地副本
 * 都会在某次 webhook 丢包之后开始撒谎，而它撒的谎看起来和真话一模一样。
 *
 * ── 换传输 ─────────────────────────────────────────────────────────
 *
 * 想改用 MCP 时，新写一个 `JiraMcpProvider implements WorkManagementProvider`，
 * 在装配处换一行。业务契约、TeamService、工具层都不动 —— 这就是把 MCP
 * 当传输而不是当抽象的意义。
 */
export class JiraProvider implements WorkManagementProvider {
  readonly providerId = 'jira' as const;

  constructor(
    private readonly client: JiraClient,
    private readonly baseUrl: string,
  ) {}

  /**
   * 把用户给的 key 规范成引用。
   *
   * 这里就能拼出深链，因为站点地址是 Provider 的知识。`externalId` 缺省时
   * 先用 key 占位 —— 真正的不可变 id 要等一次 `get()` 才知道，而建会话的
   * 路径上不该有网络调用。
   */
  ref(input: { key: string; externalId?: string | null }): ExternalWorkRef {
    const key = input.key.trim();
    return {
      provider: 'jira',
      externalId: input.externalId?.trim() || key,
      key,
      url: this.browseUrl(key),
    };
  }

  async search(query: string, limit = 10): Promise<ExternalWorkSummary[]> {
    const result = await this.client.search(query, limit);
    return result.issues.map((issue) => this.toSummary(issue));
  }

  async get(ref: ExternalWorkRef): Promise<ExternalWorkSummary> {
    return this.toSummary(await this.client.getIssue(ref.key));
  }

  async addComment(ref: ExternalWorkRef, body: string): Promise<void> {
    await this.client.addComment(ref.key, body);
  }

  async transition(ref: ExternalWorkRef, transitionId: string): Promise<void> {
    await this.client.transition(ref.key, transitionId);
  }

  async assign(ref: ExternalWorkRef, assignee: string | null): Promise<void> {
    await this.client.assign(ref.key, assignee);
  }

  async listTransitions(
    ref: ExternalWorkRef,
  ): Promise<Array<{ id: string; name: string; to: string | null }>> {
    const result = await this.client.listTransitions(ref.key);
    return result.transitions.map((item) => ({
      id: item.id,
      name: item.name,
      to: item.to?.name ?? null,
    }));
  }

  private browseUrl(key: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}`;
  }

  private toSummary(issue: JiraIssue): ExternalWorkSummary {
    return {
      // 用 issue.id 而不是回填输入：一次 get 之后，引用就带上了不可变 id，
      // 之后项目改名也不会让这条引用指向别的东西。
      ref: {
        provider: 'jira',
        externalId: issue.id || issue.key,
        key: issue.key,
        url: this.browseUrl(issue.key),
      },
      title: issue.fields.summary,
      status: issue.fields.status?.name ?? null,
      // 显示名给模型和 UI 看；寻址要用 accountId，那是另一条路径（assign）。
      assignee: issue.fields.assignee?.displayName ?? null,
    };
  }
}
