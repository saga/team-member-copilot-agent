import type { defineTool } from '@github/copilot-sdk';
import type { CapabilityBinding, MemberCapabilities } from '../domain.js';

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

export interface ToolDecision {
  allowed: boolean;
  /** 允许或拒绝的理由。拒绝时必须写清楚为什么，它会进日志。 */
  reason: string;
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
 * 一轮 turn 真正生效的能力。
 *
 * 它是「解析」与「执行」之间唯一的中间物：引擎只拿到这个，看不到任何 Provider。
 * `manifestHash` 落在 execution 快照里，回答「这一轮到底用了哪个能力实现」。
 */
export interface RuntimeCapabilities {
  skills: SkillArtifact[];
  knowledge: ResolvedKnowledgeBinding[];
  tools: RuntimeTool[];
  /** 按名字索引，授权判定用它 —— 名字来自引擎，必须能反查到声明的性质。 */
  toolIndex: Map<string, RuntimeTool>;
  manifestHash: string;
}
