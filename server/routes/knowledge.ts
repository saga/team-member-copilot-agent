import { Router } from 'express';
import { z } from 'zod';
import type { LocalFilesystemKnowledgeProvider } from '../capabilities/providers/filesystem-knowledge.js';
import { sendError } from '../middleware/errorHandler.js';

/**
 * `local.filesystem-knowledge` 这个 Provider 的管理面。
 *
 * 它回答的是「本地后端里有哪些库、库里有什么文档」，**不包括**「哪个 Member 能看
 * 哪个库」—— 绑定关系归 `/api/capabilities/members/:id`。分开的理由很具体：
 * 绑定是能力声明（换后端也成立），而「建库、写文档」是本地实现专有的运维动作。
 * 混在一个命名空间里，会让人以为换掉后端之后这套接口还会存在。
 */

const createBaseSchema = z.object({
  key: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const documentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  relativePath: z.string().trim().min(1).max(500),
  content: z.string().max(500_000),
  sourceUri: z.string().url().nullable().optional(),
});

export function knowledgeRouter(knowledge: LocalFilesystemKnowledgeProvider) {
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
