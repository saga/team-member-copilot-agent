import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { hashText } from './content-hash.js';

/**
 * Member 长期记忆的文件层。
 *
 * 一个 Member 只有**一份**记忆：`.data/members/<id>/memory/MEMORY.md`。
 * 它描述的是「这个人知道什么」，跨 Conversation 稳定 —— 不按房间、也不按 Team
 * 分片。分片会带来两个说不清的问题：同一个事实要在哪一份里记；以及改一次
 * Team 归属之后，之前记下的东西还在不在。
 *
 * 不进数据库：记忆是自然语言文本，用户会想直接看 / 直接改，一个文件比一张
 * 两列表更好用。
 */

export interface MemoryDocument {
  content: string;
  /** 全文 sha256，不是 schema 版本：回答「和我上次读到的是不是同一份」。 */
  version: string;
}

const TITLE = /^\s*#\s*Long-?term Memory\s*/i;
const TITLE_LINE = '# Long-term Memory';
const SEED = `${TITLE_LINE}\n\n`;

/** 拼进 system prompt 的截断长度：全文用于编辑，尾部用于注入。 */
const PROMPT_TAIL_CHARS = 16000;

export function memberHomeDir(memberId: string): string {
  return path.join(config.memberHomeRoot, memberId);
}

export function globalMemoryFile(memberId: string): string {
  return path.join(memberHomeDir(memberId), 'memory', 'MEMORY.md');
}

/**
 * 建 member home 的目录形状。skill 目录也在这里兜底建：home 的形状是统一的
 * 契约，即使 skill 的读写已经搬去 SkillService。
 */
export function ensureMemberHome(memberId: string): void {
  const home = memberHomeDir(memberId);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.dirname(globalMemoryFile(memberId)), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  ensureDocument(globalMemoryFile(memberId), SEED);
}

function ensureDocument(file: string, seed: string): void {
  if (!fs.existsSync(file)) fs.writeFileSync(file, seed, 'utf8');
}

function readDocument(file: string): MemoryDocument {
  const content = fs.readFileSync(file, 'utf8');
  return { content, version: hashText(content) };
}

/** 拼 prompt 用的尾部：长记忆不能把 system prompt 撑爆。 */
function readTail(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').slice(-PROMPT_TAIL_CHARS);
}

/**
 * 原子写入：先写同目录临时文件并 fsync，再 rename 覆盖。
 *
 * 直接写目标文件会在写到一半崩溃时留下一个被截断的文件 —— 对记忆文件来说
 * 就是「这个人格的一半记忆没了」，而且没有任何备份。rename 在同一目录内是
 * 原子的：读到的要么是旧全文，要么是新全文。
 */
function writeDocument(file: string, content: string): void {
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

/** 全文带版本冲突校验的覆盖；不匹配抛 409 且不写盘。 */
function replaceDocument(file: string, content: string, expectedVersion?: string): MemoryDocument {
  ensureDocument(file, SEED);
  if (expectedVersion !== undefined) {
    const current = readDocument(file);
    if (expectedVersion !== current.version) {
      throw Object.assign(
        new Error(
          '这份记忆已被其他地方修改（可能是 Agent 在干活时记下的，或另一个页面保存过）。' +
            '请重新加载后再保存，避免覆盖掉中间写入的内容。',
        ),
        { status: 409 },
      );
    }
  }
  const body = content.replace(TITLE, '').trim();
  writeDocument(file, body ? `${TITLE_LINE}\n\n${body}\n` : `${TITLE_LINE}\n\n`);
  return readDocument(file);
}

/** 追加一条带时间戳的记录；读-改-写走同一个原子写路径。 */
function appendDocument(file: string, content: string): void {
  ensureDocument(file, SEED);
  const line = content.trim();
  if (!line) throw new Error('memory 内容不能为空');
  const current = fs.readFileSync(file, 'utf8');
  writeDocument(file, `${current}\n\n## ${new Date().toISOString()}\n\n${line}\n`);
}

export function readGlobalMemory(memberId: string): string {
  ensureMemberHome(memberId);
  return readTail(globalMemoryFile(memberId));
}

export function getGlobalMemory(memberId: string): MemoryDocument {
  ensureMemberHome(memberId);
  return readDocument(globalMemoryFile(memberId));
}

export function replaceGlobalMemory(
  memberId: string,
  content: string,
  expectedVersion?: string,
): MemoryDocument {
  ensureMemberHome(memberId);
  return replaceDocument(globalMemoryFile(memberId), content, expectedVersion);
}

export function appendGlobalMemory(memberId: string, content: string): void {
  ensureMemberHome(memberId);
  appendDocument(globalMemoryFile(memberId), content);
}
