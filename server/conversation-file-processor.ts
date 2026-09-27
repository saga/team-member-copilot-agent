import { describeByKind, extensionOf, TextFileExtractor, type FileExtractor } from './file-extractor.js';
import type { ConversationFile } from './domain.js';
import type { ConversationFileService } from './conversation-file-service.js';
/**
 * 会话文件的提取与索引。
 *
 * 上传接口只负责「落盘 + 建行（processing）」，提取在这里异步跑：
 * 让 POST /files 等 PDF 解析 / 全文索引跑完，等于把上传的响应时间绑在
 * 「文件多大、内容多长」上，而这两件事用户完全无从预期。
 *
 * ── 为什么是串行队列 ────────────────────────────────────────────────
 *
 * 提取是同步 IO + CPU（readFileSync + 一次 INSERT），并发跑不会更快，
 * 只会让多个上传互相拖慢、并且让「哪个文件先就绪」变得不可预测。
 * 一次一个，按入队顺序。
 *
 * 进程重启时停在 processing 的文件由 recoverProcessing() 重新入队 ——
 * 没有这一步，它们会永远停在「处理中」，而 UI 上那是一个转不完的圈。
 */
export class ConversationFileProcessor {
  private readonly extractor: FileExtractor;
  private readonly queue: string[] = [];
  private draining = false;

  constructor(
    private readonly files: ConversationFileService,
    private readonly maxExtractedTextChars: number,
    extractor?: FileExtractor,
  ) {
    this.extractor = extractor ?? new TextFileExtractor();
  }

  /** 上传后调用。不 await：响应先回去，提取在后台继续。 */
  enqueue(file: ConversationFile): void {
    this.queue.push(file.id);
    /**
     * 起步必须推迟一个宏任务，不能直接 `void this.drain()`。
     *
     * `drain()` 的第一轮会**同步**跑到 `markReady`（提取是同步 IO），于是
     * `file.updated` 会在路由 `res.json()` 之前就广播出去。调用方就会先收到
     * 「已就绪」的事件、后收到 202 里「处理中」的快照 —— 那份快照是上传那一刻
     * 的状态，却比事件更晚到达，界面上这份文件会永远停在「处理中…」。
     *
     * 队列已经在排空时（连着传两个文件）也得益于同一个理由：那时续跑发生在
     * 微任务里，而 `res.json()` 是在 handler 里同步写出的，响应仍然在前。
     */
    setImmediate(() => {
      void this.drain();
    });
  }

  /** 启动恢复：把上次进程留下的 processing 重新跑一遍。 */
  recoverProcessing(): number {
    const pending = this.files.processingFiles();
    for (const file of pending) this.queue.push(file.id);
    if (pending.length > 0) void this.drain();
    return pending.length;
  }

  /** 串行排空队列。异常只在单个文件上收口，不中断后面的。 */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const fileId = this.queue.shift() as string;
        await this.processOne(fileId);
      }
    } finally {
      this.draining = false;
    }
  }

  private async processOne(fileId: string): Promise<void> {
    // 队列里可能是一条已经被删掉 / 已被别的路径处理完的 id：取不到就跳过。
    let file: ConversationFile;
    try {
      file = this.files.getForProcessing(fileId);
    } catch {
      return;
    }

    try {
      const extension = extensionOf(file.originalName);
      if (this.extractor.canHandle(extension)) {
        const extracted = this.extractor.extract(
          this.files.absolutePathOf(file),
          this.maxExtractedTextChars,
        );
        this.files.markReady(file.id, extracted.text);
        return;
      }

      // 不可搜的格式：直接就绪，但没有文本。它们仍然可以作为原文件 attachment
      // 交给模型，也能预览 / 下载 —— 「不能搜」和「没处理完」是两件事。
      const described = describeByKind(file.originalName, file.contentType);
      this.files.markReady(file.id, described.text);
    } catch (error) {
      // 提取失败不该让文件消失：正文还在，只是搜不到。把原因记下来给用户看，
      // 而不是让它在 UI 上永远转圈。
      this.files.markFailed(file.id, error instanceof Error ? error.message : String(error));
    }
  }
}
