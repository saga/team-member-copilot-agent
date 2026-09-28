import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolInvocation } from '@github/copilot-sdk';

/**
 * AuditEvidence —— 事后证明「发生了什么」。
 *
 * 这一组用例锁的是**证据链的完整性**，不是功能。审计的价值全在「一条都不少」
 * 上：漏掉一条被拒的调用，等于那次拒绝从来没发生过；漏掉 `ended_at`，等于
 * 分不清「还在跑」和「进程没了」。
 *
 * ── 两张表为什么要分别断言 ───────────────────────────────────────────
 *
 *   policy_decision_audit   谁批的（allow / deny / approval_required）
 *   tool_execution_audit    批了之后真的调了什么、结果如何
 *
 * 一次**拒绝**只有前者（引擎根本不会去执行它），所以「把 Policy 决策折进
 * tool_execution_audit」会让所有被拒的调用从审计里消失 —— 而那恰恰是合规
 * 最常被问的一类。反过来只记前者，则「放行了但执行炸了」也看不出来。
 *
 * ── 为什么每一条都断言「恰好一条」 ───────────────────────────────────
 *
 * 适配器在两条路径上都会写审计（有 handler 的 custom tool、以及没有 handler
 * 的拒绝 / MCP），很容易变成「一次调用两条记录」。多出来的那条不是冗余，
 * 是**错的** —— 它会让人以为这个工具被调用了两次。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-audit-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';
process.env.HOST_CODING_TOOLS = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { AuditService } = await import('../audit-service.js');
const { EntitlementService } = await import('../entitlement-service.js');
const { DefaultToolPolicy } = await import('../tool-policy.js');
const { DenyHighRiskPolicyService } = await import('../policy.js');
const { CopilotCapabilityAdapter } = await import('../capabilities/copilot-adapter.js');
const { createTestStack, StubCopilot } = await import('./support.js');
import type { CopilotService } from '../copilot.js';
import type { PolicyService } from '../policy.js';
import type {
  CapabilityContext,
  RuntimeCapabilities,
  RuntimeTool,
} from '../capabilities/types.js';

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 装配

const audit = new AuditService(db);
const memberService = new MemberService(db);
const stack = createTestStack(db, memberService, new StubCopilot().asCopilot as unknown as CopilotService);

/** 一个真实的 execution 行。审计表对它有外键，编一个 id 是插不进去的。 */
let executionId = '';
let context: CapabilityContext;

before(async () => {
  const member = stack.team.createMember({ name: 'Audit Subject', role: 'Lead' });
  const room = stack.team.createConversation({
    kind: 'task',
    title: 'Audit',
    memberIds: [member.id],
    leadMemberId: member.id,
  });
  const sent = await stack.team.sendMessage({
    actorId: 'test-user',
    conversationId: room.id,
    content: '起一轮',
  });
  const { singleExecutionId } = await import('./support.js');
  executionId = singleExecutionId(db, room.id, sent.wakes);

  context = {
    teamId: stack.team.getConversation(room.id).teamId,
    memberId: member.id,
    conversationId: room.id,
    executionId,
    userId: 'test-user',
  };
});

/** 把一组工具包成 adapter 认得的能力形状。 */
function runtimeOf(tools: RuntimeTool[]): RuntimeCapabilities {
  return {
    skills: [],
    knowledge: [],
    tools,
    mcpServers: [],
    toolIndex: new Map(tools.map((tool) => [tool.name, tool])),
    mcpToolIndex: new Map(),
    manifestHash: 'audit-test',
  };
}

function toolOf(overrides: Partial<RuntimeTool> & Pick<RuntimeTool, 'name'>): RuntimeTool {
  return {
    providerId: 'audit.test-tools',
    implementation: 'app',
    kind: 'custom',
    description: 'audit fixture',
    risk: 'read',
    parameters: {},
    ...overrides,
  };
}

/** 每个用例都新建 adapter：审计对象是同一个（真库），策略按用例给。 */
function adapterWith(
  tools: RuntimeTool[],
  options: {
    policy?: PolicyService;
    entitlement?: InstanceType<typeof EntitlementService>;
    allowHostTools?: boolean;
  } = {},
) {
  const policy = options.policy ?? new DenyHighRiskPolicyService();
  const policyImpl = new DefaultToolPolicy(
    { allowHostTools: options.allowHostTools ?? false },
    policy,
    options.entitlement ?? new EntitlementService(db),
  );
  const adapter = new CopilotCapabilityAdapter(policyImpl, audit);
  const built = adapter.build(runtimeOf(tools), context);
  return built;
}

/** 从 build 结果里取一个工具的 handler —— 它就是「引擎真的去执行」那一步。 */
function handlerOf(built: ReturnType<typeof adapterWith>, name: string) {
  const tool = built.tools.find((item) => item.name === name);
  assert.ok(tool?.handler, `工具 ${name} 必须带 handler`);
  return tool.handler!;
}

// ------------------------------------------------------------------ 用例

describe('审计：工具调用的四种结局都要留痕', () => {
  it('放行并执行成功 → tool_execution_audit 一条，收口且无 error', async () => {
    const built = adapterWith([
      toolOf({ name: 'audit_ok', risk: 'read', execute: async () => 'done' }),
    ]);

    const result = await handlerOf(built, 'audit_ok')({}, {} as ToolInvocation);
    assert.equal(result, 'done');

    const rows = audit.listToolExecutions(executionId).filter((row) => row.toolName === 'audit_ok');
    assert.equal(rows.length, 1, '一次调用必须恰好一条记录');
    assert.equal(rows[0].allowed, true);
    assert.ok(rows[0].endedAt, '成功也必须收口 —— 否则「还在跑」和「进程没了」分不开');
    assert.equal(rows[0].error, null);
    assert.equal(rows[0].providerId, 'audit.test-tools');
  });

  it('被拒 → 也有一条（引擎不会执行它，所以只能在这里写）', async () => {
    let executed = 0;
    const built = adapterWith([
      toolOf({
        name: 'audit_denied',
        risk: 'read',
        guard: () => ({ allowed: false, reason: '输入越界' }),
        execute: async () => {
          executed += 1;
          return 'nope';
        },
      }),
    ]);

    await assert.rejects(
      async () => handlerOf(built, 'audit_denied')({}, {} as ToolInvocation),
      /被拒绝：输入越界/,
    );
    assert.equal(executed, 0);

    const rows = audit.listToolExecutions(executionId).filter((row) => row.toolName === 'audit_denied');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allowed, false);
    assert.equal(rows[0].error, '输入越界');
    assert.ok(rows[0].endedAt, '拒绝就是结论，必须当场收口');
  });

  it('执行抛异常 → 留痕且带 error（否则「成功但没返回值」和「炸了」长得一样）', async () => {
    const built = adapterWith([
      toolOf({
        name: 'audit_throws',
        risk: 'read',
        execute: async () => {
          throw new Error('外部系统 500');
        },
      }),
    ]);

    await assert.rejects(
      async () => handlerOf(built, 'audit_throws')({}, {} as ToolInvocation),
      /外部系统 500/,
    );

    const rows = audit.listToolExecutions(executionId).filter((row) => row.toolName === 'audit_throws');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allowed, true, '放行是放行，执行失败是另一件事');
    assert.equal(rows[0].error, '外部系统 500');
    assert.ok(rows[0].endedAt);
  });

  it('checkToolUse 被拒时也写一条（这条路径没有 handler 兜底）', async () => {
    const built = adapterWith([
      toolOf({
        name: 'audit_pre_denied',
        risk: 'read',
        guard: () => ({ allowed: false, reason: 'pre hook 拒绝' }),
        execute: async () => 'unreachable',
      }),
    ]);

    const decision = await built.checkToolUse('audit_pre_denied', {});
    assert.equal(decision.allowed, false);

    const rows = audit.listToolExecutions(executionId).filter((row) => row.toolName === 'audit_pre_denied');
    assert.equal(rows.length, 1, 'pre-hook 拒绝也是一次「想调」，必须留痕');
    assert.equal(rows[0].allowed, false);
    assert.equal(rows[0].error, 'pre hook 拒绝');
  });
});

describe('审计：Policy 决策与 Entitlement 拒绝', () => {
  it('高风险工具被 Policy 拒 → policy_decision_audit 记 approval_required，工具审计回指它', async () => {
    const built = adapterWith([
      toolOf({ name: 'audit_external_write', risk: 'external-write', execute: async () => 'x' }),
    ]);

    await assert.rejects(
      async () => handlerOf(built, 'audit_external_write')({}, {} as ToolInvocation),
    );

    const decisions = audit
      .listPolicyDecisions(executionId)
      .filter((row) => row.toolName === 'audit_external_write');
    assert.equal(decisions.length, 1);
    // 默认 Policy 说的是「要人批」，不是「明令禁止」：前者指向一条可行的操作
    // 路径（把批准出口接上），后者看起来像配置错误。
    assert.equal(decisions[0].decision, 'approval_required');
    assert.equal(decisions[0].policyRevision, 'deny-high-risk-v2');

    const rows = audit
      .listToolExecutions(executionId)
      .filter((row) => row.toolName === 'audit_external_write');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].policyDecisionId, decisions[0].id, '工具审计必须能回指到那一次判定');
  });

  it('低风险工具放行 → 也记一条 allow 决策（只记拒绝会漏掉「本该拦却放过了」）', async () => {
    const built = adapterWith([
      toolOf({ name: 'audit_low_risk', risk: 'read', execute: async () => 'ok' }),
    ]);
    await handlerOf(built, 'audit_low_risk')({}, {} as ToolInvocation);

    const decisions = audit
      .listPolicyDecisions(executionId)
      .filter((row) => row.toolName === 'audit_low_risk');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'allow');
  });

  it('Entitlement 拒绝 → 决策理由点名是数据授权那一层拒的', async () => {
    // 真 EntitlementService + 空表 = 默认拒绝。这正是这一层的价值所在：
    // 默认放行的话，它只是一份没人维护的文档。
    const built = adapterWith(
      [
        toolOf({
          providerId: 'atlassian.jira-tools',
          name: 'jira_add_comment',
          risk: 'external-write',
          execute: async () => 'x',
        }),
      ],
      { entitlement: new EntitlementService(db) },
    );

    await assert.rejects(
      async () =>
        handlerOf(built, 'jira_add_comment')({ issueKey: 'ABC-1', body: 'hi' }, {} as ToolInvocation),
      /Data Entitlement 拒绝/,
    );

    const rows = audit
      .listToolExecutions(executionId)
      .filter((row) => row.toolName === 'jira_add_comment');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allowed, false);
    assert.match(rows[0].error ?? '', /Data Entitlement/);

    // 决策记录里也必须能看出是哪一层拒的 —— 否则「被 Policy 拒」和「被数据授权拒」
    // 在审计上长得一模一样，而两者的处置方式完全不同。
    const decisions = audit
      .listPolicyDecisions(executionId)
      .filter((row) => row.toolName === 'jira_add_comment');
    assert.equal(decisions.length, 1);
    assert.match(decisions[0].reason, /Data Entitlement/);
  });
});

describe('审计：参数脱敏', () => {
  it('凭证类参数按名字替换成 [REDACTED]，但原文 hash 仍然可验证', async () => {
    const built = adapterWith([
      toolOf({ name: 'audit_redact', risk: 'read', execute: async () => 'ok' }),
    ]);
    await handlerOf(built, 'audit_redact')(
      { issueKey: 'ABC-1', apiToken: 'super-secret-value', body: '正常内容' },
      {} as ToolInvocation,
    );

    const row = db
      .prepare(`SELECT args_redacted_json, args_hash FROM tool_execution_audit WHERE tool_name = ?`)
      .get('audit_redact') as unknown as { args_redacted_json: string; args_hash: string };

    const redacted = JSON.parse(row.args_redacted_json) as Record<string, unknown>;
    assert.equal(redacted.apiToken, '[REDACTED]', '按名字脱敏：apiToken 这个名字没有歧义');
    assert.equal(redacted.body, '正常内容', '不该把正常内容误伤成 [REDACTED]');
    assert.equal(redacted.issueKey, 'ABC-1');
    assert.ok(!row.args_redacted_json.includes('super-secret-value'), '脱敏后的 JSON 里不能有凭证');
    assert.match(row.args_hash, /^[\da-f]{64}$/, '原文的 sha256 仍然留着，「参数有没有被改过」可验证');
  });
});
