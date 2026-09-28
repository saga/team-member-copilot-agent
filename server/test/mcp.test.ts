import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * MCP 只做连接能力：定义加载 → 授权绑定 → 解析 → SDK 配置 → 策略回退。
 *
 * 不测真实 MCP server（没有网络、不起子进程）：测的是「声明的东西是不是
 *  JSON 里写的那样」以及「没声明的东西进不来」。运行与调用是 SDK 的事。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-mcp-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { loadMcpServerDefinitions } = await import('../mcp/registry.js');
const { buildMcpToolIndex, mcpToolAliases } = await import('../capabilities/resolver.js');
const { CapabilityRegistry } = await import('../capabilities/registry.js');
const { CapabilityResolver } = await import('../capabilities/resolver.js');
const { CopilotCapabilityAdapter } = await import('../capabilities/copilot-adapter.js');
const { DefaultToolPolicy } = await import('../tool-policy.js');
const { DenyHighRiskPolicyService } = await import('../policy.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { SkillService } = await import('../skill-service.js');
const { createTestStack, capabilityContext, StubCopilot } = await import('./support.js');
import type { CopilotService } from '../copilot.js';
import type { McpServerDefinition } from '../mcp/types.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeJson(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function githubServer(): McpServerDefinition {
  return {
    id: 'github',
    displayName: 'GitHub',
    type: 'http',
    url: 'https://mcp.github.example/mcp',
    headers: { Authorization: 'Bearer token' },
    tools: {
      search_code: { risk: 'external-read' },
      issue_write: { risk: 'external-write' },
    },
    version: '1',
  };
}

// ---------------------------------------------------------- 定义加载

describe('MCP 定义加载：形状 + allowlist + 门禁', () => {
  it('有效定义加载，${ENV} 展开', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-mcp-file-'));
    process.env.TMCA_TEST_MCP_TOKEN = 'secret-token';
    try {
      const file = writeJson(dir, 'mcp.json', {
        servers: [
          {
            id: 'github',
            displayName: 'GitHub',
            type: 'http',
            url: 'https://mcp.example/mcp',
            headers: { Authorization: 'Bearer ${TMCA_TEST_MCP_TOKEN}' },
            tools: { search_code: { risk: 'external-read' } },
            version: '1',
          },
        ],
      });
      const [server] = loadMcpServerDefinitions(file, { allowLocal: false });
      assert.equal(server.id, 'github');
      assert.equal(server.headers?.Authorization, 'Bearer secret-token');
    } finally {
      delete process.env.TMCA_TEST_MCP_TOKEN;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在 = 没接 MCP：警告并返回空，不让服务起不来', () => {
    assert.deepEqual(
      loadMcpServerDefinitions(path.join(os.tmpdir(), 'tmca-mcp-missing.json'), { allowLocal: false }),
      [],
    );
  });

  it('坏 JSON / 坏形状 / "*" / 空工具 / 重复 id 直接抛', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-mcp-bad-'));
    try {
      const badJson = path.join(dir, 'bad.json');
      fs.writeFileSync(badJson, '{oops', 'utf8');
      assert.throws(() => loadMcpServerDefinitions(badJson, { allowLocal: false }), /合法 JSON/);

      const star = writeJson(dir, 'star.json', {
        servers: [{ id: 'g', displayName: 'G', type: 'http', url: 'https://x', tools: { '*': { risk: 'read' } }, version: '1' }],
      });
      assert.throws(() => loadMcpServerDefinitions(star, { allowLocal: false }), /必须显式列出/);

      const empty = writeJson(dir, 'empty.json', {
        servers: [{ id: 'g', displayName: 'G', type: 'http', url: 'https://x', tools: {}, version: '1' }],
      });
      assert.throws(() => loadMcpServerDefinitions(empty, { allowLocal: false }), /没有声明任何工具/);

      const dup = writeJson(dir, 'dup.json', {
        servers: [
          { id: 'g', displayName: 'G', type: 'http', url: 'https://x', tools: { a: { risk: 'read' } }, version: '1' },
          { id: 'g', displayName: 'G2', type: 'http', url: 'https://y', tools: { b: { risk: 'read' } }, version: '1' },
        ],
      });
      assert.throws(() => loadMcpServerDefinitions(dup, { allowLocal: false }), /重复/);

      const noUrl = writeJson(dir, 'nourl.json', {
        servers: [{ id: 'g', displayName: 'G', type: 'http', tools: { a: { risk: 'read' } }, version: '1' }],
      });
      assert.throws(() => loadMcpServerDefinitions(noUrl, { allowLocal: false }), /缺少 url/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('local 默认拒绝（MCP_LOCAL_ENABLED），打开才放行', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-mcp-local-'));
    try {
      const file = writeJson(dir, 'local.json', {
        servers: [
          { id: 'dev', displayName: 'Dev', type: 'local', command: 'node', args: ['./x.js'], tools: { run: { risk: 'read' } }, version: '1' },
        ],
      });
      assert.throws(() => loadMcpServerDefinitions(file, { allowLocal: false }), /MCP_LOCAL_ENABLED/);
      const [server] = loadMcpServerDefinitions(file, { allowLocal: true });
      assert.equal(server.command, 'node');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------- 注册与解析

describe('MCP 注册与解析：引用 + 名单 + manifest', () => {
  function registryWithGithub(): InstanceType<typeof CapabilityRegistry> {
    const registry = new CapabilityRegistry();
    registry.registerMcpServer(githubServer());
    return registry;
  }

  it('未注册的 server / 未声明的工具直接抛，不静默落空', async () => {
    const resolver = new CapabilityResolver(registryWithGithub());
    const context = capabilityContext('m1', 't1');

    await assert.rejects(
      resolver.resolve(context, { skills: [], knowledge: [], tools: [], mcp: [{ providerId: 'mcp.ghost' }] }),
      /未注册 MCP Server/,
    );
    await assert.rejects(
      resolver.resolve(context, {
        skills: [],
        knowledge: [],
        tools: [],
        mcp: [{ providerId: 'mcp.github', selector: 'no_such_tool' }],
      }),
      /不存在工具/,
    );
  });

  it('selector 子集解析 + manifest 随 MCP 组成变化', async () => {
    const resolver = new CapabilityResolver(registryWithGithub());
    const context = capabilityContext('m1', 't1');
    const base = { skills: [], knowledge: [], tools: [] };

    const subset = await resolver.resolve(context, {
      ...base,
      mcp: [{ providerId: 'mcp.github', selector: 'search_code' }],
    });
    assert.equal(subset.mcpServers.length, 1);
    assert.deepEqual(subset.mcpServers[0].tools, ['search_code']);
    assert.equal(subset.mcpServers[0].toolPolicies.search_code, 'external-read');

    const full = await resolver.resolve(context, {
      ...base,
      mcp: [{ providerId: 'mcp.github' }],
    });
    assert.deepEqual(full.mcpServers[0].tools, ['issue_write', 'search_code']);

    const none = await resolver.resolve(context, base);
    assert.deepEqual(none.mcpServers, []);
    assert.notEqual(subset.manifestHash, full.manifestHash, '选的工具不同，审计指纹必须不同');
    assert.notEqual(subset.manifestHash, none.manifestHash, '用没用 MCP，审计指纹必须不同');
  });

  it('mcp id 与三类 Provider 共用全局唯一性', () => {
    const registry = new CapabilityRegistry();
    registry.registerToolProvider({ id: 'mcp.github', version: '1', resolve: async () => [] });
    assert.throws(() => registry.registerMcpServer(githubServer()), /重复 Capability Provider/);
  });
});

// ---------------------------------------------------------- 可见性与策略回退

describe('MCP 可见性与策略：SDK 配置 + 同一套 Policy', () => {
  const policy = new DefaultToolPolicy({ allowHostTools: false }, new DenyHighRiskPolicyService());
  const adapter = new CopilotCapabilityAdapter(policy);

  function githubRuntimeServer() {
    return {
      id: 'github',
      displayName: 'GitHub',
      type: 'http' as const,
      url: 'https://mcp.github.example/mcp',
      tools: ['issue_write', 'search_code'],
      toolPolicies: { issue_write: 'external-write' as const, search_code: 'external-read' as const },
      version: '1',
    };
  }

  function runtime() {
    return {
      skills: [],
      knowledge: [],
      tools: [],
      mcpServers: [
        githubRuntimeServer(),
        {
          id: 'devtools',
          displayName: 'Dev',
          type: 'local' as const,
          command: 'node',
          args: ['./x.js'],
          cwd: '/tmp/ws',
          tools: ['inspect_repo'],
          toolPolicies: { inspect_repo: 'read' as const },
          version: '1',
        },
      ],
      toolIndex: new Map(),
      mcpToolIndex: buildMcpToolIndex([githubRuntimeServer()]),
      manifestHash: 'x',
    };
  }

  it('mcpServers 按 SDK 形状翻译：local 的 cwd → workingDirectory', () => {
    const built = adapter.build(runtime(), capabilityContext('m', 't'));
    assert.deepEqual(built.mcpServers.github, {
      type: 'http',
      url: 'https://mcp.github.example/mcp',
      tools: ['issue_write', 'search_code'],
    });
    assert.deepEqual(built.mcpServers.devtools, {
      type: 'local',
      command: 'node',
      args: ['./x.js'],
      workingDirectory: '/tmp/ws',
      tools: ['inspect_repo'],
    });
    // 可见性逐个声明，不用 mcp:* 通配
    const patterns = built.availableTools.toArray();
    assert.ok(patterns.includes('mcp:github-search_code'), `缺可见性声明：${patterns.join(',')}`);
  });

  it('read 放行、external-write 落 Policy（默认拒绝）、未知拒绝', async () => {
    const built = adapter.build(runtime(), capabilityContext('m', 't'));
    assert.equal((await built.checkToolUse('github-search_code', {})).allowed, true);
    assert.equal((await built.checkToolUse('github-issue_write', {})).allowed, false);

    const unknown = await built.checkToolUse('github-drop_table', {});
    assert.equal(unknown.allowed, false);
    assert.match(unknown.reason, /未为该工具定义策略/);
  });

  it('同名工具在两个 server 上出现时按歧义拒绝，不猜一个执行', async () => {
    const both = {
      ...runtime(),
      mcpToolIndex: buildMcpToolIndex([
        {
          id: 'a',
          displayName: 'A',
          type: 'http' as const,
          url: 'https://a.example/mcp',
          tools: ['search'],
          toolPolicies: { search: 'external-read' as const },
          version: '1',
        },
        {
          id: 'b',
          displayName: 'B',
          type: 'http' as const,
          url: 'https://b.example/mcp',
          tools: ['search'],
          toolPolicies: { search: 'external-read' as const },
          version: '1',
        },
      ]),
    };
    const built = adapter.build(both, capabilityContext('m', 't'));
    // 规范 wire 名各自唯一，照常放行
    assert.equal((await built.checkToolUse('a-search', {})).allowed, true);
    // 裸名撞车：分不清调谁，拒绝并告诉管理员收窄 selector
    const decision = await built.checkToolUse('search', {});
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /重名/);
  });

  it('别名覆盖 SDK 可能报上来的写法', () => {
    const aliases = mcpToolAliases('github', 'search_code');
    assert.ok(aliases.includes('github-search_code'), '规范 wire 名必须在列');
    assert.ok(aliases.includes('search_code'), '裸名必须在列（回退匹配用）');
  });
});

// ---------------------------------------------------------- 目录翻译

describe('MCP 目录：展示 + 选择 → 绑定', () => {
  const stub = new StubCopilot();
  const memberService = new MemberService(db);
  const stack = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);
  const skillService = new SkillService(db);
  const defaultTeam = stack.structure.ensureDefaultTeam();

  function deps() {
    return {
      capabilities: stack.capabilities,
      skills: skillService,
      knowledge: stack.knowledge,
      registry: stack.registry,
      hostToolsEnabled: false,
    };
  }

  it('目录列出 server 与逐工具开关；选择落成显式名单绑定', async () => {
    stack.registry.registerMcpServer(githubServer());

    const member = stack.team.createMember({ name: 'McpUser', role: 'T' });
    const query = { scope: 'member' as const, teamId: defaultTeam.id, memberId: member.id };

    const { buildCatalog, assignmentsToBindings } = await import('../capabilities/catalog.js');
    const empty = await buildCatalog(deps(), query);
    assert.equal(empty.mcp.length, 1);
    assert.equal(empty.mcp[0].id, 'mcp.github');
    assert.ok(empty.mcp[0].tools.every((tool) => tool.enabled === false));

    const bindings = await assignmentsToBindings(deps(), query, {
      skills: [],
      knowledge: [],
      tools: [],
      mcp: ['mcp.github.search_code'],
    });
    assert.deepEqual(bindings.mcp, [{ providerId: 'mcp.github', selector: 'search_code' }]);

    stack.team.updateMemberCapabilities(member.id, bindings);
    const filled = await buildCatalog(deps(), query);
    const server = filled.mcp.find((item) => item.id === 'mcp.github')!;
    assert.equal(server.tools.find((tool) => tool.name === 'search_code')?.enabled, true);
    assert.equal(server.tools.find((tool) => tool.name === 'issue_write')?.enabled, false);

    // 拼错的 server / 工具在落库前就 400
    await assert.rejects(
      assignmentsToBindings(deps(), query, { skills: [], knowledge: [], tools: [], mcp: ['mcp.ghost.search_code'] }),
      /MCP Server 不存在/,
    );
    await assert.rejects(
      assignmentsToBindings(deps(), query, { skills: [], knowledge: [], tools: [], mcp: ['mcp.github.ghost_tool'] }),
      /没有这个工具/,
    );
  });
});
