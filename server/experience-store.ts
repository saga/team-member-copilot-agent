import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export type ExperienceKind = 'success' | 'failure' | 'user_feedback' | 'preference' | 'strategy';

export interface ExperienceRecord {
  id: string;
  memberId: string;
  teamId: string;
  kind: ExperienceKind;
  /**
   * 什么情况下值得使用这条经验。
   * 例：jira story existing subtasks / compliance review。
   */
  trigger: string;
  /** 真正可以复用的工作方法，而不是事件流水账。 */
  lesson: string;
  /** 原始反馈/背景，可选。 */
  evidence?: string | null;
  /**
   * 经验作用域：member = 只给这个 Member，team = Team 内共享。
   */
  scope: 'member' | 'team';
  confidence: number;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

const MAX_EXPERIENCES = 500;
const MAX_RESULTS = 5;

/**
 * 可检索的工作经验库：`反馈 → 经验 → 检索 → 行为改变` 的中间两环。
 *
 * 刻意用 JSONL 文件而不是数据库表：它是 append 为主、人类可读、可重建的
 * 非事务核心状态，和 MEMORY.md 同一类东西。需要统计、embedding、reward
 * 时再迁 SQLite —— 现在不需要。
 *
 * 落盘位置 `.data/experiences/<teamId>/experiences.jsonl`，和 member home
 * 同一级：经验属于 Team（或 Team 里的某个人），不属于某次 conversation。
 */
export class ExperienceStore {
  constructor(private readonly root: string = path.join(config.memberHomeRoot, '..', 'experiences')) {}

  add(input: {
    memberId: string;
    teamId: string;
    kind: ExperienceKind;
    trigger: string;
    lesson: string;
    evidence?: string | null;
    scope?: 'member' | 'team';
    confidence?: number;
  }): ExperienceRecord {
    const trigger = normalize(input.trigger);
    const lesson = normalize(input.lesson);
    if (!trigger) throw new Error('Experience trigger 不能为空');
    if (!lesson) throw new Error('Experience lesson 不能为空');

    const record: ExperienceRecord = {
      id: randomUUID(),
      memberId: input.memberId,
      teamId: input.teamId,
      kind: input.kind,
      trigger: trigger.slice(0, 1000),
      lesson: lesson.slice(0, 4000),
      evidence: input.evidence ? normalize(input.evidence).slice(0, 4000) : null,
      scope: input.scope ?? 'team',
      confidence: clamp(input.confidence ?? 0.8, 0, 1),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
    };

    const file = this.fileFor(input.teamId);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 简单去重：同一 Team + trigger + lesson 不重复写。
    const existing = this.readAll(input.teamId).find(
      (item) =>
        normalize(item.trigger) === trigger &&
        normalize(item.lesson) === lesson &&
        (item.scope === 'team' || item.memberId === input.memberId),
    );
    if (existing) {
      return existing;
    }

    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    this.compactIfNeeded(input.teamId);
    return record;
  }

  search(input: {
    memberId: string;
    teamId: string;
    query: string;
    limit?: number;
  }): ExperienceRecord[] {
    const queryTokens = tokenize(input.query);
    if (queryTokens.size === 0) return [];

    const records = this.readAll(input.teamId)
      .filter((item) => item.scope === 'team' || item.memberId === input.memberId)
      .map((item) => ({ item, score: scoreExperience(item, queryTokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt))
      .slice(0, Math.min(input.limit ?? MAX_RESULTS, MAX_RESULTS))
      .map((item) => item.item);

    if (records.length > 0) {
      this.markUsed(records);
    }
    return records;
  }

  private markUsed(records: ExperienceRecord[]): void {
    const ids = new Set(records.map((item) => item.id));
    if (ids.size === 0) return;

    for (const teamId of new Set(records.map((item) => item.teamId))) {
      const all = this.readAll(teamId);
      let changed = false;
      const next = all.map((item) => {
        if (!ids.has(item.id)) return item;
        changed = true;
        return { ...item, lastUsedAt: new Date().toISOString(), useCount: item.useCount + 1 };
      });
      if (changed) {
        this.writeAll(teamId, next);
      }
    }
  }

  private readAll(teamId: string): ExperienceRecord[] {
    const file = this.fileFor(teamId);
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const result: ExperienceRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ExperienceRecord;
        if (parsed && typeof parsed.id === 'string' && typeof parsed.teamId === 'string' && typeof parsed.lesson === 'string') {
          result.push(parsed);
        }
      } catch {
        // 一条坏行不能断掉整库的检索：跳过它。
      }
    }
    return result;
  }

  private writeAll(teamId: string, records: ExperienceRecord[]): void {
    const file = this.fileFor(teamId);
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名：读到一半文件是旧的完整版，不会读到写一半的。
    fs.writeFileSync(temp, records.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
    fs.renameSync(temp, file);
  }

  private compactIfNeeded(teamId: string): void {
    const records = this.readAll(teamId);
    if (records.length <= MAX_EXPERIENCES) return;

    // 淘汰分 = 使用次数 + 置信度：高频用、没被纠正的留下，长期不用的走。
    // 后续要做 utility（success/failure 计数）时，分母就是这几个字段。
    const sorted = [...records].sort((a, b) => b.useCount + b.confidence - (a.useCount + a.confidence));
    this.writeAll(teamId, sorted.slice(0, MAX_EXPERIENCES));
  }

  private fileFor(teamId: string): string {
    return path.join(this.root, teamId, 'experiences.jsonl');
  }
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 关键词检索：中文按字词切分天然困难，所以只做大小写归一 + 标点切分 + 短词过滤。 */
function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .split(/\s+/)
      .filter((item) => item.length >= 2),
  );
}

function scoreExperience(experience: ExperienceRecord, queryTokens: Set<string>): number {
  const triggerTokens = tokenize(experience.trigger);
  const lessonTokens = tokenize(experience.lesson);

  let score = 0;
  for (const token of queryTokens) {
    if (triggerTokens.has(token)) score += 5;
    else if (lessonTokens.has(token)) score += 2;
  }

  // 高置信度 + 曾经被使用过的经验轻微加权。
  score *= 1 + experience.confidence * 0.2;
  score += Math.min(experience.useCount, 5) * 0.1;
  return score;
}
