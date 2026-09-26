import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  couldStillBeNoReply,
  NoReplyStreamGate,
  parseMemberTurnOutcome,
} from '../member-decision.js';

/**
 * 哨兵是**协议**，不是内容。
 *
 * 这里守两条边界，方向相反、同样重要：
 *
 *   1. 模型说「我不发言」时必须被认出来 —— 认不出来的话，房间会被
 *      `<NO_REPLY>` 这种噪声消息塞满，而且每个 Member 都成了必须抢答的 chatbot。
 *   2. 模型**真的发言**、只是恰好提到了 `<NO_REPLY>` 时，绝不能被吞掉 ——
 *      静默丢一条真实回复比多一条噪声难查得多，因为界面上什么都不缺。
 *
 * 流式过滤是第三条边界：哨兵可以在解析层被正确识别，却仍然在转发层漏给
 * 用户 —— 用户会看着 `<NO_REPLY>` 长出来再整条消失，看起来像 UI 故障。
 * 所以 `NoReplyStreamGate` 必须和解析用**同一套**噪声容忍规则。
 */

describe('parseMemberTurnOutcome：整个回复就是哨兵才算 skip', () => {
  const skips = [
    '<NO_REPLY>',
    '  <NO_REPLY>  ',
    '<no_reply>',
    '<NO_REPLY>\n',
    '<NO_REPLY>.',
    '```\n<NO_REPLY>\n```',
    '"<NO_REPLY>"',
    '「<NO_REPLY>」',
  ];

  for (const raw of skips) {
    it(`skip：${JSON.stringify(raw)}`, () => {
      assert.deepEqual(parseMemberTurnOutcome(raw), { decision: 'skip', content: '' });
    });
  }

  const replies = [
    // 真实发言里提到哨兵 —— 这是发言，不是 skip。吞掉它就是静默丢消息。
    '<NO_REPLY> 但我觉得风险在依赖上',
    '结论：可以用 <NO_REPLY> 表示沉默',
    '先做架构评审',
    'NO_REPLY',
    '',
  ];

  for (const raw of replies) {
    it(`reply：${JSON.stringify(raw)}`, () => {
      const outcome = parseMemberTurnOutcome(raw);
      assert.equal(outcome.decision, 'reply');
      assert.equal(outcome.content, raw.trim());
    });
  }
});

describe('couldStillBeNoReply：容忍 normalize 会抹掉的包装', () => {
  const stillPossible = [
    '',
    ' ',
    '<',
    '<NO_REPLY',
    '<NO_REPLY>',
    '<NO_REPLY>"',
    '<NO_REPLY>。',
    '\n\n<NO',
    '`',
    '``',
    '```',
    '```js\n',
    '```js\n<NO',
    '```js\n<NO_REPLY>',
    '```js\n<NO_REPLY>\n`',
    '"',
    '"<NO',
    '"<NO_REPLY>',
  ];

  for (const text of stillPossible) {
    it(`继续扣住：${JSON.stringify(text)}`, () => {
      assert.equal(couldStillBeNoReply(text), true);
    });
  }

  const diverged = [
    '架',
    '<d',
    '<div>hi',
    'NO_REPLY',
    '<NO_REPLY> 但还有话',
    '```js\nconst a = 1',
    '"你好',
    '<NO_REPLYx',
  ];

  for (const text of diverged) {
    it(`可以放行：${JSON.stringify(text)}`, () => {
      assert.equal(couldStillBeNoReply(text), false);
    });
  }
});

describe('NoReplyStreamGate：哨兵一个字符都不转发', () => {
  /** 逐字符喂进去，返回所有被转发出来的文本拼起来的结果。 */
  function stream(text: string, chunk = 1): string {
    const gate = new NoReplyStreamGate();
    let out = '';
    for (let i = 0; i < text.length; i += chunk) {
      out += gate.push(text.slice(i, i + chunk));
    }
    return out;
  }

  it('逐字吐出 <NO_REPLY> 时，中途什么都不转发', () => {
    assert.equal(stream('<NO_REPLY>'), '');
    assert.equal(stream('<no_reply>'), '');
    // 逐字符是模型真实的流式粒度；整段一次性到达（全量兜底路径）也要挡住
    assert.equal(stream('<NO_REPLY>', 10), '');
  });

  it('包在代码块 / 引号里的哨兵同样不转发', () => {
    assert.equal(stream('```\n<NO_REPLY>\n```'), '');
    assert.equal(stream('```text\n<NO_REPLY>\n```'), '');
    assert.equal(stream('"<NO_REPLY>"'), '');
    assert.equal(stream('「<NO_REPLY>」'), '');
  });

  it('正常回复从第一个字符就转发，不引入延迟', () => {
    assert.equal(stream('先做架构评审'), '先做架构评审');
    // 分歧之后剩下的增量原样通过
    const gate = new NoReplyStreamGate();
    assert.equal(gate.push('架'), '架');
    assert.equal(gate.push('构'), '构');
  });

  it('以 < 开头的正常回复只是晚一两个字符，内容不丢', () => {
    assert.equal(stream('<div>hello</div>'), '<div>hello</div>');
    assert.equal(stream('<NO_REPLY> 但我有补充'), '<NO_REPLY> 但我有补充');
  });

  it('flush 必须带上判定结果：skip 时那条尾巴就是哨兵，不能放出去', () => {
    const gate = new NoReplyStreamGate();
    gate.push('<NO_REPLY>');
    assert.equal(gate.flush('skip'), '', 'skip 时哨兵绝不能被 flush 出去');
  });

  it('flush 在 reply 时把扣住的残余还回来（模型被截断的前缀）', () => {
    const gate = new NoReplyStreamGate();
    assert.equal(gate.push('<NO_RE'), '');
    assert.equal(gate.flush('reply'), '<NO_RE', 'reply 时扣住的残余是真实内容');
  });

  it('flush 之后不残留状态（下一轮不会继续扣）', () => {
    const gate = new NoReplyStreamGate();
    gate.push('<NO_REPLY>');
    gate.flush('skip');
    assert.equal(gate.push('下一轮正常回复'), '下一轮正常回复');
  });

  it('流式转发出来的内容与 parseMemberTurnOutcome 的判定一致', () => {
    // 这条是这套东西存在的理由：两个模块对「什么算哨兵」必须给出同一个答案。
    // 用同一批样本同时过两遍 —— 解析说 skip 的，流式必须一个字符都没转发。
    const samples = [
      '<NO_REPLY>',
      '<NO_REPLY>\n',
      '```\n<NO_REPLY>\n```',
      '"<NO_REPLY>"',
      '<NO_REPLY>.',
      '先做架构评审',
      '<NO_REPLY> 但我有补充',
      '<div>hi</div>',
    ];

    for (const sample of samples) {
      const outcome = parseMemberTurnOutcome(sample);
      const forwarded = stream(sample);
      if (outcome.decision === 'skip') {
        assert.equal(forwarded, '', `${JSON.stringify(sample)} 判成 skip，就不该转发任何字符`);
      } else {
        assert.equal(
          forwarded,
          sample,
          `${JSON.stringify(sample)} 判成 reply，流式就必须完整转发`,
        );
      }
    }
  });
});
