import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

/**
 * P0 治理修复的锁定测试：
 *   Admin boundary / skill selector+版本 / knowledge 网关路由。
 * （工具授权层自己的契约在 tool-policy.test.ts，这里不再重复一遍。）
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-governance-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';
process.env.HOST_CODING_TOOLS = 'false';

const { db } = await import('../db.js');
const { config } = await import('../config.js');
const { FilesystemSkillProvider } = await import('../capabilities/providers/filesystem-skill.js');
const { SkillService } = await import('../skill-service.js');
const { createTestStack, capabilityContext, StubCopilot } = await import('./support.js');
const { MemberService } = await import('../member-service.js');
const { capabilitiesRouter } = await import('../routes/capabilities.js');
const { knowledgeRouter } = await import('../routes/knowledge.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------- skill selector + 版本

describe('FilesystemSkillProvider selector 与整目录版本', () => {
  it('空 selector 全量；点名只给点名的', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-skill-selector-'));
    for (const name of ['research', 'security-review', 'other']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\ndescription: ${name}\n---\n\n# ${name}\n`);
    }
    const provider = new FilesystemSkillProvider('team.filesystem-skills', root);
    const ctx = capabilityContext('m1');

    const all = await provider.resolve(ctx, { providerId: provider.id });
    assert.deepEqual(all.map((a) => a.name), ['other', 'research', 'security-review']);

    const subset = await provider.resolve(ctx, { providerId: provider.id, selector: 'research, security-review' });
    assert.deepEqual(subset.map((a) => a.name), ['research', 'security-review']);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------- admin boundary

describe('Admin boundary：改 capability boundary 的写入要 token，读不要', () => {
  let server: Server;
  let base: string;
  const originalAdmin = config.adminApiToken;
  const originalInternal = config.internalApiToken;

  const memberService = new MemberService(db);
  const stub = new StubCopilot();
  const stack = createTestStack(db, memberService, stub.asCopilot);
  const member = stack.team.createMember({ name: 'AdminProbe', role: 'T' });

  before(async () => {
    const { initTeamScope } = await import('../middleware/teamScope.js');
    initTeamScope(stack.structure, stack.structure.ensureDefaultTeam().id);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(
      '/api/capabilities',
      capabilitiesRouter(stack.team, stack.registry, new SkillService(db), stack.knowledge, {
        hostToolsEnabled: false,
      }),
    );
    app.use('/api/knowledge', knowledgeRouter(stack.knowledge));
    server = app.listen(0);
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    config.adminApiToken = originalAdmin;
    config.internalApiToken = originalInternal;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('配置 ADMIN_API_TOKEN 后：读放行，写无 token 拒绝，带 token 才行', async () => {
    config.adminApiToken = 'admin-secret';

    const read = await fetch(`${base}/api/capabilities/catalog?scope=member&memberId=${member.id}`);
    assert.equal(read.status, 200);

    const noToken = await fetch(`${base}/api/capabilities/catalog`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'member', memberId: member.id, skills: [], knowledge: [], tools: [], mcp: [] }),
    });
    assert.ok(noToken.status === 401 || noToken.status === 403, `期望 401/403，实际 ${noToken.status}`);

    const withToken = await fetch(`${base}/api/capabilities/catalog`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ scope: 'member', memberId: member.id, skills: [], knowledge: [], tools: [], mcp: [] }),
    });
    assert.equal(withToken.status, 200);

    const kbWrite = await fetch(`${base}/api/knowledge/team`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'x', name: 'X' }),
    });
    assert.ok(kbWrite.status === 401 || kbWrite.status === 403, `期望 401/403，实际 ${kbWrite.status}`);
  });
});
