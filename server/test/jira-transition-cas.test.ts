import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `JiraProvider.transitionIfVersion` —— 条件流转。
 *
 * ── 为什么流转比评论更需要它 ─────────────────────────────────────────
 *
 *   评论写错了是一条多余的信息，可以删；
 *   流转写错了是把工作项推进到了错误的状态，而 workflow 通常**没有回头路**。
 *
 * Command 是在「看到某个版本的工单」时被批准的，而批准到执行之间工单可能已经
 * 被人改了。一笔基于「In Review」批准的流转，如果期间有人把它退回了
 * 「In Progress」，无条件写会把它推到一个当前**不合法**的目标状态（或者落到
 * 一个语义完全不同的 transition 上），而记录看起来是一次正常执行。
 *
 * ── 两个判定点，缺一不可 ─────────────────────────────────────────────
 *
 *   第一次读 → 让「已变化」这条错误能带上一句人话（版本从 A 变成 B），
 *              而不是一个光秃秃的 412。错误信息的质量决定这类问题能不能排查。
 *   第二次写 → **真正关掉窗口的那一步**：带 `If-Unmodified-Since`，Jira 在
 *              事务里比对，412 就作废。
 *
 * 所以下面既断言「版本不符时不发写请求」，也断言「版本相符时写请求带着版本头」。
 * 只测前者会放过一个「比对完就无条件写」的实现 —— 那个实现在「比对」和「写」
 * 之间仍然有窗口。
 */

let calls: Array<{ url: string; method: string; ifUnmodifiedSince: string | null; body: unknown }> = [];
let restoreFetch: () => void = () => {};

const VERSION_OLD = '2026-09-26T10:00:00.000Z';
const VERSION_NEW = '2026-09-26T11:30:00.000Z';

/** 让 getIssue 返回 `updated = serverVersion`，并记账每一次请求。 */
function stubFetch(serverVersion: string): void {
  calls = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      ifUnmodifiedSince: headers['If-Unmodified-Since'] ?? null,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(
      JSON.stringify({
        id: '10001',
        key: 'ABC-1',
        fields: {
          summary: 'Fix the thing',
          description: null,
          status: { name: 'In Review' },
          assignee: null,
          updated: serverVersion,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

before(() => {
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
});

after(() => restoreFetch());

const { JiraClient } = await import('../jira/client.js');
const { JiraProvider } = await import('../work-management/jira-provider.js');

const provider = new JiraProvider(
  new JiraClient({ baseUrl: 'https://acme.atlassian.net/', email: 'e', apiToken: 't' }),
  'https://acme.atlassian.net/',
);
const ref = { provider: 'jira' as const, externalId: '10001', key: 'ABC-1', url: null };

describe('JiraProvider：条件流转（transitionIfVersion）', () => {
  it('版本相符：发出流转，并带上 If-Unmodified-Since', async () => {
    stubFetch(VERSION_OLD);

    await provider.transitionIfVersion(ref, '31', VERSION_OLD);

    const writes = calls.filter((call) => call.method === 'POST');
    assert.equal(writes.length, 1);
    assert.match(writes[0].url, /\/issue\/ABC-1\/transitions$/);
    assert.deepEqual(writes[0].body, { transition: '31' });
    assert.equal(
      writes[0].ifUnmodifiedSince,
      VERSION_OLD,
      '不带版本头的话，判定和写入之间仍然有窗口 —— 那正是要关掉的东西',
    );
  });

  it('版本不符：抛错，且一个写请求都不发', async () => {
    stubFetch(VERSION_NEW);

    await assert.rejects(
      () => provider.transitionIfVersion(ref, '31', VERSION_OLD),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /已变化/);
        assert.match(message, /拒绝执行旧 Command/);
        // 人话里必须有两个版本号，否则排查时不知道是「谁改的」还是「读到的是哪一版」。
        assert.match(message, new RegExp(VERSION_OLD));
        assert.match(message, new RegExp(VERSION_NEW));
        return true;
      },
    );

    assert.equal(
      calls.filter((call) => call.method === 'POST').length,
      0,
      '已经知道版本不符还发写请求，等于把决策施加到新状态上',
    );
  });

  it('不带版本头的 transition 仍然可用（控制面直接发起的路径）', async () => {
    stubFetch(VERSION_OLD);

    await provider.transition(ref, '31');

    const writes = calls.filter((call) => call.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0].ifUnmodifiedSince,
      null,
      '没有 resourceVersion 的 Command 走这条 —— 它不是「更安全」，而是「没有可比的版本」',
    );
  });

  it('addCommentIfVersion 与它是同一个形状（两处判定必须一致）', async () => {
    stubFetch(VERSION_NEW);

    await assert.rejects(
      () => provider.addCommentIfVersion(ref, '看过了', VERSION_OLD),
      /已变化/,
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  });
});
