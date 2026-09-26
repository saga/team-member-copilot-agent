/**
 * Jira Cloud REST API v3 的最小客户端。
 *
 * 这里只做「HTTP + 认证 + 错误翻译」，不做任何业务建模：不缓存工单状态、
 * 不映射本地对象 —— 业务事实在 Jira，本地复制一份就开始腐烂。
 *
 * 它是 **传输层**，不是业务层。上层 WorkManagementProvider 把「读一条、搜一批、
 * 评论、流转、改负责人」翻译成这里的调用；换成 MCP 传输时，换的是这一层，
 * 业务契约（WorkManagementProvider）不动。
 */

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export class JiraClient {
  constructor(private readonly cfg: JiraConfig) {}

  private auth(): string {
    return `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64')}`;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/rest/api/3${path}`;
    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: this.auth(),
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Jira API ${response.status} ${init?.method ?? 'GET'} ${path}: ${detail.slice(0, 500)}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** JQL 搜索。只取 Agent 关心的字段，不整页搬。 */
  search(jql: string, limit = 10): Promise<JiraSearchResult> {
    return this.request<JiraSearchResult>(
      `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(limit, 50)}` +
        `&fields=key,summary,status,assignee,description`,
    );
  }

  getIssue(key: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      `/issue/${encodeURIComponent(key)}?fields=key,summary,status,assignee,description`,
    );
  }

  addComment(key: string, body: string): Promise<void> {
    return this.request(`/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: {
        // Atlassian Document Format：v3 的 comment body 只吃 ADF，不吃纯文本。
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
      },
    });
  }

  transition(key: string, transitionId: string): Promise<void> {
    return this.request(`/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: transitionId },
    });
  }

  listTransitions(key: string): Promise<{ transitions: Array<{ id: string; name: string; to: { name: string } }> }> {
    return this.request(`/issue/${encodeURIComponent(key)}/transitions`);
  }

  /**
   * 改负责人。`null` = 取消指派。
   *
   * 参数是 **accountId**（Jira Cloud 的稳定用户标识），不是显示名也不是邮箱 ——
   * 显示名会重名，邮箱会变。谁来把「张三」解析成 accountId 是上层的事：
   * 解析错了是给人改错了负责人，不是一个可以靠默认值糊过去的参数。
   */
  assign(key: string, accountId: string | null): Promise<void> {
    return this.request(`/issue/${encodeURIComponent(key)}/assignee`, {
      method: 'PUT',
      body: { accountId },
    });
  }
}

export interface JiraSearchResult {
  issues: JiraIssue[];
}

export interface JiraIssue {
  /**
   * 服务端生成的**不可变** id。key 会随项目改名而变（ABC-1 → XYZ-1），
   * 它不会 —— 这就是 ExternalWorkRef 里 externalId 的来源。
   */
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string };
    assignee: { displayName: string } | null;
  };
}
