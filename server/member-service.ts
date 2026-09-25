import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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

/** Skill 目录里必须有这个文件，Copilot SDK 靠它发现并加载 skill。 */
const SKILL_FILE = 'SKILL.md';

/**
 * 一个 Member 自己的 skill。
 *
 * skill 是**目录**，不是数据库行：Copilot SDK 的 `skillDirectories` 直接扫
 * 文件系统，`<member home>/skills/<name>/SKILL.md` 就是它的全部契约。
 * 所以这里既没有表也没有同步逻辑 —— 磁盘就是 source of truth。
 */
export interface MemberSkill {
  name: string;
  description: string;
  fileCount: number;
  updatedAt: string;
}

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

/** 目录名 / skill 名必须是单个安全路径段。 */
function assertSafeSkillName(value: string): string {
  const name = value.trim().replace(/\.zip$/i, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw Object.assign(new Error(`非法的 skill 名：${value}`), { status: 400 });
  }
  return name;
}

/**
 * 解压前先看条目列表，拦掉绝对路径与 `..` 穿越。
 *
 * 现代 unzip 自己也会拦，但不能依赖实现版本：这是一次「把远端来的压缩包写进
 * 用户 home」的操作，越界的后果是往 skills 目录外面写文件。
 */
function assertZipEntriesSafe(zipPath: string): void {
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });

  for (const raw of listing.split('\n')) {
    const entry = raw.trim();
    if (!entry) continue;

    if (entry.startsWith('/') || entry.includes('\\') || /^[A-Za-z]:/.test(entry)) {
      throw Object.assign(new Error(`zip 里有绝对路径条目：${entry}`), { status: 400 });
    }
    if (entry.split('/').includes('..')) {
      throw Object.assign(new Error(`zip 里有路径穿越条目：${entry}`), { status: 400 });
    }
  }
}

let unzipChecked = false;

/** 安装 skill 依赖系统 unzip；缺失时给一个能看懂的 501，而不是 ENOENT。 */
function requireUnzip(): void {
  if (unzipChecked) return;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    throw Object.assign(
      new Error('安装 skill 需要系统提供 unzip，当前环境找不到该命令'),
      { status: 501 },
    );
  }
  unzipChecked = true;
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * 从 SKILL.md 里取一句描述。
 *
 * 优先 YAML frontmatter 的 `description:`（skill 的标准写法），否则退回到
 * 一级标题之后的第一段正文。都是纯文本启发式 —— 它只是列表里的一行说明，
 * 不值得为它引入一个 YAML parser。
 */
function readSkillDescription(skillFile: string): string {
  const text = fs.readFileSync(skillFile, 'utf8');

  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter) {
    const line = frontmatter[1]
      .split(/\r?\n/)
      .find((row) => /^\s*description\s*:/i.test(row));
    if (line) {
      return line
        .replace(/^\s*description\s*:/i, '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .slice(0, 200);
    }
  }

  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  const paragraph = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));

  return (paragraph ?? '').slice(0, 200);
}

/**
 * 长期 Member 身份。Member 是跨 conversation 稳定的业务对象，
 * 它的 SOUL / memory / skills 落在 member home，而不是任何 conversation 里。
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

  skillsPath(memberId: string): string {
    return path.join(this.homePath(memberId), 'skills');
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

  // ----------------------------------------------------------------- skills

  /**
   * 列出这个 Member 已安装的 skill。
   *
   * 只认目录，且跳过 `.` 开头的（包括安装过程中的 staging 目录）。
   */
  listSkills(memberId: string): MemberSkill[] {
    this.get(memberId);
    this.ensureHome(memberId);

    return fs
      .readdirSync(this.skillsPath(memberId), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => this.describeSkill(memberId, entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 安装 skill（zip）。
   *
   * 流程刻意是「先解到暂存目录 → 校验 → 再 rename 进 skills/」：
   * 直接解到目标目录的话，中途失败会留下半个 skill，而 `skillDirectories`
   * 会把它当成一个真的 skill 加载进 Copilot session。
   */
  installSkill(memberId: string, archive: Buffer, filename: string): MemberSkill {
    this.get(memberId);
    this.ensureHome(memberId);
    requireUnzip();

    // zip 的本地文件头是 PK\x03\x04（空归档是 PK\x05\x06），先挡掉明显不是 zip 的
    if (archive.length < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b) {
      throw Object.assign(new Error('不是合法的 zip 文件（缺少 PK 头）'), { status: 400 });
    }

    const root = this.skillsPath(memberId);
    const staging = path.join(root, `.install-${randomUUID()}`);
    const zipPath = `${staging}.zip`;

    try {
      fs.writeFileSync(zipPath, archive);
      assertZipEntriesSafe(zipPath);
      fs.mkdirSync(staging, { recursive: true });
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', staging]);

      // 习惯上 zip 里包一层同名目录；只有一层目录时就用它，否则以压缩包名兜底
      const entries = fs.readdirSync(staging, { withFileTypes: true });
      const only = entries.length === 1 && entries[0].isDirectory() ? entries[0].name : null;

      const name = assertSafeSkillName(only ?? filename);
      const source = only ? path.join(staging, only) : staging;

      if (!fs.existsSync(path.join(source, SKILL_FILE))) {
        throw Object.assign(
          new Error(`zip 里没有 ${SKILL_FILE}，这不是一份有效的 skill`),
          { status: 400 },
        );
      }

      const target = path.join(root, name);
      if (fs.existsSync(target)) {
        throw Object.assign(new Error(`Skill ${name} 已存在`), { status: 409 });
      }

      fs.renameSync(source, target);
      return this.describeSkill(memberId, name);
    } finally {
      // 成功后 source 已经被 rename 走，这里只是清掉暂存与压缩包
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
    }
  }

  removeSkill(memberId: string, name: string): void {
    this.get(memberId);
    this.ensureHome(memberId);

    const safe = assertSafeSkillName(name);
    const dir = path.join(this.skillsPath(memberId), safe);
    if (!fs.existsSync(dir)) {
      throw Object.assign(new Error(`Skill 不存在：${safe}`), { status: 404 });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private describeSkill(memberId: string, name: string): MemberSkill {
    const dir = path.join(this.skillsPath(memberId), name);
    const skillFile = path.join(dir, SKILL_FILE);
    const hasSkillFile = fs.existsSync(skillFile);

    return {
      name,
      description: hasSkillFile ? readSkillDescription(skillFile) : '',
      fileCount: countFiles(dir),
      updatedAt: (hasSkillFile ? fs.statSync(skillFile) : fs.statSync(dir)).mtime.toISOString(),
    };
  }

  private ensureHome(memberId: string): void {
    const home = this.homePath(memberId);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.dirname(this.memoryPath(memberId)), { recursive: true });
    fs.mkdirSync(this.skillsPath(memberId), { recursive: true });

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
