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

/**
 * 任意 JSON 值的短指纹。
 *
 * 和 `hashText` 分开而不是共用一个「先 stringify 再 hash」的入口：文本 hash
 * 的输入已经是字符串，再 stringify 一次会给它加上一对引号并转义内部引号，
 * 于是同一个内容在两条路径上算出两个指纹 —— 正是上面那段注释要避免的事。
 *
 * **调用方负责键序**：`JSON.stringify` 按插入序输出，所以「同一个对象、不同的
 * 构造顺序」会得到不同的指纹。用于「内容有没有变」时，构造处必须排序
 * （`canonicalHash` 就是这么做的）。
 */
export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
