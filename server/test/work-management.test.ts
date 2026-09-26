import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';

/**
 * External Work System Adapter。
 *
 * 这一组用例锁的是**边界**，不是功能：
 *
 *   1. 本地只有引用，没有工单对象 —— 适配层不能长出第二套工作模型
 *   2. 传输可换：业务契约是 WorkManagementProvider，JiraClient 只是 REST 实现
 *   3. webhook 是最小投影：只说明「变了什么字段」，不携带变化后的值
 *   4. 控制面与 Agent 共用同一个 Provider 实例，不经过 LLM
 *
 * 第 3 条尤其重要：一旦 webhook 把 status 的新值写进本地，本地就有了第二份
 * 会过期的工单状态。这种 bug 最难查 —— 本地显示 Done，Jira 里其实是 In Review，
 * 两边看起来都对。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-work-mgmt-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { config } = await import('../config.js');
const { createTestStack, StubCopilot } = await import('./support.js');
const {
  normalizeExternalWorkRef,
  parseExternalWorkRef,
  parseExternalWorkSnapshot,
  WorkManagementRegistry,
} = await import('../work-management/types.js');
const { JiraProvider } = await import('../work-management/jira-provider.js');
const { JiraClient } = await import('../jira/client.js');
const { workManagementRouter } = await import('../routes/work-management.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ 引用（值对象）

describe('ExternalWorkRef：本地唯一持有的业务标识', () => {
  it('规范化只做形状与空白，不查存在性', () => {
    assert.deepEqual(normalizeExternalWorkRef({ key: ' ABC-1 ' }), {
      provider: 'jira',
      key: 'ABC-1',
      externalId: null,
    });
    // 空 key 当作「没有引用」，而不是造一个指向空工单的引用 ——
    // 那种引用会一路传到 Jira 变成一个 404。
    assert.equal(normalizeExternalWorkRef({ key: '   ' }), null);
    assert.equal(normalizeExternalWorkRef(null), null);
    assert.equal(normalizeExternalWorkRef(undefined), null);
  });

  it('不认识的外部工作系统显式报错，不静默当成 Jira', () => {
    assert.throws(
      () => normalizeExternalWorkRef({ provider: 'linear', key: 'ENG-1' }),
      /不支持的外部工作系统/,
    );
  });

  it('坏数据（手改过 / 老版本写的）读回 null，不抛', () => {
    assert.equal(parseExternalWorkRef(null), null);
    assert.equal(parseExternalWorkRef(''), null);
    assert.equal(parseExternalWorkRef('not json'), null);
    assert.equal(parseExternalWorkRef('{"provider":"jira"}'), null, '没有 key 的引用没有意义');
    assert.equal(parseExternalWorkRef('{"provider":"linear","key":"ENG-1"}'), null);
  });

  it('取证快照缺 ref 或缺 title 就是坏数据 —— 宁可为空，不要半条', () => {
    assert.equal(parseExternalWorkSnapshot(null), null);
    assert.equal(parseExternalWorkSnapshot('{"title":"x"}'), null);
    assert.equal(
      parseExternalWorkSnapshot(JSON.stringify({ ref: { provider: 'jira', key: 'A-1' } })),
      null,
      '没有 title 的快照说明不了「当时在干什么活」',
    );

    const snapshot = {
      ref: { provider: 'jira' as const, externalId: '1', key: 'A-1', url: null },
      title: 'Fix the thing',
      status: 'In Progress',
      assignee: 'Ada',
      capturedAt: '2026-09-26T00:00:00.000Z',
    };
    assert.deepEqual(parseExternalWorkSnapshot(JSON.stringify(snapshot)), snapshot);
  });
});

// ---------------------------------------------------------------- Registry

describe('WorkManagementRegistry：查不到必须抛，不能静默跳过', () => {
  const provider = new JiraProvider(
    new JiraClient({ baseUrl: 'https://acme.atlassian.net', email: 'e', apiToken: 't' }),
    'https://acme.atlassian.net',
  );

  it('未注册时查不到 —— 静默返回 null 会让「校验 + 取证」被悄悄跳过', () => {
    const empty = new WorkManagementRegistry();
    assert.equal(empty.size, 0);
    assert.equal(empty.has('jira'), false);
    assert.throws(() => empty.byId('jira'), /未注册 Work Management Provider/);
  });

  it('同一个 providerId 注册两次直接抛：否则「用哪个实现」取决于注册顺序', () => {
    const registry = new WorkManagementRegistry();
    registry.register(provider);
    assert.equal(registry.size, 1);
    assert.equal(registry.has('jira'), true);
    assert.throws(() => registry.register(provider), /重复注册 Work Management Provider/);
  });
});

// ------------------------------------------------------- JiraProvider（REST）

describe('JiraProvider：把五个动作翻译成 REST，不做本地建模', () => {
  interface Call {
    url: string;
    method: string;
    body: unknown;
  }

  let calls: Call[] = [];
  let restore: () => void = () => {};

  before(() => {
    const original = globalThis.fetch;
    restore = () => {
      globalThis.fetch = original;
    };
  });

  after(() => restore());

  function stubFetch(responder: (url: string) => unknown): void {
    calls = [];
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(responder(url) ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }

  const provider = new JiraProvider(
    new JiraClient({ baseUrl: 'https://acme.atlassian.net/', email: 'e', apiToken: 't' }),
    'https://acme.atlassian.net/',
  );

  const ISSUE = {
    id: '10001',
    key: 'ABC-1',
    fields: {
      summary: 'Fix the thing',
      description: null,
      status: { name: 'In Progress' },
      assignee: { displayName: 'Ada' },
    },
  };

  it('ref()：由 Provider 补深链（只有它知道站点地址），并吃掉尾部斜杠', () => {
    assert.deepEqual(provider.ref({ key: ' ABC-1 ' }), {
      provider: 'jira',
      externalId: 'ABC-1',
      key: 'ABC-1',
      url: 'https://acme.atlassian.net/browse/ABC-1',
    });
  });

  it('get()：externalId 取不可变的 issue id，而不是会变的 key', async () => {
    stubFetch(() => ISSUE);
    const summary = await provider.get(provider.ref({ key: 'ABC-1' }));

    assert.ok(calls[0].url.includes('/rest/api/3/issue/ABC-1'), '按 key 寻址');
    assert.equal(summary.ref.externalId, '10001', 'get 之后引用带上不可变 id');
    assert.equal(summary.ref.key, 'ABC-1');
    assert.equal(summary.title, 'Fix the thing');
    assert.equal(summary.status, 'In Progress');
    assert.equal(summary.assignee, 'Ada');
  });

  it('search()：JQL 原样透传（Provider 自己的查询语法，不做统一）', async () => {
    stubFetch(() => ({ issues: [ISSUE] }));
    const found = await provider.search('project = ABC AND status != Done', 5);

    assert.equal(found.length, 1);
    assert.equal(found[0].ref.key, 'ABC-1');
    assert.ok(calls[0].url.includes(`jql=${encodeURIComponent('project = ABC AND status != Done')}`));
    assert.ok(calls[0].url.includes('maxResults=5'));
  });

  it('addComment()：body 转成 ADF（v3 的 comment 只吃 ADF）', async () => {
    stubFetch(() => ({}));
    await provider.addComment(provider.ref({ key: 'ABC-1' }), '看过了');

    assert.equal(calls[0].method, 'POST');
    assert.ok(calls[0].url.endsWith('/issue/ABC-1/comment'));
    assert.deepEqual(calls[0].body, {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '看过了' }] }],
    });
  });

  it('assign()：null 是「取消指派」，不是「不改」', async () => {
    stubFetch(() => ({}));
    await provider.assign(provider.ref({ key: 'ABC-1' }), 'acc-9');
    assert.equal(calls[0].method, 'PUT');
    assert.deepEqual(calls[0].body, { accountId: 'acc-9' });

    stubFetch(() => ({}));
    await provider.assign(provider.ref({ key: 'ABC-1' }), null);
    assert.deepEqual(calls[0].body, { accountId: null }, 'null 必须原样发出去');
  });

  it('listTransitions()：带上目标状态名，让 Agent 不必试错挑 id', async () => {
    stubFetch(() => ({
      transitions: [
        { id: '21', name: 'Start', to: { name: 'In Progress' } },
        { id: '31', name: 'Done', to: { name: 'Done' } },
      ],
    }));
    assert.deepEqual(await provider.listTransitions(provider.ref({ key: 'ABC-1' })), [
      { id: '21', name: 'Start', to: 'In Progress' },
      { id: '31', name: 'Done', to: 'Done' },
    ]);
  });

  it('Jira 报错时抛出带状态码的错误，不静默返回空', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 404 })) as typeof fetch;
    await assert.rejects(() => provider.get(provider.ref({ key: 'ABC-404' })), /Jira API 404/);
  });
});

// ---------------------------------------------- 控制面取证（不经 LLM，直连 Provider）

describe('execution 开始时的取证：控制面直连 Provider', () => {
  const originalFetch = globalThis.fetch;
  const registry = new WorkManagementRegistry();
  registry.register(
    new JiraProvider(
      new JiraClient({ baseUrl: 'https://acme.atlassian.net', email: 'e', apiToken: 't' }),
      'https://acme.atlassian.net',
    ),
  );

  let jiraCalls = 0;

  before(() => {
    globalThis.fetch = (async (input: unknown) => {
      jiraCalls += 1;
      assert.ok(
        String(input).includes('/rest/api/3/issue/ABC-2001'),
        `控制面取证应当直连 Jira 的 issue 端点，实际请求了 ${String(input)}`,
      );
      return new Response(
        JSON.stringify({
          id: '2001',
          key: 'ABC-2001',
          fields: {
            summary: 'Ship the adapter',
            description: null,
            status: { name: 'In Progress' },
            assignee: { displayName: 'Ada' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('跑完一轮之后，取证快照仍然在 —— 收口的 update 不能把它抹掉', async () => {
    const memberService = new MemberService(db);
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot, registry);
    const agent = stack.team.createMember({ name: 'SnapshotProbe', role: 'E' });
    const room = stack.team.createConversation({
      kind: 'work',
      title: 'ABC-2001',
      externalWorkRef: { provider: 'jira', key: 'ABC-2001' },
      memberIds: [agent.id],
    });

    const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'start' });
    assert.equal(sent.wakes.length, 1, '期望恰好一个唤醒');
    const executionId = findExecutionId(db, room.id);

    await waitFor(
      () => stack.team.getExecution(executionId).status === 'completed',
      'execution 跑完',
    );

    const execution = stack.team.getExecution(executionId);
    assert.equal(jiraCalls, 1, '控制面应当只取证一次');
    assert.ok(execution.externalWorkSnapshot, '开跑时取到的快照必须留下来');
    assert.equal(execution.externalWorkSnapshot.status, 'In Progress');
    assert.equal(execution.externalWorkSnapshot.title, 'Ship the adapter');
    assert.equal(execution.externalWorkSnapshot.assignee, 'Ada');
    assert.equal(
      execution.externalWorkSnapshot.ref.externalId,
      '2001',
      '快照里的引用带不可变 id',
    );
    assert.equal(execution.externalWorkRef?.key, 'ABC-2001', '引用本身不因取证而漂移');
  });
});

function findExecutionId(db: DatabaseSync, conversationId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM execution WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(conversationId) as unknown as { id: string } | undefined;
  assert.ok(row, '找不到 execution');
  return row.id;
}

/** 轮询直到条件成立或超时。 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等待超时：${what}`);
}

// ------------------------------------------------------------ webhook（HTTP）

describe('Jira webhook：最小投影 + 共享密钥门禁', () => {
  let server: Server;
  let base: string;
  const originalSecret = config.jira.webhookSecret;

  const memberService = new MemberService(db);
  const registry = new WorkManagementRegistry();
  registry.register(
    new JiraProvider(
      new JiraClient({ baseUrl: 'https://acme.atlassian.net', email: 'e', apiToken: 't' }),
      'https://acme.atlassian.net',
    ),
  );

  // Copilot stub：这个 describe 不跑 turn，只验 webhook → 投影这一段。
  const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
  const agent = stack.team.createMember({ name: 'WebhookAgent', role: 'E' });
  const room = stack.team.createConversation({
    kind: 'work',
    title: 'ABC-777',
    externalWorkRef: { provider: 'jira', key: 'ABC-777' },
    memberIds: [agent.id],
  });

  before(async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/work-management', workManagementRouter(stack.team, registry));
    server = app.listen(0);
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    config.jira.webhookSecret = originalSecret;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}/api/work-management/jira/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('/providers：让前端问平台「接了哪些外部系统」，而不是自己猜 provider id', async () => {
    const response = await fetch(`${base}/api/work-management/providers`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { providers: ['jira'] });
  });

  it('payload 里带整张工单也只投影三样：id / key / 变了哪些字段', async () => {
    config.jira.webhookSecret = '';

    const response = await post({
      webhookEvent: 'jira:issue_updated',
      // Jira 真的会推这么多东西过来。关键是：一个字节都不写进本地。
      issue: {
        id: '100777',
        key: 'ABC-777',
        self: 'https://acme.atlassian.net/rest/api/3/issue/100777',
        fields: {
          summary: 'SECRET SUMMARY',
          status: { name: 'SECRET STATUS' },
          assignee: { displayName: 'SECRET ASSIGNEE' },
          customfield_10042: 'SECRET CUSTOM FIELD',
        },
      },
      changelog: {
        items: [
          { field: 'status', fromString: 'To Do', toString: 'In Progress' },
          { field: 'assignee', fromString: null, toString: 'Ada' },
        ],
      },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { matched: number; conversations: string[] };
    assert.equal(body.matched, 1);
    assert.deepEqual(body.conversations, [room.id]);

    // 本地那份事件里绝不能出现工单内容。查库比查响应更直接：
    // 只要它进了 payload，就进了 conversation_event 表。
    const row = db
      .prepare(
        `SELECT payload FROM conversation_event
         WHERE conversation_id = ? AND event_type = 'external_work.changed'
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(room.id) as unknown as { payload: string } | undefined;
    assert.ok(row, '必须落库一条 external_work.changed（断线重连靠它补发）');

    assert.ok(!row.payload.includes('SECRET'), `本地事件里混进了工单内容：${row.payload}`);
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['changedFields', 'receivedAt', 'ref'],
      'payload 只说明「变了什么字段」，不携带变化后的值',
    );
    assert.deepEqual(payload.changedFields, ['status', 'assignee']);
  });

  it('没挂这条工单的房间不受影响（matched=0 是正常结果，不是错误）', async () => {
    config.jira.webhookSecret = '';
    const response = await post({
      webhookEvent: 'jira:issue_updated',
      issue: { id: '999999', key: 'NOPE-1' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { matched: 0, conversations: [] });
  });

  it('配了密钥之后：不带 / 带错的都 401，带对才放行', async () => {
    config.jira.webhookSecret = 'webhook-secret';

    const body = { webhookEvent: 'jira:issue_updated', issue: { id: '100777', key: 'ABC-777' } };

    const noHeader = await post(body);
    assert.equal(noHeader.status, 401);

    const wrong = await post(body, { 'X-Jira-Webhook-Secret': 'nope' });
    assert.equal(wrong.status, 401);

    const right = await post(body, { 'X-Jira-Webhook-Secret': 'webhook-secret' });
    assert.equal(right.status, 200);
    assert.equal(((await right.json()) as { matched: number }).matched, 1);
  });
});
