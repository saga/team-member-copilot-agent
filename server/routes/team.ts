import { Router } from 'express';
import { z } from 'zod';
import type { TeamStructureService } from '../team-structure-service.js';
import type { StoredTeamEvent, TeamEventService } from '../team-event-service.js';
import { sendError } from '../middleware/errorHandler.js';
import { isAdminAuthorized } from '../middleware/apiScope.js';
import { parseSince } from './conversations.js';
import {
  currentTeamId,
  requireTeamMember,
  isTeamAdmin,
  resolveActor,
} from '../middleware/teamScope.js';
import type { TeamParticipantKind } from '../domain.js';

/**
 * Team 领域路由：Team / Membership / Presence / Schedule / Current Activity。
 * 一个 Router 承载整个领域，不拆几十个文件。
 */
const scheduleSchema = z.object({
  memberId: z.string().min(1),
  conversationId: z.string().min(1),
  prompt: z.string().trim().min(1).max(8000),
  type: z.enum(['once', 'interval']),
  runAt: z.string().min(1),
  intervalSeconds: z.number().int().positive().nullable().optional(),
});

function adminOrRole(req: { headers: unknown; query: unknown } & { [k: string]: unknown }): boolean {
  // 过渡期：ADMIN_API_TOKEN 通过即视为 admin；Team role 接管后以 role 为准。
  // 两者任一通过即可，避免 token 部署与 membership 部署互相卡死。
  const asRequest = req as unknown as Parameters<typeof isAdminAuthorized>[0];
  if (isAdminAuthorized(asRequest)) return true;
  return isTeamAdmin(asRequest, 'owner', 'admin');
}


export function teamRouter(structure: TeamStructureService, teamEvents: TeamEventService) {
  const router = Router();

  /**
   * Team 级实时事件（Member Activity / Schedule / Presence / External Work /
   * Membership）。
   *
   * 语义与 Conversation SSE 相同：事件先落 team_event 再广播，SSE 帧带
   * `id: <sequence>`，断线重连由浏览器自动带 Last-Event-ID 补发。当前部署
   * 只有一个 Team，所以端点不带 teamId —— teamScope 的默认 Team 即目标。
   */
  router.get('/events', requireTeamMember(), (req, res) => {
    const teamId = currentTeamId();
    const since = parseSince(req.headers['last-event-id'], req.query.since);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);
    res.write('retry: 3000\n\n');
    res.write(`event: connected\ndata: ${JSON.stringify({ teamId, since })}\n\n`);

    const send = (event: StoredTeamEvent) => {
      res.write(
        [`id: ${event.sequence}`, `event: ${event.type}`, `data: ${JSON.stringify(event.data)}`].join('\n') +
          '\n\n',
      );
    };

    const unsubscribe = teamEvents.replayAndSubscribe(teamId, since, send);

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  router.get('/', requireTeamMember(), (_req, res) => {
    try {
      res.json({ team: structure.getTeam(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/members', requireTeamMember(), (_req, res) => {
    try {
      res.json({ members: structure.listMemberships(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/members/:kind/:id', (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!adminOrRole(req as any)) {
      res.status(403).json({ error: '需要 Team owner/admin' });
      return;
    }
    const parsed = z.object({ role: z.enum(['owner', 'admin', 'member']).optional(), status: z.enum(['active', 'inactive']).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'role/status 不合法' });
      return;
    }
    try {
      const kind = req.params.kind as 'human' | 'agent';
      res.json({ member: structure.updateMembership(currentTeamId(), kind, (req.params.id as string), parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Current Work：谁在干什么。挂了 Jira 工单的给出引用，明细在 Jira。 */
  router.get('/activity', requireTeamMember(), (_req, res) => {
    try {
      res.json({ activity: structure.listCurrentActivity(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/presence', requireTeamMember(), (_req, res) => {
    try {
      res.json({ presence: structure.listPresence(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/presence/:kind/:id', requireTeamMember(), (req, res) => {
    const parsed = z.object({ availability: z.enum(['available', 'away', 'paused']) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'availability 不合法' });
      return;
    }
    // 本人改本人，Admin 改别人：Human A 不能暂停 Agent B，Agent 也不能改别人。
    const actor = resolveActor(req);
    const targetKind = req.params.kind as TeamParticipantKind;
    const targetId = req.params.id as string;
    const isSelf = actor.kind === targetKind && actor.principalId === targetId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!isSelf && !isTeamAdmin(req as any, 'owner', 'admin')) {
      res.status(403).json({ error: '只能修改自己的 Presence' });
      return;
    }
    try {
      res.json({
        presence: structure.setAvailability(currentTeamId(), targetKind, targetId, parsed.data.availability),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/schedules', requireTeamMember(), (_req, res) => {
    try {
      res.json({ schedules: structure.listSchedules(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/schedules', (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!adminOrRole(req as any)) {
      res.status(403).json({ error: '需要 Team owner/admin' });
      return;
    }
    const parsed = scheduleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      // created_by 记真实调用方，不再写死 local actor。当前部署都是人类 Admin
      // 操作，所以不需要把 created_by 拆成 kind/id；接认证后 resolveActor
      // 换实现即可，这里不动。
      const actor = resolveActor(req);
      res.status(201).json({ schedule: structure.createSchedule(currentTeamId(), parsed.data, actor.principalId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  for (const [path, status] of [['/schedules/:id/pause', 'paused'], ['/schedules/:id/resume', 'active'], ['/schedules/:id/cancel', 'cancelled']] as const) {
    router.post(path, (req, res) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!adminOrRole(req as any)) {
        res.status(403).json({ error: '需要 Team owner/admin' });
        return;
      }
      try {
        res.json({ schedule: structure.updateScheduleStatus((req.params.id as string), status) });
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  router.patch('/schedules/:id', (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!adminOrRole(req as any)) {
      res.status(403).json({ error: '需要 Team owner/admin' });
      return;
    }
    const parsed = z.object({ status: z.enum(['active', 'paused', 'completed', 'cancelled']) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'status 不合法' });
      return;
    }
    try {
      res.json({ schedule: structure.updateScheduleStatus((req.params.id as string), parsed.data.status) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
