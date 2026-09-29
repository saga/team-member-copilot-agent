import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now } from './db.js';
import { badRequest, conflict, notFound } from './http-error.js';
import type { CapabilityResolver } from './capabilities/resolver.js';
import type { CapabilityService } from './capabilities/service.js';
import type { CapabilityContext, KnowledgeAuthority } from './capabilities/types.js';

/**
 * 一条执行结果的依据链。
 *
 * ── 它只回答一个窄问题 ──────────────────────────────────────────────────
 *
 *   「这句话**依据**什么说的」
 *
 * 它不回答「这句话对不对」，也不给任何 Member / Agent 打分。没有 Member
 * Reliability、没有 Agent Trust、没有模型自评 —— 那些东西看着像质量信号，
 * 实际是同一个系统在给自己打分，而打分的那一位恰恰是最需要被审视的对象。
 *
 * ── 三个字段不许互相代替 ────────────────────────────────────────────────
 *
 *   execution.status   这轮跑完没有
 *   evidence_score     当前依据有多强
 *   review_status      人看过没有
 *
 * 所以「已完成 + 高分 + 待审核」是正常且常见的组合：活干完了、依据很硬，
 * 但这个任务被标了要人看、还没人看。不能因为没审核就把 execution 改成失败。
 *
 * ── evidence_score 不是概率 ─────────────────────────────────────────────
 *
 * 91 只能读成「当前依据强度 91/100」。读成「91% 可能是对的」就超过了它能支撑
 * 的结论：它衡量的是**引用了多硬的材料**，不是模型和现实的一致程度。
 */

export type EvidenceSupport = 'direct' | 'partial' | 'weak';

export interface EvidenceClaimInput {
  claim: string;
  citations: string[];
  support: EvidenceSupport;
}

interface EvidenceSource {
  citation: string;
  title: string;
  sourceUri: string | null;
  authority: KnowledgeAuthority;
}

export interface EvidenceClaimRecord extends EvidenceClaimInput {
  /** 真正算进分数的引用：这一轮检索过、且解析得出来。 */
  sources: EvidenceSource[];
  /**
   * 报了但这一轮根本没检索过的 citation。
   *
   * 留在记录里而不是丢掉：它正是「拿一份真实存在的材料去支持不相干的结论」
   * 这类行为唯一的痕迹。丢掉它，审计里就只剩一个 0 分，看不出为什么是 0。
   */
  unseen: string[];
  score: number;
}

export interface ExecutionEvidence {
  executionId: string;
  evidenceScore: number;
  evidenceLevel: 'low' | 'medium' | 'high';
  verificationLevel: 'none' | 'human';
  reviewRequired: boolean;
  reviewStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  claims: EvidenceClaimRecord[];
  reviewNote: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const AUTHORITY_WEIGHT: Record<KnowledgeAuthority, number> = {
  authoritative: 1,
  approved: 0.8,
  reference: 0.5,
};

const SUPPORT_WEIGHT: Record<EvidenceSupport, number> = {
  direct: 1,
  partial: 0.6,
  weak: 0.3,
};

interface ExecutionContext {
  executionId: string;
  memberId: string;
  teamId: string;
  conversationId: string;
  taskId: string | null;
}

interface EvidenceRow {
  execution_id: string;
  evidence_score: number;
  evidence_level: 'low' | 'medium' | 'high';
  verification_level: 'none' | 'human';
  review_required: number;
  review_status: 'not_required' | 'pending' | 'approved' | 'rejected';
  claims_json: string;
  review_note: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export class EvidenceService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly capabilities: CapabilityService,
    private readonly resolver: CapabilityResolver,
  ) {}

  /**
   * 记下这一轮真的检索过哪些 citation。
   *
   * 写入方只有检索工具。Agent 没有任何路径能往这里加一行 —— 否则「我检索过」
   * 就又变回一句自述。
   */
  recordSeen(input: { executionId: string; providerId: string; citations: string[] }): void {
    if (!input.executionId) return;
    const statement = this.db.prepare(
      `
      INSERT OR IGNORE INTO execution_evidence_seen (execution_id, citation, provider_id, seen_at)
      VALUES (?, ?, ?, ?)
      `,
    );
    const timestamp = now();
    for (const citation of new Set(input.citations.map((item) => item.trim()).filter(Boolean))) {
      statement.run(input.executionId, citation, input.providerId, timestamp);
    }
  }

  /**
   * 记一次申报。
   *
   * Agent 只给「结论 + 引用 + 支持程度」，分数由这里算：让 Agent 报分数等于
   * 让被评估方自己填评估表，那个数字没有任何约束力。
   *
   * 同名结论按 claim 文本覆盖：同一条结论被反复申报（模型改口、工具重试）时
   * 该留下最后一次，而不是攒出一堆重复行把均分拉歪。
   */
  async recordEvidence(
    executionId: string,
    claims: EvidenceClaimInput[],
  ): Promise<ExecutionEvidence> {
    const execution = this.executionContext(executionId);
    const existing = this.get(executionId);

    const merged = new Map<string, EvidenceClaimInput>();
    for (const claim of existing?.claims ?? []) {
      merged.set(claim.claim.trim(), {
        claim: claim.claim,
        citations: claim.citations,
        support: claim.support,
      });
    }
    for (const claim of claims) {
      const normalized: EvidenceClaimInput = {
        claim: claim.claim.trim(),
        citations: [...new Set(claim.citations.map((item) => item.trim()).filter(Boolean))].slice(0, 8),
        support: claim.support,
      };
      if (!normalized.claim) continue;
      merged.set(normalized.claim, normalized);
    }

    const seen = this.seenCitations(executionId);
    const scored = await Promise.all(
      [...merged.values()].map((claim) => this.scoreClaim(execution, claim, seen)),
    );

    const score =
      scored.length === 0
        ? 0
        : Math.round(scored.reduce((sum, claim) => sum + claim.score, 0) / scored.length);

    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO execution_evidence (
          execution_id, evidence_score, evidence_level, verification_level,
          review_required, review_status, claims_json, review_note, reviewed_by, reviewed_at,
          created_at, updated_at
        )
        VALUES (?, ?, ?, 'none', 0, 'not_required', ?, '', NULL, NULL, ?, ?)
        ON CONFLICT(execution_id) DO UPDATE SET
          evidence_score = excluded.evidence_score,
          evidence_level = excluded.evidence_level,
          claims_json = excluded.claims_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(executionId, score, levelOf(score), JSON.stringify(scored), timestamp, timestamp);

    return this.get(executionId) as ExecutionEvidence;
  }

  /**
   * 执行收口。
   *
   * 一次申报都没有也要建一条 0 分记录：「没有提供依据」本身就是一个有意义
   * 的状态，和「还没跑完」必须区分得开。
   *
   * 审核要求在这里才落到证据上，而不是申报时：任务上的开关可能在执行过程中
   * 被人改过，收口那一刻读到的才是最终要求。
   */
  finalizeExecution(executionId: string): ExecutionEvidence {
    const execution = this.executionContext(executionId);

    if (!this.get(executionId)) {
      const timestamp = now();
      this.db
        .prepare(
          `
          INSERT INTO execution_evidence (
            execution_id, evidence_score, evidence_level, verification_level,
            review_required, review_status, claims_json, review_note, reviewed_by, reviewed_at,
            created_at, updated_at
          )
          VALUES (?, 0, 'low', 'none', 0, 'not_required', '[]', '', NULL, NULL, ?, ?)
          `,
        )
        .run(executionId, timestamp, timestamp);
    }

    const evidence = this.get(executionId) as ExecutionEvidence;

    const task = execution.taskId
      ? (this.db
          .prepare(`SELECT requires_human_review FROM conversation_task WHERE id = ?`)
          .get(execution.taskId) as unknown as { requires_human_review: number } | undefined)
      : undefined;
    const reviewRequired = Number(task?.requires_human_review ?? 0) === 1;

    // 人已经判过的（approved / rejected）一律保留，包括把开关关掉的那一刻：
    // 那是一个已经做出的审核决定，任务上的开关来回拨动不该把它抹掉 ——
    // 否则「先标要审核 → 驳回 → 再关掉开关」就能让一次驳回凭空消失。
    const decided =
      evidence.reviewStatus === 'approved' || evidence.reviewStatus === 'rejected';
    const reviewStatus = decided
      ? evidence.reviewStatus
      : reviewRequired
        ? 'pending'
        : 'not_required';

    this.db
      .prepare(
        `
        UPDATE execution_evidence
        SET review_required = ?, review_status = ?, updated_at = ?
        WHERE execution_id = ?
        `,
      )
      .run(reviewRequired ? 1 : 0, reviewStatus, now(), executionId);

    return this.get(executionId) as ExecutionEvidence;
  }

  review(
    executionId: string,
    reviewerId: string,
    decision: 'approved' | 'rejected',
    note: string,
  ): ExecutionEvidence {
    const evidence = this.get(executionId);
    if (!evidence) throw notFound('这条执行还没有留下依据记录，先等它跑完');
    if (!evidence.reviewRequired) throw badRequest('这个任务没有被标成「需要人看过」，不用审核');
    if (evidence.reviewStatus !== 'pending') {
      throw conflict(`这份依据已经审核过了（${statusText(evidence.reviewStatus)}），不能重复审核`);
    }

    this.db
      .prepare(
        `
        UPDATE execution_evidence
        SET verification_level = 'human',
            review_status = ?,
            review_note = ?,
            reviewed_by = ?,
            reviewed_at = ?,
            updated_at = ?
        WHERE execution_id = ?
        `,
      )
      .run(decision, note.trim(), reviewerId, now(), now(), executionId);

    return this.get(executionId) as ExecutionEvidence;
  }

  get(executionId: string): ExecutionEvidence | null {
    const row = this.db
      .prepare(`SELECT * FROM execution_evidence WHERE execution_id = ?`)
      .get(executionId) as unknown as EvidenceRow | undefined;
    if (!row) return null;

    let claims: EvidenceClaimRecord[] = [];
    try {
      const parsed: unknown = JSON.parse(row.claims_json);
      if (Array.isArray(parsed)) claims = parsed as EvidenceClaimRecord[];
    } catch {
      // 手改过 / 老格式的 claims_json 不该让整条审计打不开：
      // 宁可显示「没有依据」，也不能让这条执行查不出来。
      claims = [];
    }

    return {
      executionId: row.execution_id,
      evidenceScore: row.evidence_score,
      evidenceLevel: row.evidence_level,
      verificationLevel: row.verification_level,
      reviewRequired: row.review_required === 1,
      reviewStatus: row.review_status,
      claims,
      reviewNote: row.review_note,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private seenCitations(executionId: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT citation FROM execution_evidence_seen WHERE execution_id = ?`)
      .all(executionId) as unknown as Array<{ citation: string }>;
    return new Set(rows.map((row) => row.citation));
  }

  /**
   * 给一条结论打分。
   *
   * 只取**最强**的那份有效材料，不累加：五份「参考」加起来仍然没有一份正式
   * 政策硬，堆引用数换分数正是这条链要挡的事。
   */
  private async scoreClaim(
    execution: ExecutionContext,
    claim: EvidenceClaimInput,
    seen: Set<string>,
  ): Promise<EvidenceClaimRecord> {
    const sources: EvidenceSource[] = [];
    const unseen: string[] = [];

    for (const citation of claim.citations) {
      if (!seen.has(citation)) {
        unseen.push(citation);
        continue;
      }
      const source = await this.resolveCitation(execution, citation);
      if (source) sources.push(source);
      else unseen.push(citation);
    }

    if (sources.length === 0) {
      return { ...claim, sources, unseen, score: 0 };
    }

    const bestAuthority = Math.max(
      ...sources.map((source) => AUTHORITY_WEIGHT[source.authority] ?? 0),
    );
    const supportWeight = SUPPORT_WEIGHT[claim.support] ?? 0;

    return {
      ...claim,
      sources,
      unseen,
      score: Math.round(Math.min(1, bestAuthority * supportWeight) * 100),
    };
  }

  /**
   * citation → 它指的那份材料。
   *
   * 走 Provider，不直连表：citation 长什么样是后端自己的事，平台去拼格式再查
   * knowledge_document，等于开第二条读取路径 —— 换后端时它不会报错，只会
   * 静默算出错误的分数。
   */
  private async resolveCitation(
    execution: ExecutionContext,
    citation: string,
  ): Promise<EvidenceSource | null> {
    const context: CapabilityContext = {
      teamId: execution.teamId,
      memberId: execution.memberId,
      conversationId: execution.conversationId,
      executionId: execution.executionId,
      userId: config.localUserId,
    };

    const resolved = await this.resolver.resolve(
      context,
      this.capabilities.getEffective(execution.teamId, execution.memberId),
    );

    for (const binding of resolved.knowledge) {
      const source = await binding.provider.resolveCitation(context, citation);
      if (source) {
        return {
          citation: source.citation,
          title: source.title,
          sourceUri: source.sourceUri,
          authority: source.authority,
        };
      }
    }
    return null;
  }

  private executionContext(executionId: string): ExecutionContext {
    const row = this.db
      .prepare(
        `
        SELECT e.member_id, e.task_id, e.conversation_id, c.team_id
        FROM execution e
        JOIN conversation c ON c.id = e.conversation_id
        WHERE e.id = ?
        `,
      )
      .get(executionId) as unknown as
      | { member_id: string; task_id: string | null; conversation_id: string; team_id: string }
      | undefined;

    if (!row) throw notFound(`执行记录不存在：${executionId}`);

    return {
      executionId,
      memberId: row.member_id,
      teamId: row.team_id,
      conversationId: row.conversation_id,
      taskId: row.task_id,
    };
  }
}

function levelOf(score: number): 'low' | 'medium' | 'high' {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

function statusText(status: ExecutionEvidence['reviewStatus']): string {
  if (status === 'approved') return '已通过';
  if (status === 'rejected') return '已驳回';
  return '待审核';
}
