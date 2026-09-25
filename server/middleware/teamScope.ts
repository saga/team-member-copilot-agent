import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { forbidden } from '../http-error.js';
import type { TeamParticipantKind, TeamRole } from '../domain.js';
import type { TeamStructureService } from '../team-structure-service.js';

/**
 * Team 级 Actor 与 Role 门禁。
 *
 * Human actor：浏览器请求，无真正认证时 principalId = LOCAL_ACTOR_ID。
 * Agent actor：/api/internal 下的调用，principalId = 路径里的 Member id。
 * 后面接 Entra/OIDC 时只替换 resolveActor，不动每个路由。
 */
export interface ActorContext {
  kind: TeamParticipantKind;
  principalId: string;
}

let structure: TeamStructureService | null = null;
let defaultTeamId: string | null = null;

export function initTeamScope(service: TeamStructureService, teamId: string): void {
  structure = service;
  defaultTeamId = teamId;
}

/** 解析当前调用方。internal 路径由调用方显式带 agent 身份，其余一律 human。 */
export function resolveActor(req: Request): ActorContext {
  const agentId = (req as { agentMemberId?: unknown }).agentMemberId;
  if (typeof agentId === 'string' && agentId) return { kind: 'agent', principalId: agentId };
  const header = req.headers['x-agent-id'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === 'string' && headerValue) return { kind: 'agent', principalId: headerValue };
  return { kind: 'human', principalId: config.localActorId };
}

function teamOf(req: Request): string {
  const query = (req.query as Record<string, unknown>).teamId;
  if (typeof query === 'string' && query) return query;
  if (!defaultTeamId || !structure) throw forbidden('Team 尚未初始化');
  return defaultTeamId;
}

/** 必须是 active Team 成员（human 或 agent）。读接口用它。 */
export function requireTeamMember() {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (!structure || !defaultTeamId) throw forbidden('Team 尚未初始化');
      const actor = resolveActor(req);
      structure.requireActiveMembership(teamOf(req), actor.kind, actor.principalId);
      next();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 403;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** 必须是 owner/admin。改 capability boundary 的写入用它。 */
export function requireTeamRole(...roles: TeamRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (!structure || !defaultTeamId) throw forbidden('Team 尚未初始化');
      const actor = resolveActor(req);
      // Agent 永不直接授 admin：agent 的越权操作走 tool 授权，不走 HTTP role。
      if (actor.kind === 'agent') {
        res.status(403).json({ error: 'Agent 不能直接调用 Admin 接口' });
        return;
      }
      const membership = structure.requireActiveMembership(teamOf(req), actor.kind, actor.principalId);
      if (!roles.includes(membership.role)) {
        res.status(403).json({ error: `需要 Team 角色：${roles.join('/')}` });
        return;
      }
      next();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 403;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** 同步版，供 handler 内部分流（避免 Express 5 多 handler 类型退化）。 */
export function isTeamAdmin(req: Request, ...roles: TeamRole[]): boolean {
  if (!structure || !defaultTeamId) return false;
  try {
    const actor = resolveActor(req);
    if (actor.kind === 'agent') return false;
    const membership = structure.requireActiveMembership(teamOf(req), actor.kind, actor.principalId);
    return roles.includes(membership.role);
  } catch {
    return false;
  }
}

export function currentTeamId(): string {
  if (!defaultTeamId) throw forbidden('Team 尚未初始化');
  return defaultTeamId;
}
