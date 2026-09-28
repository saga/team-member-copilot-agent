import 'dotenv/config';
import path from 'node:path';
import { buildModelPolicy, parseModelList, parseModelStrengths, type ModelPolicy } from './model-policy.js';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const configuredMemberModels = parseModelList(env('COPILOT_MEMBER_MODELS', 'gpt-5-mini,gpt-4.1-mini'));
const legacyDefaultModel = env('COPILOT_MODEL', 'gpt-5');
// COPILOT_LEAD_MODEL 是旧配置名，仍兼容；新配置优先用 COPILOT_LEAD_STRONG_MODEL。
const strongLeadModel = env('COPILOT_LEAD_STRONG_MODEL', env('COPILOT_LEAD_MODEL', legacyDefaultModel));
const standardLeadModel = env('COPILOT_LEAD_STANDARD_MODEL', configuredMemberModels[0] ?? 'gpt-5-mini');

const dataDir = path.resolve(env('DATA_DIR', '.data'));

export const config = {
  port: Number(env('PORT', '3001')),
  corsOrigin: env('CORS_ORIGIN', 'http://localhost:5173'),
  githubToken: env('GITHUB_TOKEN', '') || undefined,
  defaultModel: legacyDefaultModel,
  /**
   * Lead 模型不是固定一个：
   *
   *   standard = 普通 Lead 工作（默认）
   *   strong   = 规划 / 澄清 / 恢复 / 综合（按规则升级）
   *
   * 具体哪一轮用哪个由 TeamService.executionModel 按模型策略决定，见 model-policy.ts。
   */
  leadStrongModel: strongLeadModel,
  leadStandardModel: standardLeadModel,
  /** 普通 Member Task 可以使用的模型：只能是 Standard / Cheap 档。 */
  memberModels: configuredMemberModels,
  /** 模型强度表：数字越大越强，`{"gpt-5":100,"gpt-5-mini":60}`。 */
  modelStrengths: parseModelStrengths(
    env('COPILOT_MODEL_STRENGTHS', '{"gpt-5":100,"gpt-5-mini":60,"gpt-4.1-mini":40}'),
  ),
  warmup: env('COPILOT_WARMUP', 'true') === 'true',
  dataDir,
  dbPath: path.join(dataDir, 'team-member.db'),
  memberHomeRoot: path.join(dataDir, 'members'),
  /**
   * 公司级 Skill 目录。它是 `global.filesystem-skills` 这个 Provider 的根目录，
   * 绑定它的每一层（global → 所有 Agent）都会加载这些 skill。
   *
   * 三层 skill 目录的形状是统一的：
   *   .data/global/skills/            公司级
   *   .data/team/skills/<teamId>/     Team 级
   *   .data/members/<memberId>/skills/  Member 级
   */
  globalSkillRoot: path.join(dataDir, 'global', 'skills'),
  /**
   * 团队统一 Skill 目录。它是 `team.filesystem-skills` 这个 Provider 的根目录，
   * 实际根是 <teamSkillRoot>/<teamId> —— Team 级能力要能区分是哪个 Team。
   * 每个 Member 的专长留在各自的 <memberHome>/<id>/skills/
   * （`member.filesystem-skills`）。
   */
  teamSkillRoot: path.join(dataDir, 'team', 'skills'),
  /**
   * 团队 KB 的资料根目录：<teamKnowledgeRoot>/<kbKey>/...。
   * 它是 `local.filesystem-knowledge` 这个 Provider 的存储：启动时会扫描子目录，
   * 目录即 KB（key = 目录名），文件落盘即可被检索；API 写入的文档也落在同一棵树上。
   * Member 个人 KB 在 <memberHomeRoot>/<id>/knowledge/。
   */
  teamKnowledgeRoot: path.join(dataDir, 'team', 'knowledge'),
  /**
   * 会话文件（聊天里的附件）的存储根：<conversationFileRoot>/<conversationId>/files/<fileId>/。
   *
   * 刻意和 member home / workspace 分开：文件属于 conversation，不属于某个 Member。
   * 放进 <memberHome> 的话，「同一个房间里两个人的视角看到同一份文件」这件事
   * 在磁盘上就表达不出来。
   */
  conversationFileRoot: path.resolve(env('CONVERSATION_FILE_ROOT', path.join(dataDir, 'conversations'))),
  workspaceRoot: path.join(dataDir, 'workspaces'),
  /**
   * global / team 两层默认能力的配置目录（global.json / team.json）。
   *
   * 和 member template 一样是 **provisioning baseline**：只在对应 scope 第一次
   * 出现时被读一次，之后那两层在 SQLite 里独立演进，配置改了也不会回头覆盖。
   *
   * 可以用环境变量指到别处（ConfigMap / 只读 volume / 配置仓库），所以它必须是
   * 配置而不是硬编码路径。
   */
  capabilityTemplatesDir: path.resolve(env('CAPABILITY_TEMPLATES_DIR', 'config/capability-templates')),
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
   * 会话文件（聊天附件）的四道闸。
   *
   * 单文件上限按「raw body 会被 express.raw 一次性读进内存」来定：50MB 是这台
   * 机器能同时接住几个上传的上限，不是「文件多了会怎样」的问题。真要做到
   * GB 级就得换成流式落盘 + 边写边算 hash，那时这个值也该跟着改实现。
   */
  maxConversationFileBytes: intEnv('MAX_CONVERSATION_FILE_BYTES', 50 * 1024 * 1024),
  /** 一条消息最多挂几个附件 —— 也是 sendMessage 里 fileIds 的上限。 */
  maxConversationFilesPerMessage: intEnv('MAX_CONVERSATION_FILES_PER_MESSAGE', 10),
  /** 一个会话最多留多少份文件（不含已软删除的）。 */
  maxConversationFilesPerConversation: intEnv('MAX_CONVERSATION_FILES_PER_CONVERSATION', 500),
  /**
   * 单份文件提取出的文本上限（字符）。超过就截断 —— FTS 里塞进一本 10MB 的
   * 日志，搜索命中的会是「第 3 万行有个 error」，对 Agent 没有任何价值。
   */
  maxExtractedTextChars: intEnv('MAX_EXTRACTED_TEXT_CHARS', 500_000),
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
   * MCP Server 定义文件（`{"servers": [...]}`，见 config/mcp-servers.json）。
   *
   * 默认空：不接 MCP 也能跑，和「没配 Jira 就没有工单工具」同一约定。
   * token / secret 只放环境变量，JSON 里写 `${VAR}` 引用 —— 定义文件本身
   * 不落任何凭证。
   */
  mcpServersFile: path.resolve(env('MCP_SERVERS_FILE', 'config/mcp-servers.json')),
  /**
   * 是否允许注册 local/stdio MCP Server：SDK 会在服务机器上为它启动子进程。
   *
   * 默认关闭。远程（http / sse）不受影响，优先用远程。
   */
  mcpLocalEnabled: env('MCP_LOCAL_ENABLED', 'false') === 'true',
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
  /**
   * human 认证模式。false = 生产模式：必须配 OIDC，走真实 JWT；
   * true = 本地开发：无 Bearer 时回落 LOCAL_ACTOR_ID。
   * 测试与本地 dev 用 true，生产必须 false（见 index.ts 启动检查）。
   */
  authDevMode: env('AUTH_DEV_MODE', 'false') === 'true',
  oidc: {
    issuer: env('OIDC_ISSUER', ''),
    audience: env('OIDC_AUDIENCE', ''),
    jwksUrl: env('OIDC_JWKS_URL', ''),
  },
  /** Scheduler tick 间隔（毫秒）。只做 once + interval，不做 Calendar/RRULE。 */
  schedulerIntervalMs: intEnv('SCHEDULER_INTERVAL_MS', 2000),
  /**
   * Jira 连接（Cloud：站点 URL + 邮箱 + API token，Basic auth）。
   * 三项齐了才算配置；没配置就不注册 Jira 工具，控制面也走「无业务上下文」
   * 路径 —— Agent 的能力清单里不该出现「调了必失败」的工单工具。
   */
  jira: {
    baseUrl: env('JIRA_BASE_URL', ''),
    email: env('JIRA_EMAIL', ''),
    apiToken: env('JIRA_API_TOKEN', ''),
    /**
     * Jira webhook 的共享密钥（在 Jira 的 webhook 配置里填 secret，Jira 会以
     * `X-Jira-Webhook-Secret` 头带上）。
     *
     * 空 = 不做门禁（localhost 单用户原型），与 internalApiToken / adminApiToken
     * 同一套约定。**但服务一旦不是只跑在本机就必须填**：这个端点会触发本地
     * 广播，无门禁时任何能访问服务的人都能伪造「这条工单变了」。
     */
    webhookSecret: env('JIRA_WEBHOOK_SECRET', ''),
  },
};

/**
 * 全局唯一的模型策略。配置错了这里直接抛，服务拒绝启动 ——
 * 强约束（Strong > Standard >= Member）在第一轮跑起来之前就必须成立。
 */
export const modelPolicy: ModelPolicy = buildModelPolicy({
  strongLeadModel: config.leadStrongModel,
  standardLeadModel: config.leadStandardModel,
  memberModels: config.memberModels,
  strengths: config.modelStrengths,
});
