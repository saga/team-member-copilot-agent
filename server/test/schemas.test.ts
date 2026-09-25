import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatBody, CreateSessionBody } from '../routes/sessions.js';

describe('CreateSessionBody', () => {
  it('空体合法（模型走服务端默认）', () => {
    assert.deepEqual(CreateSessionBody.parse({}), {});
  });

  it('空白模型视为非法', () => {
    assert.throws(() => CreateSessionBody.parse({ model: '  ' }));
  });
});

describe('ChatBody', () => {
  it('空 prompt 被拒绝', () => {
    assert.throws(() => ChatBody.parse({ prompt: '  ' }));
  });

  it('默认非流式', () => {
    assert.equal(ChatBody.parse({ prompt: 'hi' }).streaming, false);
  });
});
