import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import type { CommandService } from '../command-service.js';
import type { AuditService } from '../audit-service.js';
import { currentPrincipal } from '../middleware/auth.js';
import {
  canAccessConversation,
  requireResourceConversationAccess,
} from '../middleware/conversationAccess.js';
import { sendError } from '../middleware/errorHandler.js';

/**
 * Command / Approval API —— 外部写入的控制面。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 *
 * 默认 Policy 对一切 external-write 返回 `approvalRequired`，于是 Command 停在
 * `policy_pending` 不动。这是刻意的（「能列出工具」和「能执行动作」是两件事），
 * 但它意味着**没有审批出口时，所有外部写入都永久停在待审批**。
 *
 * 这个路由就是那个出口。在此之前 Command 只能靠代码推进，`approve()` 根本没有
 * HTTP 面 —— 一条 Jira 评论会一直躺在 `policy_pending` 里，而用户看不到它、
 * 也无法放行。
 *
 * ── 授权 ─────────────────────────────────────────────────────────────
 *
 * 整段挂在「Command 归属的那个 Conversation」上，和 executionsRouter 同一套
 * 判据。Command 里有**参数原文**（args_json）—— 评论正文、流转目标都在里面。
 * 只校验「你是这个 Team 的人」会让同 Team 的成员按 id 遍历别人的写入内容。
 *
 * 挂载点：`/api/commands`
 */
export function commandsRouter(team: TeamService, commands: CommandService, audit?: AuditService) {
  const router = Router();

  /** 单条 Command 的形状：连同审批与生命周期一起返回。 */
  const detail = (commandId: string) => {
    const command = commands.get(commandId);
    return {
      command,
      approval: command.approvalId ? commands.getApproval(command.approvalId) : null,
      // 生命周期是 Command 的**过程**，command 行上只有当前状态。
      // 审批界面要回答「谁批的、什么时候开始执行」，只有事件行说得清。
      audit: audit ? audit.listCommandAudit(commandId) : [],
    };
  };

  // 按 execution 列出这一轮里全部业务动作，或按状态列出（审批收件箱）。
  // 放在 `/:id` 之前注册，否则 `/:id` 会把这条也吃掉（Express 按注册顺序匹配）。
  router.get('/', (req, res) => {
    const executionId = typeof req.query.executionId === 'string' ? req.query.executionId : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    try {
      if (executionId) {
        // 归属校验走 execution → conversation，和单条 Command 走同一条判据：
        // 不能出现「列表看不到但详情看得到」这种半开的状态。
        const conversationId = team.getExecution(executionId).conversationId;
        team.requireTeamHumanAccess(
          team.getConversation(conversationId).teamId,
          currentPrincipal(req).principalId,
        );
        res.json({ commands: commands.listForExecution(executionId) });
        return;
      }

      if (status) {
        const parsed = commandStatusSchema.safeParse(status);
        if (!parsed.success) {
          res.status(400).json({ error: `未知的 Command 状态：${status}` });
          return;
        }
        // 按状态列是**跨房间**的，所以这里不能只靠房间 ACL —— 逐个房间过滤之后
        // 再返回。收件箱的形状决定了它必然横跨房间，而「横跨」不能成为「绕过」：
        // 看不见的房间里的 Command 不会出现在结果里。
        const visible = commands
          .listByStatus(parsed.data, 200)
          .filter((command) => canAccessConversation(team, req, command.conversationId));
        res.json({ commands: visible });
        return;
      }

      res.status(400).json({ error: '需要 executionId 或 status 之一' });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.use(
    '/:id',
    requireResourceConversationAccess(
      team,
      (id) => commands.get(id).conversationId,
      'id',
      'command',
    ),
  );

  router.get('/:id', (req, res) => {
    try {
      res.json(detail(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 审批通过。
   *
   * `execute` 默认 true —— 「批准」在用户心里就是「可以做了」，让它停在
   * `approved` 等一个不存在的第二个动作，等于批准之后还要再点一次「执行」，
   * 而那个按钮没有任何人会去找。要只批准不执行时显式传 `execute: false`
   * （比如先批量批、再统一执行）。
   *
   * 审批人取**当前请求的身份**，不从 body 读：允许 body 指定审批人等于允许
   * 冒名 —— 审计里「谁批的」这一栏必须来自认证，不能来自输入。
   */
  router.post('/:id/approve', async (req, res) => {
    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      const approver = currentPrincipal(req).principalId;
      commands.approve(req.params.id, approver);
      if (parsed.data.execute) {
        await commands.execute(req.params.id);
      }
      res.json(detail(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  /** 审批驳回：Command 落到终态 rejected，不再可执行。 */
  router.post('/:id/reject', (req, res) => {
    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      commands.reject(req.params.id, currentPrincipal(req).principalId);
      res.json(detail(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 显式执行一条已经放行的 Command（`ready` / `approved`）。
   *
   * 单独暴露是为了「先批后跑」和「Policy 直接放行的 ready 命令」两条路径 ——
   * 执行本身是 CAS 的（见 CommandService.markExecuting），所以并发点两次不会
   * 打两次外部系统，第二次会拿到 409。
   */
  router.post('/:id/execute', async (req, res) => {
    try {
      await commands.execute(req.params.id);
      res.json(detail(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

const decisionSchema = z.object({
  /**
   * 批准之后是否立刻执行。默认 true。
   *
   * 没有 comment 字段：审批意见目前没有落点（approval 表只有 decided_by /
   * decided_at）。加一个收下就丢的字段会让调用方以为意见被记下了 —— 那比
   * 没有这个字段更糟。
   */
  execute: z.boolean().optional(),
});

/**
 * 允许按状态查询的取值。
 *
 * 这里枚举而不是直接透传字符串：状态是 SQL 参数，而未知值会让 `listByStatus`
 * 静默返回空数组 —— 调用方看到的是「没有待审批」，而不是「你查错了」。
 */
const commandStatusSchema = z.enum([
  'requested',
  'policy_pending',
  'approved',
  'ready',
  'executing',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'expired',
]);
