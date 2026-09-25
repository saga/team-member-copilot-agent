import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';

const createMemberSchema = z.object({
  name: z.string().trim().min(1).max(100),
  handle: z.string().trim().min(1).max(50).optional(),
  role: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  style: z.string().max(2000).optional(),
  systemPrompt: z.string().max(12000).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  toolProfile: z.enum(['safe', 'coding']).optional(),
});

/**
 * 更新用的 schema 单独写，不复用 `createMemberSchema.partial()`：
 * 两者有两处真实差异 ——
 *
 * 1. `model` 允许显式 `null`（清空 → 回落到 COPILOT_MODEL），
 *    `.partial()` 只会保留 `string | undefined`，`null` 会被 400 掉。
 * 2. `handle` 可以改（create 时省略则由 name 推导）。
 *
 * 所有字段都是 optional：省略 = 不改。
 */
const updateMemberSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  handle: z.string().trim().min(1).max(50).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  style: z.string().max(2000).optional(),
  systemPrompt: z.string().max(12000).optional(),
  model: z.string().trim().max(100).nullable().optional(),
  toolProfile: z.enum(['safe', 'coding']).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export function membersRouter(team: TeamService) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ members: team.listMembers() });
  });

  router.post('/', (req, res) => {
    const parsed = createMemberSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      res.status(201).json({ member: team.createMember(parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      res.json({ member: team.getMember(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:id', (req, res) => {
    const parsed = updateMemberSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      res.json({ member: team.updateMember(req.params.id, parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
