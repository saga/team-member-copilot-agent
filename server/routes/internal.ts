import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';
import { requireInternalToken } from '../middleware/apiScope.js';

/**
 * Internal Member runtime API。
 *
 * 这一组端点的调用方**不是浏览器里的用户**，而是另一个 runtime —— 它要做的
 * 事和 Member 自己的工具一样：以某个 Member 的身份说话。所以 `:id` 在这里是
 * 「我代表谁」，不是「我在看谁」。
 *
 * 正因为如此，它不能和 `/api/members` 混在一起：那组路径的语义是「用户的
 * 成员管理」，一个 `:id` 在那边只用来定位资源，没有人会想到它同时还是一个
 * 可以冒充的身份。整组挂在 `requireInternalToken` 后面（见 middleware/apiScope.ts）。
 */

const directMessageSchema = z.object({
  toMemberId: z.string().min(1),
  content: z.string().trim().min(1).max(20000),
});

export function internalRouter(team: TeamService) {
  const router = Router();

  router.use(requireInternalToken());

  /**
   * 以 `:id` 这个 Member 的身份给 `toMemberId` 发一条私聊。
   *
   * 202：消息已落库、对方已入队，对方的回复通过那个房间的 SSE 推。
   * 房间不存在时自动建立，调用方不需要「先开房间再发消息」两段式。
   */
  router.post('/members/:id/direct-messages', async (req, res) => {
    const parsed = directMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      res.status(202).json(
        await team.sendDirectMessage({
          fromMemberId: req.params.id,
          toMemberId: parsed.data.toMemberId,
          content: parsed.data.content,
        }),
      );
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
