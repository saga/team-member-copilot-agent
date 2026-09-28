import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-auth-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { requireHumanAuth } = await import('../middleware/auth.js');
const { requireConversationAccess } = await import('../middleware/conversationAccess.js');
const { StubCopilot, createTestStack } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

const ISSUER = 'https://auth.test.example';
const AUDIENCE = 'tmca-test';

/** 本地 JWKS 端点：jose 现签现验，不依赖外部 IdP。 */
let jwksServer: ReturnType<typeof createServer>;
let jwksUrl = '';
let privateKey: CryptoKey;
const KID = 'test-key-1';

async function startJwks(): Promise<void> {
  const { privateKey: pk, publicKey } = await generateKeyPair('RS256');
  privateKey = pk as CryptoKey;
  const jwk = await exportJWK(publicKey);
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const port = (jwksServer.address() as AddressInfo).port;
  jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;
}

async function signToken(overrides: { issuer?: string; audience?: string; sub?: string } = {}): Promise<string> {
  return new SignJWT({ sub: 'user-1', name: 'Test User' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime('5m')
    .sign(privateKey);
}

function probeApp() {
  const app = express();
  app.get('/probe', requireHumanAuth(), (req, res) => {
    res.json({ principalId: req.principal?.principalId });
  });
  return app;
}

async function withServer(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
  const server: Server = app.listen(0);
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const stub = new StubCopilot();
const memberService = new MemberService(db);
const stack = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);

after(() => {
  jwksServer?.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Human Auth：没有 Bearer -> 401', () => {
  it('生产模式无 Bearer 直接 401，不回落 local user', async () => {
    const originalDevMode = config.authDevMode;
    config.authDevMode = false;
    try {
      await withServer(probeApp(), async (base) => {
        const response = await fetch(`${base}/probe`);
        assert.equal(response.status, 401);
      });
    } finally {
      config.authDevMode = originalDevMode;
    }
  });

  it('dev 模式无 Bearer 回落本地占位（仅开发）', async () => {
    const originalDevMode = config.authDevMode;
    config.authDevMode = true;
    try {
      await withServer(probeApp(), async (base) => {
        const response = await fetch(`${base}/probe`);
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as { principalId: string }).principalId, config.localActorId);
      });
    } finally {
      config.authDevMode = originalDevMode;
    }
  });
});

describe('Human Auth：JWT 校验', () => {
  it('错误 issuer / audience / 垃圾 token 一律 401，合法 JWT 通过', async () => {
    await startJwks();
    const originalDevMode = config.authDevMode;
    const originalOidc = { ...config.oidc };
    config.authDevMode = false;
    config.oidc.issuer = ISSUER;
    config.oidc.audience = AUDIENCE;
    config.oidc.jwksUrl = jwksUrl;
    try {
      await withServer(probeApp(), async (base) => {
        const get = (headers?: Record<string, string>) => fetch(`${base}/probe`, { headers });

        assert.equal((await get()).status, 401);
        assert.equal((await get({ authorization: 'Bearer garbage' })).status, 401);
        assert.equal(
          (await get({ authorization: `Bearer ${await signToken({ issuer: 'https://evil.example' })}` })).status,
          401,
          '错误 issuer 必须 401',
        );
        assert.equal(
          (await get({ authorization: `Bearer ${await signToken({ audience: 'other-app' })}` })).status,
          401,
          '错误 audience 必须 401',
        );

        const ok = await get({ authorization: `Bearer ${await signToken()}` });
        assert.equal(ok.status, 200);
        assert.equal(((await ok.json()) as { principalId: string }).principalId, 'user-1');
      });
    } finally {
      config.authDevMode = originalDevMode;
      config.oidc.issuer = originalOidc.issuer;
      config.oidc.audience = originalOidc.audience;
      config.oidc.jwksUrl = originalOidc.jwksUrl;
    }
  });
});

describe('用户消息归属', () => {
  it('消息的 senderId 是当前登录用户，不是写死的 local-user', async () => {
    const alice = stack.team.createMember({ name: 'Sender Alice', role: 'E' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Sender room',
      memberIds: [alice.id],
      leadMemberId: alice.id,
    });
    const sent = await stack.team.sendMessage({
      conversationId: room.id,
      actorId: 'user-9',
      content: '我是 user-9',
    });
    assert.equal(sent.message.senderId, 'user-9');
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_for_member')`,
        )
        .get(room.id) as unknown as { n: number };
      if (row.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});

describe('Conversation ACL', () => {
  it('inactive Team member -> 403，非 Team 成员 -> 403', async () => {
    const defaultTeam = stack.structure.ensureDefaultTeam();
    stack.structure.ensureHumanOwner(defaultTeam.id, 'auth-owner');
    const alice = stack.team.createMember({ name: 'Auth Alice', role: 'E' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'ACL room',
      memberIds: [alice.id],
      leadMemberId: alice.id,
    });

    // principal 注入：一般 HTTP 测试走 stub 中间件，这里直接挂。
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const principalId = req.headers['x-test-principal'];
      if (typeof principalId === 'string') {
        (req as { principal?: unknown }).principal = { kind: 'human', principalId, claims: {} };
      }
      next();
    });
    app.use('/api/conversations/:id/ping', requireConversationAccess(stack.team, 'id'), (_req, res) => {
      res.json({ ok: true });
    });

    await withServer(app, async (base) => {
      const ping = (principalId: string) =>
        fetch(`${base}/api/conversations/${room.id}/ping`, {
          headers: { 'x-test-principal': principalId },
        });

      assert.equal((await ping('auth-owner')).status, 200);
      assert.equal((await ping('stranger')).status, 403, '非 Team 成员 403');

      // 先立第二个 owner，否则“最后一个 owner 不能停用”会先拦下来。
      stack.structure.ensureHumanOwner(defaultTeam.id, 'auth-owner-standby');
      stack.structure.updateMembership(defaultTeam.id, 'human', 'auth-owner', { status: 'inactive' });
      try {
        assert.equal((await ping('auth-owner')).status, 403, '停用的成员 403');
      } finally {
        stack.structure.updateMembership(defaultTeam.id, 'human', 'auth-owner', { status: 'active' });
      }
    });
  });

  it('conversation 不属于该 Team -> 403', async () => {
    const defaultTeam = stack.structure.ensureDefaultTeam();
    stack.structure.ensureHumanOwner(defaultTeam.id, 'auth-owner-2');
    const alice = stack.team.createMember({ name: 'Auth Alice2', role: 'E' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Foreign room',
      memberIds: [alice.id],
      leadMemberId: alice.id,
    });
    // 把房间挂到另一个 Team 名下：调用方是默认 Team 的 owner，但房间不是他的。
    const stamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO team (id, name, description, created_by, created_at, updated_at)
       VALUES ('team-other', 'Other', '', 'test', ?, ?)`,
    ).run(stamp, stamp);
    db.prepare(`UPDATE conversation SET team_id = ? WHERE id = ?`).run('team-other', room.id);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { principal?: unknown }).principal = { kind: 'human', principalId: 'auth-owner-2', claims: {} };
      next();
    });
    app.use('/api/conversations/:id/ping', requireConversationAccess(stack.team, 'id'), (_req, res) => {
      res.json({ ok: true });
    });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/conversations/${room.id}/ping`);
      assert.equal(response.status, 403);
    });
  });

  it('Agent 不属于 conversation -> 403，在房间里 -> 通过', async () => {
    const alice = stack.team.createMember({ name: 'Auth Alice3', role: 'E' });
    const bob = stack.team.createMember({ name: 'Auth Bob3', role: 'E' });
    const room = stack.team.createConversation({
      kind: 'task',
      title: 'Agent ACL room',
      memberIds: [alice.id],
      leadMemberId: alice.id,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const agentId = req.headers['x-test-agent'];
      if (typeof agentId === 'string') {
        (req as { agentMemberId?: unknown }).agentMemberId = agentId;
      } else {
        (req as { principal?: unknown }).principal = { kind: 'human', principalId: 'nobody', claims: {} };
      }
      next();
    });
    app.use('/api/conversations/:id/ping', requireConversationAccess(stack.team, 'id'), (_req, res) => {
      res.json({ ok: true });
    });

    await withServer(app, async (base) => {
      const outsider = await fetch(`${base}/api/conversations/${room.id}/ping`, {
        headers: { 'x-test-agent': bob.id },
      });
      assert.equal(outsider.status, 403, '不在房间的 Agent 403');
      const insider = await fetch(`${base}/api/conversations/${room.id}/ping`, {
        headers: { 'x-test-agent': alice.id },
      });
      assert.equal(insider.status, 200);
    });
  });
});
