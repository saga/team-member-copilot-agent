import type { MemberCapabilities } from '../domain.js';
import type { CapabilityRegistry } from './registry.js';
import type { SkillService } from '../skill-service.js';
import {
  PERSONAL_SELECTOR,
  type LocalFilesystemKnowledgeProvider,
} from './providers/filesystem-knowledge.js';
import { parseSelectorList, type RuntimeTool, type ToolRisk } from './types.js';

/**
 * 管理员看到的能力目录。
 *
 * 它和 `CapabilityRegistry` 回答的是两个不同的问题：
 *
 *   Registry  「系统内部注册了什么 Provider？」（providerId + selector）
 *   Catalog   「管理员可以配置什么？」（Skill / Knowledge / Action 的名字）
 *
 * 内部模型（provider_id + selector）继续留在 SQLite 与 Resolver 里，
 * 这里只做一件事：两边互相翻译。前者是运行时治理，后者是配置界面。
 */

export type CatalogScope = 'global' | 'team' | 'member';

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface CatalogKnowledge {
  id: string;
  name: string;
  description: string;
  scope: 'team' | 'personal';
  documentCount: number;
  enabled: boolean;
}

export interface CatalogTool {
  /** 运行时工具名（`ask_member`）。配置与执行用同一个名字，不再发明第二套 ID。 */
  id: string;
  displayName: string;
  group: string;
  description: string;
  risk: ToolRisk;
  requiresHostAccess: boolean;
  /** external-write / privileged 落到 Policy，需要独立审批。 */
  needsApproval: boolean;
  /** 这一层有没有选中它。 */
  enabled: boolean;
  /**  false = 选了也用不了（部署没放行）。界面据此显示原因，而不是让用户猜。 */
  available: boolean;
  unavailableReason?: string;
}

/** Member 视角下从上层继承来的能力：只读展示，不在这里改。 */
export interface CatalogInheritedRef {
  id: string;
  name: string;
  from: 'company' | 'team';
}

export interface ScopeCatalog {
  scope: CatalogScope;
  skills: CatalogSkill[];
  knowledge: CatalogKnowledge[];
  tools: CatalogTool[];
  /** 只有 member scope 有：上面两层给了什么。 */
  inherited?: {
    skills: CatalogInheritedRef[];
    knowledge: CatalogInheritedRef[];
    tools: CatalogInheritedRef[];
  };
}

/** 管理员提交的选择：三种用户语言的 ID 数组，不含 providerId / selector。 */
export interface CatalogSelection {
  skills: string[];
  knowledge: string[];
  tools: string[];
}

export interface CatalogQuery {
  scope: CatalogScope;
  teamId: string;
  memberId?: string;
}

/**
 * 路由层给 Catalog 的能力读取口。
 *
 * 刻意不用 `CapabilityService` 本体：路由手里的是 `TeamService`（它只暴露
 * getGlobalCapabilities / getTeamCapabilities / getMemberCapabilities），
 * 这里用结构类型接住它，不给 TeamService 加新方法。
 */
export interface CatalogCapabilityReader {
  getGlobal(): MemberCapabilities;
  getTeam(teamId: string): MemberCapabilities;
  getMember(memberId: string): MemberCapabilities;
}

export interface CatalogDeps {
  capabilities: CatalogCapabilityReader;
  skills: SkillService;
  knowledge: LocalFilesystemKnowledgeProvider;
  registry: CapabilityRegistry;
  hostToolsEnabled: boolean;
}

/** Skill 的用户 ID：目录名即身份（重名本来就会在 Resolver 里冲突）。 */
export const skillIdOf = (name: string): string => `skill.${name}`;

/** Team 资料库的用户 ID。 */
export const knowledgeIdOfKey = (key: string): string => `kb.${key}`;

/** 个人资料库的用户 ID。后端的 `$personal` 写法永远只存在内部。 */
export const PERSONAL_KNOWLEDGE_ID = 'kb.personal';

/** 知识检索网关：Knowledge 能力的内部实现，不出现在配置里。 */
const KNOWLEDGE_TOOLS_ID = 'knowledge.tools';

const INTERNAL_TOOL_PROVIDERS: ReadonlySet<string> = new Set([KNOWLEDGE_TOOLS_ID]);

/**
 * 工具的用户级展示名与分组。
 *
 * risk / description / requiresHostAccess 来自 Provider 的实时解析，
 * 这里只补「人话标题 + 分组」—— UI 不许自己 `if (name === 'ask_member')` 猜。
 * Provider 新增了这里没有的工具时按原名进 `Other` 组，不会凭空消失。
 */
const TOOL_DISPLAY: Record<string, { displayName: string; group: string }> = {
  ask_member: { displayName: 'Ask another member', group: 'Team collaboration' },
  message_member: { displayName: 'Message another member', group: 'Team collaboration' },
  remember_member: { displayName: 'Remember information', group: 'Memory' },
  bash: { displayName: 'Run commands', group: 'Workspace & Web' },
  edit: { displayName: 'Edit files', group: 'Workspace & Web' },
  grep: { displayName: 'Search files', group: 'Workspace & Web' },
  web_fetch: { displayName: 'Fetch web content', group: 'Workspace & Web' },
  jira_search: { displayName: 'Search Jira issues', group: 'Jira' },
  jira_get_issue: { displayName: 'View Jira issue', group: 'Jira' },
  jira_add_comment: { displayName: 'Add Jira comment', group: 'Jira' },
  jira_transition_issue: { displayName: 'Change Jira status', group: 'Jira' },
};

/** 三层 skill Provider 与 scope 的对应。内容落盘位置与能力的三层一一对应。 */
function skillProviderIdOf(scope: CatalogScope): string {
  switch (scope) {
    case 'global':
      return 'global.filesystem-skills';
    case 'team':
      return 'team.filesystem-skills';
    case 'member':
      return 'member.filesystem-skills';
  }
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function readOwn(
  deps: CatalogDeps,
  query: CatalogQuery,
): MemberCapabilities {
  switch (query.scope) {
    case 'global':
      return deps.capabilities.getGlobal();
    case 'team':
      return deps.capabilities.getTeam(query.teamId);
    case 'member':
      if (!query.memberId) throw badRequest('member scope 需要 memberId');
      return deps.capabilities.getMember(query.memberId);
  }
}

function listInstalled(deps: CatalogDeps, query: CatalogQuery) {
  switch (query.scope) {
    case 'global':
      return deps.skills.list({ kind: 'global' });
    case 'team':
      return deps.skills.list({ kind: 'team', teamId: query.teamId });
    case 'member':
      if (!query.memberId) throw badRequest('member scope 需要 memberId');
      return deps.skills.list({ kind: 'member', memberId: query.memberId });
  }
}

/** 某一层里「这个 skill Provider 选中了哪些名字」。null = 全部。undefined = 没绑。 */
function enabledSkillNames(
  own: MemberCapabilities,
  scope: CatalogScope,
): Set<string> | null | undefined {
  const binding = own.skills.find(
    (item) => item.providerId === skillProviderIdOf(scope),
  );
  if (!binding) return undefined;
  return parseSelectorList(binding.selector);
}

interface VisibleTool {
  providerId: string;
  tool: RuntimeTool;
}

/**
 * 当前注册表中管理员可见的全部工具（实时解析，risk 等声明以它为准）。
 *
 * 传一个合成上下文：core / host / jira 的解析都不依赖调用方，
 * knowledge 网关在这里不需要（它是内部工具，直接跳过）。
 */
async function resolveVisibleTools(
  deps: CatalogDeps,
  query: CatalogQuery,
): Promise<VisibleTool[]> {
  const result: VisibleTool[] = [];
  for (const providerId of deps.registry.listProviderIds().tools) {
    if (INTERNAL_TOOL_PROVIDERS.has(providerId)) continue;
    const provider = deps.registry.toolProvider(providerId);
    const resolved = await provider.resolve(
      {
        teamId: query.teamId,
        memberId: query.memberId ?? 'catalog',
        conversationId: 'catalog',
        executionId: 'catalog',
        userId: 'catalog',
        memberCapabilities: { skills: [], knowledge: [], tools: [] },
        knowledge: [],
      },
      { providerId },
    );
    for (const tool of resolved) result.push({ providerId, tool });
  }
  return result;
}

function toCatalogTool(
  entry: VisibleTool,
  enabled: boolean,
  hostToolsEnabled: boolean,
): CatalogTool {
  const display = TOOL_DISPLAY[entry.tool.name];
  const available = entry.tool.requiresHostAccess ? hostToolsEnabled : true;
  return {
    id: entry.tool.name,
    displayName: display?.displayName ?? entry.tool.name,
    group: display?.group ?? 'Other',
    description: entry.tool.description,
    risk: entry.tool.risk,
    requiresHostAccess: entry.tool.requiresHostAccess ?? false,
    needsApproval: entry.tool.risk === 'external-write' || entry.tool.risk === 'privileged',
    enabled,
    available,
    ...(available
      ? {}
      : {
          unavailableReason:
            '当前部署未启用宿主工具（HOST_CODING_TOOLS），部署放行后才可用',
        }),
  };
}

/** 某一层 tools 绑定里「这个 Provider 选中了哪些工具名」。undefined = 没绑。 */
function enabledToolNames(
  own: MemberCapabilities,
  providerId: string,
): Set<string> | null | undefined {
  const binding = own.tools.find((item) => item.providerId === providerId);
  if (!binding) return undefined;
  return parseSelectorList(binding.selector);
}

/**
 * 读一层的目录：管理员在这一层能配什么、选中了什么。
 *
 * 未连接的外部系统（比如没配 Jira）直接不出现 —— 「连了什么」是 Connections
 * 的事，Catalog 只回答已注册的实现。没出现 ≠ 不支持。
 */
export async function buildCatalog(
  deps: CatalogDeps,
  query: CatalogQuery,
): Promise<ScopeCatalog> {
  const own = readOwn(deps, query);
  const installed = listInstalled(deps, query);

  const skillEnabled = enabledSkillNames(own, query.scope);
  const skills: CatalogSkill[] = installed.map((skill) => ({
    id: skillIdOf(skill.name),
    name: skill.name,
    description: skill.description,
    enabled: skillEnabled === undefined ? false : skillEnabled === null ? true : skillEnabled.has(skill.name),
  }));

  const knowledgeBindings = own.knowledge.filter(
    (binding) => binding.providerId === deps.knowledge.id,
  );
  const teamBases = deps.knowledge.listTeamKnowledgeBases();
  const knowledge: CatalogKnowledge[] = teamBases.map((kb) => ({
    id: knowledgeIdOfKey(kb.key),
    name: kb.name,
    description: kb.description,
    scope: 'team' as const,
    documentCount: deps.knowledge.countDocuments(kb.id),
    enabled: knowledgeBindings.some((binding) => binding.selector === kb.key),
  }));
  // 已绑定但库行还没建立的 key 也要露出来：binding 先于资料存在（模板开箱即引用），
  // 看不见它的话，管理员既不知道这一层绑了什么，也关不掉它。
  const existingKeys = new Set(teamBases.map((kb) => kb.key));
  for (const binding of knowledgeBindings) {
    if (!binding.selector || binding.selector === PERSONAL_SELECTOR) continue;
    if (existingKeys.has(binding.selector)) continue;
    existingKeys.add(binding.selector);
    knowledge.push({
      id: knowledgeIdOfKey(binding.selector),
      name: binding.selector,
      description: '资料库尚未建立（首次使用时自动建立），当前 0 篇文档',
      scope: 'team' as const,
      documentCount: 0,
      enabled: true,
    });
  }

  if (query.scope === 'member' && query.memberId) {
    const personal = deps.knowledge.personalKnowledgeBaseFor(query.memberId);
    knowledge.push({
      id: PERSONAL_KNOWLEDGE_ID,
      name: personal?.name ?? 'My Personal Knowledge',
      description: personal?.description ?? '这个 Member 的个人资料',
      scope: 'personal' as const,
      documentCount: personal ? deps.knowledge.countDocuments(personal.id) : 0,
      enabled: knowledgeBindings.some((binding) => binding.selector === PERSONAL_SELECTOR),
    });
  }

  const visible = await resolveVisibleTools(deps, query);
  const tools: CatalogTool[] = visible.map((entry) => {
    const enabled = enabledToolNames(own, entry.providerId);
    return toCatalogTool(
      entry,
      enabled === undefined ? false : enabled === null ? true : enabled.has(entry.tool.name),
      deps.hostToolsEnabled,
    );
  });

  if (query.scope !== 'member') return { scope: query.scope, skills, knowledge, tools };

  return {
    scope: query.scope,
    skills,
    knowledge,
    tools,
    inherited: buildInherited(deps, query, visible),
  };
}

/** Member 视角：上面两层给了什么（只读）。选中状态不归这里管。 */
function buildInherited(
  deps: CatalogDeps,
  query: CatalogQuery,
  visible: VisibleTool[],
): NonNullable<ScopeCatalog['inherited']> {
  const layers: Array<{ caps: MemberCapabilities; from: 'company' | 'team' }> = [
    { caps: deps.capabilities.getGlobal(), from: 'company' },
    { caps: deps.capabilities.getTeam(query.teamId), from: 'team' },
  ];

  const skills: CatalogInheritedRef[] = [];
  const globalInstalled = new Set(
    deps.skills.list({ kind: 'global' }).map((skill) => skill.name),
  );
  const teamInstalled = new Set(
    deps.skills.list({ kind: 'team', teamId: query.teamId }).map((skill) => skill.name),
  );
  for (const layer of layers) {
    const enabled =
      layer.from === 'company'
        ? enabledSkillNames(layer.caps, 'global')
        : enabledSkillNames(layer.caps, 'team');
    if (enabled === undefined) continue;
    const installed = layer.from === 'company' ? globalInstalled : teamInstalled;
    for (const name of [...installed].sort()) {
      if (enabled === null || enabled.has(name)) {
        skills.push({ id: skillIdOf(name), name, from: layer.from });
      }
    }
  }

  const teamNames = new Map(
    deps.knowledge.listTeamKnowledgeBases().map((kb) => [kb.key, kb.name]),
  );
  const knowledge: CatalogInheritedRef[] = [];
  for (const layer of layers) {
    for (const binding of layer.caps.knowledge) {
      if (binding.providerId !== deps.knowledge.id || !binding.selector) continue;
      if (binding.selector === PERSONAL_SELECTOR) continue;
      knowledge.push({
        id: knowledgeIdOfKey(binding.selector),
        name: teamNames.get(binding.selector) ?? binding.selector,
        from: layer.from,
      });
    }
  }

  const tools: CatalogInheritedRef[] = [];
  for (const layer of layers) {
    for (const binding of layer.caps.tools) {
      if (INTERNAL_TOOL_PROVIDERS.has(binding.providerId)) continue;
      const names = visible
        .filter((entry) => entry.providerId === binding.providerId)
        .map((entry) => entry.tool.name);
      const only = parseSelectorList(binding.selector);
      for (const name of names) {
        if (only && !only.has(name)) continue;
        const display = TOOL_DISPLAY[name];
        tools.push({ id: name, name: display?.displayName ?? name, from: layer.from });
      }
    }
  }

  return { skills, knowledge, tools };
}

/**
 * 管理员的选择 → 内部绑定。PUT 目录的唯一翻译入口。
 *
 * 三条纪律：
 *   skill 按名字必须装在这一层（没装就 400，别写出一条永远解析为空的绑定）
 *   knowledge 必须是已存在的库（拼错 key 在这里就失败，不等到第一轮 turn）
 *   tool 必须是可见的运行时工具名（内部检索工具不接受点名，它跟着 knowledge 走）
 */
export async function assignmentsToBindings(
  deps: CatalogDeps,
  query: CatalogQuery,
  selection: CatalogSelection,
): Promise<MemberCapabilities> {
  const installed = new Set(listInstalled(deps, query).map((skill) => skill.name));
  const skillNames = [...new Set(selection.skills.map((id) => skillNameOf(id)))];
  for (const name of skillNames) {
    if (!installed.has(name)) throw badRequest(`这一层没有安装这个 skill：${name}`);
  }
  // 选了全部 = 不写 selector（= 全部）：以后这里新装的 skill 自动在范围内。
  // 部分选择才写名单。没选 = 不绑定。
  const skills =
    skillNames.length === 0
      ? []
      : skillNames.length >= installed.size && installed.size > 0
        ? [{ providerId: skillProviderIdOf(query.scope) }]
        : [{ providerId: skillProviderIdOf(query.scope), selector: skillNames.join(' ') }];

  // key 只校验形状、不校验存在：binding 先于资料存在是合法的
  // （模板开箱即引用，库行在首次使用时自动建立）。拼错的 key 在这里只拦形状，
  // 界面本来就只提供已存在的库。
  const knowledge = [...new Set(selection.knowledge)].map((id) => {
    if (id === PERSONAL_KNOWLEDGE_ID) {
      return { providerId: deps.knowledge.id, selector: PERSONAL_SELECTOR };
    }
    const key = knowledgeKeyOf(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) throw badRequest(`知识库 key 不合法：${key}`);
    return { providerId: deps.knowledge.id, selector: key };
  });

  const visible = await resolveVisibleTools(deps, query);
  const byName = new Map(visible.map((entry) => [entry.tool.name, entry.providerId]));
  const toolNames = [...new Set(selection.tools)];
  for (const name of toolNames) {
    if (!byName.has(name)) {
      throw badRequest(
        name === 'search_knowledge' || name === 'open_knowledge_document'
          ? `${name} 是知识库自带的检索工具，选择知识库后自动可用，不需要单独配置`
          : `工具不存在：${name}`,
      );
    }
  }
  // 工具永远写显式名单：Provider 将来多一个工具时，不该静默自动放行。
  const byProvider = new Map<string, string[]>();
  for (const entry of visible) {
    if (!toolNames.includes(entry.tool.name)) continue;
    const list = byProvider.get(entry.providerId) ?? [];
    list.push(entry.tool.name);
    byProvider.set(entry.providerId, list);
  }
  const tools = [...byProvider].map(([providerId, names]) => ({
    providerId,
    selector: names.join(' '),
  }));

  return { skills, knowledge, tools };
}

function skillNameOf(id: string): string {
  if (!id.startsWith('skill.') || id.length <= 'skill.'.length) {
    throw badRequest(`skill ID 不合法：${id}`);
  }
  return id.slice('skill.'.length);
}

function knowledgeKeyOf(id: string): string {
  if (!id.startsWith('kb.') || id.length <= 'kb.'.length) {
    throw badRequest(`knowledge ID 不合法：${id}`);
  }
  const key = id.slice('kb.'.length);
  if (key === 'personal') throw badRequest('个人知识库请使用 kb.personal');
  return key;
}
