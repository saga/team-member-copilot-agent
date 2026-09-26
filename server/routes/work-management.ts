import { timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import type { TeamService } from '../team-service.js';
import type { WorkManagementRegistry } from '../work-management/types.js';

/**
 * 外部工作系统的入口（当前只有 Jira）。
 *
 * ── 为什么是 webhook 而不是轮询 ──────────────────────────────────────
 *
 * 我们关心的外部工作很少（本地只挂着若干条引用），而变化由 Jira 自己知道。
 * 轮询整个 Jira 是拿「我们关心的很少」去换「每次都全量拉」：成本随租户规模
 * 线性增长，收益恒定。webhook 只推我们挂着的那些引用，正好反着来。
 *
 * ── 为什么 webhook 只做「最小投影」 ──────────────────────────────────
 *
 * 收到的 payload 里其实带着整张工单（`issue.fields` 什么都有）。**不用它**。
 * 一旦开始往本地写 title / status / assignee，本地就有了第二份工单状态，
 * 而它只在 webhook 到达时更新 —— 一次丢包、一次乱序、一次重放，它就永久
 * 偏离 Jira。表现是「本地显示 Done，Jira 里其实是 In Review」，最难查。
 *
 * 所以这里只取三样：**id、key、变了哪些字段名**。剩下的交给 UI 自己去
 * Jira 读那一份真相。下面 zod schema 刻意没有 `fields`，未知字段被剥掉 ——
 * 「不复制工单」这条纪律由解析器强制，而不是靠写代码的人记得。
 */

/**
 * Jira webhook 的 payload 里我们真正用到的部分。
 *
 * Jira 的 payload 很大（`issue.fields` / `user` / `changelog.fromString`…），
 * 这里只声明需要的键。zod 默认剥掉未声明的键，所以即使上游加了字段，
 * 也不会悄悄流进本地存储。
 */
const jiraWebhookSchema = z.object({
  webhookEvent: z.string().max(100).optional(),
  issue: z
    .object({
      id: z.string().max(50).optional(),
      key: z.string().min(1).max(60),
    })
    .optional(),
  changelog: z
    .object({
      items: z
        .array(z.object({ field: z.string().max(200).optional() }))
        .max(200)
        .optional(),
    })
    .optional(),
});

/**
 * 共享密钥校验。
 *
 * 用定长比较而不是 `===`：字符串比较会在第一个不同的字符处返回，理论上可以
 * 靠响应时间一个字符一个字符地试出密钥。这里是一次 HMAC 级别的对手才关心的
 * 问题，但正确写法不比错误写法贵。
 *
 * 未配置密钥时不设门禁 —— 与 internalApiToken / adminApiToken 同一套约定
 * （localhost 单用户原型）。启动日志会提醒这件事。
 */
function authorized(req: Request): boolean {
  const expected = config.jira.webhookSecret;
  if (!expected) return true;
  const provided = req.header('x-jira-webhook-secret') ?? '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 启动时提醒一次：没配密钥的 webhook 是一个任何人都能触发的广播入口。 */
export function describeWebhookBoundary(): string {
  return config.jira.webhookSecret
    ? 'jira webhook: 已启用共享密钥校验'
    : 'jira webhook: 未配置 JIRA_WEBHOOK_SECRET —— 端点无门禁，只应在本机运行';
}

export function workManagementRouter(team: TeamService, registry: WorkManagementRegistry) {
  const router = Router();

  /**
   * 已接入的外部工作系统。前端据此决定要不要显示「工单」字段 ——
   * 让 UI 去猜 provider id 是错的，它应该问平台。
   */
  router.get('/providers', (_req, res) => {
    res.json({ providers: registry.has('jira') ? ['jira'] : [] });
  });

  router.post('/jira/webhook', (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    const parsed = jiraWebhookSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }

    // Jira 会推很多我们不关心的事件（sprint、comment、user、worklog…），
    // 有些 payload 里根本没有 issue。按约定回 200：回 4xx 只会让 Jira 一直
    // 重推同一个我们不处理的事件，把一次无意义的请求变成持续重试。
    if (!parsed.data.issue) {
      res.json({ ignored: true, reason: 'payload has no issue' });
      return;
    }

    const changedFields = (parsed.data.changelog?.items ?? [])
      .map((item) => item.field)
      .filter((field): field is string => Boolean(field));

    const result = team.applyExternalWorkChange({
      provider: 'jira',
      key: parsed.data.issue.key,
      externalId: parsed.data.issue.id ?? null,
      changedFields,
    });

    // matched=0 是正常结果（这条工单本地没挂任何房间），不是错误。
    res.json({
      matched: result.conversations.length,
      conversations: result.conversations,
    });
  });

  return router;
}
