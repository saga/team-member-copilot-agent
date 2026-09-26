import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

/**
 * Skill 内容的统一存储与安装。
 *
 * skill 是**目录**，不是数据库行：Copilot SDK 的 `skillDirectories` 直接扫文件
 * 系统，`<root>/<name>/SKILL.md` 就是它的全部契约。所以这里既没有表也没有同步
 * 逻辑 —— 磁盘就是 source of truth。
 *
 * 三个 scope 对应能力的三层，落盘位置也统一成同一棵树：
 *
 *   .data/global/skills/             公司级
 *   .data/team/skills/<teamId>/      Team 级
 *   .data/members/<memberId>/skills/ Member 级
 *
 * ── 为什么从 MemberService 里搬出来 ───────────────────────────────────
 *
 * skill 内容投放不再只属于 Member：global / team 也有自己的 skill 目录。留在
 * MemberService 里，就等于让「公司级 skill」这个概念挂在一个「某个 Member」的
 * 服务上 —— 读代码的人会以为 skill 是 Member 的属性。
 *
 * ── 安装是一个「把远端压缩包写进本地目录」的操作 ──────────────────────
 *
 * 所以它有三道闸，缺一不可：
 *
 *   1. 解压前看条目列表   绝对路径 / `..` 穿越 / 反斜杠 / 盘符一律拒绝
 *   2. 解压后遍历产物     文件数与总字节数上限，且**拒绝 symbolic link**
 *   3. 先解到暂存目录     校验通过才 rename 进目标；中途失败不留半个 skill
 *
 * 第 2 道是这次补上的：只有「压缩包 ≤ 25MB」这一条时，一个合法的 25MB zip
 * 解压后可以变成几 GB（zip bomb），或者用 symlink 把 workspace 之外的内容
 * 带进运行环境 —— 而 skill 目录是会被加载进 session 的。
 */
const SKILL_FILE = 'SKILL.md';

/** 解压后最多允许多少个文件。 */
const MAX_EXTRACTED_FILES = 2000;
/** 解压后总字节数上限（100 MiB）。 */
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;

export type SkillScope =
  | { kind: 'global' }
  | { kind: 'team'; teamId: string }
  | { kind: 'member'; memberId: string };

export interface SkillRecord {
  name: string;
  description: string;
  fileCount: number;
  updatedAt: string;
}

export class SkillService {
  constructor(private readonly db: DatabaseSync) {}

  list(scope: SkillScope): SkillRecord[] {
    const root = this.rootFor(scope);
    fs.mkdirSync(root, { recursive: true });

    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => this.describeSkill(root, entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  install(scope: SkillScope, archive: Buffer, filename: string): SkillRecord {
    const root = this.rootFor(scope);
    fs.mkdirSync(root, { recursive: true });
    requireUnzip();

    // zip 的本地文件头是 PK\x03\x04（空归档是 PK\x05\x06），先挡掉明显不是 zip 的
    if (archive.length < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b) {
      throw Object.assign(new Error('不是合法的 zip 文件（缺少 PK 头）'), { status: 400 });
    }

    // 暂存目录刻意放在**同一个 skills 根目录下**（以 `.` 开头，会被 list 跳过）：
    // rename 只有在同一个文件系统内才是原子的，跨设备会退化成 copy+delete。
    const staging = path.join(root, `.install-${randomUUID()}`);
    const zipPath = `${staging}.zip`;

    try {
      fs.writeFileSync(zipPath, archive);
      assertZipEntriesSafe(zipPath);
      fs.mkdirSync(staging, { recursive: true });
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', staging]);
      assertExtractedTreeSafe(staging);

      // 习惯上 zip 里包一层同名目录；只有一层目录时就用它，否则以压缩包名兜底
      const entries = fs.readdirSync(staging, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
      const onlyDirectory =
        entries.length === 1 && entries[0].isDirectory() ? entries[0].name : null;

      const name = assertSafeSkillName(onlyDirectory ?? filename);
      const source = onlyDirectory ? path.join(staging, onlyDirectory) : staging;

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
      return this.describeSkill(root, name);
    } finally {
      // 成功后 source 已经被 rename 走，这里只是清掉暂存与压缩包
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
    }
  }

  remove(scope: SkillScope, name: string): void {
    const root = this.rootFor(scope);
    fs.mkdirSync(root, { recursive: true });

    const safe = assertSafeSkillName(name);
    const directory = path.join(root, safe);

    if (!fs.existsSync(directory)) {
      throw Object.assign(new Error(`Skill 不存在：${safe}`), { status: 404 });
    }

    fs.rmSync(directory, { recursive: true, force: true });
  }

  /**
   * scope → 磁盘根目录。所有路径都从这里拼，不存在第二条拼路径。
   *
   * team / member 两种 scope 会先确认目标存在：给一个不存在的 teamId 建目录，
   * 会留下一棵永远不会被任何 Provider 读到的空树 —— 而调用方拿到的是 201。
   */
  rootFor(scope: SkillScope): string {
    switch (scope.kind) {
      case 'global':
        return config.globalSkillRoot;
      case 'team':
        this.assertTeam(scope.teamId);
        return path.join(config.teamSkillRoot, scope.teamId);
      case 'member':
        this.assertMember(scope.memberId);
        return path.join(config.memberHomeRoot, scope.memberId, 'skills');
    }
  }

  private assertTeam(teamId: string): void {
    const row = this.db.prepare(`SELECT 1 FROM team WHERE id = ?`).get(teamId);
    if (!row) {
      throw Object.assign(new Error(`Team 不存在：${teamId}`), { status: 404 });
    }
  }

  private assertMember(memberId: string): void {
    const row = this.db.prepare(`SELECT 1 FROM member WHERE id = ?`).get(memberId);
    if (!row) {
      throw Object.assign(new Error(`Member 不存在：${memberId}`), { status: 404 });
    }
  }

  private describeSkill(root: string, name: string): SkillRecord {
    const directory = path.join(root, name);
    const skillFile = path.join(directory, SKILL_FILE);
    const hasSkillFile = fs.existsSync(skillFile);

    return {
      name,
      description: hasSkillFile ? readSkillDescription(skillFile) : '',
      fileCount: countFiles(directory),
      updatedAt: (hasSkillFile ? fs.statSync(skillFile) : fs.statSync(directory)).mtime.toISOString(),
    };
  }
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
 * 用户目录」的操作，越界的后果是往 skills 目录外面写文件。
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

/**
 * 解压后的产物体检：文件数 / 总字节数上限，以及**拒绝 symbolic link**。
 *
 * 只看「压缩包多大」是不够的：压缩比可以极高，一个 25MB 的 zip 解出来几 GB 是
 * 常规的 zip bomb 手法。symlink 更直接 —— 一个指向 `/etc` 或 workspace 之外的
 * 链接，会让 skill 在加载时把宿主机的文件当成自己的内容读进来。
 *
 * 用 `lstatSync` 而不是 `statSync`：后者会跟随链接，于是链接本身永远看起来是
 * 一个普通文件/目录，检查形同不存在。
 */
function assertExtractedTreeSafe(root: string): void {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);

      if (stat.isSymbolicLink()) {
        throw Object.assign(
          new Error(`skill zip 不允许 symbolic link：${entry.name}`),
          { status: 400 },
        );
      }

      if (stat.isDirectory()) {
        walk(full);
        continue;
      }

      if (!stat.isFile()) {
        throw Object.assign(
          new Error(`skill zip 包含不支持的文件类型：${entry.name}`),
          { status: 400 },
        );
      }

      fileCount += 1;
      totalBytes += stat.size;

      if (fileCount > MAX_EXTRACTED_FILES) {
        throw Object.assign(
          new Error(`skill zip 解压后文件数超过 ${MAX_EXTRACTED_FILES}`),
          { status: 400 },
        );
      }

      if (totalBytes > MAX_EXTRACTED_BYTES) {
        throw Object.assign(
          new Error(`skill zip 解压后总大小超过 ${MAX_EXTRACTED_BYTES} bytes`),
          { status: 400 },
        );
      }
    }
  };

  walk(root);
}

function countFiles(directory: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(directory, entry.name));
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

/** 安装 skill 依赖系统 unzip；缺失时给一个能看懂的 501，而不是 ENOENT。 */
function requireUnzip(): void {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    throw Object.assign(
      new Error('安装 skill 需要系统提供 unzip，当前环境找不到该命令'),
      { status: 501 },
    );
  }
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
