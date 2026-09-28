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

  /**
   * 条件加评论：先读一次拿版本，再带 `If-Unmodified-Since` 写。
   *
   * 两次调用里，**第二次**才是真正的判定点：
   *
   *   读 → 比 → 写     窗口在「比」和「写」之间，挡不住竞态
   *   读 → 带版本写    Jira 在事务里比，412 就作废（这才是关掉窗口的那一步）
   *
   * 第一次读不是多余：它让「已变化」这条错误能带上一句人话（版本从 A 变成 B），
   * 而不是一个光秃秃的 412。错误信息的质量决定了这类问题能不能被排查。
   */
  async addCommentIfVersion(
    ref: ExternalWorkRef,
    body: string,
    expectedVersion: string,
  ): Promise<void> {
    const current = await this.client.getIssue(ref.key);

    if (current.fields.updated !== expectedVersion) {
      throw new Error(
        `Jira issue ${ref.key} 已变化（${expectedVersion} → ${current.fields.updated}），拒绝执行旧 Command`,
      );
    }

    await this.client.addComment(ref.key, body, expectedVersion);
  }

  /** 这条工单当前的并发版本号（Jira：`fields.updated`）。 */
  async versionOf(ref: ExternalWorkRef): Promise<string | null> {
    const issue = await this.client.getIssue(ref.key);
    return issue.fields.updated ?? null;
  }

  async transition(ref: ExternalWorkRef, transitionId: string): Promise<void> {
    await this.client.transition(ref.key, transitionId);
  }

  /**
   * 条件流转：先读一次拿版本，再带 `If-Unmodified-Since` 写。
   *
   * 和 `addCommentIfVersion` 是同一个形状，理由也相同 —— 但**更必要**：
   *
   *   评论写错了是一条多余的信息，可以删；
   *   流转写错了是把工作项推进到了错误的状态，而 workflow 通常**没有回头路**。
   *
   * 「先读再写」的窗口在这里尤其危险：一笔基于「In Review」批准的流转，如果
   * 期间有人把它退回了「In Progress」，无条件写会把它推到一个当前**不合法**
   * 的目标状态（或者落到一个语义完全不同的 transition 上），而记录看起来是
   * 一次正常执行。
   *
   * 第一次读不是多余的：它让「已变化」这条错误能带上人话（版本从 A 变成 B），
   * 而不是一个光秃秃的 412。真正关掉窗口的是**第二次**调用上的版本头 ——
   * Jira 在事务里比对。
   */
  async transitionIfVersion(
    ref: ExternalWorkRef,
    transitionId: string,
    expectedVersion: string,
  ): Promise<void> {
    const current = await this.client.getIssue(ref.key);

    if (current.fields.updated !== expectedVersion) {
      throw new Error(
        `Jira issue ${ref.key} 已变化（${expectedVersion} → ${current.fields.updated}），拒绝执行旧 Command`,
      );
    }

    await this.client.transition(ref.key, transitionId, expectedVersion);
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
      description: jiraDescriptionText(issue.fields.description),
    };
  }
}

/**
 * Jira description 可能是纯文本，也可能是 ADF（Atlassian Document Format）
 * 的 JSON 树。两种都收敛成纯文本，拿不到就返回 null —— 没有描述的工单
 * 很常见，不能把它变成一次失败。
 */
function jiraDescriptionText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => jiraDescriptionText(item))
      .filter((item): item is string => Boolean(item))
      .join(containsBlockNode(value) ? '\n' : '');
    return normalizeJiraText(text);
  }
  if (typeof value !== 'object') return null;
  const node = value as { type?: unknown; text?: unknown; content?: unknown };
  // hardBreak 是行内换行符：它自己就是一次换行。
  if (node.type === 'hardBreak') return '\n';
  // text 原样返回、不在这里 normalize：段落内的 'Fix ' + 'the thing' 靠
  // 原样拼接保住中间空格，整段的空白由上层的 normalizeJiraText 统一收。
  if (typeof node.text === 'string') {
    return node.text;
  }
  if (Array.isArray(node.content)) {
    const text = node.content
      .map((item) => jiraDescriptionText(item))
      .filter((item): item is string => Boolean(item))
      .join(containsBlockNode(node.content) ? '\n' : '');
    return normalizeJiraText(text);
  }
  return null;
}

/** ADF 块级节点：子节点之间换行，行内节点直接拼接。 */
const BLOCK_NODE_TYPES: ReadonlySet<string> = new Set([
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'panel',
  'rule',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'mediaSingle',
  'mediaGroup',
  'expand',
  'taskList',
  'taskItem',
  'layoutSection',
  'layoutColumn',
]);

/**
 * 子节点里混进一个块级节点就按块排（换行分隔）。
 *
 * 只看子节点类型、不看父节点：doc 下的两个 paragraph 是兄弟关系，
 * 问父节点（doc）永远得到“直接拼接”，'A' + 'B' 会粘成 'AB'。
 */
function containsBlockNode(content: unknown[]): boolean {
  return content.some(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      BLOCK_NODE_TYPES.has(String((item as { type?: unknown }).type ?? '')),
  );
}

function normalizeJiraText(value: string): string | null {
  const text = value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}
