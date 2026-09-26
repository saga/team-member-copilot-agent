import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 管理员目录（Catalog）的锁定测试。
 *
 * 锁三件事：
 *   Tool selector 真的过滤 —— 绑整个 Provider 不再等于全开
 *   knowledge.tools 自注入 —— 选了资料就有检索工具，不选就没有，不会重复
 *   用户 ID 与内部绑定的翻译 —— 来回一致，拼错就 400
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-catalog-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';
process.env.HOST_CODING_TOOLS = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { SkillService } = await import('../skill-service.js');
const { PERSONAL_SELECTOR } = await import(
  '../capabilities/providers/filesystem-knowledge.js'
);
const { buildCatalog, assignmentsToBindings } = await import('../capabilities/catalog.js');
const { createTestStack, capabilityContext, StubCopilot } = await import('./support.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memberService = new MemberService(db);
const stub = new StubCopilot();
const stack = createTestStack(db, memberService, stub.asCopilot);
const skillService = new SkillService(db);
const defaultTeam = stack.structure.ensureDefaultTeam();

const KNOWLEDGE_PROVIDER = 'local.filesystem-knowledge';

function deps() {
  return {
    capabilities: stack.capabilities,
    skills: skillService,
    knowledge: stack.knowledge,
    registry: stack.registry,
    hostToolsEnabled: false,
  };
}

function toolNamesOf(tools: Array<{ name: string }>): string[] {
  return tools.map((tool) => tool.name).sort();
}

// ------------------------------------------------------- Tool selector 过滤

describe('Resolver：Tool selector 只给点名的工具', () => {
  it('空 selector 全量；点名只给点名的；不认识的名字落空', async () => {
    const member = stack.team.createMember({ name: 'ToolSelector', role: 'T' });

    stack.capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [],
      tools: [{ providerId: 'team.core-tools', selector: 'ask_member message_member' }],
    });
    const subset = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      stack.capabilities.getEffective(defaultTeam.id, member.id),
    );
    assert.deepEqual(toolNamesOf(subset.tools), ['ask_member', 'message_member']);

    stack.capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [],
      tools: [{ providerId: 'team.core-tools' }],
    });
    const all = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      stack.capabilities.getEffective(defaultTeam.id, member.id),
    );
    assert.deepEqual(toolNamesOf(all.tools), ['ask_member', 'message_member', 'remember_member']);

    stack.capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [],
      tools: [{ providerId: 'team.core-tools', selector: 'ghost_tool' }],
    });
    const none = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      stack.capabilities.getEffective(defaultTeam.id, member.id),
    );
    assert.deepEqual(toolNamesOf(none.tools), []);
  });
});

// ------------------------------------------------------- knowledge.tools 自注入

describe('Resolver：知识检索工具跟着 knowledge 走', () => {
  it('有 knowledge 无显式绑定 → 检索工具自动出现；无 knowledge → 不出现', async () => {
    const member = stack.team.createMember({ name: 'KnowledgeAuto', role: 'T' });

    stack.capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [],
    });
    const withKnowledge = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      stack.capabilities.getEffective(defaultTeam.id, member.id),
    );
    assert.ok(
      toolNamesOf(withKnowledge.tools).includes('search_knowledge'),
      '选了资料就该有检索工具',
    );
    assert.ok(
      toolNamesOf(withKnowledge.tools).includes('open_knowledge_document'),
      '选了资料就该有开文档工具',
    );

    stack.capabilities.replaceMember(member.id, { skills: [], knowledge: [], tools: [] });
    const withoutKnowledge = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      stack.capabilities.getEffective(defaultTeam.id, member.id),
    );
    assert.ok(
      !toolNamesOf(withoutKnowledge.tools).includes('search_knowledge'),
      '没选资料就不该有检索工具',
    );
  });

  it('老库里的显式 knowledge.tools 绑定不导致重复解析', async () => {
    const member = stack.team.createMember({ name: 'KnowledgeLegacy', role: 'T' });

    stack.capabilities.replaceMember(member.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR }],
      tools: [{ providerId: 'knowledge.tools' }],
    });
    const resolved = await stack.resolver.resolve(
      capabilityContext(member.id, defaultTeam.id),
      stack.capabilities.getEffective(defaultTeam.id, member.id),
    );
    assert.equal(
      toolNamesOf(resolved.tools).filter((name) => name === 'search_knowledge').length,
      1,
      '显式绑定与自注入同时存在时不能解析出两份',
    );
  });
});

// ------------------------------------------------------- 目录翻译

describe('Catalog：用户 ID 与内部绑定的翻译', () => {
  it('Tool 按用户 IDs 开关 → 落库是按 Provider 分组的 selector', async () => {
    const member = stack.team.createMember({ name: 'CatalogTools', role: 'T' });
    const query = { scope: 'member' as const, teamId: defaultTeam.id, memberId: member.id };

    const bindings = await assignmentsToBindings(deps(), query, {
      skills: [],
      knowledge: [],
      tools: ['ask_member', 'message_member'],
    });
    assert.deepEqual(bindings.tools, [
      { providerId: 'team.core-tools', selector: 'ask_member message_member' },
    ]);

    stack.capabilities.replaceMember(member.id, bindings);
    const catalog = await buildCatalog(deps(), query);
    const byId = new Map(catalog.tools.map((tool) => [tool.id, tool]));
    assert.equal(byId.get('ask_member')?.enabled, true);
    assert.equal(byId.get('message_member')?.enabled, true);
    assert.equal(byId.get('remember_member')?.enabled, false);
  });

  it('knowledge.tools 不接受点名：它跟着 knowledge 走', async () => {
    const member = stack.team.createMember({ name: 'CatalogInternal', role: 'T' });
    const query = { scope: 'member' as const, teamId: defaultTeam.id, memberId: member.id };

    await assert.rejects(
      () =>
        assignmentsToBindings(deps(), query, {
          skills: [],
          knowledge: [],
          tools: ['search_knowledge'],
        }),
      /自带的检索工具/,
    );

    const catalog = await buildCatalog(deps(), query);
    assert.ok(
      !catalog.tools.some((tool) => tool.id === 'search_knowledge'),
      '内部检索工具不该出现在目录里',
    );
  });

  it('拼错的工具名在落库前就 400', async () => {
    const member = stack.team.createMember({ name: 'CatalogGhost', role: 'T' });
    const query = { scope: 'member' as const, teamId: defaultTeam.id, memberId: member.id };

    await assert.rejects(
      () =>
        assignmentsToBindings(deps(), query, {
          skills: [],
          knowledge: [],
          tools: ['ghost_tool'],
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { status?: number }).status === 400 &&
        /工具不存在/.test(error.message),
    );
  });

  it('Knowledge 用真实库名与文档数展示，个人库用 kb.personal', async () => {
    const kb = stack.knowledge.createTeamKnowledgeBase({
      key: 'catalog-core',
      name: 'Catalog Core',
      description: '目录测试库',
    });
    stack.knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'doc',
      relativePath: 'doc.md',
      content: 'catalog test content',
    });

    const member = stack.team.createMember({ name: 'CatalogKb', role: 'T' });
    const query = { scope: 'member' as const, teamId: defaultTeam.id, memberId: member.id };

    const bindings = await assignmentsToBindings(deps(), query, {
      skills: [],
      knowledge: ['kb.catalog-core', 'kb.personal'],
      tools: [],
    });
    assert.deepEqual(bindings.knowledge, [
      { providerId: KNOWLEDGE_PROVIDER, selector: 'catalog-core' },
      { providerId: KNOWLEDGE_PROVIDER, selector: PERSONAL_SELECTOR },
    ]);

    stack.capabilities.replaceMember(member.id, bindings);
    const catalog = await buildCatalog(deps(), query);
    const core = catalog.knowledge.find((item) => item.id === 'kb.catalog-core');
    assert.ok(core, '团队库出现在目录里');
    assert.equal(core.enabled, true);
    assert.equal(core.documentCount, 1);
    const personal = catalog.knowledge.find((item) => item.id === 'kb.personal');
    assert.ok(personal, '个人库用 kb.personal 展示，不暴露 $personal');
    assert.equal(personal.enabled, true);

    await assert.rejects(
      () =>
        assignmentsToBindings(deps(), query, {
          skills: [],
          knowledge: ['kb.bad key!'],
          tools: [],
        }),
      /知识库 key 不合法/,
    );
  });

  it('已绑定但库行未建的 key 在目录里可见且可关闭', async () => {
    stack.capabilities.replaceTeam(defaultTeam.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: 'future-base' }],
      tools: [],
    });
    const catalog = await buildCatalog(deps(), { scope: 'team', teamId: defaultTeam.id });
    const entry = catalog.knowledge.find((item) => item.id === 'kb.future-base');
    assert.ok(entry, '绑定先于资料存在时，目录里也要看得见这条绑定');
    assert.equal(entry.enabled, true);
    assert.equal(entry.documentCount, 0);

    const bindings = await assignmentsToBindings(
      deps(),
      { scope: 'team', teamId: defaultTeam.id },
      { skills: [], knowledge: [], tools: [] },
    );
    assert.deepEqual(bindings.knowledge, []);

    stack.capabilities.replaceTeam(defaultTeam.id, { skills: [], knowledge: [], tools: [] });
  });

  it('member 目录带出上面两层的继承，自身选择只动增量', async () => {
    stack.capabilities.replaceTeam(defaultTeam.id, {
      skills: [],
      knowledge: [{ providerId: KNOWLEDGE_PROVIDER, selector: 'catalog-core' }],
      tools: [{ providerId: 'team.core-tools', selector: 'ask_member' }],
    });

    const member = stack.team.createMember({ name: 'CatalogInherited', role: 'T' });
    const query = { scope: 'member' as const, teamId: defaultTeam.id, memberId: member.id };
    const catalog = await buildCatalog(deps(), query);

    assert.ok(catalog.inherited, 'member 目录必须带 inherited');
    assert.ok(
      catalog.inherited.tools.some((item) => item.id === 'ask_member' && item.from === 'team'),
      'Team 层给的工具在继承里可见',
    );
    assert.ok(
      catalog.inherited.knowledge.some(
        (item) => item.id === 'kb.catalog-core' && item.from === 'team',
      ),
      'Team 层给的资料在继承里可见',
    );
    // 自身没选：开关全关，但继承不受影响
    assert.ok(catalog.tools.every((tool) => !tool.enabled));

    stack.capabilities.replaceTeam(defaultTeam.id, { skills: [], knowledge: [], tools: [] });
  });
});
