import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';
import { isAdminAuthorized } from '../middleware/apiScope.js';
import { isTeamAdmin } from '../middleware/teamScope.js';

function canAdmin(req: Parameters<typeof isAdminAuthorized>[0]): boolean {
  if (isAdminAuthorized(req)) return true;
  return isTeamAdmin(req, 'owner', 'admin');
}

const createMemberSchema = z.object({
  name: z.string().trim().min(1).max(100),
  handle: z.string().trim().min(1).max(50).optional(),
  role: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  style: z.string().max(2000).optional(),
  systemPrompt: z.string().max(12000).optional(),
  model: z.string().trim().min(1).max(100).optional(),
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
 *
 * 「能用什么」不在这里 —— 那是 `/api/capabilities/members/:id` 的事。把能力
 * 混进身份编辑，会让「改个名字」和「给它开 shell 权限」变成同一个请求。
 */
const updateMemberSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  handle: z.string().trim().min(1).max(50).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  style: z.string().max(2000).optional(),
  systemPrompt: z.string().max(12000).optional(),
  model: z.string().trim().max(100).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const memorySchema = z.object({
  content: z.string().max(200_000),
  /**
   * GET 时拿到的 `version`（全文 sha256）。省略 = 不校验。
   *
   * 这条路径有两个人写同一个文件：人在这里编辑，Agent 在 turn 里调
   * remember_member。带上版本，中间那次写入才不会被一次全文覆盖吃掉。
   */
  expectedVersion: z.string().min(1).max(200).optional(),
});

export function membersRouter(team: TeamService) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ members: team.listMembers() });
  });

  // 建 Member 自带一组默认能力，归档则决定它接不接活：都是 Admin 面的写入。
  router.post('/', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
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

  // 改名字/人设是 Human 面；改 status（归档/恢复）是 Admin 面（决定接不接活）。
  // 同一条 PATCH 上按 body 里有没有 status 分流，避免「改个名字也要 admin token」。
  router.patch('/:id', (req, res) => {
    if ((req.body as { status?: unknown } | undefined)?.status !== undefined && !canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
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
   *
   * 返回 `{ content, version }`：version 是 content 的 sha256，保存时要带回去。
   */
  router.get('/:id/memory', (req, res) => {
    try {
      res.json(team.getMemberMemory(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 整体覆盖。PUT 而不是 PATCH：调用方提交的就是文件的全部内容。
   *
   * 带上 `expectedVersion` 时做乐观并发校验；不一致返回 409 且**不写盘**。
   * 不带则强制覆盖。
   */
  router.put('/:id/memory', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    const parsed = memorySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'content 必须是 string（expectedVersion 可选）' });
      return;
    }
    try {
      res.json(
        team.replaceMemberMemory(req.params.id, parsed.data.content, parsed.data.expectedVersion),
      );
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 这个 Member 在某一个 Team 的上下文（全文，不是给 prompt 用的截断版）。
   *
   * `teamId` 走 query，省略 = 当前默认 Team：单 Team 部署下调用方不需要知道
   * Team 的存在。多 Team 后按显式 teamId 读写 —— 未来形如
   * `/api/teams/:teamId/members/:memberId/context` 的嵌套路由出现时，
   * 这个 query 参数直接变成路径参数，不留两套。
   */
  router.get('/:id/team-context', (req, res) => {
    try {
      const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : undefined;
      res.json(team.getMemberTeamContext(req.params.id, teamId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/:id/team-context', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    const parsed = memorySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'content 必须是 string（expectedVersion 可选）' });
      return;
    }
    try {
      const body = req.body as { teamId?: unknown };
      const teamId = typeof body.teamId === 'string' ? body.teamId : undefined;
      res.json(
        team.replaceMemberTeamContext(
          req.params.id,
          parsed.data.content,
          teamId,
          parsed.data.expectedVersion,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * Member 视角的历史：参与过的 conversation（按最后活动倒序）与所属 Team。
   *
   * 不建新表 —— 前者是 conversation_member 的 join，后者是 team_membership 的
   * join。Member Profile 的 Recent activity 只读这两条。
   */
  router.get('/:id/conversations', (req, res) => {
    try {
      res.json({ conversations: team.listMemberConversations(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id/teams', (req, res) => {
    try {
      res.json({ teams: team.listMemberTeams(req.params.id) });
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

  // Skill 的安装 / 列举 / 删除不在这里：skill 内容投放有三个 scope
  // （global / team / member），见 routes/skills.ts 的 /api/capabilities/skills/*。

  return router;
}
