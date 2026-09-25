import type { DatabaseSync } from 'node:sqlite';
import { now } from '../db.js';
import type { CapabilityBinding, MemberCapabilities } from '../domain.js';

type CapabilityType = 'skill' | 'knowledge' | 'tool';

interface BindingRow {
  capability_type: CapabilityType;
  provider_id: string;
  selector: string;
}

/**
 * Member 的能力组成的读写。
 *
 * 一张表三列就够：`(member, 类型, provider, selector)`。刻意**不给三类能力各建
 * 一张表** —— 它们在这一层的形状完全一样，拆成三张只会让「列出这个 Member 的
 * 全部能力」变成三次查询加一次手工合并。
 *
 * ── selector 用 '' 而不是 NULL ────────────────────────────────────────
 *
 * 主键里带 `selector`，而 SQLite 的主键/唯一约束把 NULL 视为互不相等 ——
 * 用 NULL 表示「空 selector」会让同一个 (member, skill, provider) 能插进无限
 * 多行。空字符串没有这个问题，唯一性约束照常成立。
 */
export class CapabilityService {
  constructor(private readonly db: DatabaseSync) {}

  get(memberId: string): MemberCapabilities {
    const rows = this.db
      .prepare(
        `
        SELECT capability_type, provider_id, selector
        FROM member_capability_binding
        WHERE member_id = ?
        ORDER BY capability_type, provider_id, selector
        `,
      )
      .all(memberId) as unknown as BindingRow[];

    return {
      skills: rows.filter((row) => row.capability_type === 'skill').map(toBinding),
      knowledge: rows.filter((row) => row.capability_type === 'knowledge').map(toBinding),
      tools: rows.filter((row) => row.capability_type === 'tool').map(toBinding),
    };
  }

  /**
   * 全量替换。空数组 = 这一类能力全部解绑。
   *
   * 替换与 `member.updated_at` 的推进在同一个事务里：能力是 Member 配置的一部分，
   * 而 execution 快照用 `updated_at` 回答「当时是哪个版本的人」。只写 binding
   * 不动 updated_at 的话，换了能力之后 `memberRevision` 不变 —— 事后对账会看到
   * 「同一个 revision、两组不同的能力」。
   */
  replace(memberId: string, capabilities: MemberCapabilities): MemberCapabilities {
    const rows: Array<{ type: CapabilityType; binding: CapabilityBinding }> = [
      ...capabilities.skills.map((binding) => ({ type: 'skill' as const, binding })),
      ...capabilities.knowledge.map((binding) => ({ type: 'knowledge' as const, binding })),
      ...capabilities.tools.map((binding) => ({ type: 'tool' as const, binding })),
    ];

    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM member_capability_binding WHERE member_id = ?`).run(memberId);

      const insert = this.db.prepare(
        `
        INSERT INTO member_capability_binding (
          member_id, capability_type, provider_id, selector, created_at
        )
        VALUES (?, ?, ?, ?, ?)
        `,
      );
      for (const { type, binding } of rows) {
        insert.run(memberId, type, binding.providerId, binding.selector ?? '', timestamp);
      }

      this.db
        .prepare(`UPDATE member SET updated_at = ? WHERE id = ?`)
        .run(timestamp, memberId);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.get(memberId);
  }

  /**
   * 这个 Member 是不是真的绑定了某条 knowledge binding。
   *
   * Knowledge Provider 的 ACL 就用它。放在这一层而不是 Provider 里，是因为
   * 「谁能访问哪个资料源」是 Member 的能力声明，不是某个后端的实现细节 ——
   * 本地实现和企业搜索实现必须用同一个判据。
   */
  hasKnowledgeBinding(memberId: string, providerId: string, selector: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `
          SELECT 1
          FROM member_capability_binding
          WHERE member_id = ?
            AND capability_type = 'knowledge'
            AND provider_id = ?
            AND selector = ?
          `,
        )
        .get(memberId, providerId, selector),
    );
  }
}

function toBinding(row: BindingRow): CapabilityBinding {
  return {
    providerId: row.provider_id,
    // 空 selector 不落进对象：让「没写 selector」在返回值里就是 undefined，
    // 调用方不必区分 '' 和 undefined 两种「空」。
    ...(row.selector ? { selector: row.selector } : {}),
  };
}
