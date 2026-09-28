import type { NextFunction, Request, Response } from 'express';
import type { TeamService } from '../team-service.js';
import type { Conversation } from '../domain.js';
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

/**
 * 房间归属已解析出来之后的统一判定。
 *
 * ── human 为什么是两道闸 ──────────────────────────────────────────────
 *
 *   1. 是这个 Conversation 所在 Team 的 active 成员（身份）
 *   2. 在这间房的参与者名单里，或者是 Team 的 owner/admin（授权）
 *
 * 只做第 1 道曾经是够的 —— 单机单用户时「Team 成员」和「这间房的人」是同一
 * 批人。多用户之后它们分开了：同一个 Team 的两个 human 各自在不同房间里工作，
 * 而 execution / task / message 是**房间里的东西**（prompt、工具调用、文件引用
 * 全在里面）。少了第 2 道，任何 Team 成员都能按 id 遍历别人的房间 ——
 * 而这件事从界面上完全看不出来，因为 UI 只列出自己的房间。
 *
 * ── 为什么 owner/admin 保留兜底 ───────────────────────────────────────
 *
 * 收紧到「只认 participant」会让现有 owner 立刻看不见已有房间（这张表是新加的，
 * 历史房间没有回填）。那是个**迁移问题**，不是权限问题，不该用「让所有人先失联」
 * 来解决。
 *
 * 而 owner/admin 本来就能改 capability boundary（谁能用什么工具）、能装 skill、
 * 能改 knowledge —— 让他们多看几间房并不构成实质性的权限提升。越权面从
 * 「全体 Team 成员」缩到「owner/admin」，这才是这次收紧真正关掉的东西。
 *
 * ── agent 为什么仍然只看成员关系 ──────────────────────────────────────
 *
 * Agent 的身份由 /api/internal 注入，它的「能进哪间房」就是 conversation_member
 * ——那是唤醒与上下文派发的同一份名单。给它再加一层 participant 只会让
 * 「被唤醒但读不到房间」这种状态成为可能。
 *
 * ── 为什么先解析归属、再判定 ─────────────────────────────────────────
 *
 * 「房间不存在」必须回 404，「存在但你没权限」必须回 403 —— 对调用方是两件不同
 * 的事。所以这里不能直接把 id 交给布尔判定：那个版本为了能批量过滤，把「查不到」
 * 也归成了 false，于是不存在的房间会拿到 403，调用方会去查权限配置，而真正的问题
 * 是它把 id 拼错了。
 */
function requireAccessToConversation(team: TeamService, req: Request, conversationId: string): void {
  const conversation = team.getConversation(conversationId);
  if (!canAccessResolvedConversation(team, req, conversation)) {
    throw forbidden('你没有访问这间 Conversation 的权限');
  }
}

/**
 * 同一个判定的**布尔版**，供「批量过滤」使用（审批收件箱按状态跨房间列 Command）。
 *
 * 必须是同一份实现：`requireAccessToConversation` 就是它的否定。两处各写一套
 * 判据的结果是「列表过滤掉了但详情能打开」或者反过来 —— 而后者更危险，
 * 因为界面看起来是对的。
 *
 * 「资源不存在」也返回 false：批量过滤时一条查不到的记录不该让整个请求失败
 * （单条路径上的 404 由 `requireAccessToConversation` 先解析归属时抛）。
 */
export function canAccessConversation(
  team: TeamService,
  req: Request,
  conversationId: string,
): boolean {
  let conversation: Conversation;
  try {
    conversation = team.getConversation(conversationId);
  } catch {
    return false;
  }
  return canAccessResolvedConversation(team, req, conversation);
}

/** 归属已知时的判定本体 —— 上面两个入口共用它，保证只有一份权限判据。 */
function canAccessResolvedConversation(
  team: TeamService,
  req: Request,
  conversation: Conversation,
): boolean {
  const actor = resolveActor(req);

  try {
    if (actor.kind === 'human') {
      const membership = team.requireTeamHumanAccess(conversation.teamId, actor.principalId);

      // owner/admin：Team 级兜底访问。
      if (membership.role === 'owner' || membership.role === 'admin') return true;

      return team.isConversationParticipant(conversation.id, 'human', actor.principalId);
    }

    return conversation.members.some((m) => m.id === actor.principalId);
  } catch {
    return false;
  }
}

function denyWith(res: Response, error: unknown): void {
  const status = (error as { status?: number }).status ?? 403;
  res.status(status).json({
    error: error instanceof Error ? error.message : String(error),
  });
}
