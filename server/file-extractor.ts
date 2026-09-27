import fs from 'node:fs';

/**
 * 文件分类与文本提取。
 *
 * 这一层只回答两个问题，不做存储、不碰 DB：
 *
 *   classify()  —— 这个文件是什么，能不能搜、能不能预览
 *   extract()   —— 能搜的话，文本是什么
 *
 * 把分类和提取放在存储之外，是因为「哪些格式可搜」是会变的事实（加一个 PDF
 * 解析器就变了），而「文件怎么存、谁能看」是稳定的架构决定。混在一个 service 里
 * 时，每加一种格式都要动存储层。
 *
 * ── 当前支持的提取范围 ──────────────────────────────────────────────
 *
 * 只有文本类：UTF-8 直接读。PDF / Office / 图片**不提取**，它们仍然可以作为
 * 原文件 attachment 交给模型，也可以预览下载，只是不进 FTS —— 想搜「文件里
 * 有没有提到 X」时搜不到它们。要支持就得给每种格式加一个 extractor 实现。
 */

export type FileKind = 'text' | 'pdf' | 'image' | 'office' | 'archive' | 'binary';

export interface ExtractedFile {
  /** 提取出的文本；不可搜的格式为 null。 */
  text: string | null;
  searchable: boolean;
  previewable: boolean;
  kind: FileKind;
  /** 文本被 maxChars 截断时为 true，调用方据此提示内容不全。 */
  truncated: boolean;
}

export interface FileExtractor {
  canHandle(extension: string): boolean;
  extract(filePath: string, maxChars: number): ExtractedFile;
}

/** UTF-8 纯文本。这一版唯一真正读内容的 extractor。 */
export const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'html',
  'htm',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sql',
  'yaml',
  'yml',
  'log',
  'ini',
  'toml',
  'css',
] as const;

const TEXT_SET = new Set<string>(TEXT_EXTENSIONS);

/**
 * 一律拒绝上传的扩展名。
 *
 * 这些不是「还没实现解析」，而是「不该出现在一个给人看的协作空间里」：
 * 可执行文件、安装包、脚本。上传它们没有任何使用场景，而一旦落盘，
 * 后面每一个把它们当附件转给 runtime 的地方都多了一个需要重新论证的假设。
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'dll',
  'dmg',
  'pkg',
  'app',
  'msi',
  'scr',
  'com',
  'bat',
  'cmd',
  'sh',
  'ps1',
  'jar',
  'vbs',
  'so',
]);

/**
 * 压缩包：允许上传（作为资料附件是合理的），但**不解压**。
 *
 * 解压要处理 ZIP bomb、相对路径穿越（`../../etc/passwd`）和符号链接，
 * 三件事都做过之后才谈得上安全；这一版不做，所以它们不进 FTS，
 * 只是可下载的原文件。
 */
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz']);

const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/** 小写、不带点的扩展名；没有扩展名时返回空串。 */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export class FileTypeRejectedError extends Error {}

/**
 * 上传前的形状闸门。抛 FileTypeRejectedError，路由把它翻成 400：
 * 这是调用方输入问题，不该是 500。
 */
export function assertUploadable(originalName: string): void {
  const extension = extensionOf(originalName);
  if (!extension) {
    throw new FileTypeRejectedError('这个文件没有扩展名，无法判断类型，请先改好文件名再上传');
  }
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw new FileTypeRejectedError(
      `.${extension} 是可执行文件 / 安装包 / 脚本，不允许上传到会话里`,
    );
  }
}

export function classify(originalName: string, contentType: string): FileKind {
  const extension = extensionOf(originalName);
  if (TEXT_SET.has(extension)) return 'text';
  if (extension === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (contentType.startsWith('text/')) return 'text';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf') return 'pdf';
  return 'binary';
}

export class TextFileExtractor implements FileExtractor {
  canHandle(extension: string): boolean {
    return TEXT_SET.has(extension);
  }

  /**
   * 一次读完再截断，而不是流式读一半：截断点落在多字节字符中间会拼出一个坏字符，
   * 而 FTS 存进去之后就再也没人发现得了一开始就坏掉了。
   */
  extract(filePath: string, maxChars: number): ExtractedFile {
    const raw = fs.readFileSync(filePath, 'utf8');
    const truncated = raw.length > maxChars;
    return {
      text: truncated ? raw.slice(0, maxChars) : raw,
      searchable: true,
      previewable: true,
      kind: 'text',
      truncated,
    };
  }
}

/** 浏览器能直接渲染的格式，UI 上给「预览」入口。 */
export function isPreviewableKind(kind: FileKind): boolean {
  return kind === 'text' || kind === 'pdf' || kind === 'image';
}

/** 不读内容的分类结果，给不可搜的格式用。 */
export function describeByKind(originalName: string, contentType: string): ExtractedFile {
  const kind = classify(originalName, contentType);
  return {
    text: null,
    searchable: false,
    previewable: isPreviewableKind(kind),
    kind,
    truncated: false,
  };
}
