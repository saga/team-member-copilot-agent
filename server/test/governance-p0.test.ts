import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { forbidden } from '../http-error.js';

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
const { KnowledgeToolProvider } = await import('../capabilities/providers/knowledge-tools.js');
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

  it('SKILL.md 之外文件变化也换版本（bundle 指纹）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-skill-version-'));
    const dir = path.join(root, 'bundle');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\ndescription: x\n---\n\n# x\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'foo.py'), 'print(1)\n');
    const provider = new FilesystemSkillProvider('team.filesystem-skills', root);
    const ctx = capabilityContext('m1');

    const before = (await provider.resolve(ctx, { providerId: provider.id }))[0].version;
    fs.writeFileSync(path.join(dir, 'scripts', 'foo.py'), 'print(2)\n');
    const after = (await provider.resolve(ctx, { providerId: provider.id }))[0].version;
    assert.notEqual(before, after, 'scripts/foo.py 变化必须换版本');

    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------- knowledge 网关路由

describe('Knowledge 网关：providerId 直接路由', () => {
  it('同名 documentRef 按 providerId 路由，不挨个猜；未绑定的 providerId 直接 403', async () => {
    const provider = new KnowledgeToolProvider();
    const sameRef = 'doc-123';
    const tools = await provider.resolve(
      {
        memberId: 'm1',
        conversationId: 'c1',
        executionId: 'e1',
        userId: 'u1',
        memberCapabilities: { skills: [], knowledge: [], tools: [] },
        knowledge: [
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            provider: { id: 'a.provider', version: '1', open: async () => ({ providerId: 'a.provider', documentRef: sameRef, sourceId: 's', title: 'A', content: 'from-A', citation: 'A', sourceUri: null }) } as any,
            binding: { providerId: 'a.provider' },
            sources: [],
          },
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            provider: { id: 'b.provider', version: '1', open: async () => ({ providerId: 'b.provider', documentRef: sameRef, sourceId: 's', title: 'B', content: 'from-B', citation: 'B', sourceUri: null }) } as any,
            binding: { providerId: 'b.provider' },
            sources: [],
          },
        ],
      },
      { providerId: 'knowledge.tools' },
    );
    const open = tools.find((t) => t.name === 'open_knowledge_document');
    assert.ok(open?.execute);
    const ctx = { memberId: 'm1', conversationId: 'c1', executionId: 'e1', userId: 'u1', toolName: 'open_knowledge_document' };

    const a = JSON.parse(String(await open.execute(ctx, { documentRef: sameRef, providerId: 'a.provider' })));
    assert.equal(a.content, 'from-A');
    const b = JSON.parse(String(await open.execute(ctx, { documentRef: sameRef, providerId: 'b.provider' })));
    assert.equal(b.content, 'from-B');

    await assert.rejects(() => Promise.resolve(open.execute!(ctx, { documentRef: sameRef, providerId: 'ghost' })), (e: unknown) =>
      e instanceof Error && (e as { status?: number }).status === 403,
    );
    void forbidden;
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
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/capabilities', capabilitiesRouter(stack.team, stack.registry));
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

    const read = await fetch(`${base}/api/capabilities/members/${member.id}`);
    assert.equal(read.status, 200);

    const noToken = await fetch(`${base}/api/capabilities/members/${member.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: [], knowledge: [], tools: [] }),
    });
    assert.ok(noToken.status === 401 || noToken.status === 403, `期望 401/403，实际 ${noToken.status}`);

    const withToken = await fetch(`${base}/api/capabilities/members/${member.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ skills: [], knowledge: [], tools: [] }),
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
