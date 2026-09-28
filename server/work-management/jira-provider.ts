import type { JiraChangelogResponse, JiraClient, JiraComment, JiraIssue } from '../jira/client.js';
import type {
  ExternalOperationQuery,
  ExternalWorkRef,
  ExternalWorkSummary,
  WorkManagementProvider,
} from './types.js';
import type { ExternalOperationOutcome } from './outcome.js';

/**
 * 打在 Jira 评论正文里的操作标记。
 *
 * ── 为什么是正文里的一行文本 ────────────────────────────────────────
 *
 * Jira v3 的评论正文是 ADF，而 ADF **没有**「不可见节点」这种东西。理论上的
 * 替代是 comment properties（`POST /comment` 的 `properties` 字段），但读它要
 * 再走一次 `GET /comment/{id}/properties` —— 而那要求你**已经知道是哪条评论**。
 * 对账要回答的恰恰是「哪一条是我发的」，这是个先有鸡还是先有蛋的问题。
 *
 * 所以标记写在正文里。代价是它在渲染出来的评论里也会显示一行；换来的是
 * 「哪条评论来自平台」在**原始文本里永远查得到**，不依赖额外接口，也不依赖
 * 任何只有我们才知道的本地状态。
 *
 * 格式固定成 `<!-- copilot-operation:<id> -->`：HTML 注释的样子让人一眼看出
 * 它是机器写的，不是人写的正文。
 */
export function operationMarker(operationId: string): string {
  return `<!-- copilot-operation:${operationId} -->`;
}

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

  /**
   * 对账 —— 「这一笔到底做了没有」。
   *
   * 两类动作的痕迹不同，所以分开处理：评论在正文里留了标记（可以直接找），
   * 流转只在变更历史里留了一行（要按时间和目标状态推断）。
   *
   * 两个分支都遵守同一条纪律：**`completed` 只能来自找到痕迹**，读失败一律
   * 报 `unknown`（而不是「查不到 = 没发生」）—— 后者的下一步是重试，而重试
   * 的代价是重复副作用。
   */
  async reconcileOperation(query: ExternalOperationQuery): Promise<ExternalOperationOutcome> {
    switch (query.action) {
      case 'jira.add_comment':
        return this.reconcileComment(query);
      case 'jira.transition_issue':
        return this.reconcileTransition(query);
      default:
        return {
          status: 'unknown',
          detail: `Jira Provider 不知道怎么对账 action=${query.action}`,
        };
    }
  }

  /**
   * 评论对账：在一张工单的全部评论里找这一笔的操作标记。
   *
   * ── 为什么「找不到」可以判 failed ────────────────────────────────────
   *
   * 因为这次读是**穷尽**的（`listComments` 翻完所有页），而 Jira 的评论读对
   * 同一个账号是读己之写一致的。所以「全部评论都读过，没有这个标记」是一条
   * 关于外部世界的直接观测，不是推断。
   *
   * 反过来说，如果这里只读第一页，结论就会反过来变成灾难：一张评论很多的
   * 工单上，我们那条排在后面 → 报 failed → 人去重试 → 第二条评论。
   */
  private async reconcileComment(
    query: ExternalOperationQuery,
  ): Promise<ExternalOperationOutcome> {
    const marker = operationMarker(query.operationId);

    let comments: JiraComment[];
    try {
      comments = await this.client.listComments(query.target);
    } catch (error) {
      return {
        status: 'unknown',
        detail: `读 ${query.target} 的评论失败，无法对账：${describeError(error)}`,
      };
    }

    const hit = comments.find((comment) => (jiraDescriptionText(comment.body) ?? '').includes(marker));
    if (hit) {
      return {
        status: 'completed',
        detail: `在 ${query.target} 的评论 ${hit.id} 里找到本次操作标记`,
      };
    }

    return {
      status: 'failed',
      detail: `读过 ${query.target} 的全部 ${comments.length} 条评论，没有本次操作标记（${query.operationId}）`,
    };
  }

  /**
   * 流转对账：在变更历史里找时间窗内的状态变更。
   *
   * ── 为什么不能只看「当前状态是不是目标状态」 ─────────────────────────
   *
   * 因为那张单**本来就可能**处在目标状态 —— 别人在我们之前刚把它流转过去，
   * 或者它一直就在那里。只看当前状态会把这两种情况都报成「我们成功了」，而
   * 我们的那次写入其实被 Jira 拒绝了（transition 不合法）。
   *
   * ── 为什么目标状态可能解析不出来 ────────────────────────────────────
   *
   * `GET /transitions` 返回的是**当前可用**的流转。一次成功的流转之后，我们用
   * 的那个 transition 通常就不在可用列表里了 —— 也就是说「解析不出来」恰恰是
   * 成功之后最常见的样子。所以解析不出来时退回「时间窗内任何一次状态变更」，
   * 并在说明里带上观察到的 from → to，让人能自己核。
   */
  private async reconcileTransition(
    query: ExternalOperationQuery,
  ): Promise<ExternalOperationOutcome> {
    const transitionId =
      typeof query.args.transitionId === 'string' ? query.args.transitionId : null;
    if (!transitionId) {
      return {
        status: 'unknown',
        detail: 'Command 上没有 transitionId，无法确定这次流转的目标状态',
      };
    }

    // 目标状态是**尽力**解析，解析不出来不算失败（见上面的说明）。
    let targetStatus: string | null = null;
    try {
      const transitions = await this.listTransitions(this.ref({ key: query.target }));
      targetStatus = transitions.find((item) => item.id === transitionId)?.to ?? null;
    } catch {
      targetStatus = null;
    }

    let changelog: JiraChangelogResponse;
    try {
      changelog = await this.client.getIssueChangelog(query.target);
    } catch (error) {
      return {
        status: 'unknown',
        detail: `读 ${query.target} 的变更历史失败，无法对账：${describeError(error)}`,
      };
    }

    const histories = changelog.changelog?.histories ?? [];
    const since = Date.parse(query.attemptStartedAt);

    /** 变更历史里所有「把状态改到某个值」的条目，且发生在时间窗内。 */
    const statusChanges = histories
      .map((history) => {
        const item = (history.items ?? []).find((candidate) => candidate.field === 'status');
        if (!item) return null;
        // 时间戳解析不出来时**不**排除这条 —— 宁可多一条候选（可能落到
        // unknown）也不要因为一个格式问题把证据丢掉。
        if (Number.isFinite(since) && Number.isFinite(Date.parse(history.created))) {
          if (Date.parse(history.created) < since) return null;
        }
        return { history, to: item.toString ?? null, from: item.fromString ?? null };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const matches = targetStatus
      ? statusChanges.filter((entry) => entry.to === targetStatus)
      : statusChanges;

    if (matches.length === 1) {
      const [match] = matches;
      return {
        status: 'completed',
        detail:
          `变更历史 ${match.history.id}（${match.history.created}）把 ${query.target} ` +
          `从 ${match.from ?? '?'} 转到 ${match.to ?? '?'}` +
          (targetStatus ? '' : `（transitionId=${transitionId} 当前不可用，目标状态未能独立核对）`),
      };
    }

    if (matches.length === 0) {
      return {
        status: 'failed',
        detail:
          `读过 ${query.target} 的变更历史（${histories.length} 条），` +
          `${query.attemptStartedAt} 之后没有` +
          (targetStatus ? `到 ${targetStatus} 的` : '任何') +
          '状态变更',
      };
    }

    // 多于一條：无法确定哪一次是我们做的。如实说不知道 —— 猜一个方向都比
    // unknown 更糟（猜成功没人去查，猜失败会重试）。
    return {
      status: 'unknown',
      detail:
        `时间窗内有 ${matches.length} 次状态变更` +
        (targetStatus ? `到 ${targetStatus}` : '') +
        '，无法确定哪一次是本次操作，需要人工核对',
    };
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

/** 对账的说明里带上错误原文 —— 这一层不解释错误，只保证它不丢。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
