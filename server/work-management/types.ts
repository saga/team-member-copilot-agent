/**
 * External Work System Adapter —— 外部工作系统的薄适配层。
 *
 * ── 为什么不抽象 Project / WorkItem / TaskStatus ──────────────────────
 *
 * 本地**没有** `JiraIssue` 这个业务对象，也不打算有。一旦本地定义一套
 * `Project / WorkItem / TaskStatus / Assignment / Claim`，就等于宣布
 * 「Jira 的工单模型可以被我们这套模型表达」—— 而它表达不了：
 *
 *   - workflow 是每个项目自定义的，transition 是否合法由**服务端**状态机判定
 *   - 字段是租户自定义的（customfield_10042 是什么，只有那个租户知道）
 *   - 权限挂在项目上，不在工单上；「能不能改这张单」不是工单的属性
 *
 * 抽象成统一模型的结果是：本地模型能表达的部分同步得很好，表达不了的部分
 * 静默丢失，而用户以为它同步了。所以这里只定义一个**薄适配层**：按引用读一条、
 * 搜一批、评论、流转、改负责人。五个动作，不是一套领域模型。
 *
 * ── 平台管什么、外部系统管什么 ──────────────────────────────────────
 *
 *   Jira（外部事实源）      管「活」：工单是什么、什么状态、谁负责、怎么流转
 *   本平台                  管「Agent 怎么干活」：谁在哪个房间、跑了哪一轮、
 *                           看到什么、为什么这么决定
 *
 * 本地只存两样东西，都是**运行时 / 审计数据**，不是第二套工作管理系统：
 *
 *   ExternalWorkRef       「这间会话 / 这一轮围绕哪条外部工作」—— 一个引用
 *   ExternalWorkSnapshot  「这一轮开跑时，外部系统说它是什么」—— 一次取证
 *
 * 后者和 `execution.config_snapshot` 是同一个思路：输入会变，而 execution 是
 * 历史事实，所以把「当时看到的输入」记在 execution 上。它不是缓存 ——
 * 没有任何读路径会拿它当业务事实用，它只回答「这一轮当时看到的业务上下文」。
 *
 * ── 传输不是抽象 ────────────────────────────────────────────────────
 *
 * MCP 只是**传输**：`WorkManagementProvider → JiraProvider → {JiraRestClient |
 * JiraMcpClient}`。把 MCP 当成业务抽象，会变成「换一个 MCP server 就换一套
 * 业务语义」，而它本来就只是同一批操作的另一种调用方式。
 *
 * ── 谁走 Provider、谁走工具 ──────────────────────────────────────────
 *
 *   LLM 发起的动作        → Tools（Agent 自己决定要不要评论/流转）
 *   控制面动作            → 直接调 Provider，**永不经过 LLM**
 *
 * 控制面包括：建会话时记引用、execution 开始时校验并取证、Scheduler 读、
 * 恢复、审计。这些必须确定性、可复现、不依赖模型愿不愿意调工具。
 */

/** 已接入的外部工作系统。加一家就加一个取值 + 一个 Provider 实现。 */
export type WorkProviderId = 'jira';

/**
 * 对一条外部工作的引用。**这是本地唯一持有的业务标识**。
 *
 * 注意它不携带任何「工单内容」：没有 title、没有 status、没有 assignee。
 * 那些每次要用就去问外部系统 —— 一旦落进这里，它就开始腐烂。
 */
export interface ExternalWorkRef {
  provider: WorkProviderId;
  /**
   * Provider 侧的稳定 id（Jira：issue id）。
   *
   * 和 `key` 的区别是真实存在的：`key` 会随项目改名而变（ABC-1 → XYZ-1），
   * 这个不会。只拿到 key 时先用 key 占位，`get()` 之后会被规范成真正的 id。
   */
  externalId: string;
  /** 人读的 key（Jira：ABC-123）。会变，所以只用于显示与向 Provider 寻址。 */
  key: string;
  /** 深链。null = 还没问过 Provider（它才知道站点地址）。 */
  url: string | null;
}

/**
 * 一轮 execution 开跑那一刻，外部工作系统的说法。
 *
 * 最小字段集：**只够回答「这一轮当时在干什么活」**。不 dump 整个 issue JSON ——
 * 那等于把 Jira 的 schema 复制进本地库，然后跟着它一起腐烂。
 */
export interface ExternalWorkSnapshot {
  /** Provider 当时返回的规范引用（key / url 可能已经和建会话时不同）。 */
  ref: ExternalWorkRef;
  title: string;
  status: string | null;
  /** 显示名。Jira 的负责人是 accountId，那是寻址用的，不是给人看的。 */
  assignee: string | null;
  capturedAt: string;
}

/** 一次读操作的结果。字段与 Snapshot 同形，区别只在有没有 capturedAt。 */
export interface ExternalWorkSummary {
  ref: ExternalWorkRef;
  title: string;
  status: string | null;
  assignee: string | null;
}

/**
 * Provider 的「命名」能力：把用户/调用方给的一个 key 规范成 ExternalWorkRef。
 *
 * 单独拆出来而不是塞进 WorkManagementProvider，是因为它是**身份**问题不是
 * **操作**问题：只有 Provider 知道自己的站点地址、知道 key 长什么样、
 * 知道深链怎么拼。放进五个操作里会让「适配层有五个动作」这件事变得不清晰。
 */
export interface WorkRefFactory {
  readonly providerId: WorkProviderId;
  /** `externalId` 缺省时用 key 占位，`get()` 之后会被规范成真正的 id。 */
  ref(input: { key: string; externalId?: string | null }): ExternalWorkRef;
}

/**
 * 外部工作系统的五个动作。
 *
 * 刻意保持小：每多一个方法，就多一个「所有 Provider 都必须能表达」的语义，
 * 而不同系统的语义恰恰是不能对齐的那部分。表达能力更强的操作（批量改、
 * 建子任务、改字段）应当做成**某个 Provider 的扩展**，而不是接口上的必需项。
 */
export interface WorkManagementProvider extends WorkRefFactory {
  /**
   * 搜索。`query` 是 **Provider 自己的查询语法**（Jira：JQL），不做统一 ——
   * 统一查询语言等于重新发明一套 DSL，然后把两边的表达能力取交集。
   */
  search(query: string, limit?: number): Promise<ExternalWorkSummary[]>;

  /** 按引用读一条。也是「这条外部工作还存在吗」的权威回答。 */
  get(ref: ExternalWorkRef): Promise<ExternalWorkSummary>;

  /** 加评论。 */
  addComment(ref: ExternalWorkRef, body: string): Promise<void>;

  /**
   * 流转。`transitionId` 必须由 Provider 侧的状态机认账 ——
   * 本地不复制 workflow，所以「这个流转合不合法」永远问 Provider。
   */
  transition(ref: ExternalWorkRef, transitionId: string): Promise<void>;

  /**
   * 改负责人。`assignee` 是 Provider 的稳定用户标识（Jira：accountId），
   * null = 取消指派。
   */
  assign(ref: ExternalWorkRef, assignee: string | null): Promise<void>;

  /**
   * 可选：列出当前可用的流转。
   *
   * 做成可选是因为不是每家都有「显式流转 id」这个概念（有的系统就是直接
   * 写 status）。没有它时，Agent 只能靠 `transition` 报错来试 —— 所以
   * 有这个能力的 Provider 应该实现它。
   *
   * `to` 是流转的**目标状态名**，不是本地状态机的取值：它只是让 Agent 不必
   * 试错就能挑对 id，本地仍然不持有状态机。
   */
  listTransitions?(ref: ExternalWorkRef): Promise<Array<{ id: string; name: string; to: string | null }>>;
}

/**
 * Provider 注册表。和 CapabilityRegistry 一样：按 id 查，查不到就抛。
 *
 * 查不到必须抛而不是返回 null：调用方拿到 null 会静默跳过「校验 + 取证」，
 * 于是审计链上少一段而没人知道。数据与部署漂移时应当显式失败。
 */
export class WorkManagementRegistry {
  private readonly providers = new Map<WorkProviderId, WorkManagementProvider>();

  register(provider: WorkManagementProvider): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`重复注册 Work Management Provider：${provider.providerId}`);
    }
    this.providers.set(provider.providerId, provider);
  }

  /** 有没有任何已接入的外部工作系统。没有时控制面走「无业务上下文」路径。 */
  get size(): number {
    return this.providers.size;
  }

  byId(id: WorkProviderId): WorkManagementProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`未注册 Work Management Provider：${id}`);
    return provider;
  }

  /** 按引用找到能处理它的 Provider。 */
  for(ref: ExternalWorkRef): WorkManagementProvider {
    return this.byId(ref.provider);
  }

  has(id: WorkProviderId): boolean {
    return this.providers.has(id);
  }
}

/**
 * 规范化一个外部传入的引用。
 *
 * 只做「形状与空白」的校验，不做「这条工单存不存在」的校验 —— 后者是网络
 * 调用，不该发生在建会话的路径上（Jira 抖一下就不让人开会话，是错的）。
 * 存在性在 execution 开始时由控制面校验并取证。
 *
 * 返回 null 表示「没有引用」：调用方传了空对象/空 key 时按「不挂业务」处理，
 * 而不是造一个 key 为空的引用出来 —— 那种引用会一路传到 Jira 变成一个 404。
 */
export function normalizeExternalWorkRef(input: {
  provider?: string | null;
  key?: string | null;
  externalId?: string | null;
} | null | undefined): { provider: WorkProviderId; key: string; externalId: string | null } | null {
  if (!input) return null;
  const key = input.key?.trim();
  if (!key) return null;
  const provider = (input.provider ?? 'jira').trim();
  if (provider !== 'jira') {
    throw new Error(`不支持的外部工作系统：${provider}`);
  }
  return { provider, key, externalId: input.externalId?.trim() || null };
}

/** 从 JSON 列读回一个引用。坏数据（手改过 / 老版本写的）一律当没有，不抛。 */
export function parseExternalWorkRef(raw: string | null): ExternalWorkRef | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ExternalWorkRef>;
    if (!value || typeof value !== 'object') return null;
    if (value.provider !== 'jira') return null;
    if (typeof value.key !== 'string' || !value.key) return null;
    return {
      provider: value.provider,
      externalId: typeof value.externalId === 'string' && value.externalId ? value.externalId : value.key,
      key: value.key,
      url: typeof value.url === 'string' && value.url ? value.url : null,
    };
  } catch {
    return null;
  }
}

/** 落库。null 存 NULL 而不是字符串 "null"。 */
export function serializeExternalWorkRef(ref: ExternalWorkRef | null): string | null {
  return ref ? JSON.stringify(ref) : null;
}

/** 从 JSON 列读回一份取证快照。 */
export function parseExternalWorkSnapshot(raw: string | null): ExternalWorkSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ExternalWorkSnapshot>;
    if (!value || typeof value !== 'object') return null;
    const ref = parseExternalWorkRef(JSON.stringify(value.ref));
    if (!ref) return null;
    if (typeof value.title !== 'string') return null;
    return {
      ref,
      title: value.title,
      status: typeof value.status === 'string' ? value.status : null,
      assignee: typeof value.assignee === 'string' ? value.assignee : null,
      capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : '',
    };
  } catch {
    return null;
  }
}

/** 落库一份取证快照。 */
export function serializeExternalWorkSnapshot(
  snapshot: ExternalWorkSnapshot | null,
): string | null {
  return snapshot ? JSON.stringify(snapshot) : null;
}
