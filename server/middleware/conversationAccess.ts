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

      const conversation = team.getConversation(conversationId);
      const actor = resolveActor(req);

      if (actor.kind === 'human') {
        team.requireTeamHumanAccess(conversation.teamId, actor.principalId);
        next();
        return;
      }

      if (!conversation.members.some((m) => m.id === actor.principalId)) {
        throw forbidden('Agent 不属于这个 Conversation');
      }

      next();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 403;
      res.status(status).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
