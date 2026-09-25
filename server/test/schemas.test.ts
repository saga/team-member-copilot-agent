import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

/**
 * 路由层请求体校验的契约测试。这里刻意重新声明 schema（而不是 import 路由模块），
 * 因为 import 路由会把 app.ts 一起拉起来，触发 express / CopilotClient 的副作用。
 */

const CreateMemberBody = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
});

const CreateConversationBody = z.object({
  memberIds: z.array(z.string().min(1)).min(1),
  kind: z.enum(['direct', 'group', 'work']).optional(),
});

const MemberCapabilitiesBody = z.object({
  skills: z.array(z.object({ providerId: z.string().trim().min(1) })).max(100),
  knowledge: z.array(
    z.object({ providerId: z.string().trim().min(1), selector: z.string().max(300).optional() }),
  ).max(100),
  tools: z.array(z.object({ providerId: z.string().trim().min(1) })).max(100),
});

describe('Member schema', () => {
  it('name / role 必填', () => {
    assert.throws(() => CreateMemberBody.parse({ name: '', role: '' }));
  });

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

describe('Member capabilities schema', () => {
  it('三类能力都必须显式给出（漏一类 = 那一类被清空，不能靠默认值兜）', () => {
    assert.throws(() => MemberCapabilitiesBody.parse({ skills: [], knowledge: [] }));
  });

  it('binding 的形状是 providerId + 可选 selector', () => {
    assert.deepEqual(
      MemberCapabilitiesBody.parse({
        skills: [],
        knowledge: [{ providerId: 'local.filesystem-knowledge', selector: '$personal' }],
        tools: [{ providerId: 'team.core-tools' }],
      }),
      {
        skills: [],
        knowledge: [{ providerId: 'local.filesystem-knowledge', selector: '$personal' }],
        tools: [{ providerId: 'team.core-tools' }],
      },
    );
  });

  it('空 providerId 被拒绝', () => {
    assert.throws(() =>
      MemberCapabilitiesBody.parse({ skills: [{ providerId: '' }], knowledge: [], tools: [] }),
    );
  });
});

describe('Conversation schema', () => {
  it('至少需要一个 member', () => {
    assert.throws(() => CreateConversationBody.parse({ memberIds: [] }));
  });

  it('group 合法', () => {
    assert.equal(
      CreateConversationBody.parse({ memberIds: ['a', 'b'], kind: 'group' }).kind,
      'group',
    );
  });
});
