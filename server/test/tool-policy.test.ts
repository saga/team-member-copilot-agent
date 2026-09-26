import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultToolPolicy } from '../tool-policy.js';
import type { PolicyService } from '../policy.js';
import { HOST_BUILTIN_NAMES } from '../capabilities/providers/host-tools.js';
import type {
  RuntimeTool,
  ToolDecision,
  ToolExecutionContext,
  ToolRisk,
} from '../capabilities/types.js';

/**
 * 工具授权层。
 *
 * 这一层存在的理由是「声明」和「授权」是两件事，而它们很容易各自漂移：
 * 给引擎的 availableTools 说了一套，hook 里又按另一套判，结果就是模型看得见
 * 一个它其实用不了的工具（或者更糟：看不见却在某个路径上被放行）。
 *
 * ── 这一组用例真正在锁的东西 ──────────────────────────────────────────
 *
 * 判据只有四个，全部来自 RuntimeTool 的声明：`requiresHostAccess` + 部署开关、
 * `guard()`、`risk ∈ {external-write, privileged}` 是否走 PolicyService。
 * **没有一条看工具名**。
 *
 * 「不看名字」这件事没法靠「bash 被拒了」来证明 —— 旧实现里 `if (name === 'bash')`
 * 同样会让那条断言通过。所以下面反复用同一个手法：**造一个名字从未出现过的工具**，
 * 用同样的声明走一遍，看结论是否与 `bash` 一致。反过来也造一个叫 `bash` 但声明
 * 是个普通读工具的家伙，它必须被放行。名字一旦参与判定，这两条立刻会红。
 *
 * ── guard 与 PolicyService 的边界 ─────────────────────────────────────
 *
 * guard 的「允许」只对低风险工具有效。高风险工具即使 guard 放行，也必须落到
 * PolicyService —— 用例专门造一个「guard 说可以」的 privileged 工具，断言结论
 * 仍由 PolicyService 给出。没有这条，任何 Provider 都能写一个
 * `() => ({ allowed: true })` 把自己升级成无限制工具。
 */

const DENY_HIGH_RISK: PolicyService = {
  decide: (input) => ({ allowed: false, reason: `policy deny: risk=${input.tool.risk}` }),
};

const ALLOW_HIGH_RISK: PolicyService = {
  decide: (input) => ({ allowed: true, reason: `policy allow: ${input.tool.name}` }),
};

function policy(allowHostTools: boolean, highRisk: PolicyService = DENY_HIGH_RISK): DefaultToolPolicy {
  return new DefaultToolPolicy({ allowHostTools }, highRisk);
}

const ALLOW_HOST = true;
const WITHHOLD_HOST = false;

function tool(overrides: Partial<RuntimeTool> = {}): RuntimeTool {
  return {
    providerId: 'test.provider',
    implementation: 'app',
    kind: 'custom',
    name: 'ask_member',
    description: 'test tool',
    risk: 'coordination',
    ...overrides,
  };
}

function context(toolName: string): ToolExecutionContext {
  return {
    memberId: 'm1',
    conversationId: 'c1',
    executionId: 'e1',
    userId: 'u1',
    toolName,
  };
}

async function decide(
  layer: DefaultToolPolicy,
  subject: RuntimeTool,
  args: Record<string, unknown> = {},
): Promise<ToolDecision> {
  return layer.check(subject, context(subject.name), args);
}

/** 一组声明相同、只有名字不同的宿主工具（其中一个名字是真的）。 */
function hostTools(): RuntimeTool[] {
  return [
    ...HOST_BUILTIN_NAMES.map((name) =>
      tool({
        providerId: 'runtime.host-coding-tools',
        implementation: 'copilot-builtin',
        kind: 'builtin',
        name,
        risk: 'host-execution',
        requiresHostAccess: true,
      }),
    ),
    tool({
      providerId: 'someone.else',
      implementation: 'copilot-builtin',
      kind: 'builtin',
      name: 'a_tool_invented_after_this_test_was_written',
      risk: 'host-execution',
      requiresHostAccess: true,
    }),
  ];
}

describe('check：判据来自声明，不来自名字', () => {
  it('read / self-write / coordination / external-read 都不需要额外开关', async () => {
    const layer = policy(WITHHOLD_HOST);

    for (const risk of ['read', 'self-write', 'coordination', 'external-read'] as ToolRisk[]) {
      const decision = await decide(layer, tool({ risk }));
      assert.equal(decision.allowed, true, `risk=${risk} 不该被拒：${decision.reason}`);
    }
  });

  it('宿主工具：部署没放行就拒绝，理由指出是部署开关', async () => {
    const layer = policy(WITHHOLD_HOST);

    for (const subject of hostTools()) {
      const decision = await decide(layer, subject);
      assert.equal(decision.allowed, false, `${subject.name} 不该被放行`);
      assert.match(decision.reason, /HOST_CODING_TOOLS/);
    }
  });

  it('宿主工具：部署放行就放行 —— 名字是旧的还是新的都一样', async () => {
    const layer = policy(ALLOW_HOST);

    for (const subject of hostTools()) {
      const decision = await decide(layer, subject);
      assert.equal(decision.allowed, true, `${subject.name} 被拒了：${decision.reason}`);
    }
  });

  it('名字叫 bash，但声明是个普通工具 → 放行', async () => {
    // 这条专门打「按名字判」的写法：一个再也不能碰宿主机的 bash 就是一个工具名。
    // 加上上面那条「新名字的宿主工具也走同一条路」，两头都堵死了。
    const decision = await decide(
      policy(WITHHOLD_HOST),
      tool({ providerId: 'sandbox.simulated-shell', name: 'bash', risk: 'read' }),
    );

    assert.equal(decision.allowed, true, `被按名字拒了：${decision.reason}`);
  });

  it('privileged 一律落 PolicyService —— guard 说可以也不行', async () => {
    // Provider 不能批准自己的高风险动作：guard 的「允许」到 privileged 这里失效，
    // 结论必须来自 PolicyService（这里给的是拒绝桩，理由必须出自它）。
    const layer = policy(ALLOW_HOST, DENY_HIGH_RISK);
    const subject = tool({
      name: 'submit_trade',
      risk: 'privileged',
      guard: () => ({ allowed: true, reason: '这一笔在额度内' }),
    });

    const decision = await decide(layer, subject);

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /policy deny/);
    assert.doesNotMatch(decision.reason, /额度内/);
  });

  it('privileged + PolicyService 放行 → 放行（决策权确实在 Policy 手里）', async () => {
    const decision = await decide(policy(ALLOW_HOST, ALLOW_HIGH_RISK), tool({ risk: 'privileged' }));
    assert.equal(decision.allowed, true);
    assert.match(decision.reason, /policy allow/);
  });

  it('privileged 的拒绝不依赖部署开关恰好关着', async () => {
    const decision = await decide(policy(WITHHOLD_HOST), tool({ risk: 'privileged' }));
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /policy deny/);
  });
});

describe('check：guard 是逐次判定，不是第二份白名单', () => {
  it('guard 说不行 → 拒绝，理由原样带出来', async () => {
    const layer = policy(ALLOW_HOST);
    const subject = tool({
      name: 'read_file',
      risk: 'read',
      guard: (_context, args) =>
        String(args.path ?? '').startsWith('/workspace/')
          ? { allowed: true, reason: '在 workspace 内' }
          : { allowed: false, reason: `路径不在 workspace 内：${String(args.path)}` },
    });

    const inside = await decide(layer, subject, { path: '/workspace/a.ts' });
    assert.equal(inside.allowed, true);

    const outside = await decide(layer, subject, { path: '/etc/shadow' });
    assert.equal(outside.allowed, false);
    assert.match(outside.reason, /不在 workspace 内/);
  });

  it('guard 是 async 的也照常判（查库、远端校验都行）', async () => {
    const layer = policy(ALLOW_HOST);
    const subject = tool({
      risk: 'read',
      guard: async () => ({ allowed: false, reason: '远端校验拒绝' }),
    });

    const decision = await decide(layer, subject);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /远端校验拒绝/);
  });

  it('guard 的拒绝优先于 PolicyService（external-write 先被输入边界挡下）', async () => {
    const layer = policy(ALLOW_HOST, ALLOW_HIGH_RISK);
    const subject = tool({
      risk: 'external-write',
      guard: () => ({ allowed: false, reason: '参数越界' }),
    });

    const decision = await decide(layer, subject);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /参数越界/);
  });
});

describe('check：external-write 的放行权在 PolicyService', () => {
  it('PolicyService 拒绝 → 拒绝（Provider 的 guard 批准不了它）', async () => {
    const layer = policy(ALLOW_HOST, DENY_HIGH_RISK);
    const subject = tool({
      name: 'send_email',
      risk: 'external-write',
      guard: () => ({ allowed: true, reason: '收件人在白名单' }),
    });

    const decision = await decide(layer, subject);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /policy deny/);
  });

  it('PolicyService 放行 → 放行', async () => {
    const decision = await decide(
      policy(ALLOW_HOST, ALLOW_HIGH_RISK),
      tool({ name: 'send_email', risk: 'external-write' }),
    );
    assert.equal(decision.allowed, true);
    assert.match(decision.reason, /policy allow/);
  });
});

describe('hostToolWithheld 与 check 不允许漂移', () => {
  it('对每个宿主工具，「被收走」与「check 拒绝」是同一个结论', async () => {
    // 两处分开写就会漂移，而漂移的表现是日志里说「没给」、实际给了。
    const layer = policy(WITHHOLD_HOST);

    for (const subject of hostTools()) {
      assert.equal(layer.hostToolWithheld(subject), true);
      assert.equal((await decide(layer, subject)).allowed, false);
    }
  });

  it('部署放行时两边同时翻面', async () => {
    const layer = policy(ALLOW_HOST);

    for (const subject of hostTools()) {
      assert.equal(layer.hostToolWithheld(subject), false);
      assert.equal((await decide(layer, subject)).allowed, true);
    }
  });

});
