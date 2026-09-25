import { hashText } from '../content-hash.js';
import type { MemberCapabilities } from '../domain.js';
import type { CapabilityRegistry } from './registry.js';
import type {
  CapabilityContext,
  ResolvedKnowledgeBinding,
  RuntimeCapabilities,
  RuntimeTool,
  SkillArtifact,
  ToolProviderContext,
} from './types.js';

/**
 * Member 的「能力引用」→「这一轮实际生效的能力」。
 *
 * 它是运行时**唯一**的解析入口：`TeamService.executeMemberTurn()` 里出现
 * `resolve(member, context, capabilities)` 之后，引擎拿到的就只有
 * `RuntimeCapabilities`。任何一处重新去读 `config.teamSkillRoot`、直接调
 * `knowledgeService.searchXxx()` 都是架构回退 —— 那意味着「这一轮用了什么」
 * 又多了一条不经过解析器的路径，而 manifestHash 不会再反映它。
 *
 * ── 冲突即失败 ────────────────────────────────────────────────────────
 *
 * skill 名或 tool 名重复会**直接抛**，不静默去重。两个 Provider 都想注册
 * `search_knowledge` 时，正确结果是装配错误而不是「其中一个赢了」—— 后者会
 * 让「模型调了这个工具」和「另一个实现被调用」同时成立，且没有任何日志。
 */
export class CapabilityResolver {
  constructor(private readonly registry: CapabilityRegistry) {}

  /** 校验 Provider ID 都存在（写能力组成之前调用，把错误挡在落库之前）。 */
  validate(capabilities: MemberCapabilities): void {
    this.registry.validateMemberCapabilities(capabilities);
  }

  /**
   * 解析一轮 turn 的能力。
   *
   * 刻意不收 `Member`：解析器只做「binding → 能力」这一件事，不需要知道这个
   * Member 叫什么、是谁。要 Member 身份的是 manifest 的**使用方**（快照已经记了
   * memberRevision），把它塞进来只会让解析器多一个可用的东西、多一条隐式依赖。
   */
  async resolve(
    context: CapabilityContext,
    capabilities: MemberCapabilities,
  ): Promise<RuntimeCapabilities> {
    this.registry.validateMemberCapabilities(capabilities);

    const skills: SkillArtifact[] = [];
    for (const binding of capabilities.skills) {
      const provider = this.registry.skillProvider(binding.providerId);
      skills.push(...(await provider.resolve(context, binding)));
    }

    const knowledge: ResolvedKnowledgeBinding[] = [];
    for (const binding of capabilities.knowledge) {
      const provider = this.registry.knowledgeProvider(binding.providerId);
      knowledge.push({
        provider,
        binding,
        sources: await provider.listSources(context, binding),
      });
    }

    const toolContext: ToolProviderContext = {
      ...context,
      memberCapabilities: capabilities,
      knowledge,
    };

    const tools: RuntimeTool[] = [];
    for (const binding of capabilities.tools) {
      const provider = this.registry.toolProvider(binding.providerId);
      tools.push(...(await provider.resolve(toolContext, binding)));
    }

    const dedupedSkills = dedupe(skills, (skill) => skill.name, 'Skill');
    const dedupedTools = dedupe(tools, (tool) => tool.name, 'Tool');

    return {
      skills: dedupedSkills,
      knowledge,
      tools: dedupedTools,
      toolIndex: new Map(dedupedTools.map((tool) => [tool.name, tool])),
      manifestHash: manifestHashOf(dedupedSkills, knowledge, dedupedTools),
    };
  }
}

function dedupe<T>(items: T[], keyOf: (item: T) => string, label: string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      throw new Error(
        `${label} 名冲突：${key} —— 两个 Provider 提供了同一个名字。` +
          `这会让「模型调用了它」与「实际执行了哪一个」变成两件无法区分的事。`,
      );
    }
    seen.set(key, item);
  }
  return items;
}

/**
 * 这一轮能力组成的指纹。
 *
 * 覆盖三件事，缺一件就回答不了「这一轮到底用了哪个能力实现」：
 *
 *   Provider 版本   —— 同一个 ID 背后的实现换了一版
 *   selector        —— 同一个 Provider，指向了另一个资料源
 *   工具的声明形状   —— 名字 / risk / 是否需要宿主权限
 *
 * 刻意**不含 memberId**：这个指纹描述的是「能力组成」本身，所以两个配置相同的
 * Member 会得到同一个哈希。带着 memberId 会让「跨成员比较同一套能力」失去意义。
 *
 * 排序保证稳定性：binding 与解析结果都按可比较的键排序后再序列化，否则同一套
 * 能力只要 Provider 注册顺序变了就会算出不同的哈希。
 */
function manifestHashOf(
  skills: SkillArtifact[],
  knowledge: ResolvedKnowledgeBinding[],
  tools: RuntimeTool[],
): string {
  const payload = {
    skills: [...skills]
      .sort(byKey((skill) => `${skill.providerId}\u0000${skill.name}`))
      .map((skill) => ({
        providerId: skill.providerId,
        name: skill.name,
        version: skill.version,
      })),
    knowledge: [...knowledge]
      .sort(byKey((item) => `${item.provider.id}\u0000${item.binding.selector ?? ''}`))
      .map((item) => ({
        providerId: item.provider.id,
        providerVersion: item.provider.version,
        selector: item.binding.selector ?? '',
        sources: item.sources
          .map((source) => ({ id: source.id, authority: source.authority ?? null }))
          .sort(byKey((source) => source.id)),
      })),
    tools: [...tools]
      .sort(byKey((tool) => `${tool.providerId}\u0000${tool.name}`))
      .map((tool) => ({
        providerId: tool.providerId,
        name: tool.name,
        kind: tool.kind,
        risk: tool.risk,
        requiresHostAccess: tool.requiresHostAccess ?? false,
      })),
  };

  return hashText(JSON.stringify(payload));
}

function byKey<T>(keyOf: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => keyOf(a).localeCompare(keyOf(b));
}
