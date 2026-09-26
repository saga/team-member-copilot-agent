import type { MemberCapabilities } from '../domain.js';
import type { KnowledgeProvider, SkillProvider, ToolProvider } from './types.js';

export interface ProviderDescriptor {
  kind: 'skill' | 'knowledge' | 'tool';
  id: string;
  version: string;
}

/**
 * Provider 注册表。
 *
 * 它是「有哪些能力实现可用」的**唯一**答案来源。三个 Map 而不是一个：三类
 * Provider 的契约完全不同，混在一张表里只能靠字符串前缀再分一次，等于把类型
 * 系统已经保证过的事情改回运行时判断。
 *
 * ── 为什么重复注册直接抛 ──────────────────────────────────────────────
 *
 * Provider ID 是 Member binding 指向的稳定契约。同一个 ID 注册两次，意味着
 * 「某个 Member 的能力实现取决于注册顺序」—— 装配代码里多写一行就会静默改变
 * 谁在用哪个实现。宁可启动就失败。
 *
 * ── 为什么查不到也抛 ─────────────────────────────────────────────────
 *
 * 未注册的 Provider ID 出现在 Member 的能力里，说明数据与部署已经漂移（比如
 * 换了构建、少了某个 Provider 插件）。这时**不能静默降级成「没有这个能力」**：
 * 一个安全评审 Member 少了一个知识源，它会照常回答，只是答案不再有依据。
 */
export class CapabilityRegistry {
  private readonly skills = new Map<string, SkillProvider>();
  private readonly knowledge = new Map<string, KnowledgeProvider>();
  private readonly tools = new Map<string, ToolProvider>();

  registerSkillProvider(provider: SkillProvider): void {
    this.assertProviderIdAvailable(provider.id);
    this.skills.set(provider.id, provider);
  }

  registerKnowledgeProvider(provider: KnowledgeProvider): void {
    this.assertProviderIdAvailable(provider.id);
    this.knowledge.set(provider.id, provider);
  }

  registerToolProvider(provider: ToolProvider): void {
    this.assertProviderIdAvailable(provider.id);
    this.tools.set(provider.id, provider);
  }

  /**
   * Provider ID 跨三类全局唯一。
   *
   * binding 里只有 `providerId`，没有类型 —— 类型由 binding 所在的数组表达。
   * 同一个 ID 同时出现在两类里时，`providerId` 就不再指向唯一的实现，
   * 「按 ID 谈论一个 Provider」这件事（审计、管理界面、远程策略）失去根基。
   */
  private assertProviderIdAvailable(id: string): void {
    for (const [kind, map] of [
      ['skill', this.skills],
      ['knowledge', this.knowledge],
      ['tool', this.tools],
    ] as const) {
      if (map.has(id)) {
        throw new Error(`重复 Capability Provider：${id}（已被 ${kind} Provider 占用）`);
      }
    }
  }

  skillProvider(id: string): SkillProvider {
    const provider = this.skills.get(id);
    if (!provider) throw new Error(`未注册 Skill Provider：${id}`);
    return provider;
  }

  knowledgeProvider(id: string): KnowledgeProvider {
    const provider = this.knowledge.get(id);
    if (!provider) throw new Error(`未注册 Knowledge Provider：${id}`);
    return provider;
  }

  toolProvider(id: string): ToolProvider {
    const provider = this.tools.get(id);
    if (!provider) throw new Error(`未注册 Tool Provider：${id}`);
    return provider;
  }

  listProviderIds(): { skills: string[]; knowledge: string[]; tools: string[] } {
    return {
      skills: [...this.skills.keys()].sort(),
      knowledge: [...this.knowledge.keys()].sort(),
      tools: [...this.tools.keys()].sort(),
    };
  }

  /** 平台当前装了哪些 Provider。管理界面据此列选项，而不是去猜 ID。 */
  listProviders(): ProviderDescriptor[] {
    const descriptors: ProviderDescriptor[] = [];
    for (const [id, provider] of this.skills) {
      descriptors.push({ kind: 'skill', id, version: provider.version });
    }
    for (const [id, provider] of this.knowledge) {
      descriptors.push({ kind: 'knowledge', id, version: provider.version });
    }
    for (const [id, provider] of this.tools) {
      descriptors.push({ kind: 'tool', id, version: provider.version });
    }
    return descriptors.sort((a, b) =>
      `${a.kind}\u0000${a.id}`.localeCompare(`${b.kind}\u0000${b.id}`),
    );
  }

  /**
   * 校验一份能力组成的 Provider ID 都存在。
   *
   * 只校验「这个 Provider 有没有」，不校验 selector 指向的资料源存不存在 ——
   * 那是 Provider 自己的语义（三类 Provider 的 selector 含义完全不同），
   * 注册表没有资格解释它。
   *
   * 名字不带 Member：它校验的是任意一层（global / team / member）的能力组成，
   * 而这三层用的是同一份契约。带 Member 会让「校验 global 层」读起来像是在
   * 校验某个人的东西。
   */
  validateCapabilities(capabilities: MemberCapabilities): void {
    for (const binding of capabilities.skills) this.skillProvider(binding.providerId);
    for (const binding of capabilities.knowledge) this.knowledgeProvider(binding.providerId);
    for (const binding of capabilities.tools) this.toolProvider(binding.providerId);
  }
}
