import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';

/**
 * Member 的能力组成（Skill / Knowledge / Tool 的 Provider 引用）。
 *
 * 这是「这个 Member 能用什么」的唯一写入口。它以前散在三个地方：
 * member.tool_profile（一个二值档位）、knowledge 路由（绑 team KB）、
 * 以及代码里硬编码的工具清单。三者各自表达一部分能力，于是没有任何一处能回答
 * 「它到底能用什么」—— 现在答案是这一份 binding 列表。
 *
 * `GET /api/members/:id/skills` 仍然存在，但它回答的是另一件事：**磁盘上装了哪些
 * skill**（内容投放），不是「启用了哪个 skill 来源」。两者混在一起时，界面上
 * 会出现「装了一个 skill 却不知道谁在用它」。
 */

const bindingSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  /** Provider 自己解释的选择子。knowledge 用（KB key / `$personal`），skill / tool 通常不写。 */
  selector: z.string().max(300).optional(),
});

const capabilitiesSchema = z.object({
  skills: z.array(bindingSchema).max(100),
  knowledge: z.array(bindingSchema).max(100),
  tools: z.array(bindingSchema).max(100),
});

export function capabilitiesRouter(team: TeamService) {
  const router = Router();

  router.get('/members/:memberId', (req, res) => {
    try {
      res.json({ capabilities: team.getMemberCapabilities(req.params.memberId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/members/:memberId', (req, res) => {
    const parsed = capabilitiesSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
      });
      return;
    }

    try {
      res.json({
        capabilities: team.updateMemberCapabilities(req.params.memberId, parsed.data),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
