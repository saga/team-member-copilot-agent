import express, { Router } from 'express';
import type { SkillService } from '../skill-service.js';
import { currentTeamId, isTeamAdmin } from '../middleware/teamScope.js';
import { isAdminAuthorized } from '../middleware/apiScope.js';
import { sendError } from '../middleware/errorHandler.js';

/** 装 skill 是改「Agent 能加载什么」，属于 Admin 面：token 或 Team role 任一通过。 */
function canAdmin(req: Parameters<typeof isAdminAuthorized>[0]): boolean {
  if (isAdminAuthorized(req)) return true;
  return isTeamAdmin(req, 'owner', 'admin');
}

/**
 * raw zip body。用 raw 而不是 multipart：只需要一个文件，引入 multipart parser
 * 只会多一层依赖和一个临时目录。文件名走 query —— `X-` 头在部分代理上会被吃掉。
 *
 * Content-Type 必须落在白名单里，否则 express.raw 不会解析，body 会是一个普通
 * 对象而不是 Buffer（路由里按 400 处理，而不是让 Buffer.isBuffer 静默失败）。
 */
const rawZip = express.raw({
  type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
  limit: '25mb',
});

function filenameOf(req: express.Request): string {
  return typeof req.query.filename === 'string' ? req.query.filename : 'skill.zip';
}

/**
 * Skill 内容投放的三个 scope。
 *
 * 它和 `/api/capabilities/*` 是两件事：那边回答「启用了哪个 skill 来源」，
 * 这边回答「磁盘上装了哪些 skill」。混在一起时界面上会出现「装了一个 skill
 * 却不知道谁在用它」。
 */
export function skillsRouter(skills: SkillService) {
  const router = Router();

  // ------------------------------------------------------------- global

  router.get('/global', (_req, res) => {
    try {
      res.json({ skills: skills.list({ kind: 'global' }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/global', rawZip, (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: '请以 application/zip 上传 skill' });
      return;
    }

    try {
      res.status(201).json({ skill: skills.install({ kind: 'global' }, req.body, filenameOf(req)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/global/:name', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    try {
      skills.remove({ kind: 'global' }, req.params.name);
      res.json({ skills: skills.list({ kind: 'global' }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // --------------------------------------------------------------- team

  router.get('/team', (_req, res) => {
    try {
      const teamId = currentTeamId();
      res.json({ teamId, skills: skills.list({ kind: 'team', teamId }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/team', rawZip, (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: '请以 application/zip 上传 skill' });
      return;
    }

    try {
      const teamId = currentTeamId();
      res.status(201).json({
        teamId,
        skill: skills.install({ kind: 'team', teamId }, req.body, filenameOf(req)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/team/:name', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    try {
      const teamId = currentTeamId();
      skills.remove({ kind: 'team', teamId }, req.params.name);
      res.json({ teamId, skills: skills.list({ kind: 'team', teamId }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ------------------------------------------------------------- member

  router.get('/members/:memberId', (req, res) => {
    try {
      res.json({ skills: skills.list({ kind: 'member', memberId: req.params.memberId }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/members/:memberId', rawZip, (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: '请以 application/zip 上传 skill' });
      return;
    }

    try {
      res.status(201).json({
        skill: skills.install({ kind: 'member', memberId: req.params.memberId }, req.body, filenameOf(req)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/members/:memberId/:name', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    try {
      skills.remove({ kind: 'member', memberId: req.params.memberId }, req.params.name);
      res.json({ skills: skills.list({ kind: 'member', memberId: req.params.memberId }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
