import type { ExecutionDecision } from './domain.js';

/**
 * Member 的一轮 turn 有两个合法结果：发言，或者**判断自己不该发言**。
 *
 * `skip` 不是错误，这是 Team Member 和普通 chatbot 最大的区别之一 ——
 * 它可以说「我没有新信息，不重复 Bob 的结论」。把 skip 当失败处理会让
 * 房间里的每个 Member 都变成必须抢答的 chatbot。
 *
 * 第一版刻意不用 structured output：直接在 prompt 里约定一个哨兵字符串，
 * 服务器做**严格**解析。等真的需要 reply / skip / delegate 三态决策时，
 * 再换成 tool call 或 JSON schema —— 那时解析代码的边界已经由这里的测试固定住了。
 *
 * 解析必须严格：哨兵只在整个回复就是哨兵时才算数。如果模型在正常回复里
 * 提到了 `<NO_REPLY>`，那是一次真实发言，不能被吞掉。
 */
export const NO_REPLY_SENTINEL = '<NO_REPLY>';

export interface MemberTurnOutcome {
  decision: ExecutionDecision;
  /** 要落库的内容。skip 时为空串。 */
  content: string;
}

export function parseMemberTurnOutcome(raw: string): MemberTurnOutcome {
  const normalized = normalize(raw);

  if (normalized.toUpperCase() === NO_REPLY_SENTINEL.toUpperCase()) {
    return { decision: 'skip', content: '' };
  }

  return { decision: 'reply', content: raw.trim() };
}

/**
 * 抹掉模型爱加的包装，再判断是不是哨兵。
 *
 * 覆盖三种常见噪声：整体包在 ``` 代码块里、整体带引号、末尾多一个句号。
 * 都是「模型照做了但格式不干净」，不该因此把一次 skip 记成一次发言。
 */
function normalize(raw: string): string {
  let text = raw.trim();

  // ```text\n<NO_REPLY>\n```
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();

  // "<NO_REPLY>" / '<NO_REPLY>' / 「<NO_REPLY>」
  const quoted = text.match(/^["'`「『]([\s\S]*)["'`」』]$/);
  if (quoted) text = quoted[1].trim();

  // <NO_REPLY>. / <NO_REPLY>。
  return text.replace(/[.。]+$/, '').trim();
}
