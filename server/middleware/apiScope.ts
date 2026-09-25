import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * 调用方边界。
 *
 * ── 三类调用方 ──────────────────────────────────────────────────────
 *
 *   Human API     用户以**自己**的身份做事：发消息、静音、看历史。
 *                 这类请求没有「我代表谁」这个字段 —— 说话的人就是请求的人。
 *
 *   Admin API     配置类写入：Member CRUD、记忆、技能、房间管理。
 *                 它改的是「系统长什么样」，不是「谁说了什么」。
 *
 *   Internal API  以**某个 Member 的身份**做事。它和 Member 自己的工具
 *                 （message_member / ask_member / remember_member）是同一个
 *                 能力面，只是入口不同 —— 一个从引擎里调，一个走 HTTP。
 *
 * ── 为什么 Internal 必须单独一个命名空间 ─────────────────────────────
 *
 * `POST /api/members/:id/direct-messages` 里的 `:id` 是**调用方自己填的**。
 * 它长在 Human API 的路径上时，任何能访问到这个服务的人都能填别人的 id，
 * 效果就是「替 Alice 发消息」—— 身份不是一个校验过的输入，而是一个参数。
 *
 * 所以这类路由挂在 `/api/internal` 下，并且在配置了 INTERNAL_API_TOKEN 时
 * 强制校验。**路径本身也是契约的一部分**：看到 `/api/internal` 就知道这个
 * 端点的调用方不是浏览器里的用户，而是另一个 runtime。
 *
 * ── 为什么默认放行 ──────────────────────────────────────────────────
 *
 * 单用户 localhost 原型不配 token（`config.internalApiToken === ''`），此时
 * 中间件直接放行 —— 否则前端那条「以 Member 身份发私聊」的路径整个断掉。
 * 但这是**降级**而不是等价：启动日志会明确写出「Internal API 未设防」，
 * 让人知道此刻的服务只该待在本机。
 */

/** 取出调用方出示的 token。`Authorization: Bearer` 优先，其次专用的内部头。 */
function readPresentedToken(req: Request): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }

  // `X-Internal-Token` 是给不方便改 Authorization 的调用方（例如共享网关）准备的。
  const header = req.headers['x-internal-token'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 定长比较，避免用响应时间把 token 逐字节猜出来。
 *
 * 长度不同直接返回 false —— 长度本身不敏感，而 timingSafeEqual 对不等长的
 * 输入会抛异常。
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Internal API 的门禁。挂在 `/api/internal` 整个 router 上，而不是逐个路由 ——
 * 新增一个内部端点时忘了加中间件，就又是一个「任意身份可调用」的洞。
 */
export function requireInternalToken() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.internalApiToken) {
      next();
      return;
    }

    const presented = readPresentedToken(req);
    if (!presented || !tokensMatch(presented, config.internalApiToken)) {
      res.status(401).json({ error: 'Internal API 需要有效的 INTERNAL_API_TOKEN' });
      return;
    }

    next();
  };
}

/** Admin token 是否通过。空配置 = 单机原型，直接放行（启动日志会写明未设防）。 */
export function isAdminAuthorized(req: Request): boolean {
  if (!config.adminApiToken) return true;
  const presented = readPresentedToken(req);
  return !!presented && tokensMatch(presented, config.adminApiToken);
}

/**
 * Admin API 的门禁：改 capability boundary 的写入（capabilities / knowledge 管理 /
 * skills 安装 / 建 Member / 归档）。只用在「整条路由都是 Admin」的写入上；
 * 同一个 router 里读写混放时（如 PATCH 改名 vs 归档），调用方用 isAdminAuthorized()
 * 在 handler 内部分流 —— Express 5 给多 handler 的 req.params 推断会退化成
 * string|string[]，多一个中间件就多一处 as string。
 */
export function requireAdminToken() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAdminAuthorized(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Admin API 需要有效的 ADMIN_API_TOKEN' });
  };
}

/**
 * 启动时的一句话体检。把「当前有哪些边界是真的存在的」写进日志 ——
 * 一个只在文档里存在的边界等于没有边界。
 */
export function describeApiBoundary(): string {
  const internal = config.internalApiToken
    ? 'Internal API(/api/internal) 已启用 token 校验'
    : 'Internal API(/api/internal) 未设防（INTERNAL_API_TOKEN 为空，仅限本机单用户）';
  const admin = config.adminApiToken
    ? 'Admin API(capabilities/knowledge/skills 写入) 已启用 token 校验'
    : 'Admin API(capabilities/knowledge/skills 写入) 未设防（ADMIN_API_TOKEN 为空，仅限本机单用户）';
  return `${internal}；${admin}`;
}
