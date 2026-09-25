import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltInTools } from '@github/copilot-sdk';
import type { ToolProfile } from '../domain.js';
import {
  CUSTOM_TOOLS,
  DefaultToolPolicy,
  HOST_TOOLS,
  type ToolCallRequest,
} from '../tool-policy.js';

/**
 * 工具授权层。
 *
 * 这一层存在的理由是「声明」和「授权」是两件事，而它们很容易各自漂移：
 * 给引擎的 availableTools 说了一套，hook 里又按另一套判，结果就是模型看得见
 * 一个它其实用不了的工具（或者更糟：看不见却在某个路径上被放行）。
 *
 * 用例分两组，分别盯这两个问题：
 *   1. 成员**看得见**什么 —— 三个 custom tool 一个都不能漏
 *   2. 每一次调用**放不放行** —— 默认拒绝，宿主工具要两道门都开
 *
 * 最后一条用例把它们钉在一起：声明出来的东西不允许被自己的 hook 拒掉。
 */

function policy(allowHostTools: boolean): DefaultToolPolicy {
  return new DefaultToolPolicy({ allowHostTools });
}

function request(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    memberId: 'm1',
    toolProfile: 'safe',
    executionId: 'e1',
    conversationId: 'c1',
    toolName: 'ask_member',
    toolArgs: {},
    ...overrides,
  };
}

/** `toArray()` 是源限定前缀格式：`builtin:bash` / `custom:ask_member`。 */
function declaredFor(profile: ToolProfile, allowHostTools: boolean): Set<string> {
  return new Set(policy(allowHostTools).availableTools(profile).toArray());
}

const ALLOW_HOST = true;
const WITHHOLD_HOST = false;

describe('availableTools：成员看得见什么', () => {
  it('safe profile 下三个 custom tool 都在，宿主工具一个都不在', () => {
    const declared = declaredFor('safe', WITHHOLD_HOST);

    for (const name of CUSTOM_TOOLS) {
      assert.ok(
        declared.has(`custom:${name}`),
        `成员看不到 ${name} —— 工具注册了却没有声明，等于这个能力不存在`,
      );
    }

    for (const name of HOST_TOOLS) {
      assert.ok(!declared.has(`builtin:${name}`), `safe profile 不该看到 ${name}`);
    }
  });

  it('SDK 的 isolated 集合原样声明（它们只在 session 边界内活动）', () => {
    const declared = declaredFor('safe', WITHHOLD_HOST);

    for (const name of BuiltInTools.Isolated) {
      assert.ok(declared.has(`builtin:${name}`), `缺少 isolated built-in ${name}`);
    }
  });

  it('声明了 coding 但宿主工具未启用：仍然不给宿主工具，且能被上层问出原因', () => {
    const layer = policy(WITHHOLD_HOST);
    const declared = new Set(layer.availableTools('coding').toArray());

    for (const name of HOST_TOOLS) {
      assert.ok(
        !declared.has(`builtin:${name}`),
        `toolProfile=coding 不等于获得宿主机执行权，${name} 不该被声明`,
      );
    }

    assert.equal(layer.hostToolsWithheld('coding'), true);
    assert.equal(layer.hostToolsWithheld('safe'), false);
  });

  it('部署显式启用宿主工具后，coding profile 才拿得到', () => {
    const declared = declaredFor('coding', ALLOW_HOST);

    for (const name of HOST_TOOLS) {
      assert.ok(declared.has(`builtin:${name}`), `已启用宿主工具，${name} 应被声明`);
    }
  });

  it('宿主工具启用也只给 coding —— safe profile 仍然拿不到', () => {
    const declared = declaredFor('safe', ALLOW_HOST);

    for (const name of HOST_TOOLS) {
      assert.ok(!declared.has(`builtin:${name}`), `safe profile 不该看到 ${name}`);
    }
  });
});

describe('check：每一次调用放不放行', () => {
  it('三个 custom tool 在 safe profile 下也放行（它们的边界由各自的业务校验兜住）', () => {
    const layer = policy(WITHHOLD_HOST);

    for (const name of CUSTOM_TOOLS) {
      const decision = layer.check(request({ toolName: name, toolProfile: 'safe' }));
      assert.equal(decision.allowed, true, `${name} 被拒了：${decision.reason}`);
    }
  });

  it('isolated built-in 放行', () => {
    const layer = policy(WITHHOLD_HOST);

    for (const name of BuiltInTools.Isolated) {
      assert.equal(layer.check(request({ toolName: name })).allowed, true, `${name} 被拒`);
    }
  });

  it('宿主工具对非 coding profile 一律拒绝，理由说得出是 profile 的问题', () => {
    const layer = policy(ALLOW_HOST);

    for (const name of HOST_TOOLS) {
      const decision = layer.check(request({ toolName: name, toolProfile: 'safe' }));
      assert.equal(decision.allowed, false, `${name} 不该对 safe profile 放行`);
      assert.match(decision.reason, /coding/);
    }
  });

  it('coding profile 也要宿主工具已启用才放行', () => {
    const withHost = policy(ALLOW_HOST);
    const withoutHost = policy(WITHHOLD_HOST);
    const coding = { toolProfile: 'coding' as const };

    const denied = withoutHost.check(request({ toolName: 'bash', ...coding }));
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /HOST_CODING_TOOLS/);

    assert.equal(withHost.check(request({ toolName: 'bash', ...coding })).allowed, true);
  });

  it('没定义过策略的工具默认拒绝', () => {
    const layer = policy(ALLOW_HOST);

    // 引擎新增的 built-in、skill 带来的 MCP 工具，都会先落到这一支。
    for (const name of ['mcp:github-list_issues', 'builtin:some_future_tool', 'custom:unknown']) {
      const decision = layer.check(request({ toolName: name, toolProfile: 'coding' }));
      assert.equal(decision.allowed, false, `${name} 应被默认拒绝`);
      assert.match(decision.reason, /默认拒绝/);
    }
  });
});

describe('声明与放行不允许漂移', () => {
  const profiles: ToolProfile[] = ['safe', 'coding'];
  const deployments = [
    ['宿主工具已启用', ALLOW_HOST],
    ['宿主工具未启用', WITHHOLD_HOST],
  ] as const;

  for (const profile of profiles) {
    for (const [label, allowHostTools] of deployments) {
      it(`${profile} / ${label}：声明出来的工具必须能被同一个 policy 放行`, () => {
        const layer = policy(allowHostTools);
        const declared = layer.availableTools(profile).toArray();

        // 通配声明要展开成具体名字才能逐个判；这里只处理具体名字。
        const concrete = declared.filter((item) => !item.endsWith(':*') && item !== '*');
        assert.ok(concrete.length > 0);

        for (const qualified of concrete) {
          const name = qualified.slice(qualified.indexOf(':') + 1);
          const decision = layer.check(request({ toolName: name, toolProfile: profile }));
          assert.equal(
            decision.allowed,
            true,
            `${qualified} 声明给了成员，却在授权层被拒（${decision.reason}）——` +
              '模型会看得见一个用不了的工具',
          );
        }
      });
    }
  }
});
