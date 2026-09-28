import { Router } from 'express';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';
import { requireResourceConversationAccess } from '../middleware/conversationAccess.js';

/**
 * Task API。
 *
 * Task 的正常创建路径是 Lead Agent 的 `plan_tasks` 工具，这里不提供
 * `POST /tasks` —— 用户建任务的方式是「在工作区里说清楚目标」，不是填表。
 *
 * ── 授权 ─────────────────────────────────────────────────────────────
 *
 * 整段挂在「Task 归属的那个 Conversation」上，理由与 executions 相同：
 * Task 是房间里的东西，Team 成员身份不等于能读别人的任务。
 *
 * 挂载点：`/api/tasks`
 */
export function tasksRouter(team: TeamService) {
  const router = Router();

  router.use(
    '/:id',
    requireResourceConversationAccess(team, (id) => team.getTask(id).conversationId, 'id', 'Task'),
  );

  /** 单个 Task。 */
  router.get('/:id', (req, res) => {
    try {
      res.json({ task: team.getTask(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** 重试：failed / blocked / cancelled → ready，旧 execution 保留。 */
  router.post('/:id/retry', (req, res) => {
    try {
      res.json({ task: team.retryTask(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** 取消：未结束的 Task → cancelled。 */
  router.post('/:id/cancel', (req, res) => {
    try {
      res.json({ task: team.cancelTask(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
