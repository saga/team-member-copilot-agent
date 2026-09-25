import { Router } from 'express';
import { z } from 'zod';
import type { TeamStructureService } from '../team-structure-service.js';
import { sendError } from '../middleware/errorHandler.js';
import { isAdminAuthorized } from '../middleware/apiScope.js';
import { currentTeamId, isTeamAdmin } from '../middleware/teamScope.js';
import { config } from '../config.js';

/**
 * Team 领域路由：Team / Membership / Project / WorkItem / Presence / Schedule。
 * 一个 Router 承载整个领域，不拆几十个文件。
 */
const projectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const workItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(8000).optional(),
  projectId: z.string().min(1).nullable().optional(),
});

const updateWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(8000).optional(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
});

const assignSchema = z.object({
  kind: z.enum(['human', 'agent']).nullable().optional(),
  principalId: z.string().min(1).nullable().optional(),
});

const claimSchema = z.object({
  memberId: z.string().min(1),
  executionId: z.string().min(1).nullable().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

const scheduleSchema = z.object({
  memberId: z.string().min(1),
  conversationId: z.string().min(1),
  projectId: z.string().min(1).nullable().optional(),
  workItemId: z.string().min(1).nullable().optional(),
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

export function teamRouter(structure: TeamStructureService) {
  const router = Router();

  router.get('/', (_req, res) => {
    try {
      res.json({ team: structure.getTeam(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/members', (_req, res) => {
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
      res.json({ member: structure.updateMembership(currentTeamId(), kind, req.params.id, parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/projects', (_req, res) => {
    try {
      res.json({ projects: structure.listProjects(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/projects', (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!adminOrRole(req as any)) {
      res.status(403).json({ error: '需要 Team owner/admin' });
      return;
    }
    const parsed = projectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'name 必填' });
      return;
    }
    try {
      res.status(201).json({ project: structure.createProject(currentTeamId(), parsed.data, config.localActorId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/projects/:id', (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!adminOrRole(req as any)) {
      res.status(403).json({ error: '需要 Team owner/admin' });
      return;
    }
    const parsed = z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(), status: z.enum(['active', 'archived']).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: '参数不合法' });
      return;
    }
    try {
      res.json({ project: structure.updateProject(req.params.id, parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/work-items', (req, res) => {
    try {
      const query = req.query as Record<string, string>;
      res.json({
        workItems: structure.listWorkItems(currentTeamId(), {
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.status ? { status: query.status as 'todo' } : {}),
        }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/work-items', (req, res) => {
    const parsed = workItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'title 必填' });
      return;
    }
    try {
      res.status(201).json({ workItem: structure.createWorkItem(currentTeamId(), parsed.data, config.localActorId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/work-items/:id', (req, res) => {
    try {
      res.json({ workItem: structure.getWorkItem(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/work-items/:id', (req, res) => {
    const parsed = updateWorkItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: '参数不合法' });
      return;
    }
    try {
      // actor 取 human 占位；agent 经 tool 路径带 claimer 身份（见 core-tools）。
      const actor = { kind: 'human' as const, principalId: config.localActorId, teamRole: undefined as 'owner' | 'admin' | undefined };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (adminOrRole(req as any)) actor.teamRole = 'admin';
      res.json({ workItem: structure.updateWorkItem(req.params.id, parsed.data, actor) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/work-items/:id/assign', (req, res) => {
    const parsed = assignSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'assignee 不合法' });
      return;
    }
    try {
      const assignee =
        parsed.data.kind && parsed.data.principalId
          ? { kind: parsed.data.kind, principalId: parsed.data.principalId }
          : null;
      res.json({ workItem: structure.assignWorkItem(req.params.id, assignee) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/work-items/:id/claim', (req, res) => {
    const parsed = claimSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'memberId 必填' });
      return;
    }
    try {
      res.json({ workItem: structure.claimWorkItem(req.params.id, parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/work-items/:id/release', (req, res) => {
    const parsed = z.object({ memberId: z.string().min(1).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: '参数不合法' });
      return;
    }
    try {
      res.json({ workItem: structure.releaseWorkItem(req.params.id, parsed.data.memberId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/presence', (_req, res) => {
    try {
      res.json({ presence: structure.listPresence(currentTeamId()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/presence/:kind/:id', (req, res) => {
    const parsed = z.object({ availability: z.enum(['available', 'away', 'paused']) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'availability 不合法' });
      return;
    }
    try {
      res.json({
        presence: structure.setAvailability(currentTeamId(), req.params.kind as 'human' | 'agent', req.params.id, parsed.data.availability),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/schedules', (_req, res) => {
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
      res.status(201).json({ schedule: structure.createSchedule(currentTeamId(), parsed.data, config.localActorId) });
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
        res.json({ schedule: structure.updateScheduleStatus(req.params.id, status) });
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
      res.json({ schedule: structure.updateScheduleStatus(req.params.id, parsed.data.status) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
