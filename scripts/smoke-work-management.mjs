/**
 * 真实装配的 smoke test：拉起 dist-server 本体（不是测试里自建的 express），
 * 验证 schema v13 能建出来、新路由挂上了、webhook 在未配 Jira 时也安全。
 *
 * 必须 spawn + fetch + kill 在同一个脚本里：后台进程在工具调用返回后会被回收。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-smoke-'));
const port = 3987;
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['dist-server/index.js'], {
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    COPILOT_WARMUP: 'false',
    RECOVER_ON_STARTUP: 'true',
    // Jira 三项留空 —— 这正是「没接外部工作系统」的默认路径，要能正常跑。
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
    JIRA_WEBHOOK_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => {
  logs += String(chunk);
});
child.stderr.on('data', (chunk) => {
  logs += String(chunk);
});

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForBoot() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`服务没起来：\n${logs}`);
}

try {
  await waitForBoot();
  console.log('服务已启动\n');

  check('启动日志显示 schema v13', logs.includes('schema v13'), logs.split('\n')[1] ?? '');
  check(
    '启动日志说明外部工作系统未配置',
    logs.includes('work management: 未配置'),
    logs.match(/work management: .*/)?.[0] ?? '（没有这行）',
  );
  check(
    '启动日志提醒 webhook 无门禁',
    logs.includes('未配置 JIRA_WEBHOOK_SECRET'),
    logs.match(/jira webhook: .*/)?.[0] ?? '（没有这行）',
  );

  const providers = await fetch(`${base}/api/work-management/providers`);
  check('GET /api/work-management/providers 返回 200', providers.status === 200, String(providers.status));
  check(
    '未配 Jira 时 providers 为空（不假装有能力）',
    JSON.stringify(await providers.json()) === JSON.stringify({ providers: [] }),
  );

  const ignored = await fetch(`${base}/api/work-management/jira/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookEvent: 'sprint_started' }),
  });
  check('没有 issue 的 webhook 回 200 忽略', ignored.status === 200, String(ignored.status));
  check(
    '忽略原因写清楚',
    JSON.stringify(await ignored.json()) ===
      JSON.stringify({ ignored: true, reason: 'payload has no issue' }),
  );

  const matched = await fetch(`${base}/api/work-management/jira/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: { id: '1', key: 'ABC-1', fields: { summary: 'should not be stored' } },
      changelog: { items: [{ field: 'status' }] },
    }),
  });
  check('带 issue 的 webhook 回 200', matched.status === 200, String(matched.status));
  check(
    '没有房间挂这条工单时 matched=0（不是错误）',
    JSON.stringify(await matched.json()) === JSON.stringify({ matched: 0, conversations: [] }),
  );

  // 旧的 Jira key 字段必须真的没了 —— 留着就会有人继续往那儿写。
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'team-member.db'));
  const conversationCols = db
    .prepare(`PRAGMA table_info(conversation)`)
    .all()
    .map((row) => row.name);
  const executionCols = db
    .prepare(`PRAGMA table_info(execution)`)
    .all()
    .map((row) => row.name);
  db.close();

  check('conversation 有 external_work_ref', conversationCols.includes('external_work_ref'));
  check('conversation 不再有 jira_issue_key', !conversationCols.includes('jira_issue_key'));
  check('execution 有 external_work_snapshot', executionCols.includes('external_work_snapshot'));
  check('execution 不再有 jira_issue_key', !executionCols.includes('jira_issue_key'));
  check(
    'schema 登记为 13',
    new DatabaseSync(path.join(dataDir, 'team-member.db')).prepare('PRAGMA user_version').get()
      .user_version === 13,
  );
} catch (error) {
  failures.push(`异常：${error instanceof Error ? error.message : error}`);
  console.log(`\n${logs}`);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // 沙箱的删除保护可能拦住；临时目录留着无妨
  }
}

console.log(
  failures.length ? `\n${failures.length} 项失败：${failures.join('; ')}` : '\n全部通过',
);
process.exit(failures.length ? 1 : 0);
