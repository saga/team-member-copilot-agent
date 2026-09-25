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
  /**
   * 团队统一 Skill 目录。它是 `team.filesystem-skills` 这个 Provider 的根目录，
   * 绑定它的 Member 都会加载这些 skill。每个 Member 的专长留在各自的
   * <memberHome>/<id>/skills/（`member.filesystem-skills`）。
   */
  teamSkillRoot: path.join(dataDir, 'team', 'skills'),
  /**
   * 团队 KB 的资料根目录：<teamKnowledgeRoot>/<kbKey>/...。
   * 它是 `local.filesystem-knowledge` 这个 Provider 的存储：启动时会扫描子目录，
   * 目录即 KB（key = 目录名），文件落盘即可被检索；API 写入的文档也落在同一棵树上。
   * Member 个人 KB 在 <memberHomeRoot>/<id>/knowledge/。
   */
  teamKnowledgeRoot: path.join(dataDir, 'team', 'knowledge'),
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
   * 单轮注进入 prompt 的 shared message 条数上限。
   *
   * 没有它时会有一个很具体的事故：一个 Member 沉默很久（或被静音一段时间）
   * 之后第一次被唤醒，checkpoint 停在很久以前，于是整段房间历史被一次性灌进
   * prompt —— 既超出模型窗口，也把这一轮的真实意图埋在最底下。
   */
  maxContextMessages: intEnv('MAX_CONTEXT_MESSAGES', 100),
  /**
   * 单轮注入的 shared message 字符数上限（按 transcript 渲染后的长度算）。
   *
   * 和条数上限是两条独立的闸门：100 条长文和 100 条短句的差别是一个数量级。
   * 两条都超的话按先到的那个截。见 context-assembler.ts 的 selectWindow()。
   */
  maxContextChars: intEnv('MAX_CONTEXT_CHARS', 60_000),
  /**
   * 是否允许 Member 使用会触达宿主机的 built-in（bash / edit / grep / web_fetch）。
   *
   * 默认关闭，且**不随能力绑定打开**：给 Member 绑定 `runtime.host-coding-tools`
   * 只是声明想要什么，拿到这个 Provider 不等于拿到了宿主机的执行权。打开它等于
   * 承认「当前 runtime 是可信的单租户环境」；多租户必须等沙箱运行时（K8s / Kata /
   * Firecracker）就位后，由运行时策略而不是这个开关来给工具。
   */
  allowHostCodingTools: env('HOST_CODING_TOOLS', 'false') === 'true',
  /**
   * Internal Member runtime API 的共享 token。
   *
   * 空 = 不做门禁（localhost 单用户原型）。真正的部署必须配置它，或者把这组
   * 路由挡在内网 / API gateway 后面 —— 启动日志会提醒。
   */
  internalApiToken: env('INTERNAL_API_TOKEN', ''),
  /**
   * Admin API（capabilities / knowledge 管理 / skills 安装）的共享 token。
   *
   * 空 = 不做门禁（localhost 单用户原型）。只要服务不是只跑在本机就必须填，
   * 否则任何能访问服务的人都能给 Member 开宿主能力（capability boundary 提升）。
   */
  adminApiToken: env('ADMIN_API_TOKEN', ''),
  /**
   * 默认 Member 模板目录。
   *
   * 这里的文件是 **provisioning baseline**，不是运行时 source of truth：
   * 只在「这个 Member 还没出现过」时被读取一次，之后 Member 在 SQLite 和
   * member home 里独立演进。用户改过的 Profile / Memory / Skills 不会被它覆盖。
   *
   * 目录可以用环境变量指到别处（ConfigMap / 只读 volume / 配置仓库），
   * 所以它必须是配置而不是硬编码路径。
   */
  memberTemplatesDir: path.resolve(env('MEMBER_TEMPLATES_DIR', 'config/member-templates')),
  /**
   * 是否在启动时执行 Member provisioning。
   *
   * 关掉它等于「代码带着模板目录，但不要自动建人」—— 生产环境接管已有数据时
   * 会想这么做（否则模板目录里的每一条都可能在某个空环境下被创建出来）。
   */
  seedDefaultMembers: env('SEED_DEFAULT_MEMBERS', 'true') === 'true',
  /** 单 Team 部署的默认 Team 名。启动时 ensure，不提供新建 Team 入口。 */
  teamName: env('TEAM_NAME', 'AI Team'),
  /** 没有真正用户系统时的 human actor 占位。接 Entra/OIDC 后只换 teamScope 的解析。 */
  localActorId: env('LOCAL_ACTOR_ID', 'local-user'),
  /** Scheduler tick 间隔（毫秒）。只做 once + interval，不做 Calendar/RRULE。 */
  schedulerIntervalMs: intEnv('SCHEDULER_INTERVAL_MS', 2000),
};
