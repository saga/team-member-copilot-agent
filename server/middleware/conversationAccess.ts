import type { NextFunction, Request, Response } from 'express';
import type { TeamService } from '../team-service.js';
import { resolveActor } from './teamScope.js';
import { forbidden } from '../http-error.js';

export function requireConversationAccess(team: TeamService, paramName = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const conversationId = req.params[paramName];
      if (typeof conversationId !== 'string' || !conversationId) {
        throw forbidden('缺少 conversation id');
      }

      requireAccessToConversation(team, req, conversationId);
      next();
    } catch (error) {
      denyWith(res, error);
    }
  };
}

/**
 * 通过**子资源**（execution / task）间接鉴权。
 *
 * ── 为什么不能只看 Team 成员身份 ──────────────────────────────────────
 *
 * `requireTeamMember()` 只回答「你是这个 Team 的人」。而 execution / task 是
 * **房间里的东西**：同一个 Team 的两个 Member 各自在跑不同的房间，能进 Team
 * 不等于能看另一个房间的执行记录。少了这一层，任何 Team 成员都能按 id 遍历
 * 别人的 execution —— 里面有 prompt、工具调用、文件引用。
 *
 * ── 为什么用「解析出 conversationId 再复用同一段判定」 ───────────────
 *
 * 而不是在这里再写一遍 human/agent 的分支：那样两处判定会各自漂移，而漂移的
 * 表现是「房间进不去但执行记录看得见」这种半开的状态。解析归属是这一步唯一
 * 的新逻辑，权限判定必须与直接访问房间时完全一致。
 *
 * 子资源不存在时抛 404（而不是 403）：`getExecution` 自己会抛 notFound，
 * 而「不存在」与「存在但你没权限」对调用方是两件不同的事 —— 后者会让人以为
 * 是权限配置错了。
 */
export function requireResourceConversationAccess(
  team: TeamService,
  resolveConversationId: (resourceId: string) => string,
  paramName = 'id',
  label = '资源',
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const resourceId = req.params[paramName];
      if (typeof resourceId !== 'string' || !resourceId) {
        throw forbidden(`缺少 ${label} id`);
      }

      requireAccessToConversation(team, req, resolveConversationId(resourceId));
      next();
    } catch (error) {
      denyWith(res, error);
    }
  };
}

/** 归属已解析出来的房间：human 看 Team 成员身份，agent 看自己在不在这个房间。 */
function requireAccessToConversation(team: TeamService, req: Request, conversationId: string): void {
  const conversation = team.getConversation(conversationId);
  const actor = resolveActor(req);

  if (actor.kind === 'human') {
    team.requireTeamHumanAccess(conversation.teamId, actor.principalId);
    return;
  }

  if (!conversation.members.some((m) => m.id === actor.principalId)) {
    throw forbidden('Agent 不属于这个 Conversation');
  }
}

function denyWith(res: Response, error: unknown): void {
  const status = (error as { status?: number }).status ?? 403;
  res.status(status).json({
    error: error instanceof Error ? error.message : String(error),
  });
}
