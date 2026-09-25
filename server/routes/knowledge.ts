import { Router } from 'express';
import { z } from 'zod';
import type { KnowledgeService } from '../knowledge-service.js';
import { sendError } from '../middleware/errorHandler.js';

const createBaseSchema = z.object({
  key: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const bindSchema = z.object({
  /** 全量替换：数组里有什么就绑什么，空数组 = 解绑全部。 */
  teamKnowledgeBaseIds: z.array(z.string().min(1)).max(100),
});

const documentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  relativePath: z.string().trim().min(1).max(500),
  content: z.string().max(500_000),
  sourceUri: z.string().url().nullable().optional(),
});

export function knowledgeRouter(knowledge: KnowledgeService) {
  const router = Router();

  router.get('/team', (_req, res) => {
    res.json({ knowledgeBases: knowledge.listTeamKnowledgeBases() });
  });

  router.post('/team', (req, res) => {
    const parsed = createBaseSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      res.status(201).json({ knowledgeBase: knowledge.createTeamKnowledgeBase(parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/members/:memberId', (req, res) => {
    try {
      res.json(knowledge.listForMember(req.params.memberId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/members/:memberId', (req, res) => {
    const parsed = bindSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      res.json({
        teamKnowledgeBases: knowledge.setTeamKnowledgeBases(
          req.params.memberId,
          parsed.data.teamKnowledgeBaseIds,
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/bases/:knowledgeBaseId/documents', (req, res) => {
    const parsed = documentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      const document = knowledge.writeDocument({
        knowledgeBaseId: req.params.knowledgeBaseId,
        title: parsed.data.title,
        relativePath: parsed.data.relativePath,
        content: parsed.data.content,
        sourceUri: parsed.data.sourceUri ?? null,
      });
      res.status(201).json({ document });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
