/**
 * Single vs Multi 策略评测：跑一轮真实场景，从 DB 里收可观测指标。
 *
 * 只回答机器能回答的部分（latency / executions / tool calls / 失败数 /
 * 重试数 / 需人工审核数）。quality / success 由人按 docs/multi-agent-evaluation.md
 * 里的 rubric 判定后填表 —— 模型给自己打分是作弊，脚本不做。
 *
 * 用法（server 需已启动且 AUTH_DEV_MODE=true，跑的是真实模型与真实计费）：
 *
 *   npx tsx scripts/agent-strategy-eval.ts \
 *     --server http://localhost:3001 --dataDir .data \
 *     --members '<leadId>,<memberId>...' \
 *     --title 'eval-decomposable-single' \
 *     --objective '对 3 家金融公司做基本面/风险/新闻研究' \
 *     --timeoutMs 600000
 *
 * 同一个 scenario 跑 single（1 个 Member）和 multi（3 个 Member）各一次，
 * 把两行输出贴进评测文档的表里读 quality×cost。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

function arg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  for (const item of process.argv.slice(2)) {
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return fallback;
}

const server = arg('server', 'http://localhost:3001');
const dataDir = arg('dataDir', '.data');
const memberIds = arg('members', '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const title = arg('title', `eval-${Date.now()}`);
const objective = arg('objective', '');
const timeoutMs = Number(arg('timeoutMs', '600000'));

if (memberIds.length === 0) throw new Error('必须给 --members（逗号分隔的 member id，第一个是 Lead）');
if (!objective) throw new Error('必须给 --objective（场景描述）');

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${server}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${pathname} -> ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<unknown>;
}

function metrics(db: DatabaseSync, conversationId: string) {
  const executions = db
    .prepare(`SELECT status, created_at, ended_at FROM execution WHERE conversation_id = ?`)
    .all(conversationId) as Array<{ status: string; created_at: string; ended_at: string | null }>;
  const toolCalls = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM tool_execution_audit WHERE conversation_id = ?`)
      .get(conversationId) as { n: number }
  ).n;
  const retries = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND retry_of_execution_id IS NOT NULL`,
      )
      .get(conversationId) as { n: number }
  ).n;
  const humanReview = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_task WHERE conversation_id = ? AND requires_human_review = 1`,
      )
      .get(conversationId) as { n: number }
  ).n;
  const byStatus: Record<string, number> = {};
  for (const item of executions) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  return {
    executions: executions.length,
    byStatus,
    toolCalls,
    retries,
    humanReviewRequired: humanReview,
    failedExecutions: (byStatus.failed ?? 0) + (byStatus.blocked ?? 0),
  };
}

const startedAt = Date.now();
const created = (await api('/api/conversations', {
  method: 'POST',
  body: JSON.stringify({ kind: 'task', title, memberIds, leadMemberId: memberIds[0] }),
})) as { conversation: { id: string } };
const conversationId = created.conversation.id;

await api(`/api/conversations/${conversationId}/messages`, {
  method: 'POST',
  body: JSON.stringify({ content: objective }),
});

const db = new DatabaseSync(path.join(dataDir, 'team-member.db'));
try {
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('评测超时：conversation 一直没 idle');
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_for_member')`,
      )
      .get(conversationId) as { n: number };
    if (row.n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const latencyMs = Date.now() - startedAt;
  const row = { conversationId, mode: memberIds.length === 1 ? 'single' : 'multi', latencyMs, ...metrics(db, conversationId) };
  console.log(`| ${row.mode} | ${row.latencyMs}ms | ${row.executions} | ${JSON.stringify(row.byStatus)} | ${row.toolCalls} | ${row.retries} | ${row.humanReviewRequired} |`);
  console.log(JSON.stringify(row, null, 2));
} finally {
  db.close();
}
