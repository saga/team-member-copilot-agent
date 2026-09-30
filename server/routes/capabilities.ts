import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { SkillService } from '../skill-service.js';
import type { LocalFilesystemKnowledgeProvider } from '../capabilities/providers/filesystem-knowledge.js';
import {
  buildCatalog,
  assignmentsToBindings,
  type CatalogDeps,
  type CatalogScope,
} from '../capabilities/catalog.js';
import { sendError } from '../middleware/errorHandler.js';
import { isAdminAuthorized } from '../middleware/apiScope.js';
import { currentTeamId, isTeamAdmin } from '../middleware/teamScope.js';

/** 改 capability boundary 必须 owner/admin：token 或 Team role 任一通过。 */
function canAdmin(req: Parameters<typeof isAdminAuthorized>[0]): boolean {
  if (isAdminAuthorized(req)) return true;
  return isTeamAdmin(req, 'owner', 'admin');
}

/**
 * 能力目录（管理员语言）：Skill / Knowledge / Action 的名字与开关。
 *
 * 这里只说「Security Review 开不开」「Financial Core 给不给」，
 * 不说 providerId / selector —— 后两者是内部实现，只存在 SQLite 与 Resolver 里，
 * 翻译由 `server/capabilities/catalog.ts` 负责。
 *
 *   GET /catalog?scope=global            公司级：所有 Team 与 Member 自动获得
 *   GET /catalog?scope=team              Team 级：Team 内所有 Member 自动获得
 *   GET /catalog?scope=member&memberId=  这个人额外拥有的 + 上面两层继承来的
 *   PUT /catalog                         全量替换某一层的选择（空数组 = 这一类全关）
 *
 * 读不需要 admin（只是「当前配置长什么样」），写要。
 */

const scopeSchema = z.enum(['global', 'team', 'member']);

const selectionSchema = z.object({
  scope: scopeSchema,
  memberId: z.string().min(1).max(200).optional(),
  skills: z.array(z.string().min(1).max(220)).max(200),
  knowledge: z.array(z.string().min(1).max(220)).max(200),
  tools: z.array(z.string().min(1).max(200)).max(200),
  // 必填：PUT 是整层全量替换，缺字段会被读成「这一类全关」。老客户端不发就 400，
  // 不能静默把已配好的 MCP 绑定清掉。
  mcp: z.array(z.string().min(1).max(220)).max(200),
});

export interface CapabilitiesRouterOptions {
  hostToolsEnabled: boolean;
}

export function capabilitiesRouter(
  team: TeamService,
  registry: CapabilityRegistry,
  skills: SkillService,
  knowledge: LocalFilesystemKnowledgeProvider,
  options: CapabilitiesRouterOptions,
) {
  const router = Router();

  /**
   * `teamId` 是必传的：member 层能力的读写都要落在某个 Team 的边界内。
   * 之前这里不带 Team，`memberId` 是唯一输入 —— 拿到别人的 id 就能读、能写
   * 别人 Team 里那个人的能力。
   */
  function deps(teamId: string): CatalogDeps {
    return {
      capabilities: {
        getGlobal: () => team.getGlobalCapabilities(),
        getTeam: (id: string) => team.getTeamCapabilities(id),
        getMember: (memberId: string) => team.getMemberCapabilities(teamId, memberId),
      },
      skills,
      knowledge,
      registry,
      hostToolsEnabled: options.hostToolsEnabled,
    };
  }

  router.get('/catalog', (req, res) => {
    void (async () => {
      try {
        const parsed = scopeSchema.safeParse(req.query.scope);
        if (!parsed.success) {
          res.status(400).json({ error: 'scope 必须是 global / team / member' });
          return;
        }
        const scope: CatalogScope = parsed.data;
        const memberId =
          typeof req.query.memberId === 'string' && req.query.memberId
            ? req.query.memberId
            : undefined;
        const teamId = currentTeamId();
        if (scope === 'member' && memberId) team.requireMemberBelongsToTeam(teamId, memberId);
        res.json({ teamId, catalog: await buildCatalog(deps(teamId), { scope, teamId, memberId }) });
      } catch (error) {
        sendError(res, error);
      }
    })();
  });

  router.put('/catalog', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner 或 admin 权限' });
      return;
    }
    void (async () => {
      try {
        const parsed = selectionSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
              .join('; '),
          });
          return;
        }
        const teamId = currentTeamId();
        const memberId = parsed.data.memberId;
        if (parsed.data.scope === 'member') {
          // 归属校验放在读之前，不是只在写之前：assignmentsToBindings 会去列这个
          // Member 已装的 skill，那已经是一次跨 Team 读了。同一个 memberId 既能
          // 读又能写，所以两道都必须挡住。
          if (!memberId) {
            res.status(400).json({ error: 'member scope 需要 memberId' });
            return;
          }
          team.requireMemberBelongsToTeam(teamId, memberId);
        }
        const query = {
          scope: parsed.data.scope,
          teamId,
          memberId,
        };
        const bindings = await assignmentsToBindings(deps(teamId), query, {
          skills: parsed.data.skills,
          knowledge: parsed.data.knowledge,
          tools: parsed.data.tools,
          mcp: parsed.data.mcp,
        });

        if (parsed.data.scope === 'global') team.updateGlobalCapabilities(bindings);
        else if (parsed.data.scope === 'team') team.updateTeamCapabilities(teamId, bindings);
        // scope === 'member' 时 memberId 一定存在：上面那个分支已经 400 掉了空值。
        else if (memberId) team.updateMemberCapabilities(teamId, memberId, bindings);

        res.json({ teamId, catalog: await buildCatalog(deps(teamId), query) });
      } catch (error) {
        sendError(res, error);
      }
    })();
  });

  return router;
}
