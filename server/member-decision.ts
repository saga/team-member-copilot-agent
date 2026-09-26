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

/** normalize 会抹掉的引号。 */
const QUOTE_CHARS = `"'` + '`「『';

/**
 * 这段文本**还可能**变成哨兵吗？
 *
 * 流式过滤的全部难点在这里：收到 `<` 时还不知道它会不会变成 `<NO_REPLY>`；
 * 收到一个反引号时，也不知道后面跟的是代码块还是包在代码块里的哨兵。
 * 判据必须容忍 `normalize()` 会抹掉的那些包装，否则一个包在围栏里的哨兵
 * 会从流里漏出去 —— 而那正是要修的现象。
 *
 * 实现是「把包装逐层剥掉，再看剩下的是不是哨兵的前缀」。剥不干净时一律
 * 返回 true（继续扣住）：多扣几个字符的代价是几十毫秒的延迟，漏一个哨兵的
 * 代价是用户看到一条凭空出现又凭空消失的消息。
 *
 * 尾部噪声（引号、闭合围栏、句号）单独判：哨兵后面只有这些才继续扣，
 * 一旦出现真内容就说明这是一次真实发言（`<NO_REPLY> 之外还有话`），
 * 必须放行 —— parseMemberTurnOutcome 也会把它判成 reply。
 */
export function couldStillBeNoReply(text: string): boolean {
  let rest = text.replace(/^\s+/, '');
  if (rest === '') return true;

  // 代码围栏：```lang\n。可能只写了一半（"`"、"``"），那时也还在围栏里。
  if (rest.startsWith('`')) {
    const fence = rest.match(/^```[a-zA-Z]*\s*\n/);
    if (!fence) {
      // 还没写到换行 —— 连 ``` 都没写全也算「可能是个围栏」
      return '```'.startsWith(rest.split('\n')[0]) || rest.startsWith('```');
    }
    rest = rest.slice(fence[0].length).replace(/^\s+/, '');
    if (rest === '') return true;
  }

  // 引号包装
  if (QUOTE_CHARS.includes(rest[0])) {
    rest = rest.slice(1).replace(/^\s+/, '');
    if (rest === '') return true;
  }

  const upper = rest.toUpperCase();
  if (upper.startsWith(NO_REPLY_SENTINEL)) {
    // 哨兵已经完整，但后面可能还有闭合包装没到齐 → 继续扣
    return /^[\s"'`「」『』.。]*$/.test(upper.slice(NO_REPLY_SENTINEL.length));
  }
  return NO_REPLY_SENTINEL.startsWith(upper);
}

/**
 * 流式增量里的哨兵过滤器。
 *
 * 模型会**逐字**吐出 `<NO_REPLY>`。原样转发的话，用户会看着这串字符长出来，
 * 然后在 execution 收口时整条消失 —— 看起来像 UI 出了故障，而不是「这个
 * Member 判断自己不必发言」。哨兵是**控制信号**，不是内容，它不该出现在
 * 任何客户端。
 *
 * 用法：每次增量 `push()`，把返回的文本转发出去（空串表示这次全被扣住）；
 * 这一轮结束时用 `flush(decision)` 取回残余。
 *
 * 为什么 `flush` 要带 decision：哨兵是「整条回复」级别的判断，所以扣住的
 * 尾巴既可能是真回复（被截断的前缀）也可能是哨兵本身。让调用方**必须**把
 * 判定结果传进来，就不存在「忘了判断、顺手把哨兵 flush 出去」这条路径 ——
 * 泄漏在类型层面被堵住，而不是靠写代码的人记得。
 */
export class NoReplyStreamGate {
  private held = '';
  /**
   * 一旦确定不是哨兵就不再扣了。
   *
   * 哨兵只可能是**整条回复**，不会出现在中间，所以首次分歧之后剩下的增量
   * 可以无条件转发 —— 既省掉每个 chunk 的重复判断，也避免「回复中间碰巧
   * 出现 `<NO_REPLY>` 字样」被误扣（那是一次真实发言）。
   */
  private diverged = false;

  /** 吃一段增量，返回现在可以安全转发的文本。 */
  push(delta: string): string {
    if (this.diverged) return delta;

    this.held += delta;
    if (couldStillBeNoReply(this.held)) return '';

    this.diverged = true;
    const visible = this.held;
    this.held = '';
    return visible;
  }

  /** 这一轮结束：取回扣住的残余。skip 时返回空串 —— 那条残余就是哨兵。 */
  flush(decision: ExecutionDecision): string {
    const visible = this.held;
    this.held = '';
    return decision === 'skip' ? '' : visible;
  }
}
