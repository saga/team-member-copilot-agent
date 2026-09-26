import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hashText } from './content-hash.js';
import { now } from './db.js';
import type { Member } from './domain.js';

interface MemberRow {
  id: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  style: string;
  system_prompt: string;
  model: string | null;
  status: 'active' | 'archived';
  seed_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMemberInput {
  name: string;
  handle?: string;
  role: string;
  description?: string;
  style?: string;
  systemPrompt?: string;
  model?: string;
}

/**
 * Provisioning 元数据。**刻意不放进 `CreateMemberInput`** ——
 * 那个形状是 HTTP create schema 的来源，把 `seedKey` 放进去等于让它可被请求体设置，
 * 于是任何调用方都能自称「我是模板创建的那条」，把真正的模板行挤掉。
 */
export interface ProvisionMemberOptions {
  /** 这份 Member 来自哪份模板。唯一索引保证一个 key 只会落一次。 */
  seedKey?: string;
  /** 初始长期记忆。省略 = 留空（`# Long-term Memory`），与手工创建一致。 */
  initialMemory?: string;
}

export interface UpdateMemberInput {
  name?: string;
  handle?: string;
  role?: string;
  description?: string;
  style?: string;
  systemPrompt?: string;
  model?: string | null;
  status?: 'active' | 'archived';
}

function mapRow(row: MemberRow): Member {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    role: row.role,
    description: row.description,
    style: row.style,
    systemPrompt: row.system_prompt,
    model: row.model,
    status: row.status,
    seedKey: row.seed_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeHandle(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `member-${randomUUID().slice(0, 8)}`;
}

/** 记忆文件的一级标题；replaceMemory 用它保证文件里只有一个标题。 */
const MEMORY_TITLE = /^\s*#\s*Long-?term Memory\s*/i;

/**
 * 长期记忆的全文 + 版本。
 *
 * `version` 是全文的 sha256，不是 schema 版本：记忆没有字段级结构，能表达
 * 「这份内容和我上次读到的是不是同一份」的最小信息就是它自己的指纹。
 */
export interface MemberMemory {
  content: string;
  version: string;
}

/**
 * 长期 Member 身份。Member 是跨 conversation 稳定的业务对象，
 * 它的 SOUL / memory / skills 落在 member home，而不是任何 conversation 里。
 *
 * Skill 的安装 / 列举 / 删除**不在这里** —— 见 `skill-service.ts`。skill 内容
 * 投放有三个 scope（global / team / member），把它挂在「某个 Member」的服务上
 * 会让读代码的人以为 skill 是 Member 的属性。
 */
export class MemberService {
  constructor(private readonly db: DatabaseSync) {}

  list(): Member[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM member
        WHERE status = 'active'
        ORDER BY name
        `,
      )
      .all() as unknown as MemberRow[];
    return rows.map(mapRow);
  }

  get(id: string): Member {
    const row = this.db.prepare(`SELECT * FROM member WHERE id = ?`).get(id) as unknown as
      | MemberRow
      | undefined;
    if (!row) {
      throw Object.assign(new Error(`Member 不存在：${id}`), { status: 404 });
    }
    return mapRow(row);
  }

  /**
   * 按模板来源查 Member，**不过滤 status**。
   *
   * 归档的也要能找到，这是 provisioning 的关键：归档是用户明确表达过的意图
   * （「这个人我现在不用了」），如果查询只看 active，下一次启动会理直气壮地
   * 把它重新建出来 —— 用户每次重启都要再归档一次。
   */
  findBySeedKey(seedKey: string): Member | null {
    const row = this.db.prepare(`SELECT * FROM member WHERE seed_key = ?`).get(seedKey) as unknown as
      | MemberRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: CreateMemberInput, options: ProvisionMemberOptions = {}): Member {
    const id = randomUUID();
    const createdAt = now();

    const handle = this.resolveHandle(input.handle ?? input.name, id);

    const role = input.role.trim();

    this.db
      .prepare(
        `
        INSERT INTO member (
          id,
          handle,
          name,
          role,
          description,
          style,
          system_prompt,
          model,
          status,
          seed_key,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `,
      )
      .run(
        id,
        handle,
        input.name.trim(),
        role,
        input.description?.trim() ?? '',
        input.style?.trim() ?? '',
        input.systemPrompt?.trim() ?? '',
        input.model?.trim() || null,
        options.seedKey ?? null,
        createdAt,
        createdAt,
      );

    this.ensureHome(id);

    // ensureHome 已经写了空的记忆文件；初始记忆必须在这之后覆盖它，
    // 否则模板里的 MEMORY.md 会被那个默认值无声盖掉。
    if (options.initialMemory !== undefined) {
      this.replaceMemory(id, options.initialMemory);
    }

    const member = this.get(id);
    this.writeSoul(member);
    return member;
  }

  update(id: string, input: UpdateMemberInput): Member {
    const current = this.get(id);
    const next = {
      name: input.name ?? current.name,
      handle: input.handle === undefined ? current.handle : this.resolveHandle(input.handle, id),
      role: input.role ?? current.role,
      description: input.description ?? current.description,
      style: input.style ?? current.style,
      systemPrompt: input.systemPrompt ?? current.systemPrompt,
      model: input.model === undefined ? current.model : input.model?.trim() || null,
      status: input.status ?? current.status,
      updatedAt: now(),
    };

    this.db
      .prepare(
        `
        UPDATE member
        SET
          name = ?,
          handle = ?,
          role = ?,
          description = ?,
          style = ?,
          system_prompt = ?,
          model = ?,
          status = ?,
          updated_at = ?
        WHERE id = ?
        `,
      )
      .run(
        next.name,
        next.handle,
        next.role,
        next.description,
        next.style,
        next.systemPrompt,
        next.model,
        next.status,
        next.updatedAt,
        id,
      );

    const member = this.get(id);
    this.writeSoul(member);
    return member;
  }

  archive(id: string): void {
    this.update(id, { status: 'archived' });
  }

  homePath(memberId: string): string {
    return path.join(config.memberHomeRoot, memberId);
  }

  memoryPath(memberId: string): string {
    return path.join(this.homePath(memberId), 'memory', 'MEMORY.md');
  }

  readMemory(memberId: string): string {
    this.ensureHome(memberId);
    const file = this.memoryPath(memberId);
    if (!fs.existsSync(file)) return '';
    // 只回传尾部，避免长记忆把 system prompt 撑爆
    return fs.readFileSync(file, 'utf8').slice(-16000);
  }

  /**
   * 完整读取长期记忆（供 UI 编辑）。
   *
   * 和 readMemory() 的区别是**故意的**：那个是拼进 system prompt 用的，只给
   * 尾部 16000 字符；如果编辑器也用它，用户一保存就会把被截掉的前半段永久
   * 丢掉。改记忆必须看到全文。
   *
   * 一并返回 `version`：这是全文的 sha256，保存时带回来做乐观并发校验。
   */
  getMemory(memberId: string): MemberMemory {
    this.get(memberId);
    this.ensureHome(memberId);
    const content = fs.readFileSync(this.memoryPath(memberId), 'utf8');
    return { content, version: hashText(content) };
  }

  /**
   * 整体覆盖长期记忆。
   *
   * 两个入口会写同一个文件：人在这里编辑，Agent 在 turn 里调 remember_member。
   * 所以保存必须能发现「我读到的版本已经被改掉了」—— 否则用户保存的就是一份
   * 基于旧内容的全文覆盖，中间 Agent 记下的那一句会无声消失。
   *
   * `expectedVersion` 省略 = 不做校验（内部调用；以及明确想强制覆盖的场景）。
   * 不匹配时抛 409，并且**不写盘**。
   *
   * 文件恒定以 `# Long-term Memory` 开头：appendMemory 与 replaceMemory 都
   * 走这一个归一化，避免出现两个标题（UI 的文本框里显示的就是含标题的全文）。
   */
  replaceMemory(memberId: string, content: string, expectedVersion?: string): MemberMemory {
    this.get(memberId);
    this.ensureHome(memberId);

    const current = this.getMemory(memberId);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw Object.assign(
        new Error(
          '长期记忆已被其他地方修改（可能是 Agent 在干活时记下的，或另一个页面保存过）。' +
            '请重新加载后再保存，避免覆盖掉中间写入的内容。',
        ),
        { status: 409 },
      );
    }

    const body = content.replace(MEMORY_TITLE, '').trim();
    this.writeMemory(memberId, body ? `# Long-term Memory\n\n${body}\n` : '# Long-term Memory\n\n');
    return this.getMemory(memberId);
  }

  appendMemory(memberId: string, content: string): string {
    const member = this.get(memberId);
    this.ensureHome(member.id);
    const line = content.trim();
    if (!line) throw new Error('memory 内容不能为空');

    // 读-改-写而不是 appendFileSync：语义上仍然是「追加」，但落盘走同一个
    // 原子写路径，不会出现「文件被截断了一半」或者和 replaceMemory 的
    // temp→rename 交错的中间态。
    const current = fs.readFileSync(this.memoryPath(member.id), 'utf8');
    this.writeMemory(member.id, `${current}\n\n## ${new Date().toISOString()}\n\n${line}\n`);
    return `已保存到 ${member.name} 的长期记忆。`;
  }

  /**
   * 原子写入：先写同目录的临时文件并 fsync，再 rename 覆盖目标。
   *
   * 直接 `writeFileSync(target)` 在写到一半时崩溃（或断电）会留下一个被截断的
   * 文件 —— 对记忆文件来说就是「这个人格的一半记忆没了」，而且没有任何备份。
   * rename 在同一个目录内是原子的：读到的要么是旧全文，要么是新全文。
   */
  private writeMemory(memberId: string, content: string): void {
    const file = this.memoryPath(memberId);
    const temp = `${file}.${randomUUID()}.tmp`;

    try {
      const fd = fs.openSync(temp, 'w');
      try {
        fs.writeFileSync(fd, content, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  /**
   * handle 在 member 表上唯一（UI 里就是 @handle）。重名时加后缀而不是报错：
   * 用户改的是「这个 Member 是谁」，不该被一个显示名撞车卡住。
   */
  private resolveHandle(value: string, selfId: string): string {
    const base = normalizeHandle(value);
    const clash = this.db
      .prepare(`SELECT id FROM member WHERE handle = ? AND id <> ?`)
      .get(base, selfId) as unknown as { id: string } | undefined;
    return clash ? `${base}-${selfId.slice(0, 6)}` : base;
  }

  private ensureHome(memberId: string): void {
    const home = this.homePath(memberId);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.dirname(this.memoryPath(memberId)), { recursive: true });
    // skill 目录仍在这里兜底建：member home 的形状是 MemberService 的契约，
    // 即使 skill 的读写已经搬去 SkillService（见 skill-service.ts）。
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });

    const memoryFile = this.memoryPath(memberId);
    if (!fs.existsSync(memoryFile)) {
      fs.writeFileSync(memoryFile, '# Long-term Memory\n\n', 'utf8');
    }
  }

  private writeSoul(member: Member): void {
    const file = path.join(this.homePath(member.id), 'SOUL.md');
    const content = `# ${member.name}

## Role
${member.role}

## Description
${member.description}

## Style
${member.style}

## System Prompt
${member.systemPrompt}

## Authorization
Your role describes how you work. It does not grant authorization to access data,
execute privileged actions, approve requests, or bypass application policy.
`;
    fs.writeFileSync(file, content, 'utf8');
  }
}
