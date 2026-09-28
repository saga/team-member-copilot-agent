/**
 * Jira Cloud REST API v3 的最小客户端。
 *
 * 这里只做「HTTP + 认证 + 错误翻译」，不做任何业务建模：不缓存工单状态、
 * 不映射本地对象 —— 业务事实在 Jira，本地复制一份就开始腐烂。
 *
 * 它是 **传输层**，不是业务层。上层 WorkManagementProvider 把「读一条、搜一批、
 * 评论、流转、改负责人」翻译成这里的调用；换成 MCP 传输时，换的是这一层，
 * 业务契约（WorkManagementProvider）不动。
 *
 * ── 失败必须翻译成结构化的 ExternalOperationError ────────────────────
 *
 * 上层是一个**状态机**（Command 的 failed / unknown），而它的判据只能是
 * 「这一次调用确定没发生，还是可能已经发生」。裸 `Error('Jira API 500 …')`
 * 把这个信息编码进了**文案**，于是判定变成字符串匹配 —— 改个措辞、加一层
 * 代理、换一家 Provider 都会让它悄悄失准，而失准的代价是一次重复的外部副作用。
 *
 * 所以这里每一处失败都带 `kind` 与 `status`：有响应 = 服务端表过态（4xx 是
 * definite，5xx / 408 / 429 是 unknown）；连响应都没有 = 交给
 * `classifyExternalError` 按系统错误码判（连接没建起来 → definite，连接断了
 * → unknown）。
 */

import {
  ExternalOperationError,
  classifyExternalError,
  kindForStatus,
} from '../work-management/outcome.js';

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
    let response: Response;
    try {
      response = await fetch(url, {
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
    } catch (error) {
      // fetch 自己抛 = 没能走到「有响应」这一步：超时、连接被重置、DNS 失败。
      // `cause` 才是真正带错误码的那一层（`TypeError: fetch failed` 什么也说
      // 明不了），所以交给 classifyExternalError 递归去看，而不是在这里猜。
      throw new ExternalOperationError(
        `Jira 请求失败 ${init?.method ?? 'GET'} ${path}：${
          error instanceof Error ? error.message : String(error)
        }`,
        classifyExternalError(error),
        null,
        { cause: error },
      );
    }

    if (response.status === 412) {
      // 412 = 服务端在事务里比过版本之后拒绝了这次写入。它看起来像失败，但它
      // 是一条**强证据**：写入没有发生。归到 definite 而不是 unknown，否则每次
      // 并发冲突都要人去对账一遍，而对账只会得出同一个结论。
      throw new ExternalOperationError(
        `Jira 拒绝写入 ${path}：资源自读取之后已被修改（If-Unmodified-Since 不匹配），本次操作作废`,
        'definite',
        412,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ExternalOperationError(
        `Jira API ${response.status} ${init?.method ?? 'GET'} ${path}: ${detail.slice(0, 500)}`,
        kindForStatus(response.status),
        response.status,
      );
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

  /**
   * 一条工单的**全部**评论（翻页拉完）。
   *
   * ── 为什么必须翻页 ──────────────────────────────────────────────────
   *
   * 对账的判据是「在评论里找得到那一笔的操作标记」。只看第一页的话，一张评论
   * 很多的工单上，我们那条评论会因为排在后面而被判成「没找到」—— 于是对账把
   * 一次**已经发生**的写入报成 `failed`，下一步就是重试，而重试是第二条评论。
   *
   * 这是「查不到 ≠ 没发生」的一个具体形态：对账的读必须穷尽，否则它的结论
   * 比不知道更危险。
   */
  async listComments(key: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    let startAt = 0;

    for (;;) {
      const page = await this.request<JiraCommentPage>(
        `/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}`,
      );
      const batch = page.comments ?? [];
      comments.push(...batch);

      // 两重终止条件，任一成立就停：
      //   - 已经拿到 total 条（正常路径）
      //   - 这一页是空的（服务端给了不一致的 total 时防死循环）
      // 后者不是多余的：`total` 与 `comments` 是两个字段，服务端完全可能
      // 在翻页过程中因为并发新增而让它们对不上，而这里是**一次 HTTP 请求的
      // 路径**——死循环的表现是整个进程卡住，不是一个错误。
      if (batch.length === 0) break;
      if (comments.length >= Number(page.total ?? comments.length)) break;

      startAt += batch.length;
    }

    return comments;
  }

  /**
   * 一条工单的变更历史。
   *
   * 流转对账的唯一依据：Jira 的 transition 接口**不接受**幂等标记（不像评论可以
   * 在正文里打一个），所以「这次流转到底发生没有」只能从变更历史里读出来。
   *
   * 取 `changelog` 的同时只要 `key,status` 两个字段：这里不需要工单内容，
   * 多取字段只是让响应变大。
   */
  getIssueChangelog(key: string): Promise<JiraChangelogResponse> {
    return this.request<JiraChangelogResponse>(
      `/issue/${encodeURIComponent(key)}?expand=changelog&fields=key,status`,
    );
  }
}

/** 评论翻页大小。Jira 的上限是 100，取满以减少往返。 */
const COMMENT_PAGE_SIZE = 100;

export interface JiraSearchResult {
  issues: JiraIssue[];
}

/**
 * 一条评论。
 *
 * `body` 是 ADF 树（v3 只吃 ADF），所以对账要在里面找操作标记时得先把它转成
 * 纯文本 —— 转换复用 `jiraDescriptionText`（评论正文和描述是同一套 ADF）。
 */
export interface JiraComment {
  id: string;
  body: unknown;
  created?: string;
  author?: { accountId?: string; displayName?: string };
}

interface JiraCommentPage {
  comments?: JiraComment[];
  total?: number;
  startAt?: number;
  maxResults?: number;
}

/** `GET /issue/{key}?expand=changelog` 的形状。只取对账要用的那几项。 */
export interface JiraChangelogResponse {
  key: string;
  changelog?: { histories?: JiraChangelogHistory[] };
}

/**
 * 一次变更（一个「history」里可以同时改多个字段）。
 *
 * `created` 是对账的**时间窗下界**：只有发生在本次尝试之后的变更才可能是我们
 * 做的。`items[].toString` 是变更**之后**的值 —— 对 status 来说就是目标状态名。
 */
export interface JiraChangelogHistory {
  id: string;
  created: string;
  author?: { accountId?: string; displayName?: string };
  items?: Array<{ field?: string; fromString?: string | null; toString?: string | null }>;
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
