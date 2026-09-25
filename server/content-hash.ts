import { createHash } from 'node:crypto';

/**
 * 文本内容的短指纹（sha256 十六进制）。
 *
 * 三个地方需要它，而且都需要**同一个**函数：
 *
 *   Member memory 的 `version`      —— 乐观并发（PUT 时带回来比对）
 *   execution 的 memoryHash         —— 快照里「当时是哪份记忆」
 *   execution 的 systemPromptHash   —— 快照里「当时是哪份人格」
 *
 * 各写各的（一个有换行、一个没有）会让两个指纹永远不相等，而它们本该是同一份
 * 内容的两个引用。所以放在独立模块里，只有一个实现。
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
