import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hashText } from './content-hash.js';
import { now } from './db.js';
import { badRequest, notFound, forbidden } from './http-error.js';
import type {
  KnowledgeBase,
  KnowledgeBaseScope,
  KnowledgeDocument,
  KnowledgeSearchHit,
  MemberKnowledgeProfile,
} from './domain.js';

/**
 * Knowledge Base 的存储与检索。回答「这个 Member 知道什么」：
 *
 *   Team KB      公司/团队的权威资料，显式绑定到 Member（中间表），不是全员共享
 *   Personal KB  Member 自己的资料库，一人一个（key 固定 member-<id>）
 *
 * 与 Memory 的分界：Memory 是「这个 Member 学到的动态事实」，小而常变，
 * 全文进 prompt；KB 是资料库，大而稳定，**只按需检索，永不全量进 prompt**。
 *
 * ── 权限 ──────────────────────────────────────────────────────────────
 *
 * ACL 在 SQL 的 WHERE 里完成（子查询圈定可见 KB），**不是先搜出来再过滤**。
 * 后者意味着权限检查发生在模型已经看到 snippet 之后 —— 对资料里包含客户、
 * 交易、控制措施的系统，那已经晚了一步。
 *
 * 检索结果是 untrusted content：文档正文可能藏指令（KB poisoning），
 * 返回值里带 instructions 字段 + system prompt 的 KB policy 双重声明，
 * 但真正的边界是「文档永远只是文本」，不在这层代码里。
 *
 * ── 磁盘与索引 ────────────────────────────────────────────────────────
 *
 * 文档正文在文件系统（<teamKnowledgeRoot>/<key>/... 与
 * <memberHomeRoot>/<id>/knowledge/...），SQLite 只存元数据 + FTS 索引。
 * 磁盘是正文 source of truth；syncFromDisk() 让「把文件放进去」和
 * 「POST 文档」成为两条等价的写入路径，靠 (kb, relative_path) 唯一键 +
 * content_hash 幂等收敛。磁盘上删掉的文件不会自动从索引移除 —— 用 API 删，
 * 或者接受幽灵索引（重建数据目录时自然消失）。
 */

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

function mapDocument(row: KnowledgeDocumentRow): KnowledgeDocument {
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

export class KnowledgeService {
  constructor(private readonly db: DatabaseSync) {}

  // ----------------------------------------------------------------- 查询

  get(id: string): KnowledgeBase {
    const row = this.db
      .prepare(`SELECT * FROM knowledge_base WHERE id = ?`)
      .get(id) as unknown as KnowledgeBaseRow | undefined;
    if (!row) {
      throw notFound(`Knowledge Base 不存在：${id}`);
    }
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

  /** 某 Member 视角下的 KB 清单。system prompt 的 KB policy 与检索 ACL 用同一个查询。 */
  listForMember(memberId: string): MemberKnowledgeProfile {
    const team = this.db
      .prepare(
        `
        SELECT kb.*
        FROM knowledge_base kb
        JOIN member_team_knowledge_base mt ON mt.knowledge_base_id = kb.id
        WHERE kb.scope = 'team' AND mt.member_id = ?
        ORDER BY kb.name
        `,
      )
      .all(memberId) as unknown as KnowledgeBaseRow[];

    const personal = this.db
      .prepare(
        `
        SELECT * FROM knowledge_base
        WHERE scope = 'personal' AND member_id = ?
        ORDER BY name
        `,
      )
      .all(memberId) as unknown as KnowledgeBaseRow[];

    return {
      teamKnowledgeBases: team.map(mapKnowledgeBase),
      personalKnowledgeBases: personal.map(mapKnowledgeBase),
    };
  }

  // ----------------------------------------------------------------- 写入

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

  /** personal KB 一人一个；存在即返回，不重建。Member 创建时调用。 */
  ensurePersonalKnowledgeBase(memberId: string, memberName: string): KnowledgeBase {
    const existing = this.findByKey('personal', `member-${memberId}`);
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
        `member-${memberId}`,
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

  /** 全量替换某 Member 的 team KB 绑定。传空数组 = 解绑全部。 */
  setTeamKnowledgeBases(memberId: string, knowledgeBaseIds: string[]): KnowledgeBase[] {
    const ids = [...new Set(knowledgeBaseIds)];
    for (const id of ids) {
      const kb = this.get(id);
      if (kb.scope !== 'team') {
        throw badRequest(`只能把 team Knowledge Base 绑定到 Member：${id}`);
      }
    }

    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM member_team_knowledge_base WHERE member_id = ?`).run(memberId);
      const insert = this.db.prepare(
        `INSERT INTO member_team_knowledge_base (member_id, knowledge_base_id, created_at)
         VALUES (?, ?, ?)`,
      );
      for (const id of ids) insert.run(memberId, id, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.listForMember(memberId).teamKnowledgeBases;
  }

  /**
   * 写一份文档：落盘 + 元数据 + 重建 FTS 索引，三者一个事务里收敛
   * （落盘先于事务：文件写失败时 DB 不该知道这份文档；DB 失败时多出来的
   * 文件只是没被索引，下次同名写入会覆盖）。
   */
  writeDocument(input: {
    knowledgeBaseId: string;
    title: string;
    relativePath: string;
    content: string;
    sourceUri?: string | null;
  }): KnowledgeDocument {
    const kb = this.get(input.knowledgeBaseId);
    const relativePath = input.relativePath
      .split('/')
      .map(safeSegment)
      .join('/');

    const contentHash = hashText(input.content);
    fs.mkdirSync(path.dirname(this.resolveDocumentPath(kb, relativePath)), { recursive: true });
    fs.writeFileSync(this.resolveDocumentPath(kb, relativePath), input.content, 'utf8');

    this.indexDocument({ kb, relativePath, title: input.title, content: input.content, contentHash, sourceUri: input.sourceUri ?? null });
    return this.requireDocumentByPath(kb.id, relativePath);
  }

  // ----------------------------------------------------------------- 检索

  searchTeam(memberId: string, query: string, limit = 8): KnowledgeSearchHit[] {
    return this.search(memberId, 'team', query, limit);
  }

  searchPersonal(memberId: string, query: string, limit = 8): KnowledgeSearchHit[] {
    return this.search(memberId, 'personal', query, limit);
  }

  /**
   * 读整份文档。documentId 来自模型（可能被提示词操纵），所以 ACL 检查在
   * 读文件**之前**，且以 DB 的归属为准 —— 拿 relativePath 自己拼路径是不行的。
   */
  getDocumentForMember(
    memberId: string,
    documentId: string,
  ): { document: KnowledgeDocument; content: string; citation: string } {
    const row = this.db
      .prepare(
        `
        SELECT d.*, kb.scope AS kb_scope, kb.key AS kb_key, kb.member_id AS kb_member_id
        FROM knowledge_document d
        JOIN knowledge_base kb ON kb.id = d.knowledge_base_id
        WHERE d.id = ?
        `,
      )
      .get(documentId) as unknown as
      | (KnowledgeDocumentRow & { kb_scope: KnowledgeBaseScope; kb_key: string; kb_member_id: string | null })
      | undefined;

    if (!row) {
      throw notFound(`Knowledge document 不存在：${documentId}`);
    }

    const kb: KnowledgeBase = {
      id: row.knowledge_base_id,
      scope: row.kb_scope,
      key: row.kb_key,
      name: '',
      description: '',
      memberId: row.kb_member_id,
      createdAt: '',
      updatedAt: '',
    };

    this.assertMemberCanAccess(memberId, kb);
    // DB 里存的 relative_path 当初写入时已过 safeSegment，读的时候仍走同一条
    // 校验路径 —— 双保险的成本是一行代码，收益是「DB 被手工改过」也不成立。
    const content = fs.readFileSync(this.resolveDocumentPath(kb, row.relative_path), 'utf8');

    return {
      document: mapDocument(row),
      content,
      citation: citationOf(kb.key, row.id),
    };
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

  // ------------------------------------------------------------------ ACL

  private assertMemberCanAccess(memberId: string, kb: KnowledgeBase): void {
    if (kb.scope === 'personal') {
      if (kb.memberId === memberId) return;
      throw forbidden('该 Member 没有访问这个 Knowledge Base 的权限');
    }

    const allowed = this.db
      .prepare(
        `SELECT 1 FROM member_team_knowledge_base
         WHERE member_id = ? AND knowledge_base_id = ?`,
      )
      .get(memberId, kb.id);
    if (!allowed) {
      throw forbidden('该 Member 没有访问这个 Knowledge Base 的权限');
    }
  }

  // ------------------------------------------------------------------ 内部

  private search(
    memberId: string,
    scope: KnowledgeBaseScope,
    query: string,
    limit: number,
  ): KnowledgeSearchHit[] {
    const normalized = query.trim();
    if (!normalized) return [];

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 8, 1), 12);
    const rows = this.db
      .prepare(
        `
        SELECT
          d.id AS document_id,
          d.knowledge_base_id,
          d.title,
          d.source_uri,
          kb.key AS kb_key,
          kb.name AS kb_name,
          kb.scope AS kb_scope,
          -- 列 -1 = 让 FTS5 自动选命中最多的列：命中在正文时摘正文，
          -- 只命中标题时摘标题，而不是拿不到高亮的另一列凑数
          snippet(knowledge_document_fts, -1, '<<', '>>', ' … ', 24) AS snippet
        FROM knowledge_document_fts f
        JOIN knowledge_document d ON d.id = f.document_id
        JOIN knowledge_base kb ON kb.id = d.knowledge_base_id
        WHERE knowledge_document_fts MATCH ?
          AND kb.scope = ?
          -- ACL 圈定在这一层：搜不到的 KB 连 snippet 都不会离开数据库
          AND d.knowledge_base_id IN (
            SELECT mt.knowledge_base_id
            FROM member_team_knowledge_base mt
            WHERE mt.member_id = ?
            UNION
            SELECT id FROM knowledge_base
            WHERE scope = 'personal' AND member_id = ?
          )
        ORDER BY bm25(knowledge_document_fts)
        LIMIT ?
        `,
      )
      .all(toFtsQuery(normalized), scope, memberId, memberId, safeLimit) as unknown as Array<{
      document_id: string;
      knowledge_base_id: string;
      title: string;
      source_uri: string | null;
      kb_key: string;
      kb_name: string;
      kb_scope: KnowledgeBaseScope;
      snippet: string;
    }>;

    return rows.map((row) => ({
      documentId: row.document_id,
      knowledgeBaseId: row.knowledge_base_id,
      knowledgeBaseName: row.kb_name,
      scope: row.kb_scope,
      title: row.title,
      snippet: row.snippet,
      citation: citationOf(row.kb_key, row.document_id),
      sourceUri: row.source_uri,
    }));
  }

  private requireDocumentByPath(knowledgeBaseId: string, relativePath: string): KnowledgeDocument {
    const row = this.db
      .prepare(
        `SELECT * FROM knowledge_document WHERE knowledge_base_id = ? AND relative_path = ?`,
      )
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

function citationOf(kbKey: string, documentId: string): string {
  return `[KB:${kbKey}/${documentId}]`;
}

function warnSkip(target: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[knowledge] 跳过 ${target}：${error instanceof Error ? error.message : String(error)}`,
  );
}
