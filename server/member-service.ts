import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now } from './db.js';
import type { Member, ToolProfile } from './domain.js';

interface MemberRow {
  id: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  style: string;
  system_prompt: string;
  model: string | null;
  tool_profile: ToolProfile;
  status: 'active' | 'archived';
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
  toolProfile?: ToolProfile;
}

export interface UpdateMemberInput {
  name?: string;
  handle?: string;
  role?: string;
  description?: string;
  style?: string;
  systemPrompt?: string;
  model?: string | null;
  toolProfile?: ToolProfile;
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
    toolProfile: row.tool_profile,
    status: row.status,
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

  create(input: CreateMemberInput): Member {
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
          tool_profile,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
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
        input.toolProfile ?? 'safe',
        createdAt,
        createdAt,
      );

    this.ensureHome(id);
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
      toolProfile: input.toolProfile ?? current.toolProfile,
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
          tool_profile = ?,
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
        next.toolProfile,
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

  appendMemory(memberId: string, content: string): string {
    const member = this.get(memberId);
    this.ensureHome(member.id);
    const line = content.trim();
    if (!line) throw new Error('memory 内容不能为空');
    fs.appendFileSync(
      this.memoryPath(member.id),
      `\n\n## ${new Date().toISOString()}\n\n${line}\n`,
      'utf8',
    );
    return `已保存到 ${member.name} 的长期记忆。`;
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
