import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationFile, ConversationFileRelation, ConversationFileStatus } from './domain.js';
import { now } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './http-error.js';
import { assertUploadable, extensionOf } from './file-extractor.js';
import { documentPathIssue } from './capabilities/providers/knowledge-document-limits.js';

/**
 * 会话文件：聊天里的附件。
 *
 * 它是**第四种**文件语义，和前三种都不同：
 *
 *   Message attachment  跟着一条消息（关系行 conversation_message_file）
 *   Conversation file   属于一个会话，ACL = conversation membership ← 本服务
 *   Team knowledge      长期团队资料，ACL = capability binding
 *   Member knowledge    某个 Member 的个人资料
 *
 * 最关键的一条：上传**不会**自动进知识库。否则在 A 讨论里传的评审稿会顺着
 * knowledge search 流到没参与这场讨论的人手里 —— 聊天文件的权限边界是
 * 「这场对话的参与者」，不是「谁有 knowledge 能力」。要长期复用必须显式 promote。
 *
 * ── 存哪里 ────────────────────────────────────────────────────────
 *
 *   <root>/<conversationId>/files/<fileId>/original<ext>
 *
 * 不放进 member home：文件属于会话，不属于任何一个人。DB 里存相对路径，
 * 整个 data 目录因此可以搬家。
 */

export interface ConversationFileRow {
  id: string;
  conversation_id: string;
  team_id: string;
  uploaded_by: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  content_hash: string;
  status: ConversationFileStatus;
  extracted_text: string | null;
  extraction_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationFileSearchHit {
  fileId: string;
  title: string;
  snippet: string;
  /** 给模型用的引用标记，前端把它渲染成可点的文件 chip。 */
  citation: string;
}

export interface ConversationFileServiceOptions {
  /** 存储根目录（config.conversationFileRoot）。 */
  root: string;
  maxBytesPerFile: number;
  maxFilesPerConversation: number;
  /** 一条消息最多挂几个文件（sendMessage 的 fileIds 上限）。 */
  maxFilesPerMessage: number;
  /**
   * 状态变化广播口。惰性闭包传进来：装配时 TeamService 还没构造完，
   * 调用发生在文件真的变化的那一刻，那时它早就在了。
   */
  onEvent?: (
    conversationId: string,
    type: 'file.created' | 'file.updated' | 'file.deleted',
    file: ConversationFile,
  ) => void;
}

/** promote 的目标：把一段文本写进某个知识库。 */
export interface KnowledgeDocumentWriter {
  writeDocument(input: {
    knowledgeBaseId: string;
    title: string;
    relativePath: string;
    content: string;
    sourceUri?: string | null;
  }): { id: string; relativePath: string; title: string };
}

export class ConversationFileService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: ConversationFileServiceOptions,
  ) {}

  // ---------------------------------------------------------------- 读

  /** Shared Files 列表：不含已删除的。 */
  list(conversationId: string): ConversationFile[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_file
        WHERE conversation_id = ? AND status != 'deleted'
        ORDER BY created_at ASC
        `,
      )
      .all(conversationId) as unknown as ConversationFileRow[];
    return rows.map(mapFile);
  }

  /**
   * 取一份文件，并**重新**校验它属于这个会话。
   *
   * 所有按 id 取的路径都必须过这里：fileId 是模型 / 客户端能给的输入，
   * 直接从 URL 拿 id 去读磁盘等于把「另一个讨论的文件」也交出去了。
   */
  get(conversationId: string, fileId: string): ConversationFile {
    const row = this.db
      .prepare('SELECT * FROM conversation_file WHERE id = ? AND conversation_id = ?')
      .get(fileId, conversationId) as unknown as ConversationFileRow | undefined;
    if (!row) throw notFound('这份文件不在当前会话里');
    return mapFile(row);
  }

  absolutePathOf(file: ConversationFile): string {
    return path.join(this.options.root, file.storagePath);
  }

  /**
   * 按 id 取任意状态的文件，**跳过会话归属校验**。
   *
   * 只给后台处理器用（id 来自队列 / DB，不是客户端输入）。任何面向请求或模型的
   * 路径都必须走 `get(conversationId, fileId)` —— 那里才有归属校验。
   */
  getForProcessing(fileId: string): ConversationFile {
    return mapFile(this.requireRow(fileId));
  }

  readContent(conversationId: string, fileId: string): Buffer {
    const file = this.get(conversationId, fileId);
    if (file.status === 'deleted') throw notFound('这份文件已经被删除');
    const target = this.absolutePathOf(file);
    if (!fs.existsSync(target)) throw notFound('这份文件的正文已经不在了');
    return fs.readFileSync(target);
  }

  /** 提取出的文本。不可搜的格式（PDF / Office / 图片）返回 null。 */
  readExtractedText(conversationId: string, fileId: string): string | null {
    this.get(conversationId, fileId);
    const row = this.db
      .prepare('SELECT extracted_text FROM conversation_file WHERE id = ?')
      .get(fileId) as unknown as { extracted_text: string | null } | undefined;
    return row?.extracted_text ?? null;
  }

  /**
   * 房间成员校验。工具的 ACL 和会话文件是**同一套**（conversation_member），
   * 和 knowledge 的 capability binding 没有任何关系 —— 所以这里不查能力。
   */
  assertMemberOfConversation(conversationId: string, memberId: string): void {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM conversation_member WHERE conversation_id = ? AND member_id = ?')
      .get(conversationId, memberId) as unknown as { ok: number } | undefined;
    if (!row) throw forbidden('你不是这个会话的成员，看不到这里的文件');
  }

  /**
   * 全文检索。
   *
   * `memberId` 给的是 **Agent 路径**的调用者：ACL 直接写进 SQL（EXISTS
   * conversation_member），而不是靠调用方先校验一遍 —— 模型可以自己编一个
   * fileId，也可能编一个 conversationId，边界写在查询里才有意义。
   *
   * `memberId = null` 只给「人在界面上搜索」这一条路径：人不是 conversation_member
   * 里的一行（那是 Agent 的花名册），他进到某个会话的能力由会话级入口决定。
   * 把它写成两个方法会让同一个查询有两份实现，所以这里用条件片段。
   */
  search(input: {
    conversationId: string;
    memberId: string | null;
    query: string;
    limit: number;
  }): ConversationFileSearchHit[] {
    const match = toFtsQuery(input.query);
    if (!match) return [];

    const membershipClause = input.memberId
      ? `AND EXISTS (
            SELECT 1
            FROM conversation_member cm
            WHERE cm.conversation_id = f.conversation_id
              AND cm.member_id = ?
          )`
      : '';
    const params: Array<string | number> = [match, input.conversationId];
    if (input.memberId) params.push(input.memberId);
    params.push(input.limit);

    const rows = this.db
      .prepare(
        `
        SELECT
          f.id AS file_id,
          f.original_name AS title,
          snippet(conversation_file_fts, 2, '', '', '…', 16) AS snippet
        FROM conversation_file_fts
        JOIN conversation_file f ON f.id = conversation_file_fts.file_id
        WHERE conversation_file_fts MATCH ?
          AND f.status = 'ready'
          AND f.conversation_id = ?
          ${membershipClause}
        ORDER BY rank
        LIMIT ?
        `,
      )
      .all(...params) as unknown as Array<{
      file_id: string;
      title: string;
      snippet: string;
    }>;

    return rows.map((row) => ({
      fileId: row.file_id,
      title: row.title,
      snippet: row.snippet,
      citation: `[FILE:${row.title}]`,
    }));
  }

  /**
   * 一条消息挂了哪些文件 —— runTurn 用它决定给模型带哪些附件。
   *
   * 只取被那条消息显式引用的：把整个 Shared Files 每次都塞给模型，会让
   * 「这轮到底在看什么」变成一个没人说得清的问题，而且很快撞上窗口上限。
   */
  filesForMessageSequence(conversationId: string, messageSequence: number): ConversationFile[] {
    const rows = this.db
      .prepare(
        `
        SELECT f.*
        FROM conversation_message_file mf
        JOIN conversation_message m ON m.id = mf.message_id
        JOIN conversation_file f ON f.id = mf.file_id
        WHERE m.conversation_id = ?
          AND m.message_sequence = ?
          AND f.status = 'ready'
        ORDER BY mf.position ASC
        `,
      )
      .all(conversationId, messageSequence) as unknown as ConversationFileRow[];
    return rows.map(mapFile);
  }

  /**
   * 批量装配多条消息的附件。
   *
   * 一条 SQL 取完再按 messageId 分组，而不是每条消息查一次：一页 100 条消息
   * 就是 100 次查询，而附件是绝大多数消息都没有的东西。
   */
  filesForMessages(messageIds: string[]): Map<string, ConversationFile[]> {
    const grouped = new Map<string, ConversationFile[]>();
    if (messageIds.length === 0) return grouped;

    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
        SELECT mf.message_id, mf.position, f.*
        FROM conversation_message_file mf
        JOIN conversation_file f ON f.id = mf.file_id
        WHERE mf.message_id IN (${placeholders})
        ORDER BY mf.message_id ASC, mf.position ASC
        `,
      )
      .all(...messageIds) as unknown as Array<ConversationFileRow & { message_id: string }>;

    for (const row of rows) {
      const list = grouped.get(row.message_id) ?? [];
      list.push(mapFile(row));
      grouped.set(row.message_id, list);
    }
    return grouped;
  }

  // ---------------------------------------------------------------- 写

  /**
   * 落一份上传的文件。
   *
   * 顺序是「先算 hash → 查重 → 写盘 → 建行」：
   *
   *   同内容同文件名重复上传直接返回已有那份（浏览器重发、用户狂点上传按钮
   *   都会走到这里），既不重复占盘，也不会在 Shared Files 里出现两份。
   *
   * 返回时状态是 processing：提取与 FTS 由 ConversationFileProcessor 异步补，
   * 上传请求不该等它。
   */
  create(input: {
    conversationId: string;
    teamId: string;
    uploadedBy: string;
    originalName: string;
    contentType: string;
    body: Buffer;
  }): ConversationFile {
    const originalName = sanitizeFileName(input.originalName);
    assertUploadable(originalName);

    if (input.body.byteLength === 0) throw badRequest('这个文件是空的');
    if (input.body.byteLength > this.options.maxBytesPerFile) {
      throw badRequest(
        `文件超过 ${Math.floor(this.options.maxBytesPerFile / 1024 / 1024)}MB 上限，请拆分后再上传`,
      );
    }

    const contentHash = hashBuffer(input.body);
    const existing = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_file
        WHERE conversation_id = ? AND content_hash = ? AND original_name = ?
        `,
      )
      .get(input.conversationId, contentHash, originalName) as unknown as
      | ConversationFileRow
      | undefined;
    if (existing) {
      // 之前删过又传回来：把状态扶正，而不是留一条 deleted 的行让用户困惑。
      if (existing.status === 'deleted') {
        this.db
          .prepare("UPDATE conversation_file SET status = 'ready', updated_at = ? WHERE id = ?")
          .run(now(), existing.id);
        const restored = this.get(input.conversationId, existing.id);
        this.options.onEvent?.(input.conversationId, 'file.created', restored);
        return restored;
      }
      return mapFile(existing);
    }

    this.assertQuota(input.conversationId);

    const id = randomUUID();
    const timestamp = now();
    const relativePath = path.join(
      input.conversationId,
      'files',
      id,
      `original${extensionSuffix(originalName)}`,
    );
    const target = path.join(this.options.root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.body);

    this.db
      .prepare(
        `
        INSERT INTO conversation_file (
          id, conversation_id, team_id, uploaded_by,
          original_name, content_type, size_bytes,
          storage_path, content_hash, status,
          extracted_text, extraction_error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, NULL, ?, ?)
        `,
      )
      .run(
        id,
        input.conversationId,
        input.teamId,
        input.uploadedBy,
        originalName,
        input.contentType || 'application/octet-stream',
        input.body.byteLength,
        toPosix(relativePath),
        contentHash,
        timestamp,
        timestamp,
      );

    const file = this.get(input.conversationId, id);
    this.options.onEvent?.(input.conversationId, 'file.created', file);
    return file;
  }

  /**
   * 提取完成：写文本 + 进 FTS。不可搜的格式（text=null）也要走这里 ——
   * 「已就绪但搜不到内容」和「还在处理」是两种状态，UI 上不能混。
   */
  markReady(fileId: string, text: string | null): ConversationFile {
    const row = this.requireRow(fileId);
    const timestamp = now();

    this.db
      .prepare(
        `
        UPDATE conversation_file
        SET status = 'ready', extracted_text = ?, extraction_error = NULL, updated_at = ?
        WHERE id = ?
        `,
      )
      .run(text, timestamp, fileId);

    // FTS 与正文保持一致：重新索引前先清掉旧行，否则重跑（启动恢复）会留下两份。
    this.db.prepare('DELETE FROM conversation_file_fts WHERE file_id = ?').run(fileId);
    if (text !== null) {
      this.db
        .prepare('INSERT INTO conversation_file_fts (file_id, title, content) VALUES (?, ?, ?)')
        .run(fileId, row.original_name, text);
    }

    const file = this.get(row.conversation_id, fileId);
    this.options.onEvent?.(row.conversation_id, 'file.updated', file);
    return file;
  }

  markFailed(fileId: string, reason: string): ConversationFile {
    const row = this.requireRow(fileId);
    this.db
      .prepare(
        `
        UPDATE conversation_file
        SET status = 'failed', extraction_error = ?, updated_at = ?
        WHERE id = ?
        `,
      )
      .run(reason, now(), fileId);
    const file = this.get(row.conversation_id, fileId);
    this.options.onEvent?.(row.conversation_id, 'file.updated', file);
    return file;
  }

  /** 启动恢复用：进程在提取途中挂掉时，这些文件停在 processing。 */
  processingFiles(): ConversationFile[] {
    const rows = this.db
      .prepare("SELECT * FROM conversation_file WHERE status = 'processing' ORDER BY created_at ASC")
      .all() as unknown as ConversationFileRow[];
    return rows.map(mapFile);
  }

  /**
   * 把文件挂到一条消息上。
   *
   * 调用方必须已经在事务里（sendMessage 就是这么用的）：关系行和消息必须
   * 一起出现，否则 message.created 已经推给前端、附件却还没写进去，
   * 那条消息在别人屏幕上就是「没有附件」的样子，刷新才会变。
   */
  attachToMessage(
    messageId: string,
    fileId: string,
    relationType: ConversationFileRelation,
    position: number,
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO conversation_message_file (message_id, file_id, relation_type, position)
        VALUES (?, ?, ?, ?)
        `,
      )
      .run(messageId, fileId, relationType, position);
  }

  /** 这条消息之前挂过哪些文件 —— 决定新一段关系是 attachment 还是 reference。 */
  attachedFileIds(messageId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT file_id FROM conversation_message_file WHERE message_id = ?')
      .all(messageId) as unknown as Array<{ file_id: string }>;
    return new Set(rows.map((row) => row.file_id));
  }

  /**
   * 发送前校验一批 fileIds，并区分「新附件」还是「引用已有文件」。
   *
   * 跨会话的 id 直接拒掉：这是最容易写错、后果也最重的一处 —— 放过去就等于
   * 「在 B 讨论里引用 A 讨论的文件」，权限边界当场破掉。
   */
  validateForMessage(conversationId: string, fileIds: string[]): ConversationFile[] {
    const unique = [...new Set(fileIds)];
    if (unique.length > this.options.maxFilesPerMessage) {
      throw badRequest(`一条消息最多带 ${this.options.maxFilesPerMessage} 个文件`);
    }

    return unique.map((fileId) => {
      const row = this.db
        .prepare('SELECT * FROM conversation_file WHERE id = ?')
        .get(fileId) as unknown as ConversationFileRow | undefined;
      if (!row) throw badRequest('引用的文件不存在，请重新选择');
      if (row.conversation_id !== conversationId) {
        throw forbidden('这个文件属于别的会话，不能在这里引用');
      }
      if (row.status === 'deleted') throw badRequest('这个文件已经被删除，不能再引用');
      return mapFile(row);
    });
  }

  /**
   * 软删除。
   *
   * 不删行、不删磁盘正文：历史消息里那条附件是**发生过的事实**，
   * 物理删掉之后过去的消息会指向一个不存在的东西，审计链就断了。
   * 正文留着，只是不再出现在 Shared Files 里、也不能再被引用。
   */
  softDelete(conversationId: string, fileId: string): void {
    const file = this.get(conversationId, fileId);
    if (file.status === 'deleted') return;
    this.db
      .prepare("UPDATE conversation_file SET status = 'deleted', updated_at = ? WHERE id = ?")
      .run(now(), fileId);
    this.db.prepare('DELETE FROM conversation_file_fts WHERE file_id = ?').run(fileId);
    this.options.onEvent?.(conversationId, 'file.deleted', this.get(conversationId, fileId));
  }

  /**
   * Promote：显式把一份会话文件变成长期知识。
   *
   * 只有提取出文本的文件能进来 —— 知识库当前是文本库（磁盘是正文 source of
   * truth），图片进去只会变成一份没有正文的索引，那是假装成功了。
   *
   * ── 路径为什么是 `promoted/<fileId>.md` ─────────────────────────────
   *
   * 写出去的是**提取出的文本**，不是原文件的字节，所以在知识库里它就是一份
   * .md 文档。不能沿用原扩展名：知识库只索引固定几种文本格式，而会话文件能
   * 提取的格式宽得多（.html / .csv / .py / .sql …）—— 沿用它会让「能搜的东西
   * 存不进去」。原文件名留在 `title` 里，检索结果上看到的就是它。
   *
   * 也不能把原文件名拼进路径：知识库的路径片段只收 ASCII（`safeSegment`），
   * 一个中文名的文件会被拒。fileId 是 uuid，天然合法，而且顺带给出幂等性 ——
   * 同一份文件重复 promote 落回同一份文档，与知识库「(kb, path) + 内容 hash
   * 收敛」的口径一致。
   */
  promote(input: {
    conversationId: string;
    fileId: string;
    knowledgeBaseId: string;
    knowledge: KnowledgeDocumentWriter;
    title?: string;
  }): { id: string; relativePath: string; title: string } {
    const file = this.get(input.conversationId, input.fileId);
    if (file.status !== 'ready') {
      throw conflict('这份文件还没有处理完，等它就绪后再保存到知识库');
    }

    const text = this.readExtractedText(input.conversationId, input.fileId);
    if (text === null) {
      throw badRequest(
        '这份文件没有可索引的文本内容（当前支持文本类文件），只能留在这个会话里作为附件',
      );
    }

    const relativePath = `promoted/${file.id}.md`;
    // 与知识库**同一个**判据：这里先判一次，用户拿到的是「存不进去，原因是什么」，
    // 而不是一次 400 之后还得自己猜。文件的正文没受影响，会话里照常可搜可下。
    const issue = documentPathIssue(relativePath, Buffer.byteLength(text, 'utf8'));
    if (issue) {
      throw badRequest(`这份文件的文本存不进知识库：${issue}。它仍然留在这个会话里。`);
    }

    return input.knowledge.writeDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.title?.trim() || file.originalName,
      relativePath,
      content: text,
      sourceUri: null,
    });
  }

  // -------------------------------------------------------------- 内部

  private requireRow(fileId: string): ConversationFileRow {
    const row = this.db
      .prepare('SELECT * FROM conversation_file WHERE id = ?')
      .get(fileId) as unknown as ConversationFileRow | undefined;
    if (!row) throw notFound('这份文件不存在');
    return row;
  }

  private assertQuota(conversationId: string): void {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM conversation_file
        WHERE conversation_id = ? AND status != 'deleted'
        `,
      )
      .get(conversationId) as unknown as { count: number };
    if (row.count >= this.options.maxFilesPerConversation) {
      throw conflict(
        `这个会话里的文件已经有 ${row.count} 份，达到上限；请先删掉一些不再需要的`,
      );
    }
  }
}

/** 去掉目录成分，并挡掉路径穿越。文件名最终会进磁盘路径，不能原样信它。 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').replace(/^\.+/, '');
  if (!cleaned) throw badRequest('文件名不能为空');
  if (cleaned.length > 200) throw badRequest('文件名太长了，请改短一点');
  return cleaned;
}

function extensionSuffix(name: string): string {
  const extension = extensionOf(name);
  return extension ? `.${extension}` : '';
}

function hashBuffer(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * 把用户输入翻成 FTS5 查询串。
 *
 * 直接拼进 MATCH 是危险的：`"` 不配对、`NEAR(` 没收尾都会让 fts5 抛语法错，
 * 而模型完全可以打出一段带引号的文本当查询。所以按空白切成词、每词加引号
 * （并去掉引号本身），得到的永远是合法查询。
 */
export function toFtsQuery(input: string): string {
  return input
    .split(/\s+/)
    .map((token) => token.replace(/["*()^:]/g, '').trim())
    .filter(Boolean)
    .map((token) => `"${token}"`)
    .join(' ');
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export function mapFile(row: ConversationFileRow): ConversationFile {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    teamId: row.team_id,
    uploadedBy: row.uploaded_by,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    storagePath: row.storage_path,
    contentHash: row.content_hash,
    extractionError: row.extraction_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
