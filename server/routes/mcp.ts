import { Router } from 'express';
import { z } from 'zod';
import type { McpServerService } from '../mcp/service.js';
import { mcpServerApiInputSchema } from '../mcp/service.js';
import { sendError } from '../middleware/errorHandler.js';
import { isAdminAuthorized } from '../middleware/apiScope.js';
import { isTeamAdmin } from '../middleware/teamScope.js';

/**
 * MCP Server 管理（定义本身的增删改查 + 可达性检查）。
 *
 * 和 capabilities catalog 的分工：
 *   这里   「系统里有哪些 MCP、怎么连」（连接层，secret 永不外泄）
 *   那里   「谁可以用其中哪些工具」（授权层，只写引用 + 工具名单）
 *
 * 写入全部要 admin（改的是所有 Agent 共用的连接定义）；读取不需要。
 */

function canAdmin(req: Parameters<typeof isAdminAuthorized>[0]): boolean {
  if (isAdminAuthorized(req)) return true;
  return isTeamAdmin(req, 'owner', 'admin');
}

const idParam = z.string().trim().min(1).max(200);

export function mcpRouter(servers: McpServerService) {
  const router = Router();

  router.get('/servers', (_req, res) => {
    try {
      res.json({ servers: servers.list() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/servers', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner 或 admin 权限' });
      return;
    }
    const parsed = mcpServerApiInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
      });
      return;
    }
    try {
      res.status(201).json({ server: servers.create(parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/servers/:id', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner 或 admin 权限' });
      return;
    }
    const id = idParam.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: 'server id 不合法' });
      return;
    }
    const parsed = mcpServerApiInputSchema
      .omit({ id: true })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
      });
      return;
    }
    try {
      res.json({ server: servers.update(id.data, parsed.data) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/servers/:id', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner 或 admin 权限' });
      return;
    }
    const id = idParam.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: 'server id 不合法' });
      return;
    }
    try {
      servers.remove(id.data);
      res.json({ deleted: id.data });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 可达性检查，不是 MCP 握手、不发现工具。
   *
   * http/sse 只确认「有 HTTP 响应」（4xx/5xx 也算可达）；local 只确认
   * command 找得到，绝不执行。返回的操作结论只记一条最近结果，
   * 不做历史曲线 —— 要监控请看部署的探针。
   */
  router.post('/servers/:id/test', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner 或 admin 权限' });
      return;
    }
    const id = idParam.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: 'server id 不合法' });
      return;
    }
    void (async () => {
      try {
        const result = await servers.test(id.data);
        res.json({ ok: result.ok, detail: result.detail, server: servers.get(id.data) });
      } catch (error) {
        sendError(res, error);
      }
    })();
  });

  return router;
}
