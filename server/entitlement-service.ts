import type { DatabaseSync } from 'node:sqlite';

/**
 * Data Entitlement —— 「能访问什么数据」。
 *
 * ── 为什么 Capability 不够 ────────────────────────────────────────────
 *
 * Capability 只回答：
 *
 *   能不能使用 jira_search
 *
 * 它回答不了：
 *
 *   能看哪些 Jira issue
 *
 * 这两件事的区别是真实的、而且必须分开：给了 `jira_search` 不等于给了
 * 「全站 JQL 的读权」。同一个工具，A 组只能查自己项目的单，B 组能查全部 ——
 * 这是数据授权，不是工具授权。把它塞进 Capability 的结果是每个数据范围都
 * 得发明一个 Provider，而 Provider 是「实现」不是「范围」。
 *
 * ── 它和 Policy 的分工 ───────────────────────────────────────────────
 *
 *   Entitlement  这个人**有没有资格**碰这类数据（静态、按 Team/Member 配）
 *   Policy       这一笔**该不该发生**（动态、每次调用判一次）
 *
 * 顺序是先 Entitlement 再 Policy：没资格的人连「该不该」都不用问。
 * 两者都通过才轮到 Command 真正执行。
 *
 * ── 默认拒绝 ─────────────────────────────────────────────────────────
 *
 * 查不到任何命中就是拒绝。这一层的价值全在「默认关」上 —— 默认放行的话，
 * 它只是一份没人维护的文档。
 *
 * `resource_pattern` 保留给「按前缀授权」（repo:team-*）这种将来才需要的能力：
 * 当前 check() 只按 resource_type 取候选，pattern 不参与判定。留着这一列是
 * 因为补列比补表便宜，而这一层一旦上线就会有存量数据。
 */
export interface EntitlementContext {
  teamId: string;
  memberId: string;
  providerId: string;
  resourceType: string;
  resourceId: string;
  action: 'read' | 'write';
}

export interface EntitlementDecision {
  allowed: boolean;
  reason: string;
  /** 命中的那一条授权。拒绝时为 undefined —— 没有「哪条拒绝了」，只有「没有哪条允许」。 */
  entitlementId?: string;
  /** 判定时这一层的版本，进 execution 快照：事后能回答「当时是按哪版数据授权放的行」。 */
  revision: string;
}

/**
 * 这一层的**调用口**，与实现分开。
 *
 * 分开的理由和 `PolicyService` 一样：`DefaultToolPolicy` 需要的是「判一次」，
 * 不是「一个连着 SQLite 的对象」。生产装配注入 `EntitlementService`（真读库），
 * 测试可以注入一个只回答固定结论的替身 —— 否则每个想验证授权层顺序的用例
 * 都得先起一个库，而那种用例关心的根本不是数据授权。
 *
 * 注意它**不是**可选的：`DefaultToolPolicy` 必须拿到一个这一层的实现。
 * 做成可选会让「忘了接 Entitlement」表现为静默跳过这一层。
 */
export interface EntitlementChecker {
  revision(): string;

  check(input: EntitlementContext): EntitlementDecision;
}

export class EntitlementService implements EntitlementChecker {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 这一层的版本。
   *
   * 用 `MAX(updated_at)` 而不是自增版本号：改动这一层的路径不止一条（将来会有
   * 管理 API、导入、人工修库），任何「由写入方负责 bump」的方案都会在漏掉的那
   * 一条路径上静默失效。取时间戳则永远跟着数据走。
   *
   * 空表返回 `''`：它同时表示「这一层没有任何授权」和「版本是空」，
   * 而这两件事在当前语义下等价 —— 没有授权就是全部拒绝。
   */
  revision(): string {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(updated_at), '') AS revision
         FROM data_entitlement`,
      )
      .get() as { revision: string };

    return row.revision;
  }

  check(input: EntitlementContext): EntitlementDecision {
    const rows = this.db
      .prepare(
        `
        SELECT id, actions_json
        FROM data_entitlement
        WHERE team_id = ?
          AND provider_id = ?
          AND resource_type = ?
          AND (member_id IS NULL OR member_id = ?)
          AND active = 1
        `,
      )
      .all(
        input.teamId,
        input.providerId,
        input.resourceType,
        input.memberId,
      ) as Array<{ id: string; actions_json: string }>;

    for (const row of rows) {
      const actions = parseActions(row.actions_json);
      if (actions.includes(input.action)) {
        return {
          allowed: true,
          reason: `entitlement=${row.id}`,
          entitlementId: row.id,
          revision: this.revision(),
        };
      }
    }

    return {
      allowed: false,
      reason: `Data Entitlement 拒绝：${input.providerId}/${input.resourceType}/${input.resourceId}`,
      revision: this.revision(),
    };
  }
}

/**
 * 坏数据一律当「没有动作」而不是抛。
 *
 * 这一层处在每次工具调用的热路径上：一行手改坏掉的 JSON 不该让整个 Agent
 * 团队停摆，而「解析不出来 = 不给权限」在安全上是正确的方向。
 */
function parseActions(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
