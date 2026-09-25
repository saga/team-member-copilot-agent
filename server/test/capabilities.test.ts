import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuiltInTools, type ToolInvocation } from '@github/copilot-sdk';
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
 *   manifestHash 稳定         排序、版本、selector、工具形状变化都要反映出来
 *   声明与授权同源            availableTools 与 toolIndex 出自同一份解析结果
 *   skipPermission 不是授权   策略拒绝时 execute 一次都不能跑
 *   检索范围只由 binding 定   模型的 query 不能扩大它
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
const { defaultMemberCapabilities } = await import('../capabilities/defaults.js');
const { PERSONAL_SELECTOR } = await import('../capabilities/providers/filesystem-knowledge.js');
const { createTestStack, capabilityContext, singleExecutionId, muteAllMembers, StubCopilot } =
  await import('./support.js');

import type { MemberCapabilities } from '../domain.js';
import type { ToolExecutionContext } from '../capabilities/types.js';
import type {
  CapabilityContext,
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

const KNOWLEDGE_PROVIDER = 'local.filesystem-knowledge';

/**
 * 直接建 member 行，**不写**能力绑定。
 *
 * 绑定表本身的用例要自己控制那一行，所以走 member-service。想拿到默认能力
 * 的用例用下面的 `memberWithDefaults()` —— 写默认绑定的是 TeamService 的编排，
 * 不是建表本身，这个区别正是「能力不是 Member 的固有属性」的体现。
 */
function rawMember(name: string) {
  return memberService.create({ name, handle: name.toLowerCase(), role: 'T' });
}

/** 走 TeamService 建人，顺带写入默认能力。 */
function memberWithDefaults(name: string) {
  return stack.team.createMember({ name, role: 'T' });
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

/** 工具 execute 拿到的上下文比能力解析多一个工具名。 */
function toolContext(memberId: string, toolName: string): ToolExecutionContext {
  return { ...capabilityContext(memberId), toolName };
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

function builtinTool(
  providerId: string,
  name: string,
  overrides: Partial<RuntimeTool> = {},
): RuntimeTool {
  return { providerId, kind: 'builtin', name, description: 'stub', risk: 'read', ...overrides };
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
  const context: CapabilityContext = {
    memberId,
    conversationId: 'c1',
    executionId: 'e1',
    userId: 'u1',
  };
  return new CapabilityResolver(registry).resolve(context, value);
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
  it('重复注册同一个 ID 直接抛 —— 否则「谁在用哪个实现」取决于注册顺序', () => {
    assert.throws(
      () => registryOf({ skills: [skillProvider('dupe'), skillProvider('dupe')] }),
      /重复 Skill Provider：dupe/,
    );
    assert.throws(
      () => registryOf({ knowledge: [knowledgeProvider('dupe'), knowledgeProvider('dupe')] }),
      /重复 Knowledge Provider：dupe/,
    );
    assert.throws(
      () => registryOf({ tools: [toolProvider('dupe'), toolProvider('dupe')] }),
      /重复 Tool Provider：dupe/,
    );
  });

  it('查未注册的 ID 直接抛，不静默降级成「没有这个能力」', () => {
    const registry = registryOf({});
    assert.throws(() => registry.skillProvider('ghost'), /未注册 Skill Provider：ghost/);
    assert.throws(() => registry.knowledgeProvider('ghost'), /未注册 Knowledge Provider：ghost/);
    assert.throws(() => registry.toolProvider('ghost'), /未注册 Tool Provider：ghost/);
  });

  it('validate 拼错一个 ID 就抛（错误挡在落库之前，不等到第一个 turn）', () => {
    const registry = manifestRegistry();

    // 三类各拼错一个，都必须被抓到
    assert.throws(
      () => registry.validateMemberCapabilities({ skills: [{ providerId: 'typo' }], knowledge: [], tools: [] }),
      /未注册 Skill Provider：typo/,
    );
    assert.throws(
      () => registry.validateMemberCapabilities({ skills: [], knowledge: [{ providerId: 'typo' }], tools: [] }),
      /未注册 Knowledge Provider：typo/,
    );
    assert.throws(
      () => registry.validateMemberCapabilities({ skills: [], knowledge: [], tools: [{ providerId: 'typo' }] }),
      /未注册 Tool Provider：typo/,
    );
  });

  it('listProviderIds 三类分开、各自排序', () => {
    const registry = registryOf({
      skills: [skillProvider('b'), skillProvider('a')],
      knowledge: [knowledgeProvider('k')],
      tools: [toolProvider('z'), toolProvider('m')],
    });

    assert.deepEqual(registry.listProviderIds(), {
      skills: ['a', 'b'],
      knowledge: ['k'],
      tools: ['m', 'z'],
    });
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

  it('Provider 版本变化 → 哈希变（同一个 ID 背后的实现换了一版）', async () => {
    const base = await manifestHash(manifestCapabilities());
    const bumped = await manifestHash(
      manifestCapabilities(),
      manifestRegistry({
        skills: [skillProvider('stub.skills', '2', [artifact('stub.skills', 'arch')])],
      }),
    );

    assert.notEqual(base, bumped);
  });

  it('selector 变化 → 哈希变（同一个 Provider，指向了另一个资料源）', async () => {
    const alpha = await manifestHash(manifestCapabilities());
    const beta = await manifestHash(
      manifestCapabilities({ knowledge: [{ providerId: 'stub.knowledge', selector: 'beta' }] }),
    );

    assert.notEqual(alpha, beta);
  });

  it('工具声明的形状变化 → 哈希变（名字 / risk / 是否需要宿主权限都算）', async () => {
    const base = await manifestHash(manifestCapabilities());

    const renamed = await manifestHash(
      manifestCapabilities(),
      manifestRegistry({ tools: [toolProvider('stub.tools', '1', [builtinTool('stub.tools', 'lookup_v2')])] }),
    );
    assert.notEqual(base, renamed);

    for (const overrides of [{ risk: 'host-execution' as const }, { requiresHostAccess: true }]) {
      const changed = await manifestHash(
        manifestCapabilities(),
        manifestRegistry({
          tools: [toolProvider('stub.tools', '1', [builtinTool('stub.tools', 'lookup', overrides)])],
        }),
      );
      assert.notEqual(base, changed, JSON.stringify(overrides));
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

  it('解析结果自带 toolIndex —— 授权判定用的反查表就是它', async () => {
    const resolved = await resolveWith(manifestRegistry(), manifestCapabilities());

    assert.deepEqual([...resolved.toolIndex.keys()], ['lookup']);
    assert.equal(resolved.toolIndex.get('lookup')?.providerId, 'stub.tools');
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

describe('CapabilityService：一张表装三类绑定', () => {
  it('replace 是全量替换，空数组就是解绑', () => {
    const member = rawMember('Binder');

    capabilities.replace(member.id, {
      skills: [{ providerId: 'team.filesystem-skills' }],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [{ providerId: 'knowledge.tools' }],
    });
    assert.deepEqual(capabilities.get(member.id), {
      skills: [{ providerId: 'team.filesystem-skills' }],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [{ providerId: 'knowledge.tools' }],
    });

    assert.deepEqual(capabilities.replace(member.id, { skills: [], knowledge: [], tools: [] }), {
      skills: [],
      knowledge: [],
      tools: [],
    });
  });

  it('replace 推进 member.updated_at —— 能力是 Member 配置的一部分', () => {
    // execution 快照用 `memberRevision`（= updated_at）回答「当时是哪个版本的人」。
    // 只写 binding 不动 updated_at，事后对账会看到「同一个 revision、两组能力」。
    const member = rawMember('Revised');
    db.prepare(`UPDATE member SET updated_at = ? WHERE id = ?`).run('1970-01-01T00:00:00.000Z', member.id);

    capabilities.replace(member.id, defaultMemberCapabilities());

    assert.notEqual(memberService.get(member.id).updatedAt, '1970-01-01T00:00:00.000Z');
  });

  it("空 selector 只可能存一行（NULL 在主键里互不相等，所以落库用的是 ''）", () => {
    const member = rawMember('Unique');
    capabilities.replace(member.id, {
      skills: [{ providerId: 'team.filesystem-skills' }],
      knowledge: [],
      tools: [],
    });

    // 落库的必须是 ''，不是 NULL：主键里带 selector，而 SQLite 把 NULL 视为
    // 互不相等 —— 用 NULL 表示「空」会让同一个 (member, type, provider) 能插进
    // 无限多行，唯一性约束形同不存在。
    const stored = db
      .prepare(
        `SELECT selector FROM member_capability_binding
         WHERE member_id = ? AND capability_type = 'skill'`,
      )
      .get(member.id) as unknown as { selector: string | null } | undefined;
    assert.ok(stored);
    assert.equal(stored.selector, '', '空 selector 必须落成空字符串');

    // 约束真的在，而不是「靠 replace 先删后插所以看不出来」。
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO member_capability_binding
             (member_id, capability_type, provider_id, selector, created_at)
           VALUES (?, 'skill', 'team.filesystem-skills', '', 't')`,
        )
        .run(member.id),
    );
  });

  it('selector 是 ACL 的一部分：hasKnowledgeBinding 精确匹配', () => {
    const member = rawMember('Scoped');
    capabilities.replace(member.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: 'financial-core' }],
      tools: [],
    });

    assert.equal(capabilities.hasKnowledgeBinding(member.id, KNOWLEDGE_PROVIDER, 'financial-core'), true);
    assert.equal(capabilities.hasKnowledgeBinding(member.id, KNOWLEDGE_PROVIDER, 'security-controls'), false);
    assert.equal(capabilities.hasKnowledgeBinding(member.id, KNOWLEDGE_PROVIDER, ''), false);
    assert.equal(capabilities.hasKnowledgeBinding(member.id, 'other.provider', 'financial-core'), false);
  });

  it('空 selector 读回来是 undefined，调用方不必区分 "" 和 undefined', () => {
    const member = rawMember('Roundtrip');
    capabilities.replace(member.id, {
      skills: [{ providerId: 'team.filesystem-skills' }],
      knowledge: [],
      tools: [],
    });

    assert.deepEqual(capabilities.get(member.id).skills, [{ providerId: 'team.filesystem-skills' }]);
  });
});

// ═══════════════════════════════════════════════ 4. 默认能力

describe('默认能力', () => {
  it('每次返回一份新对象，改一份不影响下一份', () => {
    const first = defaultMemberCapabilities();
    first.tools.push({ providerId: 'runtime.host-coding-tools' });

    assert.equal(
      defaultMemberCapabilities().tools.some(
        (binding) => binding.providerId === 'runtime.host-coding-tools',
      ),
      false,
      '共享引用会让「给一个人开能力」变成给所有人开',
    );
  });

  it('默认不含宿主工具：它不是能力，是部署前提', () => {
    assert.equal(
      defaultMemberCapabilities().tools.some(
        (binding) => binding.providerId === 'runtime.host-coding-tools',
      ),
      false,
    );
  });

  it('默认引用的 Provider ID 全部已注册（否则新建 Member 连一轮都跑不起来）', () => {
    stack.registry.validateMemberCapabilities(defaultMemberCapabilities());
  });
});

// ═══════════════════════════════════════════════ 5. Adapter

describe('Adapter：声明与授权同源', () => {
  const policy = new DefaultToolPolicy({ allowHostTools: false });
  const adapter = new CopilotCapabilityAdapter(policy);
  const context = capabilityContext('adapter-member');

  it('声明出来的集合 = 解析出来的工具集合（同源，不会自己漂移）', async () => {
    const member = memberWithDefaults('Adapter');
    const withHost = defaultMemberCapabilities();
    withHost.tools.push({ providerId: 'runtime.host-coding-tools' });
    capabilities.replace(member.id, withHost);

    const runtime = await stack.resolver.resolve(capabilityContext(member.id), capabilities.get(member.id));
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

  it('SDK 的 isolated built-in 恒可用（它们只在 session 边界内活动）', async () => {
    const member = memberWithDefaults('Isolated');
    const runtime = await stack.resolver.resolve(
      capabilityContext(member.id),
      capabilities.get(member.id),
    );

    const declared = new Set(adapter.build(runtime, context).availableTools.toArray());
    for (const name of BuiltInTools.Isolated) {
      assert.ok(declared.has(`builtin:${name}`), `缺少 isolated built-in ${name}`);
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
            kind: 'custom',
            name: 'dangerous',
            description: 'stub',
            risk: 'external-write',
            parameters: {},
            authorize: () => ({ allowed: false, reason: '策略拒绝' }),
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

  it('放行时 execute 正常跑，并把工具名带进上下文', async () => {
    let seenToolName: string | null = null;
    const registry = registryOf({
      tools: [
        toolProvider('open.tools', '1', [
          {
            providerId: 'open.tools',
            kind: 'custom',
            name: 'harmless',
            description: 'stub',
            risk: 'read',
            parameters: {},
            execute: (toolContext) => {
              seenToolName = toolContext.toolName;
              return 'ok';
            },
          },
        ]),
      ],
    });

    const runtime = await resolveWith(registry, { skills: [], knowledge: [], tools: [{ providerId: 'open.tools' }] });
    const tool = adapter.build(runtime, context).tools.find((item) => item.name === 'harmless');
    assert.ok(tool?.handler);

    assert.equal(await tool.handler!({}, {} as ToolInvocation), 'ok');
    assert.equal(seenToolName, 'harmless');
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

// ═══════════════════════════════════════════════ 6. 工具契约

describe('KnowledgeToolProvider：检索范围只由 binding 决定', () => {
  function toolOf(runtime: RuntimeCapabilities, name: string): RuntimeTool {
    const tool = runtime.tools.find((item) => item.name === name);
    assert.ok(tool?.execute, `没有解析出 ${name}`);
    return tool;
  }

  async function runtimeFor(memberId: string): Promise<RuntimeCapabilities> {
    return stack.resolver.resolve(capabilityContext(memberId), capabilities.get(memberId));
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

    // 用 TeamService 建人时只带默认的 `$personal`；要看 team 库得显式再绑一条。
    capabilities.replace(member.id, {
      ...capabilities.get(member.id),
      knowledge: [
        { providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR },
        { providerId: KNOWLEDGE_PROVIDER, selector: 'cap-team' },
      ],
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
    capabilities.replace(member.id, {
      ...capabilities.get(member.id),
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: 'cap-team' }],
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
    // 只留个人资料这一条 knowledge 绑定，工具保持默认（检索/打开要能拿到）
    capabilities.replace(member.id, {
      ...capabilities.get(member.id),
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
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

// ═══════════════════════════════════════════════ 7. TeamService 入口

describe('TeamService 的能力读写入口', () => {
  async function snapshotOf(executionId: string) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = stack.team.getExecution(executionId).configSnapshot;
      if (snapshot) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`execution ${executionId} 没有写下配置快照`);
  }

  it('新建 Member 拿到的是默认能力（不是空绑定）', () => {
    const member = memberWithDefaults('Fresh');
    assert.deepEqual(
      normalized(stack.team.getMemberCapabilities(member.id)),
      normalized(defaultMemberCapabilities()),
    );
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
    muteAllMembers(stack.team, room.id);

    const first = await stack.team.sendMessage({ conversationId: room.id, content: 'one' });
    const before = await snapshotOf(singleExecutionId(db, room.id, first.wakes));

    // 快照回答的是「这一轮到底用了哪个能力实现」—— 所以它必须等于解析器的结果，
    // 而不是另算一份指纹。
    const resolved = await stack.resolver.resolve(
      capabilityContext(member.id),
      stack.capabilities.get(member.id),
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
});
