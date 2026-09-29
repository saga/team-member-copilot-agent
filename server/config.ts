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

/**
 * 0~1 之间的比例配置（比如 compaction 阈值 0.80）。
 *
 * 不能复用 intEnv：intEnv 要求 Number.isInteger，会把 0.80 判成非法然后静默回退，
 * 于是「调了阈值但没生效」—— 而且不会有任何报错，只在跑爆上下文时才暴露。
 * 这里显式要求 0 < value < 1，越界同样回退（沿用 intEnv 的静默风格）。
 */
function ratioEnv(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

const configuredMemberModels = parseModelList(env('COPILOT_MEMBER_MODELS', 'gpt-5-mini,gpt-4.1-mini'));
const legacyDefaultModel = env('COPILOT_MODEL', 'gpt-5');
// COPILOT_LEAD_MODEL 是旧配置名，仍兼容；新配置优先用 COPILOT_LEAD_STRONG_MODEL。
const strongLeadModel = env('COPILOT_LEAD_STRONG_MODEL', env('COPILOT_LEAD_MODEL', legacyDefaultModel));
const standardLeadModel = env('COPILOT_LEAD_STANDARD_MODEL', configuredMemberModels[0] ?? 'gpt-5-mini');

const dataDir = path.resolve(env('DATA_DIR', '.data'));

/**
 * Copilot 的运行环境：
 *
 * development:
 *   不设置 baseDirectory，让 Copilot SDK 使用当前用户的默认
 *   ~/.copilot，从而复用本机 copilot CLI 的登录状态。
 *
 * production:
 *   使用独立 COPILOT_BASE_DIRECTORY，避免服务依赖宿主机用户的
 *   ~/.copilot / credential store。
 *
 * NODE_ENV 未设置时按 development 处理，方便 `npm run dev`。
 */
const isProduction = env('NODE_ENV', 'development') === 'production';

export const config = {
  port: Number(env('PORT', '3001')),
  corsOrigin: env('CORS_ORIGIN', 'http://localhost:5173'),
  isProduction,
  /**
   * 只有 production 才设置。
   *
   * development = undefined
   *   → SDK 自己使用 ~/.copilot
   *
   * production = .data/copilot（可通过 COPILOT_BASE_DIRECTORY 覆盖）
   *   → 独立 Copilot HOME
   */
  githubToken: isProduction
    ? env('GITHUB_TOKEN', '') || undefined
    : undefined,
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
  /**
   * Copilot SDK 的 session 持久化根目录（session state / checkpoints）。
   *
   * ── 为什么它必须是可配置的、且要落在持久卷上 ────────────────────────
   *
   * Infinite Session 把「compaction 之后的 checkpoint」写在 baseDirectory 下。
   * 容器里如果这是个临时层，重启后 checkpoint 连同 session state 一起丢，
   * 于是 resume 失败 → acquireSession 回落到 createSession，看起来「没坏」，
   * 实际上是每次重启都从零开始，历史全没了。所以它必须能指到挂载的持久卷。
   *
   * 刻意和 MemberRuntime.workspacePath 分开：workspace 是 Agent 的工作目录
   * （它的产物、它 cwd 下的文件），这里是 SDK 的会话状态。混在一起的话，
   * 「清一次 workspace」会连带把会话历史删掉。见计划 §十五。
   */
  /**
   * 只有 production 才设置，development = undefined（SDK 用 ~/.copilot）。
   * production 默认 <DATA_DIR>/copilot，可通过 COPILOT_BASE_DIRECTORY 覆盖。
   */
  copilotBaseDirectory: isProduction
    ? path.resolve(env('COPILOT_BASE_DIRECTORY', path.join(dataDir, 'copilot')))
    : undefined,
  /**
   * 后台 compaction 触发阈值（占模型上下文窗口的比例）。
   *
   * SDK 到这条线时**异步**压缩历史，当前这一轮不受影响。默认 0.80 是官方默认值，
   * 一般不用改；只有在模型窗口很小、希望更早压缩时才往下调。
   */
  copilotCompactionBackgroundThreshold: ratioEnv('COPILOT_COMPACTION_BACKGROUND_THRESHOLD', 0.8),
  /**
   * buffer 耗尽阈值：到这条线时必须**阻塞**压缩，否则下一轮就没地方放了。
   *
   * 必须 > background 阈值，否则后台压缩还没机会跑就先撞上阻塞线。
   * 默认 0.95 是官方默认值。这里只做透传，真正的压缩由 SDK 负责。
   */
  copilotCompactionBufferExhaustionThreshold: ratioEnv('COPILOT_COMPACTION_BUFFER_THRESHOLD', 0.95),
  localUserId: env('LOCAL_USER_ID', 'local-user'),
  maxDelegationDepth: intEnv('MAX_DELEGATION_DEPTH', 4),
  /**
   * 启动时做一次恢复：把上次进程留下的 running / waiting_for_member 标成
   * interrupted，并把从未真正跑过的 root execution 重新提交。
   *
   * 单进程独占 DB 的前提下才安全；多副本部署必须启用 Worker Lease，
   * 否则第二个进程的恢复会误伤第一个进程正在跑的 execution（见 index.ts 启动检查）。
   */
  recoverOnStartup: env('RECOVER_ON_STARTUP', 'true') === 'true',
  /**
   * 本服务同时跑几个副本。
   *
   * 这个值本身不改行为 —— 它是**声明**，用来在启动时拦下「多副本 + 没开租约」
   * 这种一定会双跑的配置（见 index.ts）。真正的互斥靠 WORKER_LEASE_ENABLED。
   */
  workerReplicas: intEnv('WORKER_REPLICAS', 1),
  /**
   * 是否启用 DB 层 Worker Lease。
   *
   * 单进程时可以不开（租约只是多一次写库）；`WORKER_REPLICAS > 1` 时必须开 ——
   * 进程内的 pending / inFlight 集合跨进程不成立，两个副本会各自认为自己是
   * 唯一 owner，同一轮 execution 跑两遍，而外部副作用不可撤销。
   */
  workerLeaseEnabled: env('WORKER_LEASE_ENABLED', 'false') === 'true',
  /**
   * 本副本的名字，只用于日志与租约归属的可读性。
   *
   * 空 = 用进程启动时生成的随机 UUID（WorkerLeaseService.owner）。
   * 刻意不拿它当租约身份：手填的名字会在「两个副本填了同一个 WORKER_ID」时
   * 让租约静默失效，而随机 UUID 不可能撞。
   */
  workerId: env('WORKER_ID', ''),
  /** 租约 TTL（毫秒）。必须显著大于一次 heartbeat 间隔，否则会频繁出现双跑。 */
  workerLeaseTtlMs: intEnv('WORKER_LEASE_TTL_MS', 30_000),
  /**
   * 租约心跳间隔（毫秒）。持有者按这个间隔把自己的 TTL 往后推。
   *
   * ── 为什么它是配置而不是各处自己算 ──────────────────────────────────
   *
   * 它和 TTL 是一对**必须一起看**的参数，而在此之前三个调用点各自写着
   * `Math.max(1_000, Math.floor(ttlMs / 3))`。分开写的坏处不是重复，是
   * 「改了 TTL 忘了改心跳」—— 而那个组合（间隔 ≥ TTL）的表现是租约在自己
   * 手里就过期，于是另一个副本接手，两边都以为自己在跑。
   *
   * 启动时会校验 heartbeat < ttl（见 index.ts）：这个不变式只写在注释里
   * 是不够的，配错一次就永久双跑。
   */
  workerLeaseHeartbeatMs: intEnv('WORKER_LEASE_HEARTBEAT_MS', 10_000),
  /**
   * 单次 Member turn 的等待上限（毫秒）。
   * Copilot SDK 的 sendAndWait 默认 60s，对带工具调用的真实 agent 工作太短，
   * 会把正常的长任务判成 failed。这里默认放宽到 10 分钟。
   */
  executionTimeoutMs: intEnv('EXECUTION_TIMEOUT_MS', 600_000),
  /**
   * 单轮注入到 prompt 的 shared message 条数上限。
   *
   * 没有它时会有一个很具体的事故：一个 Member 沉默很久（或被静音一段时间）
   * 之后第一次被唤醒，checkpoint 停在很久以前，于是整段房间历史被一次性灌进
   * prompt —— 既超出模型窗口，也把这一轮的真实意图埋在最底下。
   *
   * ── 为什么现在从 100 收紧到 60 ────────────────────────────────────
   *
   * shared transcript 只是 Member 这一轮的**输入之一**，不是它的全部记忆：
   *   · Member 自己的 Copilot Session 已经带着它自己的历史（SDK 自动 compact）；
   *   · Goal / Task / Execution / Approval 是结构化事实，单独注入；
   *   · Member / Team Memory 是跨 Conversation 的长期记忆。
   * 所以这里不需要「把房间全灌进去」。灌太多反而有两个坏处：和 Session 里
   * 已有的历史重复计费，以及把这一轮真正要处理的消息挤到 prompt 底部。
   */
  maxContextMessages: intEnv('MAX_CONTEXT_MESSAGES', 60),
  /**
   * 单轮注入的 shared message 字符数上限（按 transcript 渲染后的长度算）。
   *
   * 和条数上限是两条独立的闸门：60 条长文和 60 条短句的差别是一个数量级。
   * 两条都超的话按先到的那个截。见 context-assembler.ts 的 selectWindow()。
   *
   * 32k 是按「shared 窗口只承载最近一段房间动态」定的，理由同上：完整历史在
   * Member 的 Session 里，这里超出的部分交给 SDK 的 compaction，而不是自己塞满。
   */
  maxContextChars: intEnv('MAX_CONTEXT_CHARS', 32_000),
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
  /**
   * 首次初始化时被建成 Team owner 的 human 身份（OIDC 的 `sub`）。
   *
   * ── 为什么不能用 LOCAL_ACTOR_ID 顶上 ────────────────────────────────
   *
   * `LOCAL_ACTOR_ID` 是「没有真实用户系统时的占位」。生产模式配了 OIDC 之后，
   * 真实用户的 principalId 是 token 里的 `sub`（形如 `auth0|65f3…`），而
   * `local-user` 永远不会出现在任何一张 token 里。拿它建 owner 的结果是：
   *
   *   - 真正的第一个管理员登录进来，发现自己不是 owner，改不了任何配置
   *   - 而 `local-user` 这个身份谁也无法登录 —— owner 席位被一个**不存在的人**
   *     永久占着，只能手工改库才能解开
   *
   * 所以生产模式下它必须显式配置。dev 模式仍然回落到 LOCAL_ACTOR_ID
   * （那里两者本来就是同一个东西）。
   */
  oidcBootstrapOwnerSub: env('OIDC_BOOTSTRAP_OWNER_SUB', ''),
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
