import { Router } from 'express';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';

/**
 * Execution API。
 *
 * Execution 是「一次实际工作」的审计记录，也是操作面：用户要能看见 Agent Team
 * 正在干什么、失败在哪、然后 retry / cancel。
 *
 * 刻意不做 `/executions/:id/tree`：客户端按 `parentExecutionId` 自己组树就够了，
 * 服务端算一次树只是在缓存一个随时会变的视图。
 *
 * 挂载点：`/api/executions`
 */
export function executionsRouter(team: TeamService) {
  const router = Router();

  /** 单条 execution。 */
  router.get('/:id', (req, res) => {
    try {
      res.json({ execution: team.getExecution(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * retry 会生成一条**新的** execution，并用 retryOfExecutionId 指回原记录。
   * 不要把原记录改成「重新执行」—— 那样审计链就断了。
   */
  router.post('/:id/retry', (req, res) => {
    try {
      const { executionId } = team.retryExecution(req.params.id);
      res.status(202).json({ executionId, execution: team.getExecution(executionId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * cancel 是异步的：它要等引擎真的停下来才返回。
   *
   *   queued             → 直接落库 cancelled
   *   running            → session.abort() → 等 session.idle → turn 自己写成 cancelled
   *   waiting_for_member → 409（第一版不做子树的取消传播）
   *
   * 返回最终状态而不是「已受理」—— 因为「已受理」正是假取消的来源。
   */
  router.post('/:id/cancel', async (req, res) => {
    try {
      res.json({ execution: await team.cancelExecution(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
