import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolInvocation } from '@github/copilot-sdk';
import { forbidden, notFound } from '../http-error.js';
// 这个模块只 import 类型、不读环境变量，所以可以静态引入（其余模块要等 DATA_DIR 设好）
import { CapabilityRegistry } from '../capabilities/registry.js';

/**
 * 能力层（Skill / Knowledge / Tool）的契约测试。
 *
 * 这一层的存在理由是「引擎与具体实现解耦」，所以这里锁的不是「搜得到」这类
 * 功能，而是**解耦本身成立**所需的性质：
 *
 *   Provider ID 是稳定契约    重复注册 / 未注册都直接失败，不静默选一个
 *   manifest 描述能力组成     相同配置得到相同哈希，且不含 memberId
 *   binding 是唯一能力来源    selector 用 '' 让唯一性真的成立
 *   manifestHash 稳定         排序、版本、selector 变化都要反映出来
 *   声明与授权同源            availableTools 与 toolIndex 出自同一份解析结果
 *   skipPermission 不是授权   策略拒绝时 execute 一次都不能跑
 *   检索范围只由 binding 定   模型的 query 不能扩大它
 *   三层按序合并              global + team + member，且跨层去重
 *   guard 是授权第一道闸      适配器自己跑 guard（不依赖 policy 实现），在 Policy 之前
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-capabilities-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';
// 部署默认：宿主工具收走（要放行得显式打开，见 tool-policy.test.ts）
process.env.HOST_CODING_TOOLS = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { DefaultToolPolicy } = await import('../tool-policy.js');
const { CapabilityResolver } = await import('../capabilities/resolver.js');
const { CopilotCapabilityAdapter } = await import('../capabilities/copilot-adapter.js');
const { PERSONAL_SELECTOR } = await import('../capabilities/providers/filesystem-knowledge.js');
const { createTestStack, capabilityContext, singleExecutionId, StubCopilot } =
  await import('./support.js');

import type { MemberCapabilities } from '../domain.js';
import type { PolicyService } from '../policy.js';
import type { ToolPolicy } from '../tool-policy.js';
import type { ToolExecutionContext } from '../capabilities/types.js';

/** 高风险拒绝桩：与生产 DenyHighRiskPolicyService 同语义，理由可断言。 */
function denyHighRisk(): PolicyService {
  return { decide: (input) => ({ allowed: false, reason: `risk=${input.tool.risk} 需要独立 Policy 决策` }) };
}
import type {
  KnowledgeProvider,
  RuntimeCapabilities,
  RuntimeTool,
  SkillArtifact,
  SkillProvider,
  ToolProvider,
} from '../capabilities/types.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memberService = new MemberService(db);
const stub = new StubCopilot();
const stack = createTestStack(db, memberService, stub.asCopilot);
const capabilities = stack.capabilities;

/** 当前部署的唯一 Team。三层能力里的 team 层挂在它上面。 */
const defaultTeam = stack.structure.ensureDefaultTeam();

const KNOWLEDGE_PROVIDER = 'local.filesystem-knowledge';

/**
 * 直接建 member 行，**不写**能力绑定。
 *
 * 绑定表本身的用例要自己控制那一行，所以走 member-service。
 */
function rawMember(name: string) {
  return memberService.create({ name, handle: name.toLowerCase(), role: 'T' });
}

/**
 * 一个普通 Member 的**Member 层增量**。
 *
 * 注意它不再包含 `team.filesystem-skills` / `team.core-tools` 这类基线能力：
 * 那些是 global / team 层的事（见 `config/capability-templates`）。把基线写进
 * 每个人的私有层，等于让「管理员改 Team 能力」对这些人失效 —— 而且看不出原因。
 */
function memberLayerDefaults(): MemberCapabilities {
  return {
    skills: [{ providerId: 'member.filesystem-skills' }],
    knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
    tools: [{ providerId: 'team.core-tools' }, { providerId: 'knowledge.tools' }],
  };
}

/** 建人并写入 Member 层增量，给只关心单层的用例一个起点。 */
function memberWithDefaults(name: string) {
  const member = stack.team.createMember({ name, role: 'T' });
  capabilities.replaceMember(member.id, memberLayerDefaults());
  return member;
}

/** 绑定读回来是按 (类型, provider, selector) 排序的 —— 顺序不是契约，比较前先归一。 */
function normalized(value: MemberCapabilities): MemberCapabilities {
  const byKey = (a: { providerId: string; selector?: string }, b: { providerId: string; selector?: string }) =>
    `${a.providerId}\u0000${a.selector ?? ''}`.localeCompare(`${b.providerId}\u0000${b.selector ?? ''}`);
  return {
    skills: [...value.skills].sort(byKey),
    knowledge: [...value.knowledge].sort(byKey),
    tools: [...value.tools].sort(byKey),
  };
}

/**
 * 工具 execute 拿到的上下文比能力解析多一个工具名。
 *
 * `teamId` 用真实 Team：本地 knowledge Provider 会拿它去校验 Team 级 binding
 * （`assertTeamExists`），编造的 teamId 会变成 404 而不是「未绑定」。
 */
function toolContext(memberId: string, toolName: string): ToolExecutionContext {
  return { ...capabilityContext(memberId, defaultTeam.id), toolName };
}

// ------------------------------------------------------------------ stubs

/**
 * 只声明形状的 Provider。
 *
 * manifest 的用例要能单独改一个变量（版本 / selector / risk）再看哈希 —— 用真实
 * Provider 就得绕远路去动文件或数据库，那样测出来的是「文件变了哈希就变」，
 * 而不是「声明变了哈希就变」。
 */
function skillProvider(id: string, version = '1', artifacts: SkillArtifact[] = []): SkillProvider {
  return { id, version, resolve: async () => artifacts };
}

function knowledgeProvider(
  id: string,
  version = '1',
  sources: Array<{ id: string; name: string; scope: 'team' | 'personal' | 'enterprise' }> = [],
): KnowledgeProvider {
  return {
    id,
    version,
    listSources: async () =>
      sources.map((source) => ({
        providerId: id,
        id: source.id,
        name: source.name,
        description: '',
        scope: source.scope,
      })),
    search: async () => [],
    open: async () => {
      throw new Error('stub provider 不支持 open');
    },
  };
}

function toolProvider(id: string, version = '1', tools: RuntimeTool[] = []): ToolProvider {
  return { id, version, resolve: async () => tools };
}

function registryOf(parts: {
  skills?: SkillProvider[];
  knowledge?: KnowledgeProvider[];
  tools?: ToolProvider[];
}): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const provider of parts.skills ?? []) registry.registerSkillProvider(provider);
  for (const provider of parts.knowledge ?? []) registry.registerKnowledgeProvider(provider);
  for (const provider of parts.tools ?? []) registry.registerToolProvider(provider);
  return registry;
}

function artifact(providerId: string, name: string): SkillArtifact {
  return { providerId, name, description: `${name} skill`, directory: `/tmp/${name}`, version: '1' };
}

function builtinTool(providerId: string, name: string): RuntimeTool {
  return { providerId, implementation: 'app', kind: 'builtin', name, description: 'stub', risk: 'read' };
}

/** 一份最小的三类能力组成，供 manifest 用例逐项微调。 */
function manifestCapabilities(overrides: Partial<MemberCapabilities> = {}): MemberCapabilities {
  return {
    skills: [{ providerId: 'stub.skills' }],
    knowledge: [{ providerId: 'stub.knowledge', selector: 'alpha' }],
    tools: [{ providerId: 'stub.tools' }],
    ...overrides,
  };
}

/** 与 manifestCapabilities 配套的注册表，改某个 Provider 的实现时整体替换。 */
function manifestRegistry(overrides: {
  skills?: SkillProvider[];
  knowledge?: KnowledgeProvider[];
  tools?: ToolProvider[];
} = {}): CapabilityRegistry {
  return registryOf({
    skills: overrides.skills ?? [skillProvider('stub.skills', '1', [artifact('stub.skills', 'arch')])],
    knowledge:
      overrides.knowledge ??
      [knowledgeProvider('stub.knowledge', '1', [{ id: 'kb-1', name: 'Alpha', scope: 'team' }])],
    tools: overrides.tools ?? [toolProvider('stub.tools', '1', [builtinTool('stub.tools', 'lookup')])],
  });
}

function resolveWith(registry: CapabilityRegistry, value: MemberCapabilities, memberId = 'member-a') {
  return new CapabilityResolver(registry).resolve(capabilityContext(memberId), value);
}

async function manifestHash(
  value: MemberCapabilities,
  registry: CapabilityRegistry = manifestRegistry(),
  memberId = 'member-a',
): Promise<string> {
  return (await resolveWith(registry, value, memberId)).manifestHash;
}

// ═══════════════════════════════════════════════ 1. Registry

describe('Registry：Provider ID 是稳定契约', () => {
  it('查未注册的 ID 直接抛，不静默降级成「没有这个能力」', () => {
    const registry = registryOf({});
    assert.throws(() => registry.skillProvider('ghost'), /未注册 Skill Provider：ghost/);
    assert.throws(() => registry.knowledgeProvider('ghost'), /未注册 Knowledge Provider：ghost/);
    assert.throws(() => registry.toolProvider('ghost'), /未注册 Tool Provider：ghost/);
  });

  it('同一个 ID 跨三类冲突也直接抛（binding 里没有类型，ID 必须全局唯一）', () => {
    // binding 只写 providerId，类型由所在数组表达。同一个 ID 出现在两类里时，
    // 「按 ID 谈论一个 Provider」（审计、管理界面、远程策略）就失去了根基。
    const registry = registryOf({ skills: [skillProvider('foo', '1', [])] });

    assert.throws(
      () => registry.registerKnowledgeProvider(knowledgeProvider('foo')),
      /已被 skill Provider 占用/,
    );
    assert.throws(() => registry.registerToolProvider(toolProvider('foo', '1', [])), /已被 skill Provider 占用/);
  });
});

// ═══════════════════════════════════════════════ 2. Resolver / manifest

describe('manifest：描述能力组成，不描述是谁', () => {
  it('两个配置相同的 Member 得到同一个哈希（manifest 不含 memberId）', async () => {
    const alice = await manifestHash(manifestCapabilities(), manifestRegistry(), 'alice');
    const bob = await manifestHash(manifestCapabilities(), manifestRegistry(), 'bob');
    assert.equal(alice, bob);
  });

  it('binding 顺序不影响哈希（序列化前按 key 排序）', async () => {
    const registry = registryOf({
      skills: [
        skillProvider('s.one', '1', [artifact('s.one', 'a')]),
        skillProvider('s.two', '1', [artifact('s.two', 'b')]),
      ],
    });

    const forward = await manifestHash(
      { skills: [{ providerId: 's.one' }, { providerId: 's.two' }], knowledge: [], tools: [] },
      registry,
    );
    const backward = await manifestHash(
      { skills: [{ providerId: 's.two' }, { providerId: 's.one' }], knowledge: [], tools: [] },
      registry,
    );

    assert.equal(forward, backward);
  });

  it('binding 变化 → 哈希变，即使解析结果一模一样（「配了但失效」不能伪装成「没配」）', async () => {
    // Provider 的 resolve 忽略 selector 时，只记解析结果的话两条配置哈希相同 ——
    // 审计分不清「没配」和「配了但指向的目标不存在」。declared bindings 进哈希。
    const base = await manifestHash(manifestCapabilities());
    const withSelector = await manifestHash(
      manifestCapabilities({ tools: [{ providerId: 'stub.tools', selector: 'other' }] }),
    );

    assert.notEqual(base, withSelector);
  });

  it('Provider 实现版本变化 → 哈希变（同一份 prompt 也可能跑在另一版实现上）', async () => {
    // 9 月 25 日和 9 月 30 日可以是同一份 system prompt、同一份记忆，但一次用
    // 本地 KB、一次用企业搜索 —— 那是两种不同的能力实现。只记 Provider ID
    // 会让这两轮看起来完全一样，而它们的输入根本不同。
    const base = await manifestHash(manifestCapabilities());

    for (const bumped of [
      manifestRegistry({ skills: [skillProvider('stub.skills', '2', [artifact('stub.skills', 'arch')])] }),
      manifestRegistry({
        knowledge: [
          knowledgeProvider('stub.knowledge', '2', [{ id: 'kb-1', name: 'Alpha', scope: 'team' }]),
        ],
      }),
      manifestRegistry({ tools: [toolProvider('stub.tools', '2', [builtinTool('stub.tools', 'lookup')])] }),
    ]) {
      assert.notEqual(await manifestHash(manifestCapabilities(), bumped), base);
    }
  });

  it('Skill 名冲突直接抛，不静默去重', async () => {
    const registry = registryOf({
      skills: [
        skillProvider('s.one', '1', [artifact('s.one', 'shared')]),
        skillProvider('s.two', '1', [artifact('s.two', 'shared')]),
      ],
    });

    await assert.rejects(
      () =>
        resolveWith(registry, {
          skills: [{ providerId: 's.one' }, { providerId: 's.two' }],
          knowledge: [],
          tools: [],
        }),
      /Skill 名冲突：shared/,
    );
  });

  it('Tool 名冲突直接抛，不静默去重', async () => {
    const registry = registryOf({
      tools: [
        toolProvider('t.one', '1', [builtinTool('t.one', 'search_knowledge')]),
        toolProvider('t.two', '1', [builtinTool('t.two', 'search_knowledge')]),
      ],
    });

    await assert.rejects(
      () => resolveWith(registry, { skills: [], knowledge: [], tools: [{ providerId: 't.one' }, { providerId: 't.two' }] }),
      /Tool 名冲突：search_knowledge/,
    );
  });

  it('三类能力都按 binding 逐个解析（skillDirectories / 源清单 / 工具全集）', async () => {
    const resolved = await resolveWith(manifestRegistry(), manifestCapabilities());

    assert.deepEqual(
      resolved.skills.map((skill) => skill.name),
      ['arch'],
    );
    assert.deepEqual(
      resolved.knowledge.map((item) => [item.provider.id, item.binding.selector, item.sources.length]),
      [['stub.knowledge', 'alpha', 1]],
    );
    assert.deepEqual(
      resolved.tools.map((tool) => tool.name),
      ['lookup'],
    );
  });
});

// ═══════════════════════════════════════════════ 3. CapabilityService

describe('CapabilityService：一张表装三层绑定', () => {
  it('replaceMember 是全量替换 Member 层，空数组就是解绑', () => {
    const member = rawMember('Binder');

    capabilities.replaceMember(member.id, {
      skills: [{ providerId: 'team.filesystem-skills' }],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [{ providerId: 'knowledge.tools' }],
    });
    assert.deepEqual(capabilities.getMember(member.id), {
      skills: [{ providerId: 'team.filesystem-skills' }],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [{ providerId: 'knowledge.tools' }],
    });

    assert.deepEqual(capabilities.replaceMember(member.id, { skills: [], knowledge: [], tools: [] }), {
      skills: [],
      knowledge: [],
      tools: [],
    });
  });

  it('replaceMember 推进 member.updated_at —— 能力是 Member 配置的一部分', () => {
    // execution 快照用 `memberRevision`（= updated_at）回答「当时是哪个版本的人」。
    // 只写 binding 不动 updated_at，事后对账会看到「同一个 revision、两组能力」。
    const member = rawMember('Revised');
    db.prepare(`UPDATE member SET updated_at = ? WHERE id = ?`).run('1970-01-01T00:00:00.000Z', member.id);

    capabilities.replaceMember(member.id, memberLayerDefaults());

    assert.notEqual(memberService.get(member.id).updatedAt, '1970-01-01T00:00:00.000Z');
  });

  it('replaceGlobal / replaceTeam 不推进任何 Member 的 updated_at', () => {
    // 反过来的错误更隐蔽：改一次 Team 能力就批量 touch 所有 Member 的
    // updated_at，于是每个 execution 快照里的 memberRevision 都变了 ——
    // 「这个人改过没有」这个问题从此答不出来。
    const member = rawMember('Untouched');
    db.prepare(`UPDATE member SET updated_at = ? WHERE id = ?`).run('1970-01-01T00:00:00.000Z', member.id);

    capabilities.replaceGlobal({ skills: [], knowledge: [], tools: [{ providerId: 'team.core-tools' }] });
    capabilities.replaceTeam(defaultTeam.id, {
      skills: [],
      knowledge: [],
      tools: [{ providerId: 'knowledge.tools' }],
    });

    assert.equal(memberService.get(member.id).updatedAt, '1970-01-01T00:00:00.000Z');

    // 清干净，别把这两层留给后面的用例
    capabilities.replaceGlobal({ skills: [], knowledge: [], tools: [] });
    capabilities.replaceTeam(defaultTeam.id, { skills: [], knowledge: [], tools: [] });
  });

  it("空 selector 只可能存一行（NULL 在主键里互不相等，所以落库用的是 ''）", () => {
    const member = rawMember('Unique');
    capabilities.replaceMember(member.id, {
      skills: [{ providerId: 'member.filesystem-skills' }],
      knowledge: [],
      tools: [],
    });

    // 落库的必须是 ''，不是 NULL：主键里带 selector，而 SQLite 把 NULL 视为
    // 互不相等 —— 用 NULL 表示「空」会让同一个 (scope, type, provider) 能插进
    // 无限多行，唯一性约束形同不存在。
    const stored = db
      .prepare(
        `SELECT selector FROM capability_binding
         WHERE scope_type = 'member' AND scope_id = ? AND capability_type = 'skill'`,
      )
      .get(member.id) as unknown as { selector: string | null } | undefined;
    assert.ok(stored);
    assert.equal(stored.selector, '', '空 selector 必须落成空字符串');

    // 约束真的在，而不是「靠 replace 先删后插所以看不出来」。
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO capability_binding
             (scope_type, scope_id, capability_type, provider_id, selector, created_at)
           VALUES ('member', ?, 'skill', 'member.filesystem-skills', '', 't')`,
        )
        .run(member.id),
    );
  });

  it('selector 是 ACL 的一部分：hasEffectiveKnowledgeBinding 精确匹配', () => {
    const member = rawMember('Scoped');
    capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: 'financial-core' }],
      tools: [],
    });

    const has = (providerId: string, selector: string) =>
      capabilities.hasEffectiveKnowledgeBinding(defaultTeam.id, member.id, providerId, selector);

    assert.equal(has(KNOWLEDGE_PROVIDER, 'financial-core'), true);
    assert.equal(has(KNOWLEDGE_PROVIDER, 'security-controls'), false);
    assert.equal(has(KNOWLEDGE_PROVIDER, ''), false);
    assert.equal(has('other.provider', 'financial-core'), false);
  });
});

// ═══════════════════════════════════════════════ 4. 三层组合

describe('Capability scope layering', () => {
  it('global + team + member 按层合并', () => {
    const member = memberWithDefaults('Layered');

    capabilities.replaceGlobal({
      skills: [{ providerId: 'global.filesystem-skills' }],
      knowledge: [],
      tools: [{ providerId: 'team.core-tools' }],
    });

    capabilities.replaceTeam(defaultTeam.id, {
      skills: [{ providerId: 'team.filesystem-skills' }],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: 'financial-core' }],
      tools: [{ providerId: 'knowledge.tools' }],
    });

    capabilities.replaceMember(member.id, {
      skills: [{ providerId: 'member.filesystem-skills' }],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [],
    });

    const effective = capabilities.getEffective(defaultTeam.id, member.id);

    // 顺序是契约：global 是基线，member 是增量。反过来会让「这个能力是哪一层
    // 给的」在 UI 上呈现成随机顺序。
    assert.deepEqual(
      effective.skills.map((item) => item.providerId),
      ['global.filesystem-skills', 'team.filesystem-skills', 'member.filesystem-skills'],
    );

    assert.deepEqual(
      normalized(effective).knowledge,
      normalized({
        skills: [],
        tools: [],
        knowledge: [
          { providerId: KNOWLEDGE_PROVIDER, selector: 'financial-core' },
          { providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR },
        ],
      }).knowledge,
    );

    assert.deepEqual(
      effective.tools.map((item) => item.providerId),
      ['team.core-tools', 'knowledge.tools'],
    );

    // 清干净，别把这三层留给后面的用例
    capabilities.replaceGlobal({ skills: [], knowledge: [], tools: [] });
    capabilities.replaceTeam(defaultTeam.id, { skills: [], knowledge: [], tools: [] });
    capabilities.replaceMember(member.id, { skills: [], knowledge: [], tools: [] });
  });

  it('相同 binding 在不同 scope 出现时只解析一次', () => {
    // 三层去重的键是 (providerId, selector)：同一个资料源同时挂在公司级和
    // Team 级时，Agent 不该拿到两条一模一样的引用 —— 那会让「一次检索覆盖
    // 两个源」变成「同一个源被检索两次」。
    const member = memberWithDefaults('DuplicateLayer');
    const sameKnowledge = { providerId: KNOWLEDGE_PROVIDER, selector: 'financial-core' };

    capabilities.replaceGlobal({ skills: [], knowledge: [sameKnowledge], tools: [] });
    capabilities.replaceTeam(defaultTeam.id, { skills: [], knowledge: [sameKnowledge], tools: [] });
    capabilities.replaceMember(member.id, { skills: [], knowledge: [sameKnowledge], tools: [] });

    const effective = capabilities.getEffective(defaultTeam.id, member.id);

    assert.equal(effective.knowledge.length, 1);

    capabilities.replaceGlobal({ skills: [], knowledge: [], tools: [] });
    capabilities.replaceTeam(defaultTeam.id, { skills: [], knowledge: [], tools: [] });
    capabilities.replaceMember(member.id, { skills: [], knowledge: [], tools: [] });
  });

  it('getConfig 同时给出三层声明与合并结果（界面靠它回答「谁给的」）', () => {
    const member = memberWithDefaults('Configured');
    capabilities.replaceGlobal({ skills: [], knowledge: [], tools: [{ providerId: 'team.core-tools' }] });

    const config = capabilities.getConfig(defaultTeam.id, member.id);

    assert.deepEqual(config.global.tools, [{ providerId: 'team.core-tools' }]);
    assert.deepEqual(config.team, { skills: [], knowledge: [], tools: [] });
    assert.deepEqual(config.member.skills, [{ providerId: 'member.filesystem-skills' }]);
    assert.deepEqual(
      config.effective.tools.map((item) => item.providerId),
      ['team.core-tools', 'knowledge.tools'],
    );

    capabilities.replaceGlobal({ skills: [], knowledge: [], tools: [] });
  });
});

// ═══════════════════════════════════════════════ 5. Adapter

describe('Adapter：声明与授权同源', () => {
  const policy = new DefaultToolPolicy({ allowHostTools: false }, denyHighRisk());
  const adapter = new CopilotCapabilityAdapter(policy);
  const context = capabilityContext('adapter-member');

  it('声明出来的集合 = 解析出来的工具集合（同源，不会自己漂移）', async () => {
    const member = memberWithDefaults('Adapter');
    const withHost = capabilities.getMember(member.id);
    withHost.tools.push({ providerId: 'runtime.host-coding-tools' });
    capabilities.replaceMember(member.id, withHost);

    const runtime = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      capabilities.getMember(member.id),
    );
    const declared = new Set(adapter.build(runtime, context).availableTools.toArray());

    assert.ok(runtime.tools.length > 0);
    for (const tool of runtime.tools) {
      const qualified = `${tool.kind}:${tool.name}`;
      if (policy.hostToolWithheld(tool)) {
        assert.equal(declared.has(qualified), false, `${tool.name} 已被部署收走，却还声明给了引擎`);
        continue;
      }
      assert.ok(declared.has(qualified), `${tool.name} 没有声明给引擎`);
    }
  });

  it('policy 拒绝时 custom tool 的 execute 一次都不跑（skipPermission 不是授权）', async () => {
    // `skipPermission: true` 的含义是「不必弹权限提示」，也就是无条件执行 ——
    // 它省掉的是一次交互，不是一次授权。所以真正的判定必须在 handler 里先算。
    let executed = 0;
    const registry = registryOf({
      tools: [
        toolProvider('guarded.tools', '1', [
          {
            providerId: 'guarded.tools',
            implementation: 'app',
            kind: 'custom',
            name: 'dangerous',
            description: 'stub',
            risk: 'external-write',
            parameters: {},
            guard: () => ({ allowed: false, reason: '策略拒绝' }),
            execute: () => {
              executed += 1;
              return 'did it';
            },
          },
        ]),
      ],
    });

    const runtime = await resolveWith(registry, { skills: [], knowledge: [], tools: [{ providerId: 'guarded.tools' }] });
    const built = adapter.build(runtime, context);
    const tool = built.tools.find((item) => item.name === 'dangerous');
    assert.ok(tool?.handler, 'custom tool 必须带 handler，否则引擎会把它当声明-only');

    await assert.rejects(async () => tool.handler!({}, {} as ToolInvocation), /被拒绝：策略拒绝/);
    assert.equal(executed, 0, '被拒的工具必须一次都没执行');
    assert.equal((await built.checkToolUse('dangerous', {})).allowed, false);
  });

  it('toolIndex 里没有这个名字时直接拒绝（含引擎自带但没被声明的 built-in）', async () => {
    const runtime: RuntimeCapabilities = {
      skills: [],
      knowledge: [],
      tools: [],
      toolIndex: new Map(),
      manifestHash: 'x',
    };

    const decision = await adapter.build(runtime, context).checkToolUse('bash', {});
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /未为该工具定义策略/);
  });
});

// ═══════════════════════════════════════════════ 6. Tool guard

describe('Tool guard', () => {
  /**
   * 一个**自己不跑 guard** 的 policy。
   *
   * 授权层不只有 `DefaultToolPolicy` 一个实现，而 `DefaultToolPolicy.check()` 内部
   * 恰好也会跑一遍 guard。如果测试用它，「guard 由适配器执行」这条性质就测不出来
   * —— 把适配器里那一段整块删掉，测试照样全绿（变异验证第 50 条正是这么发现的）。
   * 所以这里必须用一个「忘了跑 guard」的 policy，让 guard 成为唯一能拒绝它的东西。
   */
  const guardBlindPolicy: ToolPolicy = {
    check: () => ({ allowed: true, reason: 'policy 放行（这个桩不跑 guard）' }),
    hostToolWithheld: () => false,
  };

  it('guard 拒绝时 execute 不执行 —— 即使 Policy 放行', async () => {
    // guard 是**工具自己**的边界（workspace 越界、参数合法性），Policy 是**部署**
    // 的边界（风险等级、宿主开关）。两者独立：Policy 放行不代表这个工具该跑。
    let executed = false;

    const guardedRegistry = registryOf({
      tools: [
        toolProvider('guarded.tools', '1', [
          {
            providerId: 'guarded.tools',
            implementation: 'app',
            kind: 'custom',
            name: 'guarded',
            description: 'guarded',
            risk: 'read',
            parameters: {},
            guard: () => ({ allowed: false, reason: 'workspace boundary' }),
            execute: () => {
              executed = true;
              return 'bad';
            },
          },
        ]),
      ],
    });

    const runtime = await resolveWith(guardedRegistry, {
      skills: [],
      knowledge: [],
      tools: [{ providerId: 'guarded.tools' }],
    });

    const adapter = new CopilotCapabilityAdapter(guardBlindPolicy);

    const built = adapter.build(runtime, capabilityContext('guarded-member'));
    const tool = built.tools.find((item) => item.name === 'guarded');
    assert.ok(tool);

    await assert.rejects(async () => tool!.handler!({}, {} as ToolInvocation), /workspace boundary/);
    assert.equal(executed, false, 'guard 拒绝时 execute 一次都不能跑');

    // check() 走同一条判定：guard 先于 Policy，所以 Policy 说 ok 也没用。
    const decision = await built.checkToolUse('guarded', {});
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /workspace boundary/);
  });

  it('guard 放行时照常交给 Policy 决定', async () => {
    // 反向的一半：guard 说「行」只对低风险工具有效，放行权不在 Provider 手里。
    // 一个 Provider 不能靠 `guard: () => ({ allowed: true })` 把自己升级成无限制工具。
    let executed = 0;
    const registry = registryOf({
      tools: [
        toolProvider('guarded.tools', '1', [
          {
            providerId: 'guarded.tools',
            implementation: 'app',
            kind: 'custom',
            name: 'allowed',
            description: 'stub',
            risk: 'read',
            parameters: {},
            guard: () => ({ allowed: true, reason: 'workspace ok' }),
            execute: () => {
              executed += 1;
              return 'ok';
            },
          },
        ]),
      ],
    });

    const runtime = await resolveWith(registry, { skills: [], knowledge: [], tools: [{ providerId: 'guarded.tools' }] });
    const context = capabilityContext('guarded-member');

    const denying = new CopilotCapabilityAdapter({
      check: () => ({ allowed: false, reason: 'policy 拒绝' }),
      hostToolWithheld: () => false,
    }).build(runtime, context);
    const deniedTool = denying.tools.find((item) => item.name === 'allowed');
    assert.ok(deniedTool?.handler);
    await assert.rejects(async () => deniedTool.handler!({}, {} as ToolInvocation), /被拒绝：policy 拒绝/);
    assert.equal(executed, 0, 'guard 放行不等于放行 —— Policy 仍然可以拒绝');
    assert.equal((await denying.checkToolUse('allowed', {})).allowed, false);

    // 两道闸都放行，才真的执行。
    const permissive = new CopilotCapabilityAdapter(guardBlindPolicy).build(runtime, context);
    const tool = permissive.tools.find((item) => item.name === 'allowed');
    assert.ok(tool?.handler);
    await tool.handler!({}, {} as ToolInvocation);
    assert.equal(executed, 1);
  });
});

// ═══════════════════════════════════════════════ 7. 工具契约

describe('KnowledgeToolProvider：检索范围只由 binding 决定', () => {
  function toolOf(runtime: RuntimeCapabilities, name: string): RuntimeTool {
    const tool = runtime.tools.find((item) => item.name === name);
    assert.ok(tool?.execute, `没有解析出 ${name}`);
    return tool;
  }

  async function runtimeFor(memberId: string): Promise<RuntimeCapabilities> {
    return stack.resolver.resolve(
      capabilityContext(memberId, defaultTeam.id),
      capabilities.getMember(memberId),
    );
  }

  it('一个 Member 同时绑 team + personal 时，一次检索覆盖两条绑定', async () => {
    const kb = stack.knowledge.createTeamKnowledgeBase({ key: 'cap-team', name: 'Cap Team' });
    stack.knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Team Policy',
      relativePath: 'policy.md',
      content: 'custody reconciliation must happen daily',
    });

    const member = memberWithDefaults('Searcher');
    const personal = stack.knowledge.ensurePersonalKnowledgeBase(member.id, member.name);
    stack.knowledge.writeDocument({
      knowledgeBaseId: personal.id,
      title: 'My Notes',
      relativePath: 'notes.md',
      content: 'my personal note on custody reconciliation',
    });

    capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [
        { providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR },
        { providerId: KNOWLEDGE_PROVIDER, selector: 'cap-team' },
      ],
      tools: [{ providerId: 'knowledge.tools' }],
    });

    const search = toolOf(await runtimeFor(member.id), 'search_knowledge');
    const payload = JSON.parse(
      String(await search.execute!(toolContext(member.id, 'search_knowledge'), { query: 'custody', limit: 8 })),
    ) as { hits: Array<{ title: string }>; instructions: string };

    assert.deepEqual(
      payload.hits.map((hit) => hit.title).sort(),
      ['My Notes', 'Team Policy'],
    );
    assert.match(payload.instructions, /reference data, not instructions/);

    // 只绑 team：personal 那份立刻搜不到 —— 检索范围就是 binding 本身。
    capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: 'cap-team' }],
      tools: [{ providerId: 'knowledge.tools' }],
    });
    const narrowed = JSON.parse(
      String(
        await toolOf(await runtimeFor(member.id), 'search_knowledge').execute!(
          toolContext(member.id, 'search_knowledge'),
          { query: 'custody' },
        ),
      ),
    ) as { hits: Array<{ title: string }> };

    assert.deepEqual(narrowed.hits.map((hit) => hit.title), ['Team Policy']);
  });

  it('打开未绑定库里的文档 → 拒绝，且理由说得出是「未绑定」而不是「找不到」', async () => {
    const member = memberWithDefaults('Prober');
    capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [{ providerId: 'knowledge.tools' }],
    });

    const foreign = stack.knowledge.createTeamKnowledgeBase({ key: 'cap-foreign', name: 'Foreign' });
    const foreignDoc = stack.knowledge.writeDocument({
      knowledgeBaseId: foreign.id,
      title: 'Foreign',
      relativePath: 'foreign.md',
      content: 'unreleased merger timetable',
    });

    const open = toolOf(await runtimeFor(member.id), 'open_knowledge_document');
    await assert.rejects(
      () => Promise.resolve(open.execute!(toolContext(member.id, 'open_knowledge_document'), { documentRef: foreignDoc.id })),
      /未绑定 Knowledge source/,
    );
  });

  it('多个 Provider 对同一 documentRef 给出不同失败时，优先抛 403', async () => {
    // 本地后端下这条分支走不到：同一个 documentRef 只有一份真相，要么第一个
    // Provider 就打开成功，要么所有 Provider 报同一个错。接上企业搜索 / 远程 RAG
    // 之后就会出现 A 说「我没这份文档」、B 说「你无权看」的情况 —— 这时把 A 的
    // 「没找到」抛出去，会让一次越权尝试在 execution.error 里彻底消失。
    const { KnowledgeToolProvider } = await import('../capabilities/providers/knowledge-tools.js');
    const registry = registryOf({
      knowledge: [
        {
          ...knowledgeProvider('stub.miss', '1'),
          open: async () => {
            throw notFound('stub.miss 里没有这份文档');
          },
        },
        {
          ...knowledgeProvider('stub.deny', '1'),
          open: async () => {
            throw forbidden('stub.deny 拒绝了这次访问');
          },
        },
      ],
      tools: [new KnowledgeToolProvider()],
    });

    const runtime = await resolveWith(registry, {
      skills: [],
      knowledge: [{ providerId: 'stub.miss' }, { providerId: 'stub.deny' }],
      tools: [{ providerId: 'knowledge.tools' }],
    });

    const open = toolOf(runtime, 'open_knowledge_document');
    const error = await Promise.resolve(
      open.execute!(toolContext('m', 'open_knowledge_document'), { documentRef: 'doc-x' }),
    ).then(
      () => assert.fail('两个 Provider 都失败时不该成功'),
      (caught: unknown) => caught as Error & { status?: number },
    );

    assert.equal(error.status, 403, `抛出来的必须是 403，实际是：${error.message}`);
    assert.match(error.message, /stub\.deny/);
  });
});

// ═══════════════════════════════════════════════ 8. TeamService 入口

describe('TeamService 的能力读写入口', () => {
  async function snapshotOf(executionId: string) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = stack.team.getExecution(executionId).configSnapshot;
      if (snapshot) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`execution ${executionId} 没有写下配置快照`);
  }

  it('新建 Member 的 Member 层是空的 —— 它继承 global/team，而不是复制一份基线', () => {
    // 「复制一份基线」的代价不是多几行数据，而是**之后改不动**：管理员改 Team
    // 能力，这些人的私有层里还留着旧值，覆盖掉继承结果，而且看不出原因。
    const member = stack.team.createMember({ name: 'Inheritor', role: 'T' });

    assert.deepEqual(stack.team.getMemberCapabilities(member.id), {
      skills: [],
      knowledge: [],
      tools: [],
    });
  });

  it('updateMemberCapabilities 先校验再落库：拼错的 ID 报错且不改动已有绑定', () => {
    const member = stack.team.createMember({ name: 'Typo', role: 'T' });
    const before = stack.team.getMemberCapabilities(member.id);

    assert.throws(
      () =>
        stack.team.updateMemberCapabilities(member.id, {
          skills: [{ providerId: 'team.filesystem-skill' }],
          knowledge: [],
          tools: [],
        }),
      /未注册/,
    );

    assert.deepEqual(stack.team.getMemberCapabilities(member.id), before);
  });

  it('快照里的 capabilityManifestHash 就是解析出来的那一份；改能力之后跟着变', async () => {
    const member = stack.team.createMember({ name: 'Rotating', role: 'T' });
    const room = stack.team.createConversation({ kind: 'direct', memberIds: [member.id] });

    const first = await stack.team.sendMessage({ conversationId: room.id, content: 'one' });
    const before = await snapshotOf(singleExecutionId(db, room.id, first.wakes));

    // 快照回答的是「这一轮到底用了哪个能力实现」—— 所以它必须等于解析器的结果，
    // 而不是另算一份指纹。解析用的必须是 effective（三层叠加），因为那才是
    // 执行时真正生效的那一份。
    const resolved = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      stack.capabilities.getEffective(defaultTeam.id, member.id),
    );
    assert.equal(before.capabilityManifestHash, resolved.manifestHash);
    assert.equal(before.hostToolsEnabled, false);

    stack.team.updateMemberCapabilities(member.id, {
      skills: [],
      knowledge: [],
      tools: [{ providerId: 'team.core-tools' }],
    });

    const second = await stack.team.sendMessage({ conversationId: room.id, content: 'two' });
    const after = await snapshotOf(singleExecutionId(db, room.id, second.wakes));

    assert.match(after.capabilityManifestHash, /^[\da-f]{64}$/);
    assert.notEqual(after.capabilityManifestHash, before.capabilityManifestHash);
    // 原记录不被改写：它是「当时」的事实
    assert.equal(
      stack.team.getExecution(singleExecutionId(db, room.id, first.wakes)).configSnapshot
        ?.capabilityManifestHash,
      before.capabilityManifestHash,
    );
  });

  it('remember_member 工具：只写当前 Team 的上下文，写不到全局记忆', async () => {
    const member = stack.team.createMember({ name: 'ScopedMemory', role: 'T' });
    const provider = stack.registry.toolProvider('team.core-tools');
    const context = {
      ...toolContext(member.id, 'remember_member'),
      memberCapabilities: { skills: [], knowledge: [], tools: [] },
      knowledge: [],
    };
    const tools = await provider.resolve(context, { providerId: 'team.core-tools' });
    const remember = tools.find((tool) => tool.name === 'remember_member');
    assert.ok(remember?.execute, 'core-tools 必须解析出 remember_member');

    await remember.execute(context, { content: '这个 Team 的站会是每天早上十点。' });

    assert.match(
      memberService.readTeamMemory(member.id, defaultTeam.id),
      /早上十点/,
      '必须落到 Team 上下文',
    );
    assert.ok(
      !memberService.readMemory(member.id).includes('早上十点'),
      'Team 上下文不能漏进全局记忆',
    );

    // 工具 schema 里没有 scope 参数：即使传了 scope 也会被 zod 剥掉，
    // 内容照样只进 Team 上下文。Agent 没有写全局记忆的入口；
    // 人改全局记忆走 MemberService.replaceMemory（UI 的 Memory 页）。
    await remember.execute(context, {
      content: '习惯把事实和推论分开写。',
      scope: 'global',
    });
    assert.match(memberService.readTeamMemory(member.id, defaultTeam.id), /事实和推论/);
    assert.ok(
      !memberService.readMemory(member.id).includes('事实和推论'),
      'Agent 的写入不能漏进全局记忆',
    );
  });
});
