import { Router } from 'express';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';
import { requireResourceConversationAccess } from '../middleware/conversationAccess.js';
import { resolveActor } from '../middleware/teamScope.js';

/**
 * Execution API。
 *
 * Execution 是「一次实际工作」的审计记录，也是操作面：用户要能看见 Agent Team
 * 正在干什么、失败在哪、然后 retry / cancel。
 *
 * 刻意不做 `/executions/:id/tree`：客户端按 `parentExecutionId` 自己组树就够了，
 * 服务端算一次树只是在缓存一个随时会变的视图。
 *
 * ── 授权 ─────────────────────────────────────────────────────────────
 *
 * 整段挂在「execution 归属的那个 Conversation」上。Execution 是**房间里的东西**，
 * 而执行记录里有 prompt、工具调用、文件引用 —— 只校验「你是这个 Team 的人」
 * 会让同一个 Team 的成员按 id 遍历别人的执行记录。
 *
 * 挂载点：`/api/executions`
 */
export function executionsRouter(team: TeamService) {
  const router = Router();

  router.use(
    '/:id',
    requireResourceConversationAccess(team, (id) => team.getExecution(id).conversationId, 'id', 'execution'),
  );

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
   *   waiting_for_member → 409（不做子树的取消传播）
   *
   * 返回最终状态而不是「已受理」—— 因为「已受理」正是假取消的来源。
   */
  router.post('/:id/cancel', async (req, res) => {
    try {
      // 谁点的取消要落库：事后只能看到「取消过」，看不到是谁要求的。
      res.json({ execution: await team.cancelExecution(req.params.id, resolveActor(req).principalId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
