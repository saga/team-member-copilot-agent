import type { MemberCapabilities } from '../domain.js';
import type { KnowledgeProvider, SkillProvider, ToolProvider } from './types.js';

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
    if (this.skills.has(provider.id)) {
      throw new Error(`重复 Skill Provider：${provider.id}`);
    }
    this.skills.set(provider.id, provider);
  }

  registerKnowledgeProvider(provider: KnowledgeProvider): void {
    if (this.knowledge.has(provider.id)) {
      throw new Error(`重复 Knowledge Provider：${provider.id}`);
    }
    this.knowledge.set(provider.id, provider);
  }

  registerToolProvider(provider: ToolProvider): void {
    if (this.tools.has(provider.id)) {
      throw new Error(`重复 Tool Provider：${provider.id}`);
    }
    this.tools.set(provider.id, provider);
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

  /**
   * 校验一份能力组成的 Provider ID 都存在。
   *
   * 只校验「这个 Provider 有没有」，不校验 selector 指向的资料源存不存在 ——
   * 那是 Provider 自己的语义（三类 Provider 的 selector 含义完全不同），
   * 注册表没有资格解释它。
   */
  validateMemberCapabilities(capabilities: MemberCapabilities): void {
    for (const binding of capabilities.skills) this.skillProvider(binding.providerId);
    for (const binding of capabilities.knowledge) this.knowledgeProvider(binding.providerId);
    for (const binding of capabilities.tools) this.toolProvider(binding.providerId);
  }
}
