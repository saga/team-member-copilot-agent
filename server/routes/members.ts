import express, { Router } from 'express';
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

const memorySchema = z.object({
  content: z.string().max(200_000),
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

  /**
   * Member 的长期记忆（全文，不是给 prompt 用的截断版）。
   *
   * 记忆文件在 `.data/members/<id>/memory/MEMORY.md`，同时被
   * buildMemberSystemPrompt 注入到每一轮的 persona 里。
   */
  router.get('/:id/memory', (req, res) => {
    try {
      res.json({ content: team.getMemberMemory(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** 整体覆盖。PUT 而不是 PATCH：调用方提交的就是文件的全部内容。 */
  router.put('/:id/memory', (req, res) => {
    const parsed = memorySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'content 必须是 string' });
      return;
    }
    try {
      res.json({ content: team.replaceMemberMemory(req.params.id, parsed.data.content) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ------------------------------------------------- Member ↔ Member 私聊

  /**
   * 这个 Member 参与的全部私聊，按最后活动时间倒序。
   *
   * 私聊房间在库里就是「两个 Member 的 direct conversation」—— 复用 direct
   * 而不是新增 kind，是为了不动 `conversation.kind` 的 CHECK 约束
   * （SQLite 改不了它，只能重建表，而这张表被 6 张表 FK 引用）。
   *
   * 写入那一半（以某个 Member 的身份发消息）不在这里：它属于 Internal API，
   * 见 routes/internal.ts。这里只读 —— 读不需要「我代表谁」。
   */
  router.get('/:id/direct-messages', (req, res) => {
    try {
      res.json({ conversations: team.listDirectMessages(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // --------------------------------------------------------------- skills

  router.get('/:id/skills', (req, res) => {
    try {
      res.json({ skills: team.listMemberSkills(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 上传安装一个 skill（zip）。
   *
   * 用 raw body 而不是 multipart：只需要一个文件，引入 multipart parser 只会
   * 多一层依赖和一个临时目录。文件名走 query —— `X-` 头在部分代理上会被吃掉。
   *
   * Content-Type 必须落在下面的白名单里，否则 express.raw 不会解析，body 会是
   * 一个普通对象而不是 Buffer（这时按 400 处理，而不是让 Buffer.isBuffer 静默失败）。
   */
  router.post(
    '/:id/skills',
    express.raw({
      type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
      limit: '25mb',
    }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({
          error: '请以 application/zip（或 application/octet-stream）上传 skill 压缩包',
        });
        return;
      }

      const filename = typeof req.query.filename === 'string' ? req.query.filename : 'skill.zip';

      try {
        res.status(201).json({ skill: team.installMemberSkill(req.params.id, req.body, filename) });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.delete('/:id/skills/:name', (req, res) => {
    try {
      team.removeMemberSkill(req.params.id, req.params.name);
      res.json({ skills: team.listMemberSkills(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
