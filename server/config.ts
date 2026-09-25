import 'dotenv/config';
import path from 'node:path';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const dataDir = path.resolve(env('DATA_DIR', '.data'));

export const config = {
  port: Number(env('PORT', '3001')),
  corsOrigin: env('CORS_ORIGIN', 'http://localhost:5173'),
  githubToken: env('GITHUB_TOKEN', '') || undefined,
  defaultModel: env('COPILOT_MODEL', 'gpt-5'),
  warmup: env('COPILOT_WARMUP', 'true') === 'true',
  dataDir,
  dbPath: path.join(dataDir, 'team-member.db'),
  memberHomeRoot: path.join(dataDir, 'members'),
  workspaceRoot: path.join(dataDir, 'workspaces'),
  copilotBaseDirectory: path.join(dataDir, 'copilot'),
  localUserId: env('LOCAL_USER_ID', 'local-user'),
  maxDelegationDepth: intEnv('MAX_DELEGATION_DEPTH', 4),
  /**
   * 启动时做一次恢复：把上次进程留下的 running / waiting_for_member 标成
   * interrupted，并把从未真正跑过的 root execution 重新提交。
   *
   * 单进程独占 DB 的前提下才安全；多副本部署必须换成 DB lease（见 recovery-service）。
   */
  recoverOnStartup: env('RECOVER_ON_STARTUP', 'true') === 'true',
  /**
   * 单次 Member turn 的等待上限（毫秒）。
   * Copilot SDK 的 sendAndWait 默认 60s，对带工具调用的真实 agent 工作太短，
   * 会把正常的长任务判成 failed。这里默认放宽到 10 分钟。
   */
  executionTimeoutMs: intEnv('EXECUTION_TIMEOUT_MS', 600_000),
  /**
   * group 房间里「没有 @mention 的 Member 发言」最多能连着唤醒几轮。
   *
   * A 发言 → 唤醒 B → B 发言 → 唤醒 A → ... 是一个没有天然终点的循环。
   * 用户消息重置这个计数；连续 N 条 member 消息之后，member 消息只靠
   * @mention 才能唤醒别人（mention 永远有效）。见 group-dispatcher.ts。
   */
  groupAutoWakeRounds: intEnv('GROUP_AUTO_WAKE_ROUNDS', 2),
};
