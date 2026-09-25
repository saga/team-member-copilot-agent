import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../../config.js';
import { hashText } from '../../content-hash.js';
import { now } from '../../db.js';
import { badRequest, notFound, forbidden } from '../../http-error.js';
import type { CapabilityBinding } from '../../domain.js';
import type { CapabilityService } from '../service.js';
import type {
  CapabilityContext,
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeSearchHit,
  KnowledgeSource,
} from '../types.js';

/**
 * 本地文件系统 + SQLite FTS 的知识库 Provider。
 *
 * 它是**一个 Provider**，不再是「整个平台唯一的 Knowledge Service」：
 * 同一个 Registry 里可以同时注册 `snowflake.semantic-knowledge`、
 * `enterprise.search`，Member 用 binding 选自己用哪个。所以这个类里不允许出现
 * 「Member 应该用哪个后端」的判断 —— 那是 capability binding 的事。
 *
 *   正文     <teamKnowledgeRoot>/<key>/...        与 <memberHomeRoot>/<id>/knowledge/...
 *   索引     knowledge_base / knowledge_document / knowledge_document_fts
 *
 * 磁盘是正文 source of truth。`writeDocument()`（API 写入）与 `syncFromDisk()`
 * （扫描目录）是两条等价入口，靠 (kb, relative_path) 唯一键 + content_hash 幂等
 * 收敛。磁盘上删掉的文件不会自动从索引移除 —— 用 API 删，或接受幽灵索引
 * （重建数据目录时自然消失）。
 *
 * ── 权限 ──────────────────────────────────────────────────────────────
 *
 * ACL 的判据是 **member_capability_binding**（`hasKnowledgeBinding`），不是
 * 「这个库存不存在」。两处必须分别成立：
 *
 *   search   —— 检索被**限定在**这一个已授权的 KB 上（WHERE d.knowledge_base_id = ?），
 *               而不是搜完全库再过滤；两者的区别是后者会让未授权文档的 snippet
 *               先离开数据库再被丢掉
 *   open     —— documentRef 来自模型，**必须重新判一次**：先认证文档所属的 KB
 *               能不能看（personal 还要查属主），再去读文件
 *
 * 第二处是真正要紧的：`open` 是唯一一个「模型拿一个 id 就能要到内容」的入口。
 */
export class LocalFilesystemKnowledgeProvider implements KnowledgeProvider {
  readonly id = 'local.filesystem-knowledge';
  readonly version = '1';

  constructor(
    private readonly db: DatabaseSync,
    private readonly capabilities: CapabilityService,
  ) {}

  // ------------------------------------------------------------- Provider

  async listSources(context: CapabilityContext, binding: CapabilityBinding): Promise<KnowledgeSource[]> {
    const kb = this.baseForBinding(context.memberId, binding.selector ?? '');
    return [
      {
        providerId: this.id,
        id: kb.id,
        name: kb.name,
        description: kb.description,
        scope: kb.scope === 'personal' ? 'personal' : 'team',
      },
    ];
  }

  async search(
    context: CapabilityContext,
    binding: CapabilityBinding,
    query: string,
    limit: number,
  ): Promise<KnowledgeSearchHit[]> {
    const normalized = query.trim();
    if (!normalized) return [];

    const kb = this.baseForBinding(context.memberId, binding.selector ?? '');
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 8, 1), 12);

    const rows = this.db
      .prepare(
        `
        SELECT
          d.id AS document_id,
          d.title,
          d.source_uri,
          -- 列 -1 = 让 FTS5 自动选命中最多的列：命中在正文时摘正文，
          -- 只命中标题时摘标题，而不是拿不到高亮的另一列凑数
          snippet(knowledge_document_fts, -1, '<<', '>>', ' … ', 24) AS snippet
        FROM knowledge_document_fts f
        JOIN knowledge_document d ON d.id = f.document_id
        WHERE knowledge_document_fts MATCH ?
          AND d.knowledge_base_id = ?
        ORDER BY bm25(knowledge_document_fts)
        LIMIT ?
        `,
      )
      .all(toFtsQuery(normalized), kb.id, safeLimit) as unknown as Array<{
      document_id: string;
      title: string;
      source_uri: string | null;
      snippet: string;
    }>;

    return rows.map((row) => ({
      providerId: this.id,
      documentRef: row.document_id,
      sourceId: kb.id,
      sourceName: kb.name,
      title: row.title,
      snippet: row.snippet,
      citation: citationOf(kb.key, row.document_id),
      sourceUri: row.source_uri,
    }));
  }

  async open(context: CapabilityContext, documentRef: string): Promise<KnowledgeDocument> {
    const row = this.db
      .prepare(
        `
        SELECT
          d.*,
          kb.scope AS kb_scope,
          kb.key AS kb_key,
          kb.name AS kb_name,
          kb.member_id AS kb_member_id
        FROM knowledge_document d
        JOIN knowledge_base kb ON kb.id = d.knowledge_base_id
        WHERE d.id = ?
        `,
      )
      .get(documentRef) as unknown as
      | (KnowledgeDocumentRow & {
          kb_scope: KnowledgeBaseScope;
          kb_key: string;
          kb_name: string;
          kb_member_id: string | null;
        })
      | undefined;

    if (!row) {
      throw notFound(`Knowledge document 不存在：${documentRef}`);
    }

    const kb: KnowledgeBase = {
      id: row.knowledge_base_id,
      scope: row.kb_scope,
      key: row.kb_key,
      name: row.kb_name,
      description: '',
      memberId: row.kb_member_id,
      createdAt: '',
      updatedAt: '',
    };

    this.assertMemberCanAccess(context.memberId, kb);

    // DB 里存的 relative_path 当初写入时已过 safeSegment，读的时候仍走同一条
    // 校验路径 —— 双保险的成本是一行代码，收益是「DB 被手工改过」也不成立。
    const content = fs.readFileSync(this.resolveDocumentPath(kb, row.relative_path), 'utf8');

    return {
      providerId: this.id,
      documentRef: row.id,
      sourceId: kb.id,
      title: row.title,
      content,
      citation: citationOf(kb.key, row.id),
      sourceUri: row.source_uri,
    };
  }

  // ------------------------------------------------- 管理面（本地后端专有）

  get(id: string): KnowledgeBase {
    const row = this.db.prepare(`SELECT * FROM knowledge_base WHERE id = ?`).get(id) as unknown as
      | KnowledgeBaseRow
      | undefined;
    if (!row) throw notFound(`Knowledge Base 不存在：${id}`);
    return mapKnowledgeBase(row);
  }

  findByKey(scope: KnowledgeBaseScope, key: string): KnowledgeBase | null {
    const row = this.db
      .prepare(`SELECT * FROM knowledge_base WHERE scope = ? AND key = ?`)
      .get(scope, key) as unknown as KnowledgeBaseRow | undefined;
    return row ? mapKnowledgeBase(row) : null;
  }

  listTeamKnowledgeBases(): KnowledgeBase[] {
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_base WHERE scope = 'team' ORDER BY name`)
      .all() as unknown as KnowledgeBaseRow[];
    return rows.map(mapKnowledgeBase);
  }

  createTeamKnowledgeBase(input: { key: string; name: string; description?: string }): KnowledgeBase {
    const key = safeSegment(input.key);
    if (this.findByKey('team', key)) {
      throw badRequest(`team Knowledge Base 已存在：${key}`);
    }

    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_base (id, scope, key, name, description, member_id, created_at, updated_at)
        VALUES (?, 'team', ?, ?, ?, NULL, ?, ?)
        `,
      )
      .run(id, key, input.name.trim(), input.description?.trim() ?? '', timestamp, timestamp);

    const created = this.get(id);
    fs.mkdirSync(this.rootOf(created), { recursive: true });
    return created;
  }

  /**
   * personal KB 一人一个；存在即返回。
   *
   * 它的行是**索引锚点**（knowledge_document 需要 knowledge_base_id），所以必须
   * 存在；但它是幂等的，因此可以在读路径上补 —— 见 `baseForBinding`。不这样做
   * 的话，「刚建出来的 Member 搜不到自己的资料」只能靠重启修好。
   */
  ensurePersonalKnowledgeBase(memberId: string, memberName: string): KnowledgeBase {
    const existing = this.findByKey('personal', personalKeyOf(memberId));
    if (existing) return existing;

    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_base (id, scope, key, name, description, member_id, created_at, updated_at)
        VALUES (?, 'personal', ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        personalKeyOf(memberId),
        `${memberName} Personal Knowledge`,
        `Personal reference material for ${memberName}`,
        memberId,
        timestamp,
        timestamp,
      );

    const created = this.get(id);
    fs.mkdirSync(this.rootOf(created), { recursive: true });
    return created;
  }

  /**
   * 写一份文档：正文落盘 + 元数据与 FTS 索引进同一个事务。
   *
   * 落盘先于事务：文件写失败时 DB 不该知道这份文档；DB 失败时多出来的文件只是
   * 没被索引，下次同名写入会覆盖。两个世界没有一个共同事务，这个顺序是能选的
   * 最不坏的一种。
   */
  writeDocument(input: {
    knowledgeBaseId: string;
    title: string;
    relativePath: string;
    content: string;
    sourceUri?: string | null;
  }): KnowledgeDocumentRecord {
    const kb = this.get(input.knowledgeBaseId);
    const relativePath = input.relativePath.split('/').map(safeSegment).join('/');
    const contentHash = hashText(input.content);

    const target = this.resolveDocumentPath(kb, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.content, 'utf8');

    this.indexDocument({
      kb,
      relativePath,
      title: input.title,
      content: input.content,
      contentHash,
      sourceUri: input.sourceUri ?? null,
    });
    return this.requireDocumentByPath(kb.id, relativePath);
  }

  // ------------------------------------------------------- 磁盘同步（启动）

  /**
   * 扫描磁盘，把「目录即 KB、文件即文档」的世界收敛进索引：
   *
   *   <teamKnowledgeRoot>/<key>/**     → team KB（key = 目录名，缺行则建）
   *   <memberHomeRoot>/<id>/knowledge/ → 该 Member 的 personal KB
   *
   * 只增不改不删：已索引且 hash 相同的文件跳过，磁盘上消失的文件留在索引里。
   * 失败只影响那一个 KB，不让整个启动挂掉 —— 资料放错了格式不该拦住服务。
   */
  syncFromDisk(memberIds: string[]): { teamBases: number; personalBases: number; indexed: number } {
    let teamBases = 0;
    let personalBases = 0;
    let indexed = 0;

    if (fs.existsSync(config.teamKnowledgeRoot)) {
      for (const entry of fs.readdirSync(config.teamKnowledgeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        let kb = this.findByKey('team', entry.name);
        if (!kb) {
          try {
            kb = this.createTeamKnowledgeBase({ key: entry.name, name: entry.name });
            teamBases += 1;
          } catch (error) {
            warnSkip(entry.name, error);
            continue;
          }
        }
        indexed += this.indexDirectory(kb, this.rootOf(kb));
      }
    }

    for (const memberId of memberIds) {
      const personalRoot = path.join(config.memberHomeRoot, memberId, 'knowledge');
      if (!fs.existsSync(personalRoot)) continue;
      let kb: KnowledgeBase;
      try {
        kb = this.ensurePersonalKnowledgeBase(memberId, memberId);
      } catch (error) {
        warnSkip(memberId, error);
        continue;
      }
      const before = indexed;
      indexed += this.indexDirectory(kb, personalRoot);
      if (indexed > before) personalBases += 1;
    }

    return { teamBases, personalBases, indexed };
  }

  // ------------------------------------------------------------------ 内部

  /** selector → 能访问的 KB 行。所有检索/打开路径都必须先过这里。 */
  private baseForBinding(memberId: string, selector: string): KnowledgeBase {
    if (!selector) {
      throw badRequest(
        `knowledge binding 缺少 selector：不知道要指向哪个资料源（本地后端用 KB key 或 ${PERSONAL_SELECTOR}）`,
      );
    }

    if (selector === PERSONAL_SELECTOR) {
      const member = this.db
        .prepare(`SELECT name FROM member WHERE id = ?`)
        .get(memberId) as unknown as { name: string } | undefined;
      if (!member) throw notFound(`Member 不存在：${memberId}`);
      const kb = this.ensurePersonalKnowledgeBase(memberId, member.name);
      this.assertMemberCanAccess(memberId, kb);
      return kb;
    }

    const kb = this.findByKey('team', selector);
    if (!kb) {
      throw notFound(`Knowledge source 不存在：${selector}`);
    }
    this.assertMemberCanAccess(memberId, kb);
    return kb;
  }

  private assertMemberCanAccess(memberId: string, kb: KnowledgeBase): void {
    // personal 的属主判断不能省：`$personal` 这条 binding 每个 Member 都有，
    // 光看 binding 会让 A 打开 B 的个人资料。
    if (kb.scope === 'personal' && kb.memberId !== memberId) {
      throw forbidden('该 Member 没有访问这个 Knowledge Base 的权限');
    }

    const selector = kb.scope === 'personal' ? PERSONAL_SELECTOR : kb.key;
    if (!this.capabilities.hasKnowledgeBinding(memberId, this.id, selector)) {
      throw forbidden(`该 Member 未绑定 Knowledge source：${selector}`);
    }
  }

  /** KB 根目录之下递归索引所有文件（相对路径即文档路径，标题取文件名）。 */
  private indexDirectory(kb: KnowledgeBase, root: string): number {
    let count = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const relativePath = path.relative(root, full).split(path.sep).join('/');
        try {
          relativePath.split('/').forEach(safeSegment);
        } catch {
          warnSkip(`${kb.key}/${relativePath}`, new Error('路径含非法字符'));
          continue;
        }

        const content = fs.readFileSync(full, 'utf8');
        const contentHash = hashText(content);
        const existing = this.db
          .prepare(
            `SELECT id, content_hash FROM knowledge_document
             WHERE knowledge_base_id = ? AND relative_path = ?`,
          )
          .get(kb.id, relativePath) as unknown as { id: string; content_hash: string } | undefined;

        if (existing?.content_hash === contentHash) continue;

        try {
          this.indexDocument({
            kb,
            relativePath,
            title: path.basename(relativePath),
            content,
            contentHash,
            sourceUri: null,
          });
          count += 1;
        } catch (error) {
          warnSkip(`${kb.key}/${relativePath}`, error);
        }
      }
    };

    walk(root);
    return count;
  }

  /** 元数据 + FTS 索引的同写事务。正文落盘由调用方负责。 */
  private indexDocument(input: {
    kb: KnowledgeBase;
    relativePath: string;
    title: string;
    content: string;
    contentHash: string;
    sourceUri: string | null;
  }): void {
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `
          INSERT INTO knowledge_document (
            id, knowledge_base_id, title, relative_path, content_hash, source_uri, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(knowledge_base_id, relative_path)
          DO UPDATE SET
            title = excluded.title,
            content_hash = excluded.content_hash,
            source_uri = excluded.source_uri,
            updated_at = excluded.updated_at
          `,
        )
        .run(
          randomUUID(),
          input.kb.id,
          input.title.trim(),
          input.relativePath,
          input.contentHash,
          input.sourceUri,
          timestamp,
        );

      const documentId = this.requireDocumentByPath(input.kb.id, input.relativePath).id;
      this.db.prepare(`DELETE FROM knowledge_document_fts WHERE document_id = ?`).run(documentId);
      this.db
        .prepare(`INSERT INTO knowledge_document_fts (document_id, title, content) VALUES (?, ?, ?)`)
        .run(documentId, input.title.trim(), input.content);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireDocumentByPath(knowledgeBaseId: string, relativePath: string): KnowledgeDocumentRecord {
    const row = this.db
      .prepare(`SELECT * FROM knowledge_document WHERE knowledge_base_id = ? AND relative_path = ?`)
      .get(knowledgeBaseId, relativePath) as unknown as KnowledgeDocumentRow | undefined;
    if (!row) {
      throw new Error(`Knowledge document 索引丢失：${knowledgeBaseId}/${relativePath}`);
    }
    return mapDocument(row);
  }

  /** KB 的正文根目录。路径一律从这里拼，不存在第二条拼路径。 */
  private rootOf(kb: KnowledgeBase): string {
    if (kb.scope === 'team') {
      return path.join(config.teamKnowledgeRoot, kb.key);
    }
    if (!kb.memberId) {
      throw new Error(`personal Knowledge Base ${kb.id} 缺少 memberId`);
    }
    return path.join(config.memberHomeRoot, kb.memberId, 'knowledge');
  }

  private resolveDocumentPath(kb: KnowledgeBase, relativePath: string): string {
    const root = path.resolve(this.rootOf(kb));
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw badRequest('Knowledge document 路径越界');
    }
    return resolved;
  }
}

/** 本地后端里「这个 Member 自己的资料库」这个 selector 的写法。 */
export const PERSONAL_SELECTOR = '$personal';

export type KnowledgeBaseScope = 'team' | 'personal';

export interface KnowledgeBase {
  id: string;
  scope: KnowledgeBaseScope;
  /** 稳定的目录名 / 引用名。team KB 全局唯一；personal KB 固定为 member-<memberId>。 */
  key: string;
  name: string;
  description: string;
  /** personal KB 的属主；team KB 为 null。 */
  memberId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 本地后端的索引记录（正文在磁盘上）。 */
export interface KnowledgeDocumentRecord {
  id: string;
  knowledgeBaseId: string;
  title: string;
  /** 相对 KB 根目录的路径，也是 (kb, path) 唯一键。 */
  relativePath: string;
  /** 全文 sha256 —— 磁盘同步靠它跳过没变过的文件。 */
  contentHash: string;
  sourceUri: string | null;
  updatedAt: string;
}

interface KnowledgeBaseRow {
  id: string;
  scope: KnowledgeBaseScope;
  key: string;
  name: string;
  description: string;
  member_id: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeDocumentRow {
  id: string;
  knowledge_base_id: string;
  title: string;
  relative_path: string;
  content_hash: string;
  source_uri: string | null;
  updated_at: string;
}

function mapKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    name: row.name,
    description: row.description,
    memberId: row.member_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDocument(row: KnowledgeDocumentRow): KnowledgeDocumentRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    title: row.title,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    sourceUri: row.source_uri,
    updatedAt: row.updated_at,
  };
}

function personalKeyOf(memberId: string): string {
  return `member-${memberId}`;
}

/** KB key 与文档路径的每一段都过这道闸：白名单字符，杜绝 `..` 与分隔符注入。 */
function safeSegment(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw badRequest(`非法 knowledge base key/路径片段：${value}`);
  }
  return normalized;
}

/** FTS 的查询语法是注入面：token 一律加引号变成短语，内部引号翻倍转义。 */
function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(' OR ');
}

function citationOf(kbKey: string, documentId: string): string {
  return `[KB:${kbKey}/${documentId}]`;
}

function warnSkip(target: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[knowledge] 跳过 ${target}：${error instanceof Error ? error.message : String(error)}`,
  );
}
