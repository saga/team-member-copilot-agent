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
  toolProfile: z.enum(['safe', 'coding']).optional(),
});

const CreateConversationBody = z.object({
  memberIds: z.array(z.string().min(1)).min(1),
  kind: z.enum(['direct', 'group', 'work']).optional(),
});

describe('Member schema', () => {
  it('name / role 必填', () => {
    assert.throws(() => CreateMemberBody.parse({ name: '', role: '' }));
  });

  it('safe tool profile 合法', () => {
    assert.equal(
      CreateMemberBody.parse({
        name: 'Researcher',
        role: 'Research Analyst',
        toolProfile: 'safe',
      }).toolProfile,
      'safe',
    );
  });

  it('未知 tool profile 被拒绝', () => {
    assert.throws(() =>
      CreateMemberBody.parse({
        name: 'Researcher',
        role: 'Research Analyst',
        toolProfile: 'root',
      }),
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
