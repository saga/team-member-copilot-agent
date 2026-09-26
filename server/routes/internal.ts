import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';
import { requireInternalToken } from '../middleware/apiScope.js';
import { resolveActor } from '../middleware/teamScope.js';

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
 *
 * Agent 身份只在这里注入（`req.agentMemberId`，Team API 的 resolveActor 读它）。
 * 这是全服务**唯一**的注入点：普通 `/api` 路径没有任何中间件写这个字段，
 * 所以「请求头里塞个 agent id 就变成 Agent」在这条边界上不存在。
 */

const directMessageSchema = z.object({
  toMemberId: z.string().min(1),
  content: z.string().trim().min(1).max(20000),
});

const workItemClaimSchema = z.object({
  workItemId: z.string().min(1),
  executionId: z.string().min(1),
});

export function internalRouter(team: TeamService) {
  const router = Router();

  router.use(requireInternalToken());

  // /members/:id/** 的请求以 :id 作为 agent 身份进入下游（resolveActor 读它）。
  // 挂在 mount path 上而不是逐个路由写，新增内部端点时身份注入不会漏。
  router.use('/members/:id', (req, _res, next) => {
    (req as { agentMemberId?: string }).agentMemberId = req.params.id as string;
    next();
  });

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

  /**
   * 以 `:id` 这个 Member 的身份 claim 一个 WorkItem。
   *
   * 走 `claimWorkItemForAgent`（与 tool 路径同一个服务方法）：execution 必须属于
   * 这个 Member 且正在跑，claim 成功后 execution.work_item_id 双向回写 ——
   * HTTP 路径不提供任何绕过审计绑定的捷径。
   */
  router.post('/members/:id/work-item-claims', async (req, res) => {
    const parsed = workItemClaimSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'workItemId / executionId 必填' });
      return;
    }
    try {
      // 身份一致性：token 授权的是「这个 runtime」，路径 :id 是「替谁说话」，
      // resolveActor 注入的身份必须与路径一致，防止用 A 的 token 替 B claim。
      const actor = resolveActor(req);
      if (actor.kind !== 'agent' || actor.principalId !== req.params.id) {
        res.status(403).json({ error: '调用方身份与路径中的 Member 不一致' });
        return;
      }
      const result = JSON.parse(
        await team.claimWorkItemForAgent({
          memberId: req.params.id,
          executionId: parsed.data.executionId,
          workItemId: parsed.data.workItemId,
        }),
      ) as unknown;
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
