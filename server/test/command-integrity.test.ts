import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Command Layer 的**完整性**：参数冻结、CAS、幂等、审计链。
 *
 * ── 这一组用例锁的四件事 ─────────────────────────────────────────────
 *
 *   1. 参数冻结   落库的那份 args 是这条 Command 的定义，执行时从库里读，
 *                 不接受调用方再传一遍。审批的全部意义就在「批的和做的是
 *                 同一件事」—— 少了它，人批的是 A，执行的是 B。
 *
 *   2. CAS        `markExecuting` 必须返回 changes === 1。SQLite 的 UPDATE 在
 *                 WHERE 不成立时是**静默 0 行**，返回 void 的旧签名让「没抢到」
 *                 和「抢到了」完全一样 —— 而这两者的差别是「执行一次」和
 *                 「执行两次」，外部副作用不可撤销。
 *
 *   3. 幂等       靠 `ON CONFLICT(idempotency_key) DO NOTHING` + 回读。写成
 *                 「先 SELECT 再 INSERT」会有两个进程同时进、同时 INSERT 的窗口，
 *                 结果是主键冲突异常 —— 一次本该静默复用的重试变成一次失败。
 *
 *   4. 审计链     每个状态推进都留一条事件，且**不能反过来让业务失败**。
 *
 * 前三条都是「静默失败」的形态：接口 200、日志干净、什么也没发生或者发生了两次。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-cmd-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { AuditService } = await import('../audit-service.js');
const { EntitlementService } = await import('../entitlement-service.js');
const { CommandService } = await import('../command-service.js');
const { hashJson } = await import('../content-hash.js');
const { createTestStack, StubCopilot } = await import('./support.js');
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
  const member = stack.team.createMember({ name: 'Command Subject', role: 'Engineer' });
  memberId = member.id;
  const room = stack.team.createConversation({
    kind: 'task',
    title: 'Command integrity',
    memberIds: [member.id],
  });
  conversationId = room.id;

  const sent = await stack.team.sendMessage({
    actorId: 'test-user',
    conversationId: room.id,
    content: '起一轮',
  });
  const { singleExecutionId } = await import('./support.js');
  executionId = singleExecutionId(db, room.id, sent.wakes);
});

// ------------------------------------------------------------------ 工具

/** 一律放行的 Command Policy。 */
function allowPolicy(): CommandPolicy {
  return {
    revision: () => 'test-allow',
    decideCommand: () => ({ allowed: true, reason: 'test allow' }),
  };
}

/** 一律「要人批」的 Command Policy —— 用来把 Command 停在 policy_pending。 */
function approvalPolicy(): CommandPolicy {
  return {
    revision: () => 'test-approval',
    decideCommand: () => ({
      allowed: false,
      approvalRequired: true,
      reason: 'test 要求审批',
    }),
  };
}

let keyCounter = 0;
function nextKey(prefix = 'k'): string {
  keyCounter += 1;
  return `${prefix}-${keyCounter}`;
}

/** 一笔 Command 请求的默认形状。 */
function requestFor(overrides: {
  idempotencyKey: string;
  args?: Record<string, unknown>;
  action?: string;
  target?: string;
  policy?: CommandPolicy;
  entitlement?: InstanceType<typeof EntitlementService>;
  onExecute?: (args: Record<string, unknown>) => void;
}) {
  const service = new CommandService(
    db,
    overrides.entitlement ?? new EntitlementService(db),
    overrides.policy ?? allowPolicy(),
    audit,
  );
  const seen: Array<Record<string, unknown>> = [];
  service.registerExecutor(overrides.action ?? 'test.action', async ({ args }) => {
    seen.push(args);
    overrides.onExecute?.(args);
    return { ok: true };
  });
  return {
    service,
    seen,
    input: {
      executionId,
      conversationId,
      memberId,
      actorType: 'agent' as const,
      actorId: memberId,
      action: overrides.action ?? 'test.action',
      target: overrides.target ?? 'TARGET-1',
      args: overrides.args ?? { body: 'first' },
      idempotencyKey: overrides.idempotencyKey,
    },
  };
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

// ------------------------------------------------------ 1. 参数冻结

describe('Command：参数在落库那一刻冻结', () => {
  it('执行器拿到的是落库的那份 args，不是调用方后来传的', async () => {
    const { service, seen, input } = requestFor({
      idempotencyKey: nextKey('freeze'),
      args: { body: '批的时候看到的措辞' },
      policy: approvalPolicy(),
    });

    const requested = await service.request(input);
    assert.equal(requested.approvalRequired, true);
    assert.equal(requested.command.status, 'policy_pending');

    service.approve(requested.command.id, 'test-approver');
    await service.execute(requested.command.id);

    assert.deepEqual(
      seen[0],
      { body: '批的时候看到的措辞' },
      '执行必须用审批时看见的那份参数',
    );
  });

  it('同 key 重试改了 args：第一次的那份胜出', async () => {
    const key = nextKey('freeze-reuse');
    const { service, seen, input } = requestFor({
      idempotencyKey: key,
      args: { body: 'first' },
      policy: approvalPolicy(),
    });

    const first = await service.request(input);
    service.approve(first.command.id, 'test-approver');
    await service.execute(first.command.id);
    assert.equal(statusOf(first.command.id), 'completed');

    // 同一轮重试：key 相同、措辞改了。idempotencyKey 刻意不含 body，
    // 所以这**是**同一次动作 —— 该生效的是已经冻结的那一份。
    const retry = await service.request({ ...input, args: { body: 'second' } });

    assert.equal(retry.reused, true, '终态命中 = 幂等复用，不重新执行');
    assert.deepEqual(retry.command.args, { body: 'first' });
    assert.equal(seen.length, 1, '重试不能产生第二次副作用');
    assert.equal(
      (db.prepare(`SELECT args_json FROM command WHERE id = ?`).get(first.command.id) as unknown as {
        args_json: string;
      }).args_json,
      JSON.stringify({ body: 'first' }),
    );
  });

  it('落库后被改过 → 执行失败并留痕（不能照常执行）', async () => {
    const { service, seen, input } = requestFor({ idempotencyKey: nextKey('tamper') });
    const command = service.create(input);
    assert.equal(command.status, 'ready');

    // 模拟手工改库 / 迁移写错。
    db.prepare(`UPDATE command SET args_json = ? WHERE id = ?`).run(
      JSON.stringify({ body: '被改过的' }),
      command.id,
    );

    await assert.rejects(() => service.execute(command.id), /args_hash 不符/);

    assert.equal(statusOf(command.id), 'failed', '不能停在 ready 等人再点一次');
    assert.equal(seen.length, 0, '一次外部写入都不能发生');
    assert.equal(eventsOf(command.id).includes('failed'), true, '失败必须留痕');
  });

  it('args_json 不是合法 JSON 时在读取处就报错', () => {
    const { service, input } = requestFor({ idempotencyKey: nextKey('badjson') });
    const command = service.create(input);
    db.prepare(`UPDATE command SET args_json = 'not json' WHERE id = ?`).run(command.id);

    assert.throws(() => service.get(command.id), /不是合法 JSON/);
  });
});

// ------------------------------------------------------ 2. CAS

describe('Command：状态推进必须是 CAS', () => {
  it('markExecuting 第一次 true，第二次 false（否则等于执行两次）', () => {
    const { service, input } = requestFor({ idempotencyKey: nextKey('cas') });
    const command = service.create(input);

    assert.equal(service.markExecuting(command.id), true);
    assert.equal(service.markExecuting(command.id), false, '静默 0 行必须被翻译成 false');
    assert.equal(statusOf(command.id), 'executing');
    assert.equal(
      eventsOf(command.id).filter((event) => event === 'executing').length,
      1,
      '抢不到的那次不能留下一条「我开始了」的审计',
    );
  });

  it('已经是 executing 的 Command 不能被再次 execute', async () => {
    const { service, input } = requestFor({ idempotencyKey: nextKey('cas-exec') });
    const command = service.create(input);
    service.markExecuting(command.id);

    await assert.rejects(() => service.execute(command.id), /不能执行/);
  });

  it('approve 是 CAS：驳回之后不能再批回来', async () => {
    const { service, input } = requestFor({
      idempotencyKey: nextKey('cas-approve'),
      policy: approvalPolicy(),
    });
    const requested = await service.request(input);
    const id = requested.command.id;

    service.reject(id, 'test-approver');
    assert.equal(statusOf(id), 'rejected');

    assert.throws(() => service.approve(id, 'test-approver'), /不能审批通过/);
    assert.equal(statusOf(id), 'rejected', '终态不能被误点拉回来');
  });

  it('重复 approve 第二次冲突', async () => {
    const { service, input } = requestFor({
      idempotencyKey: nextKey('cas-approve2'),
      policy: approvalPolicy(),
    });
    const requested = await service.request(input);

    service.approve(requested.command.id, 'test-approver');
    assert.throws(() => service.approve(requested.command.id, 'test-approver'), /不能审批通过/);
  });
});

// ------------------------------------------------------ 3. 幂等

describe('Command：幂等靠数据库约束，不靠调用方自觉', () => {
  it('同 key 两次 create 拿到同一条，且只有一行', async () => {
    const key = nextKey('idem');
    const { service, input } = requestFor({ idempotencyKey: key, policy: approvalPolicy() });

    const first = service.create(input);
    const second = service.create(input);

    assert.equal(second.id, first.id);
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM command WHERE idempotency_key = ?`).get(key) as
          unknown as { n: number }
      ).n,
      1,
    );
  });

  it('库里已经有同 key 的行时复用而不是主键冲突', async () => {
    const key = nextKey('idem-preexisting');
    const { service, input } = requestFor({ idempotencyKey: key, policy: approvalPolicy() });

    const seeded = service.create(input);
    // 另一个进程抢先落库的样子：这里直接再 create 一次，走的是「回读」路径。
    const again = service.create({ ...input, args: { body: '不同措辞' } });

    assert.equal(again.id, seeded.id, '幂等命中的正解是「用已经存在的那一条」，不是报错');
  });

  it('终态命中直接返回，不重新跑 pipeline', async () => {
    const { service, seen, input } = requestFor({ idempotencyKey: nextKey('idem-terminal') });
    await service.request(input);
    assert.equal(seen.length, 1);

    const again = await service.request(input);
    assert.equal(again.reused, true);
    assert.equal(seen.length, 1, '重试不能产生第二次副作用');
  });

  it('get 打错 id 抛 404 语义的错误（Command 有 HTTP 面）', () => {
    const { service } = requestFor({ idempotencyKey: nextKey('notfound') });
    assert.throws(
      () => service.get('no-such-command'),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  });
});

// ------------------------------------------------------ 4. 审计链

describe('Command：生命周期审计', () => {
  it('放行执行的完整链条按发生顺序落库', async () => {
    const { service, input } = requestFor({ idempotencyKey: nextKey('audit-ok') });
    const result = await service.request(input);

    assert.deepEqual(eventsOf(result.command.id), [
      'requested',
      'policy_decided',
      'executing',
      'completed',
    ]);
  });

  it('停在审批：链条到 approval_requested 为止，没有 executing', async () => {
    const { service, input } = requestFor({
      idempotencyKey: nextKey('audit-approval'),
      policy: approvalPolicy(),
    });
    const requested = await service.request(input);

    const events = eventsOf(requested.command.id);
    assert.deepEqual(events, ['requested', 'policy_decided', 'approval_requested']);
    assert.equal(events.includes('executing'), false, '没执行就不能留执行的痕迹');

    service.approve(requested.command.id, 'test-approver');
    assert.deepEqual(eventsOf(requested.command.id), [
      'requested',
      'policy_decided',
      'approval_requested',
      'approved',
    ]);
  });

  it('驳回留痕，且记的是人做的决定', async () => {
    const { service, input } = requestFor({
      idempotencyKey: nextKey('audit-reject'),
      policy: approvalPolicy(),
    });
    const requested = await service.request(input);
    service.reject(requested.command.id, 'test-approver');

    const rejected = audit
      .listCommandAudit(requested.command.id)
      .find((row) => row.event === 'rejected');
    assert.ok(rejected, '驳回必须留痕');
    assert.equal(rejected.actorType, 'human');
    assert.equal(rejected.actorId, 'test-approver');
    assert.match(rejected.detail ?? '', /test-approver/);
  });

  it('Entitlement 拦下时也留痕（拒绝也要有记录）', async () => {
    // 真 EntitlementService + 空表 = 默认拒绝。jira.* 才解析得出资源，
    // 所以 action 必须用真实前缀，否则这一层会被跳过。
    const { service, input } = requestFor({
      idempotencyKey: nextKey('audit-entitlement'),
      action: 'jira.add_comment',
      target: 'PROJ-1',
    });

    await assert.rejects(() => service.request(input));

    const command = (
      db.prepare(`SELECT id, status FROM command WHERE idempotency_key = ?`).get(
        input.idempotencyKey,
      ) as unknown as { id: string; status: string }
    );
    assert.equal(command.status, 'rejected');
    const rejected = audit.listCommandAudit(command.id).find((row) => row.event === 'rejected');
    assert.ok(rejected, '被 Entitlement 拦下同样是「一次被拒的动作」');
    assert.equal(rejected.actorType, 'system');
  });

  it('同一条 Command 可以合法地经历多次 executing → failed（不去重）', () => {
    const { service, input } = requestFor({ idempotencyKey: nextKey('audit-retry') });
    const command = service.create(input);

    service.markExecuting(command.id);
    service.markFailed(command.id, '第一次失败');
    // 重试：手工回到 ready（真实路径是 retryExecution 生成新 Command，
    // 但表本身不该阻止同一条 Command 记录第二次尝试）。
    db.prepare(`UPDATE command SET status = 'ready' WHERE id = ?`).run(command.id);
    service.markExecuting(command.id);
    service.markFailed(command.id, '第二次失败');

    const events = eventsOf(command.id);
    assert.equal(events.filter((event) => event === 'executing').length, 2);
    assert.equal(events.filter((event) => event === 'failed').length, 2);
    const details = audit
      .listCommandAudit(command.id)
      .filter((row) => row.event === 'failed')
      .map((row) => row.detail);
    assert.deepEqual(details, ['第一次失败', '第二次失败'], '「第几次」不能被折掉');
  });

  it('不传 AuditService 时整条链静默关闭，但业务照常', async () => {
    const service = new CommandService(db, new EntitlementService(db), allowPolicy());
    service.registerExecutor('test.action', async () => ({ ok: true }));

    const result = await service.request({
      executionId,
      conversationId,
      memberId,
      actorType: 'agent',
      actorId: memberId,
      action: 'test.action',
      target: 'TARGET-1',
      args: {},
      idempotencyKey: nextKey('audit-off'),
    });

    assert.equal(result.command.status, 'completed');
    assert.deepEqual(eventsOf(result.command.id), []);
  });
});

// -------------------------------------------- 5. Policy 审计表 append-only

describe('AuditService：policy_decision_audit 是 append-only', () => {
  /**
   * 必须是函数而不是常量对象：`describe` 的回调在**收集阶段**就求值了，
   * 而那时 `before()` 还没跑 —— 常量会把 `executionId` 钉在空字符串上，
   * 于是每条用例都死在 execution 的外键上，看起来像「审计表坏了」。
   */
  const base = () => ({
    executionId,
    toolName: 'test.tool',
    policyRevision: 'rev-1',
    decision: 'allow' as const,
    reason: 'ok',
    inputHash: hashJson({ a: 1 }),
  });

  it('同 id 同内容记两遍 = 幂等，不抛错', () => {
    const id = `decision-${nextKey('same')}`;
    audit.recordPolicyDecision({ ...base(), id });
    audit.recordPolicyDecision({ ...base(), id });

    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM policy_decision_audit WHERE id = ?`).get(id) as
          unknown as { n: number }
      ).n,
      1,
    );
  });

  it('同 id 不同内容 = id 复用，必须抛错（不能静默覆盖）', () => {
    const id = `decision-${nextKey('conflict')}`;
    audit.recordPolicyDecision({ ...base(), id });

    assert.throws(
      () => audit.recordPolicyDecision({ ...base(), id, reason: '被改写过的理由' }),
      /id 被复用/,
    );

    assert.equal(
      (
        db.prepare(`SELECT reason FROM policy_decision_audit WHERE id = ?`).get(id) as unknown as {
          reason: string;
        }
      ).reason,
      'ok',
      '旧证据必须还在 —— 一条被改写的证据比一条缺失的证据更危险',
    );
  });
});
