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

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown; ifUnmodifiedSince?: string },
  ): Promise<T> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/rest/api/3${path}`;
    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: this.auth(),
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        // 乐观并发的**服务端**那一半。只在客户端比对 `updated` 是挡不住竞态的：
        // 「读到 updated」与「发写请求」之间还有一段时间，对手正好能塞进去一次
        // 修改。带上这个头，Jira 会在事务里比对，不一致时返回 412 —— 判定与
        // 写入在同一个地方发生。
        ...(init?.ifUnmodifiedSince ? { 'If-Unmodified-Since': init.ifUnmodifiedSince } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (response.status === 412) {
      throw new Error(
        `Jira 拒绝写入 ${path}：资源自读取之后已被修改（If-Unmodified-Since 不匹配），本次操作作废`,
      );
    }
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
        `&fields=key,summary,status,assignee,description,updated`,
    );
  }

  getIssue(key: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      `/issue/${encodeURIComponent(key)}?fields=key,summary,status,assignee,description,updated`,
    );
  }

  /**
   * 加评论。`ifUnmodifiedSince` = 期望的 `fields.updated`，传了就走条件写入。
   *
   * 这是 TOCTOU 的正解：Command 是在「看到某个版本的工单」时被批准的，而批准
   * 到执行之间工单可能已经被人改了。不比对就写，等于把一条基于旧状态的决策
   * 施加到新状态上 —— 表现是「评论内容和当前状态对不上」，且没人知道为什么。
   */
  addComment(key: string, body: string, ifUnmodifiedSince?: string): Promise<void> {
    return this.request(`/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: {
        // Atlassian Document Format：v3 的 comment body 只吃 ADF，不吃纯文本。
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
      },
      ...(ifUnmodifiedSince ? { ifUnmodifiedSince } : {}),
    });
  }

  transition(key: string, transitionId: string, ifUnmodifiedSince?: string): Promise<void> {
    return this.request(`/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: transitionId },
      ...(ifUnmodifiedSince ? { ifUnmodifiedSince } : {}),
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
    /**
     * 最后一次修改时间。**这就是这条工单的并发版本号**。
     *
     * Jira 没有单独的 `version` / ETag 字段，但它自己的乐观并发机制就是
     * `If-Unmodified-Since` + 这个时间戳（见 addComment 的第三个参数）。
     * 用别的字段（status / assignee）当版本号是不够的：改标题、改描述、
     * 加评论都会变，而它们一个都不改 status。
     */
    updated: string;
  };
}
