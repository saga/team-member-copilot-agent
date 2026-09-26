import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.js';
import {
  appendGlobalMemory,
  appendTeamMemory,
  ensureMemberHome,
  getGlobalMemory,
  getTeamMemory,
  memberHomeDir,
  globalMemoryFile,
  readGlobalMemory,
  readTeamMemory,
  replaceGlobalMemory,
  replaceTeamMemory,
  teamMemoryFile,
  type MemoryDocument,
} from './member-memory.js';
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

/** 记忆文件的一级标题由 member-memory.ts 归一化，这里只透出它的文档形状。 */
export interface MemberMemory extends MemoryDocument {}

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
    return memberHomeDir(memberId);
  }

  memoryPath(memberId: string): string {
    return globalMemoryFile(memberId);
  }

  teamMemoryPath(memberId: string, teamId: string): string {
    return teamMemoryFile(memberId, teamId);
  }

  /**
   * 给 prompt 用的全局记忆尾部。Team 上下文不在这里 —— 它随 Team 变化，
   * 由调用方按当前 conversation 的 teamId 另取并分段注入。
   */
  readMemory(memberId: string): string {
    this.get(memberId);
    return readGlobalMemory(memberId);
  }

  /** 给 prompt 用的 Team 上下文尾部；换 Team 就换一份，不会泄漏到别的 Team。 */
  readTeamMemory(memberId: string, teamId: string): string {
    this.get(memberId);
    return readTeamMemory(memberId, teamId);
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
    return getGlobalMemory(memberId);
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
    return replaceGlobalMemory(memberId, content, expectedVersion);
  }

  appendMemory(memberId: string, content: string): string {
    const member = this.get(memberId);
    appendGlobalMemory(member.id, content);
    return `已保存到 ${member.name} 的长期记忆。`;
  }

  /**
   * 只属于某一个 Team 的上下文（工作方式、成员关系、项目事实）。
   *
   * 和全局记忆共用同一套文件语义（全文 + 版本 + 409），只是落盘位置不同。
   * Team 是否存在由 TeamService 守，这里只管文件。
   */
  getTeamMemory(memberId: string, teamId: string): MemberMemory {
    this.get(memberId);
    return getTeamMemory(memberId, teamId);
  }

  replaceTeamMemory(
    memberId: string,
    teamId: string,
    content: string,
    expectedVersion?: string,
  ): MemberMemory {
    this.get(memberId);
    return replaceTeamMemory(memberId, teamId, content, expectedVersion);
  }

  appendTeamMemory(memberId: string, teamId: string, content: string): string {
    const member = this.get(memberId);
    appendTeamMemory(member.id, teamId, content);
    return `已保存到 ${member.name} 在这个 Team 的上下文。`;
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
    ensureMemberHome(memberId);
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
