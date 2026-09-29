import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import type { AuditService } from '../audit-service.js';
import type { EvidenceService } from '../evidence-service.js';
import { requireResourceConversationAccess } from '../middleware/conversationAccess.js';
import { sendError } from '../middleware/errorHandler.js';
import { currentPrincipal } from '../middleware/auth.js';

/**
 * 审计查询 / 导出 API。
 *
 * ── 它回答的问题 ─────────────────────────────────────────────────────
 *
 * 「这一轮到底做了什么」—— 一次 execution 下三张表合起来才是完整答案：
 *
 *   policy_decision_audit   工具层的判定（含拒绝）：它想调什么、放没放行
 *   tool_execution_audit    工具层的执行：真的调了、结果如何
 *   command_audit           **业务动作**层：谁批的、执行没执行、成没成
 *
 * 三张表刻意不合并（见 audit-service.ts 的类注释）：一次拒绝只有第一张，
 * 一次 Jira 流转可能只有第三张（控制面发起，不经过任何工具）。合并会让
 * 「被拒的调用」和「没走工具的写入」各自丢掉一半信息。
 *
 * ── 授权 ─────────────────────────────────────────────────────────────
 *
 * 和 executionsRouter 完全同一套：审计里全是**房间里的内容**（prompt、参数
 * 原文、拒绝理由）。按 execution 归属的 conversation 判定。
 *
 * 挂载点：`/api/audit`
 */
export function auditRouter(team: TeamService, audit: AuditService, evidence: EvidenceService) {
  const router = Router();

  router.use(
    '/executions/:id',
    requireResourceConversationAccess(
      team,
      (id) => team.getExecution(id).conversationId,
      'id',
      'execution',
    ),
  );

  /** 一次 execution 的完整证据链。 */
  const bundle = (executionId: string) => ({
    executionId,
    policyDecisions: audit.listPolicyDecisions(executionId),
    toolExecutions: audit.listToolExecutions(executionId),
    commands: audit.listCommandAuditForExecution(executionId),
    // 依据与审核状态。它和上面三张表不是同一件事：那三张回答「做了什么」，
    // 这一份回答「凭什么这么说、人看过没有」。缺了它，审计只能证明动作
    // 发生过，证明不了结论有出处。
    evidence: evidence.get(executionId),
  });

  router.get('/executions/:id', (req, res) => {
    try {
      res.json(bundle(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 人工审核。
   *
   * 「人看过」是这条链里唯一不能自证的一环，所以谁能调这个接口由挂载点决定
   * （requireHumanAuth），而不是在这里判身份。
   *
   * 通过 / 驳回都不改 execution 的状态 —— 那回答的是「这轮跑完没有」，
   * 和「结论要不要人背书」是两件事。
   */
  router.post('/executions/:id/review', (req, res) => {
    const parsed = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(4000).default(''),
      })
      .safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({ error: '审核结果只能是「通过」或「驳回」' });
      return;
    }

    // 挂载点已经过了 requireHumanAuth（见 app.ts 的 humanApi），走到这里的
    // principal 一定是人 —— 「Agent 给自己背书」这条路径在装配处就被断了，
    // 不需要在这里再留一个永远走不到的分支。
    try {
      res.json({
        evidence: evidence.review(
          req.params.id,
          currentPrincipal(req).principalId,
          parsed.data.decision,
          parsed.data.note,
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 导出。
   *
   * `Content-Disposition: attachment` 而不是内联 JSON：这个接口的用途是
   * 「把证据交给外部（合规、事故复盘）」，而浏览器内联显示一个大 JSON 只会
   * 让人再复制粘贴一次。文件名带上 execution id，下载下来能直接对上是哪一轮。
   *
   * 不做分页/裁剪：一次 execution 的审计行数是有限的（一轮 turn 的工具调用
   * 与业务动作都以几十计），而**截断的证据是不可用的证据** —— 一份少了两条
   * 的审计比没有更危险，因为它看起来完整。
   */
  router.get('/executions/:id/export', (req, res) => {
    try {
      const payload = bundle(req.params.id);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-${req.params.id}.json"`,
      );
      res.send(JSON.stringify(payload, null, 2));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
