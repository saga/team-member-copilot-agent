import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { sendError } from '../middleware/errorHandler.js';
import { isAdminAuthorized } from '../middleware/apiScope.js';
import { currentTeamId, isTeamAdmin } from '../middleware/teamScope.js';

/** 改 capability boundary 必须 owner/admin：token 或 Team role 任一通过。 */
function canAdmin(req: Parameters<typeof isAdminAuthorized>[0]): boolean {
  if (isAdminAuthorized(req)) return true;
  return isTeamAdmin(req, 'owner', 'admin');
}

/**
 * 能力组成（Skill / Knowledge / Tool 的 Provider 引用），分三层。
 *
 *   /global                    公司级基线，所有 Agent 默认继承
 *   /team                      Team 级基线，Team 内所有 Agent 继承
 *   /members/:memberId         某个 Member 的**增量**能力
 *   /members/:memberId/effective  三层叠加后的解析结果 + 各层声明
 *
 * 「这个 Member 能用什么」的唯一答案现在是 **effective**（三层叠加），不是任何
 * 单层。只给 member 层会让界面显示出一个「什么都不会的人」—— 而它其实继承了
 * 公司级和团队级的能力。
 *
 * `GET /api/capabilities/skills/*` 回答的是另一件事：**磁盘上装了哪些 skill**
 * （内容投放），不是「启用了哪个 skill 来源」。两者混在一起时，界面上会出现
 * 「装了一个 skill 却不知道谁在用它」。
 */

const bindingSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  /** Provider 自己解释的选择子。knowledge 用（KB key / `$personal`），skill / tool 通常不写。 */
  selector: z.string().max(300).optional(),
});

const capabilitiesSchema = z.object({
  skills: z.array(bindingSchema).max(100),
  knowledge: z.array(bindingSchema).max(100),
  tools: z.array(bindingSchema).max(100),
});

function parseCapabilities(body: unknown) {
  const parsed = capabilitiesSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw Object.assign(
      new Error(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
      ),
      { status: 400 },
    );
  }
  return parsed.data;
}

export function capabilitiesRouter(team: TeamService, registry: CapabilityRegistry) {
  const router = Router();

  // 平台装了哪些 Provider：管理界面列选项用，不暴露任何实现细节。
  router.get('/providers', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    res.json({ providers: registry.listProviders() });
  });

  // ------------------------------------------------------------- global

  router.get('/global', (_req, res) => {
    try {
      res.json({ capabilities: team.getGlobalCapabilities() });
    } catch (error) {
      sendError(res, error);
    }
  });

  // 改的是**所有 Agent** 的能力边界：必须 owner/admin。
  router.put('/global', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    try {
      res.json({ capabilities: team.updateGlobalCapabilities(parseCapabilities(req.body)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // --------------------------------------------------------------- team

  router.get('/team', (_req, res) => {
    try {
      const teamId = currentTeamId();
      res.json({ teamId, capabilities: team.getTeamCapabilities(teamId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/team', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    try {
      const teamId = currentTeamId();
      res.json({
        teamId,
        capabilities: team.updateTeamCapabilities(teamId, parseCapabilities(req.body)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ------------------------------------------------------------- member

  // 读不需要 admin：它只是「当前配置长什么样」。
  router.get('/members/:memberId', (req, res) => {
    try {
      res.json({ capabilities: team.getMemberCapabilities(req.params.memberId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/members/:memberId', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
      return;
    }
    try {
      res.json({
        capabilities: team.updateMemberCapabilities(req.params.memberId, parseCapabilities(req.body)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 三层声明 + 解析结果。
   *
   * 放在 `/members/:memberId` 之下而不是另起一个 `/effective` 命名空间：它描述
   * 的就是这个 Member 的能力全景，区别只是「要哪一层的视角」。
   */
  router.get('/members/:memberId/effective', (req, res) => {
    try {
      const teamId = currentTeamId();
      res.json({ teamId, config: team.getCapabilityConfig(teamId, req.params.memberId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
