import type { DatabaseSync } from 'node:sqlite';
import { now } from '../db.js';
import type {
  CapabilityBinding,
  CapabilityConfig,
  CapabilityScopeType,
  MemberCapabilities,
} from '../domain.js';

type CapabilityType = 'skill' | 'knowledge' | 'tool';

interface BindingRow {
  scope_type: CapabilityScopeType;
  scope_id: string;
  capability_type: CapabilityType;
  provider_id: string;
  selector: string;
}

/** 一个作用域的坐标：`(global, '')` / `(team, <teamId>)` / `(member, <memberId>)`。 */
export interface CapabilityScope {
  scopeType: CapabilityScopeType;
  scopeId: string;
}

const EMPTY_CAPABILITIES: MemberCapabilities = {
  skills: [],
  knowledge: [],
  tools: [],
};

/**
 * 能力绑定的读写，分三层作用域。
 *
 * ── 三层叠加，顺序固定 ────────────────────────────────────────────────
 *
 *   effective = global + team + member
 *
 * 按此顺序合并、按 `providerId\u0000selector` 去重，**先出现的赢**。所以 global
 * 是基线（公司级人人都有的能力），member 是增量（这个人的专长），而不是覆盖 ——
 * 后者会让「给某个 Member 单独加一条 knowledge」把它的全部基础能力一起顶掉。
 *
 * ── 一张表，scope 是一个列 ────────────────────────────────────────────
 *
 * `capability_binding` 的 (scope_type, scope_id) 决定这条能力属于谁，而不是
 * 三层各建一张表。所以 effective 是一次三向 OR 的读，而不是三次跨表查询加手工
 * 合并；管理界面想列「某一层存了什么」也只是同一个查询换个 scope 参数。
 *
 * ── 为什么只有 member 层推进 member.updated_at ────────────────────────
 *
 * Member 的能力是 Member 配置的一部分，execution 快照用 `member.updated_at`
 * （= memberRevision）回答「当时是哪个版本的人」。所以 member 层的改动必须
 * 推进它。global/team 层**不能**：改一次 Team 能力就要批量 touch 所有 Member 的
 * updated_at，等于把「一个人改了」和「全组都改了」记成同一件事 —— 快照里的
 * memberRevision 会集体漂移，事后对账完全失效。
 */
export class CapabilityService {
  constructor(private readonly db: DatabaseSync) {}

  getGlobal(): MemberCapabilities {
    return this.getScope({ scopeType: 'global', scopeId: '' });
  }

  getTeam(teamId: string): MemberCapabilities {
    this.assertTeamExists(teamId);
    return this.getScope({ scopeType: 'team', scopeId: teamId });
  }

  getMember(memberId: string): MemberCapabilities {
    this.assertMemberExists(memberId);
    return this.getScope({ scopeType: 'member', scopeId: memberId });
  }

  /**
   * 这一轮真正生效的能力：global + team + member。
   *
   * 执行路径上唯一的读入口。任何一处继续用 `getMember()` 当「这个 Member 能用
   * 什么」，都会让 global/team 两层能力在这一轮里静默消失。
   */
  getEffective(teamId: string, memberId: string): MemberCapabilities {
    this.assertTeamExists(teamId);
    this.assertMemberExists(memberId);

    return mergeCapabilities(this.getGlobal(), this.getTeam(teamId), this.getMember(memberId));
  }

  /** 三层声明 + 解析结果。管理界面用它同时展示「哪层给了什么」和「最终是什么」。 */
  getConfig(teamId: string, memberId: string): CapabilityConfig {
    return {
      global: this.getGlobal(),
      team: this.getTeam(teamId),
      member: this.getMember(memberId),
      effective: this.getEffective(teamId, memberId),
    };
  }

  replaceGlobal(capabilities: MemberCapabilities): MemberCapabilities {
    this.replaceScope({ scopeType: 'global', scopeId: '' }, capabilities);
    return this.getGlobal();
  }

  replaceTeam(teamId: string, capabilities: MemberCapabilities): MemberCapabilities {
    this.assertTeamExists(teamId);
    this.replaceScope({ scopeType: 'team', scopeId: teamId }, capabilities);
    return this.getTeam(teamId);
  }

  /**
   * 全量替换某个 Member 的增量能力。空数组 = 这一类全部解绑。
   *
   * 只有这一层推进 `member.updated_at`（理由见类注释）。替换与推进同一个事务：
   * 只写 binding 不动 updated_at 的话，换了能力之后 memberRevision 不变，事后
   * 对账会看到「同一个 revision、两组不同的能力」。
   */
  replaceMember(memberId: string, capabilities: MemberCapabilities): MemberCapabilities {
    this.assertMemberExists(memberId);

    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.deleteScope({ scopeType: 'member', scopeId: memberId });
      this.insertBindings({ scopeType: 'member', scopeId: memberId }, capabilities, timestamp);

      this.db
        .prepare(`UPDATE member SET updated_at = ? WHERE id = ?`)
        .run(timestamp, memberId);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.getMember(memberId);
  }

  /**
   * 默认能力 provisioning。
   *
   * **只在第一次建立这个 scope 时**执行。判据是 `capability_scope` 的 INSERT
   * OR IGNORE：写进去了（changes > 0）才说明这一次是我们初始化的，随后才灌
   * binding。之后无论管理员把这一层清空成什么样，重启都不会再灌回来 ——
   * 「清空」因此是一个能被表达、能被保持的状态。
   *
   * @returns 这一次是否真的初始化了（false = 之前已经初始化过，本次什么都没做）。
   */
  provision(
    scope: Extract<CapabilityScopeType, 'global' | 'team'>,
    scopeId: string,
    seedKey: string,
    capabilities: MemberCapabilities,
  ): boolean {
    if (scope === 'global') {
      if (scopeId !== '') {
        throw new Error('global capability scopeId 必须为空字符串');
      }
    } else {
      this.assertTeamExists(scopeId);
    }

    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      const result = this.db
        .prepare(
          `
          INSERT OR IGNORE INTO capability_scope (
            scope_type,
            scope_id,
            seed_key,
            created_at
          )
          VALUES (?, ?, ?, ?)
          `,
        )
        .run(scope, scopeId, seedKey, timestamp);

      if (Number(result.changes) === 0) {
        this.db.exec('COMMIT');
        return false;
      }

      this.insertBindings({ scopeType: scope, scopeId }, capabilities, timestamp);

      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 某个 Member 在某个 Team 里是否真的拥有某条 Knowledge binding。
   *
   * Knowledge Provider 的 ACL 判据。三层都算：global/team 给的是「公司/团队
   * 共享资料」，member 给的是「这个人额外能看的」。放在这一层而不是 Provider 里，
   * 是因为「谁能访问哪个资料源」是能力声明，不是某个后端的实现细节 —— 本地实现
   * 和企业搜索实现必须用同一个判据。
   */
  hasEffectiveKnowledgeBinding(
    teamId: string,
    memberId: string,
    providerId: string,
    selector: string,
  ): boolean {
    this.assertTeamExists(teamId);
    this.assertMemberExists(memberId);

    const row = this.db
      .prepare(
        `
        SELECT 1
        FROM capability_binding
        WHERE capability_type = 'knowledge'
          AND provider_id = ?
          AND selector = ?
          AND (
            (scope_type = 'global' AND scope_id = '')
            OR
            (scope_type = 'team' AND scope_id = ?)
            OR
            (scope_type = 'member' AND scope_id = ?)
          )
        LIMIT 1
        `,
      )
      .get(providerId, selector, teamId, memberId);

    return Boolean(row);
  }

  // ----------------------------------------------------------------- 内部

  private getScope(scope: CapabilityScope): MemberCapabilities {
    const rows = this.db
      .prepare(
        `
        SELECT
          scope_type,
          scope_id,
          capability_type,
          provider_id,
          selector
        FROM capability_binding
        WHERE scope_type = ?
          AND scope_id = ?
        ORDER BY capability_type, provider_id, selector
        `,
      )
      .all(scope.scopeType, scope.scopeId) as unknown as BindingRow[];

    if (rows.length === 0) {
      return structuredClone(EMPTY_CAPABILITIES);
    }

    return {
      skills: rows.filter((row) => row.capability_type === 'skill').map(toBinding),
      knowledge: rows.filter((row) => row.capability_type === 'knowledge').map(toBinding),
      tools: rows.filter((row) => row.capability_type === 'tool').map(toBinding),
    };
  }

  /** global/team 层的替换入口。刻意不碰 `member.updated_at`。 */
  private replaceScope(scope: CapabilityScope, capabilities: MemberCapabilities): void {
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.deleteScope(scope);
      this.insertBindings(scope, capabilities, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private deleteScope(scope: CapabilityScope): void {
    this.db
      .prepare(
        `
        DELETE FROM capability_binding
        WHERE scope_type = ?
          AND scope_id = ?
        `,
      )
      .run(scope.scopeType, scope.scopeId);
  }

  private insertBindings(
    scope: CapabilityScope,
    capabilities: MemberCapabilities,
    timestamp: string,
  ): void {
    const rows: Array<{ type: CapabilityType; binding: CapabilityBinding }> = [
      ...capabilities.skills.map((binding) => ({ type: 'skill' as const, binding })),
      ...capabilities.knowledge.map((binding) => ({ type: 'knowledge' as const, binding })),
      ...capabilities.tools.map((binding) => ({ type: 'tool' as const, binding })),
    ];

    const insert = this.db.prepare(
      `
      INSERT INTO capability_binding (
        scope_type,
        scope_id,
        capability_type,
        provider_id,
        selector,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
    );

    // 调用方给来的数组里可能有重复项（比如模板里手滑写了两遍同一条）。主键会让
    // 第二行直接抛 —— 但那是一个 SQLite 约束错误，不是「你重复了一条能力」。
    // 在这里先去重，语义上重复声明同一条能力本来就是幂等的。
    for (const { type, binding } of dedupeBindings(rows)) {
      insert.run(
        scope.scopeType,
        scope.scopeId,
        type,
        binding.providerId,
        binding.selector ?? '',
        timestamp,
      );
    }
  }

  private assertTeamExists(teamId: string): void {
    const row = this.db.prepare(`SELECT 1 FROM team WHERE id = ?`).get(teamId);
    if (!row) {
      throw Object.assign(new Error(`Team 不存在：${teamId}`), { status: 404 });
    }
  }

  private assertMemberExists(memberId: string): void {
    const row = this.db.prepare(`SELECT 1 FROM member WHERE id = ?`).get(memberId);
    if (!row) {
      throw Object.assign(new Error(`Member 不存在：${memberId}`), { status: 404 });
    }
  }
}

function dedupeBindings(
  rows: Array<{ type: CapabilityType; binding: CapabilityBinding }>,
): Array<{ type: CapabilityType; binding: CapabilityBinding }> {
  const seen = new Set<string>();
  const result: Array<{ type: CapabilityType; binding: CapabilityBinding }> = [];

  for (const row of rows) {
    const key = `${row.type}\u0000${row.binding.providerId}\u0000${row.binding.selector ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }

  return result;
}

/**
 * 三层按顺序合并，按 `providerId\u0000selector` 去重，先出现的赢。
 *
 * 去重键不含「类型」：三类能力的 providerId 在注册表里本来就全局唯一
 * （见 CapabilityRegistry.assertProviderIdAvailable），所以同一个键不会跨类
 * 撞车。带着类型只会让「同一对 (provider, selector) 在两类里各出现一次」
 * 被当成两条 —— 而那在数据上根本不可能成立。
 */
function mergeCapabilities(...layers: MemberCapabilities[]): MemberCapabilities {
  return {
    skills: mergeBindings(layers.map((layer) => layer.skills)),
    knowledge: mergeBindings(layers.map((layer) => layer.knowledge)),
    tools: mergeBindings(layers.map((layer) => layer.tools)),
  };
}

function mergeBindings(layers: CapabilityBinding[][]): CapabilityBinding[] {
  const result: CapabilityBinding[] = [];
  const seen = new Set<string>();

  for (const layer of layers) {
    for (const binding of layer) {
      const key = `${binding.providerId}\u0000${binding.selector ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        providerId: binding.providerId,
        // 空 selector 不落进对象：让「没写 selector」在返回值里就是 undefined，
        // 调用方不必区分 '' 和 undefined 两种「空」。
        ...(binding.selector === undefined ? {} : { selector: binding.selector }),
      });
    }
  }

  return result;
}

function toBinding(row: BindingRow): CapabilityBinding {
  return {
    providerId: row.provider_id,
    ...(row.selector ? { selector: row.selector } : {}),
  };
}
