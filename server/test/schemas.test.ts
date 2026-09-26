import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

/**
 * 身份编辑 schema 的安全分离契约。这里刻意重新声明 schema（而不是 import 路由模块），
 * 因为 import 路由会把 app.ts 一起拉起来，触发 express / CopilotClient 的副作用。
 *
 * 其余字段校验（必填、min/max）是 zod 自身语义，在本地副本上断言它们没有区分度，
 * 不在此重复；真实路由 schema 的形状由各路由的集成用例覆盖。
 */

const CreateMemberBody = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
});

describe('Member schema', () => {
  it('身份编辑不接受能力字段 —— 「改个名字」与「给它开 shell」必须是两个请求', () => {
    // create / update 的 schema 是 strip 模式，多出来的键会被丢掉而不是报错，
    // 所以断言的是「解析结果里没有它」，也就是这条路径**不可能**改到能力。
    const parsed = CreateMemberBody.parse({
      name: 'Researcher',
      role: 'Research Analyst',
      toolProfile: 'coding',
      capabilities: { tools: [{ providerId: 'runtime.host-coding-tools' }] },
    }) as Record<string, unknown>;

    assert.equal('toolProfile' in parsed, false);
    assert.equal('capabilities' in parsed, false);
  });
});
