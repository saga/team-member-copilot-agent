import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { config } from '../config.js';
import { internalRouter } from '../routes/internal.js';
import { membersRouter } from '../routes/members.js';
import type { TeamService } from '../team-service.js';

/**
 * Internal Member runtime API 的边界。
 *
 * 这里要证明的是**结构**，不是业务：以某个 Member 的身份说话的能力，不能
 * 长在普通用户 REST 路径上，也不能在没有凭证时被任意调用。
 *
 * 所以这个文件不碰数据库、不建 TeamService，只用一个记账用的假 team 把
 * 「请求到底有没有走到 handler」变成可断言的事实 —— 401 用例必须同时断言
 * `calls` 为空，否则一个「先执行业务再返回 401」的实现也会通过。
 *
 * 挂载顺序刻意与 app.ts 保持一致（members 在前、internal 在后、最后是 /api 404），
 * 这样「旧路径现在返回 404」才是对真实路由表的断言。
 */

interface DirectMessageCall {
  fromMemberId: string;
  toMemberId: string;
  content: string;
}

const calls: DirectMessageCall[] = [];

const fakeTeam = {
  sendDirectMessage: async (input: DirectMessageCall) => {
    calls.push(input);
    return { conversation: { id: 'c1' }, peer: { id: input.toMemberId }, wakes: [] };
  },
  listDirectMessages: () => [],
} as unknown as TeamService;

let server: Server;
let base: string;
/** 用例之间要改 token，测完恢复成进程启动时那份，避免污染其它断言。 */
const originalToken = config.internalApiToken;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/members', membersRouter(fakeTeam));
  app.use('/api/internal', internalRouter(fakeTeam));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  config.internalApiToken = originalToken;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { toMemberId: 'm2', content: '看一下风险' };

describe('以 Member 身份说话：路径归属', () => {
  it('长在 /api/internal 下，不在用户成员管理的路径上', async () => {
    config.internalApiToken = '';
    calls.length = 0;

    const moved = await post('/api/members/m1/direct-messages', VALID_BODY);
    assert.equal(
      moved.status,
      404,
      '旧的 Human API 路径仍然可写 —— 任何能访问服务的人都能替任意 Member 发言',
    );
    assert.equal(calls.length, 0, '旧路径不该再触达业务');

    const internal = await post('/api/internal/members/m1/direct-messages', VALID_BODY);
    assert.equal(internal.status, 202);
    assert.deepEqual(calls, [{ fromMemberId: 'm1', toMemberId: 'm2', content: '看一下风险' }]);
  });

  it('读留在了 Human API —— 读不需要「我代表谁」', async () => {
    const response = await fetch(`${base}/api/members/m1/direct-messages`);
    assert.equal(response.status, 200);
  });
});

describe('token 门禁', () => {
  it('未配置 INTERNAL_API_TOKEN 时放行（本机单用户原型）', async () => {
    config.internalApiToken = '';
    calls.length = 0;

    const response = await post('/api/internal/members/m1/direct-messages', VALID_BODY);
    assert.equal(response.status, 202);
    assert.equal(calls.length, 1);
  });

  it('配置之后，不带凭证一律 401，且不触达业务', async () => {
    config.internalApiToken = 's3cret';
    calls.length = 0;

    const response = await post('/api/internal/members/m1/direct-messages', VALID_BODY);
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0, '403/401 之前就已经执行了业务，等于没有门禁');
  });

  it('Authorization: Bearer 与 X-Internal-Token 都认', async () => {
    config.internalApiToken = 's3cret';

    calls.length = 0;
    const bearer = await post('/api/internal/members/m1/direct-messages', VALID_BODY, {
      Authorization: 'Bearer s3cret',
    });
    assert.equal(bearer.status, 202);
    assert.equal(calls.length, 1);

    calls.length = 0;
    const header = await post('/api/internal/members/m1/direct-messages', VALID_BODY, {
      'X-Internal-Token': 's3cret',
    });
    assert.equal(header.status, 202);
    assert.equal(calls.length, 1);
  });

  it('门禁在参数校验之前 —— 凭证不对时连 400 都不给', async () => {
    config.internalApiToken = 's3cret';
    calls.length = 0;

    const response = await post('/api/internal/members/m1/direct-messages', { toMemberId: '' });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });

  it('凭证正确但参数不合法时是 400，且不触达业务', async () => {
    config.internalApiToken = 's3cret';
    calls.length = 0;

    const response = await post(
      '/api/internal/members/m1/direct-messages',
      { toMemberId: 'm2', content: '   ' },
      { Authorization: 'Bearer s3cret' },
    );
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});
