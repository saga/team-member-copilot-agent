import type { defineTool } from '@github/copilot-sdk';
import type { CapabilityBinding, MemberCapabilities, TurnMode } from '../domain.js';

/**
 * 能力层（Skill / Knowledge / Tool）的契约。
 *
 * 这一层存在的理由只有一个：**引擎与具体实现解耦**。
 *
 *   现在：CopilotService 直接 import KnowledgeService、硬编码六个工具名、
 *         自己拼 skillDirectories
 *   之后：CopilotService 只认识 RuntimeCapabilities
 *
 * 于是「换 KB 后端」「加一组工具」「换 skill 来源」都不再是改引擎，而是注册
 * 一个 Provider、在 Member 上加一条 binding。Provider ID 是稳定契约，实现可换。
 *
 * ── 三层各自的语义 ─────────────────────────────────────────────────────
 *
 *   Skill       How  —— 少量程序化方法论，整体进 session context
 *   Knowledge   What —— 大量事实资料，**只按需检索**，永不全量进 prompt
 *   Tool        动作 —— 模型可以调用的东西，授权判定只看 risk / provider
 *
 * ── 为什么 resolve 是 async ────────────────────────────────────────────
 *
 * 本地 Provider 现在都是同步的（文件系统 + SQLite），但这一层的全部价值就是
 * 「实现可以换成远程的」：Snowflake / Elastic / 企业搜索 / 远程 RAG 都是网络
 * 调用。把接口定成同步，等于在大半年后换后端时被迫修改 KnowledgeToolProvider
 * 与 Resolver —— 那正是这一层要消灭的事情。所以签名从一开始就是 Promise。
 */

/**
 * 一次 capability 解析所处的上下文。全部字段在一轮 turn 开始时就已确定。
 *
 * `teamId` 是必需的：能力分 global / team / member 三层，Team 级 Provider
 * （比如 `team.filesystem-skills` 的根目录）必须知道「当前是哪个 Team」，
 * 只靠 memberId 表达不出这一层 —— 同一个 Member 可以属于多个 Team，而它在
 * 每个 Team 里继承到的 Team 级能力是不同的。
 */
export interface CapabilityContext {
  teamId: string;
  memberId: string;
  conversationId: string;
  executionId: string;
  userId: string;
  /**
   * 这一轮的性质。可选：不传时不过滤（老调用方与测试照旧）。
   * 生产路径（TeamService.resolveCapabilities）永远传。
   */
  turnMode?: TurnMode;
  /**
   * 本轮的租约代次（fencing token，见 worker-lease.ts）。
   *
   * 它**本身不参与判定** —— 判定用下面的 `assertExecutionActive`。放在这里是为了
   * 让「这一轮由哪一代跑」在工具执行的每一层都可读（审计 / 日志 / 排查）。
   * null / 不传 = 单进程部署，这一层保护不适用。
   */
  fencingToken?: number | null;
  /**
   * 断言「这条 execution 的租约**此刻**仍然属于我们这一代」，不成立就抛。
   *
   * ── 为什么工具也要这一道 ─────────────────────────────────────────────
   *
   * 租约只决定谁可以跑；`fencing_token` 决定旧 worker 还能不能**写回 DB**。
   * 但工具产生的是**外部副作用** —— Jira 评论、工单流转。那些不经过我们的
   * 条件写入，写出去就收不回来。
   *
   * 所以工具路径上必须在两个时刻各断言一次：
   *
   *   执行前  租约已经丢了 → 连这一次外部写入都不该发出去
   *   执行后  这段时间里被夺走 → 结果**不能**交回模型（另一个副本正在跑同一件事，
   *           两边同时产出结果就是双写）
   *
   * 它拦不住「已经发出去的 HTTP 请求」—— 那要靠 Command 的 unknown + 对账
   * （见 command-service.ts 的 reconcile）。这里做的是「不再产生新的副作用」
   * 和「不再使用可能已经过期的结果」，两件事都比事后补救便宜。
   *
   * 不传 = 单进程，这一层不适用（与 lease 参数的约定一致）。
   */
  assertExecutionActive?: () => void;
}

// ------------------------------------------------------------------- Skill

export interface SkillArtifact {
  providerId: string;
  name: string;
  description: string;
  /** 磁盘目录 / 远端物化后的目录。直接作为 SDK 的 skillDirectories 元素。 */
  directory: string;
  /** 内容指纹。Provider 自己决定粒度 —— 只要「内容变了版本就变」成立。 */
  version: string;
}

export interface SkillProvider {
  readonly id: string;
  readonly version: string;

  resolve(context: CapabilityContext, binding: CapabilityBinding): Promise<SkillArtifact[]>;
}

// --------------------------------------------------------------- Knowledge

export type KnowledgeAuthority = 'authoritative' | 'approved' | 'reference';

export interface KnowledgeSource {
  providerId: string;
  /** Provider 内部的 source id（本地就是 knowledge_base.id）。 */
  id: string;
  name: string;
  description: string;
  scope: 'team' | 'personal' | 'enterprise';
  authority?: KnowledgeAuthority;
}

/**
 * 一条检索命中。
 *
 * `documentRef` 是**回调 open() 用的不透明引用**，不是给人看的。它由 Provider
 * 自己定义（本地是文档 id），调用方只负责原样传回。
 */
export interface KnowledgeSearchHit {
  providerId: string;
  documentRef: string;
  sourceId: string;
  sourceName: string;
  title: string;
  snippet: string;
  /** 稳定引用标记，模型在结论里保留它。本地格式为 [KB:<key>/<documentId>]。 */
  citation: string;
  sourceUri: string | null;
  authority?: KnowledgeAuthority;
}

export interface KnowledgeDocument {
  providerId: string;
  documentRef: string;
  sourceId: string;
  title: string;
  content: string;
  citation: string;
  sourceUri: string | null;
}

export interface KnowledgeProvider {
  readonly id: string;
  readonly version: string;

  /** 这条 binding 在这个 Member 身上实际指向哪些资料源。也是 prompt 清单的来源。 */
  listSources(
    context: CapabilityContext,
    binding: CapabilityBinding,
  ): Promise<KnowledgeSource[]>;

  search(
    context: CapabilityContext,
    binding: CapabilityBinding,
    query: string,
    limit: number,
  ): Promise<KnowledgeSearchHit[]>;

  /**
   * 读整份文档。
   *
   * `documentRef` 来自模型（可能被检索到的内容或提示词操纵），所以 Provider
   * **必须在这里重新做一次 ACL** —— 不能假设「它是从 search 回来的就一定是
   * 它能看的」。
   */
  open(context: CapabilityContext, documentRef: string): Promise<KnowledgeDocument>;
}

/** 一条 binding 解析后的结果：Provider 本体 + 原始 binding + 它能看到的源。 */
export interface ResolvedKnowledgeBinding {
  provider: KnowledgeProvider;
  binding: CapabilityBinding;
  sources: KnowledgeSource[];
}

// -------------------------------------------------------------------- Tool

export type ToolKind = 'custom' | 'builtin';

/**
 * 工具的**固有性质**，不是「这个 Member 能不能用」。
 *
 * 授权层只看它 + provider + requiresHostAccess，不再出现 `if (name === 'bash')`。
 * 新增一组工具时只需要在 Provider 里声明 risk，不需要改 Policy。
 */
export type ToolRisk =
  | 'read'
  | 'self-write'
  | 'coordination'
  | 'external-read'
  | 'external-write'
  | 'host-execution'
  | 'privileged';

/**
 * 工具的**实现来源** —— 这段代码跑在哪里、信任边界在谁手里。
 *
 * 不写它，audit 只能从 Provider ID 猜（`runtime.host-coding-tools` 是内置的还是
 * 远端的？）；manifest 里有了它，「这一轮调用的工具由谁执行」才是一条可查的记录。
 * 它是声明事实，不参与授权判定 —— 放不放行仍然只看 risk / guard / Policy。
 */
export type ToolImplementation = 'app' | 'copilot-builtin' | 'mcp' | 'http' | 'script' | 'sdk';

/**
 * 一次工具调用的判定结果。
 *
 * ── 为什么除了 allowed / reason 还要带这些 id ─────────────────────────
 *
 * `allowed` 只回答「这次行不行」，回答不了合规要问的三件事：
 *
 *   policyDecisionId / policyRevision         谁批的、按哪版政策批的
 *   entitlementId / entitlementRevision       命中了哪条数据授权
 *   approvalRequired                          是「不许」还是「要人批」
 *
 * 没有它们时，审计只能记下「调用了 jira_add_comment 并被拒」—— 而「被哪条
 * 规则拒的」正是事后排查与合规检查唯一的入口。这些字段由 tool-policy 逐层
 * 填进来，最终落到 `tool_execution_audit` / `policy_decision_audit`。
 *
 * 全部可选：guard 与低风险路径没有 Policy / Entitlement 决策可报，
 * 强行给它们编一个 id 会让「有 id = 过了那道闸」这条推断失效。
 */
export interface ToolDecision {
  allowed: boolean;
  /** 允许或拒绝的理由。拒绝时必须写清楚为什么，它会进日志。 */
  reason: string;

  policyDecisionId?: string;
  entitlementId?: string;
  policyRevision?: string;
  entitlementRevision?: string;

  approvalRequired?: boolean;
}

export interface CapabilityToolArguments {
  [key: string]: unknown;
}

export interface ToolExecutionContext extends CapabilityContext {
  toolName: string;
}

/** `defineTool` 接受的参数 schema —— 直接引用 SDK 的类型，不自己发明一份。 */
type ToolParameters = NonNullable<Parameters<typeof defineTool>[1]>['parameters'];

export interface RuntimeTool {
  providerId: string;
  /** 实现来源（见 ToolImplementation）。audit 用，授权判定不看它。 */
  implementation: ToolImplementation;
  kind: ToolKind;
  name: string;
  description: string;
  risk: ToolRisk;
  /**
   * true = 这个工具会触达宿主机（文件系统、shell、网络），因此**部署层**必须
   * 显式放行（HOST_CODING_TOOLS）。它是部署前提，不是 Member 能自己声明的东西。
   */
  requiresHostAccess?: boolean;
  /**
   * 这个工具只在哪些 turn 里可见。不填 = 所有 turn 可见。
   *
   * 这只是「少给」：隐藏不等于授权，真正的 Lead 检查仍在 TeamService
   * （planTasks / addTask / reassignTask / requestClarification）里，
   * 绕过可见性直接调 host 也会被拦下。可以减少能力，不能提升权限。
   */
  availableTo?: TurnMode[];
  /** custom tool 必填。 */
  parameters?: ToolParameters;
  /** custom tool 必填。builtin 由引擎自己执行。 */
  execute?: (
    context: ToolExecutionContext,
    args: CapabilityToolArguments,
  ) => Promise<unknown> | unknown;
  /**
   * Provider 对**输入边界**的逐次判定（路径是否在 workspace 内、参数格式是否
   * 合法）。guard 可以拒绝任何一次调用，但它的「允许」只对低风险工具有效：
   * external-write / privileged 的放行权在 PolicyService，Provider 不能自己
   * 批准自己 —— 「执行动作的人」不能同时当「批准动作的人」。
   */
  guard?: (
    context: ToolExecutionContext,
    args: CapabilityToolArguments,
  ) => Promise<ToolDecision> | ToolDecision;
}

/** Tool Provider 解析时能看到的东西：Member 的全部能力 + 已解析的 knowledge。 */
export interface ToolProviderContext extends CapabilityContext {
  memberCapabilities: MemberCapabilities;
  knowledge: ResolvedKnowledgeBinding[];
}

export interface ToolProvider {
  readonly id: string;
  readonly version: string;

  resolve(context: ToolProviderContext, binding: CapabilityBinding): Promise<RuntimeTool[]>;
}

// ----------------------------------------------------------------- Runtime

/**
 * selector 语义：空 = 全部；否则是名字清单（逗号/空白分隔）。
 *
 * skill 与 tool 共用这一套：模板里写 `research, security-review` 与
 * `research security-review` 是同一件事，不值得为分隔符定第二种语法。
 * 它放在这一层而不是某个 Provider 里，是因为「怎么切分」是契约，
 * 「切出来的名字什么意思」才是各 Provider 自己的语义。
 */
export function parseSelectorList(selector: string | undefined): Set<string> | null {
  if (!selector?.trim()) return null;
  const names = selector
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

/**
 * 一轮 turn 真正生效的能力。
 *
 * 它是「解析」与「执行」之间唯一的中间物：引擎只拿到这个，看不到任何 Provider。
 * `manifestHash` 落在 execution 快照里，回答「这一轮到底用了哪个能力实现」。
 */
/**
 * 一轮生效的 MCP Server（定义的子集 + 本轮选中的工具）。
 *
 * 只带引擎需要的东西：连接字段进 sessionConfig，risk 进授权判定，
 * version 进 manifest。secret（headers / env 的值）不进快照、不进日志。
 */
export interface RuntimeMcpServer {
  id: string;
  displayName: string;
  type: 'local' | 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  /** 本轮允许的工具（已排序，manifest 稳定）。 */
  tools: string[];
  toolPolicies: Record<string, ToolRisk>;
  version: string;
  /**
   * 开关。停用的 server 不会出现在解析结果里（resolver 直接跳过并警告一次），
   * 所以 manifest 里永远只有实际生效的 —— 关掉它不需要改每一层的 binding。
   */
  enabled: boolean;
}

export interface RuntimeCapabilities {
  skills: SkillArtifact[];
  knowledge: ResolvedKnowledgeBinding[];
  tools: RuntimeTool[];
  mcpServers: RuntimeMcpServer[];
  /** 按名字索引，授权判定用它 —— 名字来自引擎，必须能反查到声明的性质。 */
  toolIndex: Map<string, RuntimeTool>;
  /**
   * MCP 工具的候选索引：别名 → 同名候选。SDK 的 wire 名（`github-search_code`）
   * 只是其中一种，引擎实际报上来的名字按哪种写，取决于 SDK 版本 ——
   * 所以一个工具挂多个别名，命中多个时按歧义拒绝。
   */
  mcpToolIndex: Map<string, RuntimeTool[]>;
  manifestHash: string;
}
