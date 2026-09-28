/**
 * 启动冒烟：拉起 dist-server 本体（不是测试里自建的 express），验证这一轮新增的
 * 启动路径行为 —— 这些只在**启动**时才会暴露：
 *
 *   - schema v28 的列 / 表在空库上能建出来（delete-and-rebuild）
 *   - owner 引导：全新库 + dev 模式应当建出 human owner，而不是拒绝启动
 *   - 新增的 /api/commands、/api/audit 路由真的挂上了（import 写错要到启动才炸）
 *   - 租约参数的不变式：heartbeat ≥ TTL 必须**拒绝启动**
 *
 * 必须 spawn + fetch + kill 在同一个脚本里：后台进程在工具调用返回后会被回收，
 * 而沙箱里 curl 连不到 127.0.0.1（Node 的 fetch 可以）。
 *
 * 用法：npm run build && node scripts/smoke-boot.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 版本号从编译产物读，**不要**在这里写常量：schema 每次改都会动它，
// 而写死的那个数字不会有任何东西提醒你同步 —— 它只会让这个 smoke test 悄悄失效。
const { SCHEMA_VERSION } = await import(
  new URL('../dist-server/db-migrations.js', import.meta.url).href
);

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? `（${detail}）` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 起一个服务，返回 { child, base, logs, dataDir }。 */
async function startServer(port, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-boot-'));
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      AUTH_DEV_MODE: 'true',
      COPILOT_WARMUP: 'false',
      HOST_CODING_TOOLS: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { child, base: `http://127.0.0.1:${port}`, logs: '', dataDir, exited: null };
  const collect = (chunk) => {
    state.logs += String(chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', (code) => {
    state.exited = code;
  });
  return state;
}

async function waitForHealth(base, state, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited !== null) {
      throw new Error(`服务提前退出（code=${state.exited}）\n${state.logs}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内没有就绪\n${state.logs}`);
}

function cleanup(state) {
  try {
    state.child.kill('SIGTERM');
  } catch {
    // 已经没了
  }
  try {
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  } catch {
    // 沙箱的删除保护可能拦住；临时目录留着无妨
  }
}

// ------------------------------------------------------------ 1. 正常启动

const server = await startServer(3971);
try {
  const health = await waitForHealth(server.base, server);
  check('/api/health 返回 ok', health?.status === 'ok', JSON.stringify(health));

  const conversations = await fetch(`${server.base}/api/conversations`);
  check('GET /api/conversations 200', conversations.status === 200, String(conversations.status));
  const conversationsPayload = await conversations.json();
  check(
    'GET /api/conversations 形状是 { conversations: [...] }',
    Array.isArray(conversationsPayload.conversations),
    JSON.stringify(conversationsPayload).slice(0, 120),
  );

  // 新挂的路由。注意 `GET /api/commands` **不带参数**返回 400 是设计
  // （列表必须限定范围：要么某一轮，要么某个状态），不是「路由没挂上」。
  const commands = await fetch(`${server.base}/api/commands?status=policy_pending`);
  check('GET /api/commands?status= 已挂载', commands.status === 200, String(commands.status));
  const commandsPayload = await commands.json();
  check(
    'GET /api/commands?status= 形状是 { commands: [...] }',
    Array.isArray(commandsPayload.commands),
    JSON.stringify(commandsPayload).slice(0, 120),
  );

  const unscoped = await fetch(`${server.base}/api/commands`);
  check(
    'GET /api/commands 无参数被拒绝（列表必须限定范围）',
    unscoped.status === 400,
    `${unscoped.status} ${(await unscoped.text()).slice(0, 80)}`,
  );

  const audit = await fetch(`${server.base}/api/audit/executions/no-such-execution`);
  check(
    'GET /api/audit/executions/:id 已挂载（未知 id 报 404，不是 500）',
    audit.status === 404,
    String(audit.status),
  );

  const members = await fetch(`${server.base}/api/members`);
  check('GET /api/members 200', members.status === 200, String(members.status));

  // -------------------------------------------------- 库的形状 + owner 引导

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(server.dataDir, 'team-member.db'));
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name);
  const commandCols = db
    .prepare(`PRAGMA table_info(command)`)
    .all()
    .map((row) => row.name);
  const version = db.prepare(`PRAGMA user_version`).get().user_version;
  const owners = db
    .prepare(
      `SELECT principal_id FROM team_membership
       WHERE kind = 'human' AND role = 'owner' AND status = 'active'`,
    )
    .all()
    .map((row) => row.principal_id);
  db.close();

  check(`schema 登记为 v${SCHEMA_VERSION}`, version === SCHEMA_VERSION, String(version));
  check('command.args_json 存在（参数冻结）', commandCols.includes('args_json'));
  check('command_audit 表存在', tables.includes('command_audit'));
  check('conversation_participant 表存在', tables.includes('conversation_participant'));
  check(
    'owner 引导：全新库 + dev 模式建出 human owner',
    owners.length === 1 && owners[0] === 'local-user',
    JSON.stringify(owners),
  );
  check(
    'recovery 报告带上 blockedTasks（新字段真的接出来了）',
    /recovery:.*blockedTasks=/.test(server.logs),
    server.logs.split('\n').find((line) => line.includes('blockedTasks=')) ?? '(无 recovery 日志)',
  );
} catch (error) {
  check('正常启动路径', false, error instanceof Error ? error.message : String(error));
} finally {
  cleanup(server);
}

// -------------------------------------- 2. 租约参数不变式：配错必须拒绝启动

const broken = await startServer(3972, {
  WORKER_LEASE_ENABLED: 'true',
  WORKER_LEASE_TTL_MS: '10000',
  WORKER_LEASE_HEARTBEAT_MS: '10000',
});
try {
  // 心跳间隔 ≥ TTL 等于租约永不续期：持有者手里的租约会在自己还在跑的时候就
  // 过期，另一个副本接手 —— 两边都以为自己在跑，而副作用不可撤销。
  // 只警告不拦是不行的：日志里的警告不会阻止部署。
  const deadline = Date.now() + 30_000;
  while (broken.exited === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  check(
    'heartbeat ≥ TTL 时拒绝启动',
    broken.exited !== null && broken.exited !== 0,
    `exit=${broken.exited}`,
  );
  check(
    '拒绝启动的理由提到那两个参数名',
    /WORKER_LEASE_HEARTBEAT_MS/.test(broken.logs) && /WORKER_LEASE_TTL_MS/.test(broken.logs),
    broken.logs
      .split('\n')
      .find((line) => line.includes('必须小于') && line.includes('WORKER_LEASE_TTL_MS')) ??
      '(无错误信息)',
  );
} catch (error) {
  check('租约参数不变式', false, error instanceof Error ? error.message : String(error));
} finally {
  cleanup(broken);
}

console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
