import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Command 的**失败谱系**：`completed` ≠ HTTP 200。
 *
 * ── 这一组用例锁的两件事 ─────────────────────────────────────────────
 *
 *   1. 分界在**传输层**，不在文案里。Jira 客户端把每一种失败翻译成带
 *      `kind` / `status` 的 `ExternalOperationError`，Command 层只读结构化
 *      字段。断言这一条的方式是**打桩 fetch**、让真实的 client 去跑 ——
 *      如果哪天有人把结构化错误改回 `throw new Error('Jira API 500 …')`，
 *      这里会红。
 *
 *   2. `unknown` 与 `failed` 是两个结论，动作相反。
 *      failed  = 确认没发生 → 可以重试
 *      unknown = 可能已发生 → 必须先对账，重试就是重复副作用
 *
 *      把 5xx / 超时记成 failed，是最容易被「修」成事故的一处：它让重试
 *      看起来安全，而重试的代价是第二条 Jira 评论。
 *
 * 顺带锁住 `command_attempt`：同一笔动作的每一次尝试都必须留痕，包括那次
 * 「我们不知道发生了什么」的尝试 —— 它会被后续的 succeeded 覆盖掉，而那
 * 正是审计最需要的一段。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-cmd-outcome-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { AuditService } = await import('../audit-service.js');
const { EntitlementService } = await import('../entitlement-service.js');
const { CommandService, UnknownCommandOutcomeError } = await import('../command-service.js');
const { JiraClient } = await import('../jira/client.js');
const { classifyExternalError, ExternalOperationError } = await import(
  '../work-management/outcome.js'
);
const { createTestStack, StubCopilot, singleExecutionId } = await import('./support.js');
import type { CommandPolicy } from '../policy.js';
import type { CopilotService } from '../copilot.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const audit = new AuditService(db);
const memberService = new MemberService(db);
const stack = createTestStack(
  db,
  memberService,
  new StubCopilot().asCopilot as unknown as CopilotService,
);

let conversationId = '';
let memberId = '';
let executionId = '';

before(async () => {
  const member = stack.team.createMember({ name: 'Outcome Subject', role: 'Engineer' });
  memberId = member.id;
  const room = stack.team.createConversation({
    kind: 'task',
    title: 'Command outcome',
    memberIds: [member.id],
  });
  conversationId = room.id;

  const sent = await stack.team.sendMessage({
    actorId: 'test-user',
    conversationId: room.id,
    content: '起一轮',
  });
  executionId = singleExecutionId(db, room.id, sent.wakes);
});

// ------------------------------------------------------------------ 工具

function allowPolicy(): CommandPolicy {
  return {
    revision: () => 'test-allow',
    decideCommand: () => ({ allowed: true, reason: 'test allow' }),
  };
}

let keyCounter = 0;
function nextKey(prefix = 'k'): string {
  keyCounter += 1;
  return `${prefix}-${keyCounter}`;
}

function statusOf(commandId: string): string {
  return (
    db.prepare(`SELECT status FROM command WHERE id = ?`).get(commandId) as unknown as {
      status: string;
    }
  ).status;
}

function eventsOf(commandId: string): string[] {
  return audit.listCommandAudit(commandId).map((row) => row.event);
}

/**
 * 一个 CommandService，它的执行器就是「跑这段函数」。
 *
 * 之所以让调用方自己给执行体，是因为这一组用例要测的正是**执行体抛什么**
 * 会被翻译成什么状态 —— 把那一步藏进 helper 里会让用例读起来像在测 helper。
 */
function serviceWith(execute: () => Promise<unknown>, policy?: CommandPolicy) {
  const service = new CommandService(
    db,
    new EntitlementService(db),
    policy ?? allowPolicy(),
    audit,
  );
  service.registerExecutor('test.action', async () => execute());
  return service;
}

function requestFor(idempotencyKey: string) {
  return {
    executionId,
    conversationId,
    memberId,
    actorType: 'agent' as const,
    actorId: memberId,
    action: 'test.action',
    target: 'TARGET-1',
    args: { body: 'hello' },
    idempotencyKey,
  };
}

/** 捕获一次 reject，并把 error 交回来断言 —— `assert.rejects` 给不到 error 本身。 */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛错，但它成功了');
}

/** 用打桩的 fetch 跑一段代码，跑完恢复原样。 */
async function withFetch(
  respond: () => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => respond()) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const jira = new JiraClient({
  baseUrl: 'https://jira.test',
  email: 'bot@example.com',
  apiToken: 'token',
});

// ------------------------------------------- 1. 传输层：失败必须结构化

describe('Jira 客户端：失败被翻译成结构化的 ExternalOperationError', () => {
  it('5xx → unknown（服务端收到了请求，但没给出结论）', async () => {
    await withFetch(
      () => new Response('upstream boom', { status: 500 }),
      async () => {
        const error = await capture(() => jira.addComment('ABC-1', 'hi'));
        assert.ok(error instanceof ExternalOperationError, '必须是结构化错误，不是裸 Error');
        assert.equal(error.kind, 'unknown');
        assert.equal(error.status, 500);
        assert.equal(classifyExternalError(error), 'unknown');
      },
    );
  });

  it('400 → definite（服务端明确拒绝了，写入没有发生）', async () => {
    await withFetch(
      () => new Response('bad field', { status: 400 }),
      async () => {
        const error = await capture(() => jira.addComment('ABC-1', 'hi'));
        assert.ok(error instanceof ExternalOperationError);
        assert.equal(error.kind, 'definite');
        assert.equal(error.status, 400);
      },
    );
  });

  it('412 → definite（If-Unmodified-Since 不匹配是一条「写入没发生」的强证据）', async () => {
    await withFetch(
      () => new Response('', { status: 412 }),
      async () => {
        const error = await capture(() => jira.addComment('ABC-1', 'hi', 'Wed, 21 Oct 2015 07:28:00 GMT'));
        assert.ok(error instanceof ExternalOperationError);
        assert.equal(error.kind, 'definite');
        assert.equal(error.status, 412);
      },
    );
  });

  it('429 → unknown（可能在限流之前已经处理过一部分）', async () => {
    await withFetch(
      () => new Response('slow down', { status: 429 }),
      async () => {
        const error = await capture(() => jira.getIssue('ABC-1'));
        assert.ok(error instanceof ExternalOperationError);
        assert.equal(error.kind, 'unknown');
      },
    );
  });

  it('fetch 抛 ECONNRESET → unknown（连接建起来过，服务端可能已经处理）', async () => {
    await withFetch(
      () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        });
      },
      async () => {
        const error = await capture(() => jira.addComment('ABC-1', 'hi'));
        assert.ok(error instanceof ExternalOperationError, '传输层失败也要结构化');
        assert.equal(error.kind, 'unknown');
        assert.equal(error.status, null, '连响应都没有 → status 是 null，不是 0');
      },
    );
  });

  it('fetch 抛 ECONNREFUSED → definite（连接没建起来 = 请求没发出去）', async () => {
    await withFetch(
      () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      },
      async () => {
        const error = await capture(() => jira.addComment('ABC-1', 'hi'));
        assert.ok(error instanceof ExternalOperationError);
        assert.equal(error.kind, 'definite');
      },
    );
  });

  it('AbortError → unknown（超时就是「请求发出去了，没等到答复」）', async () => {
    await withFetch(
      () => {
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      },
      async () => {
        const error = await capture(() => jira.getIssue('ABC-1'));
        assert.ok(error instanceof ExternalOperationError);
        assert.equal(error.kind, 'unknown');
      },
    );
  });

  it('204 不是错误：正常返回 undefined', async () => {
    await withFetch(
      () => new Response(null, { status: 204 }),
      async () => {
        assert.equal(await jira.assign('ABC-1', null), undefined);
      },
    );
  });
});

// ------------------------------------------- 2. 状态机：unknown vs failed

describe('Command：外部结果未知必须进 unknown，不能记成 failed', () => {
  it('5xx（走真实 client）→ unknown，且留一条 unknown 的 attempt 与审计', async () => {
    let attempts = 0;
    const service = serviceWith(async () => {
      attempts += 1;
      await withFetch(
        () => new Response('boom', { status: 503 }),
        async () => {
          await jira.addComment('ABC-1', 'hi');
        },
      );
    });

    const input = requestFor(nextKey('unknown-5xx'));
    const error = await capture(() => service.request(input));

    assert.ok(error instanceof UnknownCommandOutcomeError, '必须是可被程序识别的结论');
    assert.equal(attempts, 1, '只打了一次外部系统');

    const commandId = error.command.id;
    assert.equal(statusOf(commandId), 'unknown');

    const rows = service.listAttempts(commandId);
    assert.equal(rows.length, 1, '一次尝试一行');
    assert.equal(rows[0].status, 'unknown');
    assert.equal(rows[0].attemptNo, 1);
    assert.ok(rows[0].endedAt, '尝试必须收尾，否则看起来像还在跑');
    assert.match(rows[0].error ?? '', /503/);
    assert.equal(rows[0].resultHash, null, '结果未知就不该有 result_hash');

    assert.deepEqual(eventsOf(commandId), [
      'requested',
      'policy_decided',
      'executing',
      'unknown',
    ]);
  });

  it('超时（ETIMEDOUT）→ unknown', async () => {
    const service = serviceWith(async () => {
      throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });

    const error = await capture(() => service.request(requestFor(nextKey('unknown-timeout'))));
    assert.ok(error instanceof UnknownCommandOutcomeError);
    assert.equal(statusOf(error.command.id), 'unknown');
    assert.equal(service.listAttempts(error.command.id)[0].status, 'unknown');
  });

  it('认不出来的错误 → unknown（这个方向猜错的代价不可撤销）', async () => {
    const service = serviceWith(async () => {
      // 执行器里的一个普通 bug。它没法证明「外部没发生」，所以不能记 failed。
      throw new TypeError('cannot read properties of undefined');
    });

    const error = await capture(() => service.request(requestFor(nextKey('unknown-bug'))));
    assert.ok(error instanceof UnknownCommandOutcomeError);
    assert.equal(statusOf(error.command.id), 'unknown');
  });

  it('4xx → failed，并且**不能**留下 unknown 的痕迹', async () => {
    const service = serviceWith(async () => {
      throw new ExternalOperationError('Jira API 400 POST /comment', 'definite', 400);
    });

    const input = requestFor(nextKey('failed-4xx'));
    const error = await capture(() => service.request(input));

    assert.equal(
      error instanceof UnknownCommandOutcomeError,
      false,
      '4xx 是「确认没发生」，不该进 unknown',
    );
    assert.ok(error instanceof ExternalOperationError, '原始错误要原样抛给调用方');

    const commandId = (
      db.prepare(`SELECT id FROM command WHERE idempotency_key = ?`).get(input.idempotencyKey) as
        unknown as { id: string }
    ).id;
    assert.equal(statusOf(commandId), 'failed');
    assert.deepEqual(eventsOf(commandId), [
      'requested',
      'policy_decided',
      'executing',
      'failed',
    ]);
    assert.equal(service.listAttempts(commandId)[0].status, 'failed');
  });

  it('412 → failed（并发冲突是 definite，不该逼人去对账）', async () => {
    const service = serviceWith(async () => {
      throw new ExternalOperationError('Jira 拒绝写入：If-Unmodified-Since 不匹配', 'definite', 412);
    });

    const input = requestFor(nextKey('failed-412'));
    const error = await capture(() => service.request(input));

    assert.equal(error instanceof UnknownCommandOutcomeError, false);
    const commandId = (
      db.prepare(`SELECT id FROM command WHERE idempotency_key = ?`).get(input.idempotencyKey) as
        unknown as { id: string }
    ).id;
    assert.equal(statusOf(commandId), 'failed');
    assert.equal(eventsOf(commandId).includes('unknown'), false);
  });

  it('成功时 attempt 记 succeeded 并带上 result_hash', async () => {
    const service = serviceWith(async () => ({ ok: true }));
    const result = await service.request(requestFor(nextKey('ok')));

    assert.equal(result.command.status, 'completed');
    const rows = service.listAttempts(result.command.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'succeeded');
    assert.ok(rows[0].resultHash, '成功必须有 result_hash，否则对账认不出「已写」');
    assert.deepEqual(eventsOf(result.command.id), [
      'requested',
      'policy_decided',
      'executing',
      'completed',
    ]);
  });
});

// ------------------------------------------- 3. unknown 不能靠重试解决

describe('Command：unknown 不是「再试一次」能解决的', () => {
  it('同 key 再 request 一次 → 抛 UnknownCommandOutcomeError，且不重新执行', async () => {
    let attempts = 0;
    const service = serviceWith(async () => {
      attempts += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });

    const input = requestFor(nextKey('unknown-retry'));
    await capture(() => service.request(input));
    assert.equal(attempts, 1);

    const error = await capture(() => service.request(input));
    assert.ok(
      error instanceof UnknownCommandOutcomeError,
      '不能返回 reused —— 那会让模型以为「已经做完了」',
    );
    assert.equal(attempts, 1, '可能已经发生过的那笔动作，绝不能再打一次');
    assert.equal(service.listAttempts(error.command.id).length, 1);
  });

  it('unknown 状态下 execute 也会被挡下（不是终态，但也不能执行）', async () => {
    const service = serviceWith(async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    });

    const input = requestFor(nextKey('unknown-execute'));
    const first = await capture(() => service.request(input));
    const commandId = (first as InstanceType<typeof UnknownCommandOutcomeError>).command.id;

    await assert.rejects(() => service.execute(commandId), /状态是 unknown，不能执行/);
  });

  it('对账可以用 operation_id 找回这笔动作的尝试', async () => {
    const service = serviceWith(async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    });

    const error = (await capture(() =>
      service.request(requestFor(nextKey('unknown-operation-id'))),
    )) as InstanceType<typeof UnknownCommandOutcomeError>;

    const command = error.command;
    assert.ok(command.operationId, 'Command 必须带着这一笔外部动作的身份');

    const found = service.listAttemptsByOperationId(command.operationId);
    assert.equal(found.length, 1, '对账的入口是 operation_id，不是全表扫描');
    assert.equal(found[0].commandId, command.id);
    assert.equal(found[0].operationId, command.operationId);
  });
});

// ------------------------------------------- 4. attempt 的边界

describe('Command：attempt 只记真正打出去的调用', () => {
  it('参数被改过时不留 attempt（没有外部调用发生）', async () => {
    const service = serviceWith(async () => ({ ok: true }));
    const input = requestFor(nextKey('no-attempt-tamper'));
    const command = service.create(input);

    db.prepare(`UPDATE command SET args_json = ? WHERE id = ?`).run(
      JSON.stringify({ body: '被改过的' }),
      command.id,
    );

    await assert.rejects(() => service.execute(command.id), /args_hash 不符/);
    assert.equal(service.listAttempts(command.id).length, 0);
  });

  it('没有注册执行器时不留 attempt', async () => {
    const service = new CommandService(db, new EntitlementService(db), allowPolicy(), audit);
    const input = requestFor(nextKey('no-attempt-executor'));
    const command = service.create(input);

    await assert.rejects(() => service.execute(command.id), /没有为 Command action 注册执行器/);
    assert.equal(statusOf(command.id), 'failed');
    assert.equal(service.listAttempts(command.id).length, 0);
  });

  it('已经是 executing 时不留 attempt（没有真正打出去）', async () => {
    const service = serviceWith(async () => ({ ok: true }));
    const input = requestFor(nextKey('no-attempt-cas'));
    const command = service.create(input);
    service.markExecuting(command.id);

    // 单进程里 `execute()` 的 CAS 分支其实到不了：状态检查与 markExecuting
    // 之间没有 await。真正会走到它的是多副本（两个 API 同时接手同一条
    // Command），而那时拦下来的是更早的那道状态闸。这里锁的是「无论被哪道
    // 闸拦下，都不能留下一条 attempt」—— attempt 的语义是「打过外部系统」。
    await assert.rejects(() => service.execute(command.id), /不能执行/);
    assert.equal(service.listAttempts(command.id).length, 0);
  });

  it('重试后 attempt_no 递增，「第几次」不会被折掉', async () => {
    let calls = 0;
    const service = serviceWith(async () => {
      calls += 1;
      if (calls === 1) throw new ExternalOperationError('500', 'unknown', 500);
      return { ok: true };
    });

    const input = requestFor(nextKey('attempt-no'));
    const first = await capture(() => service.request(input));
    const commandId = (first as InstanceType<typeof UnknownCommandOutcomeError>).command.id;

    // 真实路径是「对账确认没写 → 允许重试」，这里手工把状态放回 ready 模拟它。
    db.prepare(`UPDATE command SET status = 'ready' WHERE id = ?`).run(commandId);
    await service.execute(commandId);

    const rows = service.listAttempts(commandId);
    assert.deepEqual(
      rows.map((row) => [row.attemptNo, row.status]),
      [
        [1, 'unknown'],
        [2, 'succeeded'],
      ],
      'attempt#1 的 unknown 必须还在 —— 它解释了为什么这里多了一次查询',
    );
    assert.equal(statusOf(commandId), 'completed');
  });

  it('attempt 与 command 共享同一个 operation_id（一笔动作，多次尝试）', async () => {
    const service = serviceWith(async () => ({ ok: true }));
    const result = await service.request(requestFor(nextKey('attempt-operation-id')));
    const rows = service.listAttempts(result.command.id);

    assert.equal(rows[0].operationId, result.command.operationId);
    assert.equal(
      service.listAttemptsByOperationId(result.command.operationId).length,
      1,
    );
  });
});
