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
  /**
   * 是否允许 Member 使用会触达宿主机的 built-in（bash / edit / grep / web_fetch）。
   *
   * 默认关闭，且**不随 toolProfile 打开**：成员把自己标成 coding 只是声明想要
   * 什么，不该等于拿到了宿主机的执行权。打开它等于承认「当前 runtime 是可信的
   * 单租户环境」；多租户必须等沙箱运行时（K8s / Kata / Firecracker）就位后，
   * 由运行时策略而不是这个开关来给工具。
   */
  allowHostCodingTools: env('HOST_CODING_TOOLS', 'false') === 'true',
  /**
   * Internal Member runtime API 的共享 token。
   *
   * 空 = 不做门禁（localhost 单用户原型）。真正的部署必须配置它，或者把这组
   * 路由挡在内网 / API gateway 后面 —— 启动日志会提醒。
   */
  internalApiToken: env('INTERNAL_API_TOKEN', ''),
};
