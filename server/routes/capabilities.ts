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

  function deps(): CatalogDeps {
    return {
      capabilities: {
        getGlobal: () => team.getGlobalCapabilities(),
        getTeam: (teamId: string) => team.getTeamCapabilities(teamId),
        getMember: (memberId: string) => team.getMemberCapabilities(memberId),
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
        res.json({ teamId, catalog: await buildCatalog(deps(), { scope, teamId, memberId }) });
      } catch (error) {
        sendError(res, error);
      }
    })();
  });

  router.put('/catalog', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner/admin（或有效的 ADMIN_API_TOKEN）' });
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
        const query = {
          scope: parsed.data.scope,
          teamId,
          memberId: parsed.data.memberId,
        };
        const bindings = await assignmentsToBindings(deps(), query, {
          skills: parsed.data.skills,
          knowledge: parsed.data.knowledge,
          tools: parsed.data.tools,
        });

        if (parsed.data.scope === 'global') team.updateGlobalCapabilities(bindings);
        else if (parsed.data.scope === 'team') team.updateTeamCapabilities(teamId, bindings);
        else {
          if (!parsed.data.memberId) {
            res.status(400).json({ error: 'member scope 需要 memberId' });
            return;
          }
          team.updateMemberCapabilities(parsed.data.memberId, bindings);
        }

        res.json({ teamId, catalog: await buildCatalog(deps(), query) });
      } catch (error) {
        sendError(res, error);
      }
    })();
  });

  return router;
}
