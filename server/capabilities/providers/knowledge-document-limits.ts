import path from 'node:path';

/**
 * 什么文件算「一份可检索的资料」。
 *
 * ── 为什么要有这份判据 ────────────────────────────────────────────────
 *
 * 磁盘是正文 source of truth，于是「目录里放了什么」与「索引里有什么」必须由
 * **同一个**判据决定。它以前不存在，代价是两处不一致：
 *
 *   1. 目录里任何文件都会被读成 utf8 塞进 FTS —— 放一张 png、一个压缩包、
 *      一个几百 MB 的导出文件进 KB 目录，索引就膨胀且检索出乱码片段。而同样
 *      的内容走 `writeDocument()`（API）没有这条路径，两边的行为不一致。
 *   2. 「这个文件为什么没被索引」没有一个可回答的规则。加上判据之后，
 *      答案是「扩展名不在白名单 / 单份超过上限」，看一眼就能确认。
 *
 * 所以 `writeDocument()`（API 写入）与 `indexDirectory()`（扫目录）共用这里的
 * `documentPathIssue()`：一边接受、一边拒绝是这类不一致最常见的形态。
 *
 * ── 刻意不做的事 ──────────────────────────────────────────────────────
 *
 * 不做 MIME sniffing / 编码探测 / 自动截断。前两者会让判据变成「取决于文件
 * 内容」，于是同一个文件名在不同机器上结论不同；后者会让人以为资料进去了，
 * 实际上检索到的只是前半段。要放更大的资料，正确的动作是改这里的上限，
 * 而不是让它悄悄半途生效。
 */

/** 单份文档上限。超过它就不再是「按需检索的资料」，而是需要另找存储的东西。 */
export const MAX_DOCUMENT_BYTES = 1_000_000;

/** 可索引的文本格式。没有例外列表 —— 例外的代价是没人能一眼说清规则。 */
export const INDEXABLE_EXTENSIONS: readonly string[] = [
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
];

/**
 * 这个路径 + 大小能不能进索引。返回 `null` = 可以，否则返回拒绝的理由。
 *
 * 理由要能直接进日志 / 400 响应：它是运维唯一能看到的「为什么这份资料不见了」。
 */
export function documentPathIssue(relativePath: string, byteLength: number): string | null {
  const extension = path.extname(relativePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.includes(extension)) {
    return `不是可索引的文本格式（允许：${INDEXABLE_EXTENSIONS.join(' ')}）`;
  }
  if (byteLength > MAX_DOCUMENT_BYTES) {
    return `体积 ${byteLength} 字节，超过单份上限 ${MAX_DOCUMENT_BYTES}`;
  }
  return null;
}
