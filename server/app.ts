import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { db, migration } from './db.js';
import { MemberService } from './member-service.js';
import { CopilotService } from './copilot.js';
import { TeamService } from './team-service.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { CapabilityService } from './capabilities/service.js';
import { CapabilityResolver } from './capabilities/resolver.js';
import { SkillService } from './skill-service.js';
import { FilesystemSkillProvider } from './capabilities/providers/filesystem-skill.js';
import { LocalFilesystemKnowledgeProvider } from './capabilities/providers/filesystem-knowledge.js';
import { CoreTeamToolProvider } from './capabilities/providers/core-tools.js';
import { ConversationFileToolProvider, conversationFileToolHost } from './capabilities/providers/conversation-file-tools.js';
import { ConversationFileService } from './conversation-file-service.js';
import { ConversationFileProcessor } from './conversation-file-processor.js';
import { KnowledgeToolProvider } from './capabilities/providers/knowledge-tools.js';
import { HostCodingToolProvider } from './capabilities/providers/host-tools.js';
import { JiraToolProvider } from './capabilities/providers/jira-tools.js';
import { JiraClient } from './jira/client.js';
import { JiraProvider, operationMarker } from './work-management/jira-provider.js';
import { WorkManagementRegistry } from './work-management/types.js';
import type { WorkManagementProvider } from './work-management/types.js';
import { DefaultToolPolicy } from './tool-policy.js';
import { DenyHighRiskPolicyService } from './policy.js';
import { EntitlementService } from './entitlement-service.js';
import { AuditService } from './audit-service.js';
import { CommandService } from './command-service.js';
import type { CommandExecutionInput, CommandExecutor } from './command-service.js';
import type { ExternalOperationOutcome } from './work-management/outcome.js';
import { WorkerLeaseService } from './worker-lease.js';
import { EnvSecretProvider } from './mcp/secret-provider.js';
import { McpServerService, seedMcpServersOnBoot } from './mcp/service.js';
import { TeamStructureService } from './team-structure-service.js';
import { SchedulerService } from './scheduler-service.js';
import { TeamEventService } from './team-event-service.js';
import { healthRouter } from './routes/health.js';
import { membersRouter } from './routes/members.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { skillsRouter } from './routes/skills.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { internalRouter } from './routes/internal.js';
import { conversationsRouter } from './routes/conversations.js';
import { modelsRouter } from './routes/models.js';
import { executionsRouter } from './routes/executions.js';
import { tasksRouter } from './routes/tasks.js';
import { commandsRouter } from './routes/commands.js';
import { auditRouter } from './routes/audit.js';
import { teamRouter } from './routes/team.js';
import { workManagementRouter, describeWebhookBoundary } from './routes/work-management.js';
import { mcpRouter } from './routes/mcp.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initTeamScope, requireTeamMember } from './middleware/teamScope.js';
import { requireHumanAuth } from './middleware/auth.js';

/**
 * 依赖装配集中在这里，index.ts 和 route 都不再各自 new service()。
 *
 * 顺序是**单向**的，照着读就是数据流：
 *
 *   db → memberService → capabilityService → provider registry → resolver
 *      → copilotService → teamService
 *
 * 只有 CoreTeamToolProvider 需要反向调 TeamService（它执行的是业务编排），
 * 用惰性箭头函数打断 —— 调用发生在真正执行工具的那一刻，那时 TeamService
 * 早就构造完了。
 *
 * CopilotService 之所以排在最后能被 teamService 依赖、又不反过来依赖它：
 * 引擎不认识任何具体 Provider，它只接受一份解析好的 RuntimeCapabilities。
 */
let teamService!: TeamService;
let schedulerService!: SchedulerService;
let conversationFileProcessor!: ConversationFileProcessor;

const memberService = new MemberService(db);
const capabilityService = new CapabilityService(db);

// ── 授权与证据层 ────────────────────────────────────────────────────────
//
// 这三样都只是 DB 的包装，谁都不认识任何 Provider，所以它们可以在最前面构造。
// 顺序上它们**必须早于** CopilotService / CommandService —— 后两者要在构造时
// 拿到它们，而不是在执行时才去全局找一个。
//
//   EntitlementService  能碰什么数据（静态、按 Team/Member 配）
//   AuditService        事后证明发生了什么（两张表，见 audit-service.ts）
//
// Policy 是有状态无关的（进程内实现），所以直接 new 一个单例给所有调用方共用：
// 两处各 new 一个会让「同一版政策」这句话失去意义。
const entitlementService = new EntitlementService(db);
const auditService = new AuditService(db);
const policyService = new DenyHighRiskPolicyService();

// Worker 租约：多副本部署下「谁在跑这一轮」的唯一仲裁点。单进程时它仍然存在，
// 只是永远能抢到 —— 让两条路径共用同一份代码，而不是让「单机模式」走一条
// 从来没被测试过的分支。
const workerLease = new WorkerLeaseService(
  db,
  config.workerLeaseTtlMs,
  config.workerLeaseHeartbeatMs,
);

// Team SSE 的事件源。结构服务的每次业务变更都会回调到这里：append 与业务行
// 同事务落库，广播由 commit hook 保证在 COMMIT 之后 —— 先落库、后广播的纪律
// 在 Team 层与 Conversation 层是同一条。
const teamEvents = new TeamEventService(db);
const structureService = new TeamStructureService(db, (teamId, type, payload) => {
  teamEvents.append(teamId, type, payload);
});

const localKnowledgeProvider = new LocalFilesystemKnowledgeProvider(db, capabilityService);

const registry = new CapabilityRegistry();

// 三个 scope 各一个实例，只有 root 不同。skill 内容落盘位置与能力的三层一一
// 对应：global/team/member。team / member 的 root 要跟着 context 走 —— Team 级
// 能力必须知道是哪个 Team，Member 级要知道是哪个 Member。
registry.registerSkillProvider(
  new FilesystemSkillProvider('global.filesystem-skills', config.globalSkillRoot),
);
registry.registerSkillProvider(
  new FilesystemSkillProvider('team.filesystem-skills', (context) =>
    path.join(config.teamSkillRoot, context.teamId),
  ),
);
registry.registerSkillProvider(
  new FilesystemSkillProvider('member.filesystem-skills', (context) =>
    path.join(config.memberHomeRoot, context.memberId, 'skills'),
  ),
);

registry.registerKnowledgeProvider(localKnowledgeProvider);

registry.registerToolProvider(
  new CoreTeamToolProvider({
    delegateMember: (input) => teamService.delegateMember(input),
    rememberMember: (input) => teamService.rememberMember(input),
    messageMember: (input) => teamService.messageMember(input),
    requestClarification: (input) => teamService.requestClarification(input),
    planTasks: (input) => teamService.planTasks(input),
    addTask: (input) => teamService.addTask(input),
    reassignTask: (input) => teamService.reassignTask(input),
    learnExperience: (input) => teamService.learnExperience(input),
    updateGoal: (input) => teamService.updateGoalTool(input),
    replanTasks: (input) => teamService.replanTasks(input),
    updateTask: (input) => teamService.updateTask(input),
  }),
);
registry.registerToolProvider(new KnowledgeToolProvider());
registry.registerToolProvider(new HostCodingToolProvider());

// MCP Server 定义：DB（mcp_server 表）是运行时 source of truth，
// 文件只在空库启动时读一次（和 capability templates 同一套 baseline 纪律）。
// 运行与工具调用是 Copilot SDK 的事（sessionConfig.mcpServers），这里只决定
// 「有哪些 server 实现可用」。谁能用哪个 server 的哪些工具，是各层
// capability binding 的事，见 resolver。
const mcpServerService = new McpServerService(db, registry, config.mcpLocalEnabled);
if (seedMcpServersOnBoot({ freshInstall: migration.created, service: mcpServerService, filePath: config.mcpServersFile })) {
  // eslint-disable-next-line no-console
  console.log(`[server] mcp servers seeded from ${config.mcpServersFile}`);
}
// registry 是进程内 map，每次启动都是空的：DB 里已有的定义在这里补注册
// （seed 只管空库，不管这个）。
for (const server of mcpServerService.listDefinitions()) {
  registry.registerMcpServer(server);
}

// 外部工作系统适配层。Jira 连接三项齐了才注册 —— 没有连接就没有 Provider，
// 控制面因此走「无业务上下文」路径（不取证、不校验），而不是拿着一个调不通的
// 客户端去假装有业务上下文。
//
// 注意装配顺序：同一个 Provider 实例**同时**给两处用 ——
//   - 工具层（Agent 自己决定要不要评论/流转）
//   - 控制面（TeamService 在 execution 开始时取证、webhook 定位房间）
// 一个实现、两种调用方。控制面的动作永远不经过 LLM，但它们和 Agent 用的是
// 同一份业务语义，这是刻意的：否则「Agent 看到的工单」和「平台看到的工单」
// 会漂移成两套。
const workManagement = new WorkManagementRegistry();

// ── Command 层 ──────────────────────────────────────────────────────────
//
// 「真正要执行的业务动作」的唯一落点。它**不认识任何 Provider** —— 出口由
// 下面按 action 注册进来（见 registerExecutor 的调用）。这是刻意的：Command
// 的职责是「谁批的、执行没执行、结果是什么」，不是「怎么打 Jira」。
//
// Policy 单独传进来（而不是复用工具层那份判定）：Command 自己再过一遍 Policy，
// 是因为**平台也会发起 Command**（控制面回写、webhook），那条路径不经过工具
// 授权，只有把闸放在 Command 上两条路径才共用同一道。
const commandService = new CommandService(db, entitlementService, policyService, auditService);

const jiraConfigured = config.jira.baseUrl && config.jira.email && config.jira.apiToken;
if (jiraConfigured) {
  const jiraProvider = new JiraProvider(
    new JiraClient({
      baseUrl: config.jira.baseUrl,
      email: config.jira.email,
      apiToken: config.jira.apiToken,
    }),
    config.jira.baseUrl,
  );
  workManagement.register(jiraProvider);

  // 写动作的出口。工具层把「加评论 / 流转」转成 Command，真正打 Jira 的是这里
  // —— 两者分开之后，「它想干什么」和「它干了什么」才各有落点。
  //
  // 幂等由 CommandService 的 idempotency_key 保证：同一个 key 第二次进来拿到
  // 的是同一条记录，不会在 Jira 上留第二条评论。跨 execution 的 retry 由
  // CommandService 的 retry 链复用保证（见 findRetryableCommand）。
  //
  // 版本比对是**服务端**的（If-Unmodified-Since）：Command 上记着「批准时看到的
  // 版本」，执行时 Jira 在事务里比。客户端读一下再写只缩小窗口，关不掉它。
  const addComment: CommandExecutor = async ({ command, args }) => {
    const ref = jiraProvider.ref({ key: String(args.issueKey) });
    // 把这一笔的 operationId 打进评论正文。没有它的话，一次超时之后我们
    // **没有任何办法**知道那条评论到底发出去了没有 —— 而对账是唯一的出路，
    // 对账又需要一个能在 Jira 侧认人的标记。
    //
    // 标记是 HTML 注释的样子，人一眼能看出它是机器写的；代价是它在渲染出来的
    // 评论里也会占一行（ADF 没有不可见节点，见 operationMarker 的说明）。
    const body = `${String(args.body)}\n\n${operationMarker(command.operationId)}`;

    if (command.resourceVersion && jiraProvider.addCommentIfVersion) {
      await jiraProvider.addCommentIfVersion(ref, body, command.resourceVersion);
    } else {
      await jiraProvider.addComment(ref, body);
    }
    return { commented: ref.key };
  };
  addComment.reconcile = (input) => reconcileJiraOperation(jiraProvider, input);

  commandService.registerExecutor('jira.add_comment', addComment);

  const transitionIssue: CommandExecutor = async ({ command, args }) => {
    const ref = jiraProvider.ref({ key: String(args.issueKey) });
    const transitionId = String(args.transitionId);
    // 版本比对和加评论同源：Command 上记着「批准时看到的版本」，执行时 Jira
    // 在事务里比。区别在于这里**更必要** —— 评论写错了能删，流转写错了是把
    // 工作项推进到错误的状态，而 workflow 通常没有回头路。
    //
    // 没有版本（Provider 不提供 / 取证失败）时退回无条件流转：把「没有版本」
    // 当成「这次写入不能做」会让所有没有版本概念的系统完全不可用。
    if (command.resourceVersion && jiraProvider.transitionIfVersion) {
      await jiraProvider.transitionIfVersion(ref, transitionId, command.resourceVersion);
    } else {
      await jiraProvider.transition(ref, transitionId);
    }
    return { transitioned: ref.key, transitionId };
  };
  // 流转没有可打的标记（transition 接口不吃），所以对账只能读变更历史 ——
  // 见 JiraProvider.reconcileTransition 的说明。
  transitionIssue.reconcile = (input) => reconcileJiraOperation(jiraProvider, input);

  commandService.registerExecutor('jira.transition_issue', transitionIssue);

  registry.registerToolProvider(new JiraToolProvider(jiraProvider, commandService));
}

const capabilityResolver = new CapabilityResolver(registry, new EnvSecretProvider());

/**
 * 会话文件（聊天附件）。
 *
 * 它在 TeamService **之前**构造：TeamService 要用它挂附件、取附件。反向的那条
 * 依赖（文件状态变化要广播到会话事件流）用箭头函数打断 —— 调用发生在文件真的
 * 变化时，那时 TeamService 早就在了。
 *
 * 装配顺序上还有一处刻意：文件的 ACL 是 conversation membership，和 capability
 * 无关，所以它在这里**不经过** capabilityResolver。绕一圈反而会让人以为
 * 「看不到文件是因为没绑定能力」。
 */
const conversationFiles = new ConversationFileService(db, {
  root: config.conversationFileRoot,
  maxBytesPerFile: config.maxConversationFileBytes,
  maxFilesPerConversation: config.maxConversationFilesPerConversation,
  maxFilesPerMessage: config.maxConversationFilesPerMessage,
  onEvent: (conversationId, type, file) =>
    teamService.conversationFileChanged(conversationId, type, file),
});

conversationFileProcessor = new ConversationFileProcessor(
  conversationFiles,
  config.maxExtractedTextChars,
);

registry.registerToolProvider(
  new ConversationFileToolProvider(conversationFileToolHost(conversationFiles)),
);

// Skill 内容的统一存储与安装。三个 scope（global / team / member）共用这一个
// 服务 —— 它按 scope 决定落盘位置，并在这里统一执行 zip 的三道安全闸。
const skillService = new SkillService(db);

const copilotService = new CopilotService({
  // 三层判定的顺序在 DefaultToolPolicy 里：Capability → Entitlement → Policy。
  // 传进去的两个实现都是**唯一实例**（同一个 policyService 也给了 CommandService）：
  // 两处各 new 一个会让「同一版政策」这句话失去意义。
  toolPolicy: new DefaultToolPolicy(
    { allowHostTools: config.allowHostCodingTools },
    policyService,
    entitlementService,
  ),
  // 工具调用的审计口。不传时整条审计链静默关闭 —— 生产装配永远传。
  audit: auditService,
  // MCP 调用展示：放行即通知，执行完成没有回调（见 notifyMcpToolUse）。
  onMcpToolUse: (info) => teamService.notifyMcpToolUse(info),
});

teamService = new TeamService(
  db,
  memberService,
  copilotService,
  capabilityService,
  capabilityResolver,
  structureService,
  // Member Activity：业务工作在 Jira，本地广播「谁在跑哪张工单的这一轮」。
  (teamId, type, payload) => teamEvents.append(teamId, type, payload),
  workManagement,
  conversationFiles,
  // 授权层的版本进 execution 快照：事后才能回答「当时按哪版政策 / 哪版数据
  // 授权放的行」。传回调而不是常量 —— 版本会变，常量记的是装配那一刻的值。
  {
    policy: () => policyService.revision(),
    entitlement: () => entitlementService.revision(),
  },
  // 执行链的租约。不启用时传 undefined —— 单进程语义，和 SchedulerService /
  // RecoveryService 同一套约定。传的是**同一个** workerLease 实例：租约的
  // owner 是进程身份，换一个实例就等于换一个身份。
  config.workerLeaseEnabled ? workerLease : undefined,
);

// Scheduler 也拿同一份租约：多副本时它是「同一条 schedule 被两个副本各跑一遍」
// 的唯一防线（scheduled_wake_run 的 UNIQUE 只保证一行，不保证只有一个进程去执行）。
// 不启用租约时传 undefined —— 单进程语义，和 RecoveryService 同一套约定。
schedulerService = new SchedulerService(
  structureService,
  () => teamService,
  config.workerLeaseEnabled ? workerLease : undefined,
);

// teamScope 的默认 Team 在 index 启动时 ensure 后再 init（库尚未就位时无 id 可用）。
// 这里先给一个占位，index 会用真实 teamId 重新 init。

// Skill / KB 的目录是「放进去就生效」的磁盘约定，必须先存在。
// KB 行本身由启动时的 syncFromDisk 按 directory 建，这里只兜目录。
// team 级 skill 的实际根是 <teamSkillRoot>/<teamId>，由 Provider 在解析时拼；
// 这里兜的是它们的父目录。
fs.mkdirSync(config.globalSkillRoot, { recursive: true });
fs.mkdirSync(config.teamSkillRoot, { recursive: true });
fs.mkdirSync(config.teamKnowledgeRoot, { recursive: true });
// 会话文件的根目录。每个会话的文件在 <root>/<conversationId>/files/ 下按需创建。
fs.mkdirSync(config.conversationFileRoot, { recursive: true });

export const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));

app.use('/api/health', healthRouter);
// Human API 统一先过 OIDC，再过 Team 成员门禁。health / internal /
// work-management webhook 不走这里（各自独立门禁）。
const humanApi = [requireHumanAuth(), requireTeamMember()];
app.use('/api/members', ...humanApi, membersRouter(teamService));
// 更具体的先挂：/api/capabilities/skills/* 是「磁盘上装了哪些 skill」，
// /api/capabilities/* 是「启用了哪些能力来源」。两者刻意分开。
app.use('/api/capabilities/skills', ...humanApi, skillsRouter(skillService));
app.use(
  '/api/capabilities',
  ...humanApi,
  capabilitiesRouter(teamService, registry, skillService, localKnowledgeProvider, {
    hostToolsEnabled: config.allowHostCodingTools,
  }),
);
app.use('/api/knowledge', ...humanApi, knowledgeRouter(localKnowledgeProvider));
app.use('/api/team', ...humanApi, teamRouter(structureService, teamEvents, teamService));
app.use('/api/work-management', workManagementRouter(teamService, workManagement));
app.use(
  '/api/conversations',
  ...humanApi,
  conversationsRouter(teamService, conversationFiles, conversationFileProcessor, localKnowledgeProvider),
);
app.use('/api/models', ...humanApi, modelsRouter());
app.use('/api/executions', ...humanApi, executionsRouter(teamService));
app.use('/api/tasks', ...humanApi, tasksRouter(teamService));
// 外部写入的控制面：默认 Policy 把一切 external-write 停在 policy_pending，
// 这个路由是唯一的放行出口（审批 / 驳回 / 显式执行）。
app.use('/api/commands', ...humanApi, commandsRouter(teamService, commandService, auditService));
// 事后证据：一次 execution 的判定 / 调用 / 业务动作三张表，支持导出。
app.use('/api/audit', ...humanApi, auditRouter(teamService, auditService));
// 以某个 Member 的身份说话 —— 独立的命名空间 + token 门禁，见 middleware/apiScope.ts
app.use('/api/internal', internalRouter(teamService));
app.use('/api/mcp', ...humanApi, mcpRouter(mcpServerService));

// 未匹配的 /api/* 返回 JSON 404，不要掉进下面的 SPA fallback 拿到一份 HTML
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use(errorHandler);

// 生产：Express 直接 serve Vite 构建产物。dev 由 vite dev server 提供页面，
// 仅 /api 走 proxy；两种模式前端都用同源相对路径，无 CORS 分支。
const DIST_DIR = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

export {
  copilotService,
  memberService,
  capabilityService,
  capabilityResolver,
  mcpServerService,
  localKnowledgeProvider,
  registry,
  skillService,
  teamService,
  structureService,
  schedulerService,
  conversationFiles,
  conversationFileProcessor,
  teamEvents,
  workManagement,
  entitlementService,
  auditService,
  commandService,
  workerLease,
  describeWebhookBoundary,
};

export { initTeamScope };

/**
 * 把「对账一条 Command」翻译成「问 Provider 这一笔做了没有」。
 *
 * 两个 Jira executor 共用它：形状完全一样，差别全在 Provider 的
 * `reconcileOperation` 里（评论找正文标记、流转读变更历史）。
 *
 * ── `attemptStartedAt` 为什么不是 `command.executedAt` ────────────────
 *
 * `executed_at` 是「我们放弃等待、判定结果未知」的时刻，而真正的外部写入发生
 * 在尝试**开始**和它之间。拿后者当时间窗下界，会把自己的那次写入排除在窗口外
 * —— 于是对账把一次**已经发生**的写入报成 failed，而 failed 的下一个动作是
 * 重试。方向恰好是反的。
 *
 * 取不到 attempt 时退回 `createdAt`：那比任何尝试都**更早**，窗口更宽 →
 * 更可能落到 `unknown`。在「可能报错结论」和「可能漏掉证据」之间，这里选后者
 * —— `unknown` 会继续挡住重试，而一个错的 failed 会把它放出去。
 */
function reconcileJiraOperation(
  provider: WorkManagementProvider,
  input: CommandExecutionInput,
): Promise<ExternalOperationOutcome> {
  const { command, args, attempt } = input;
  if (!provider.reconcileOperation) {
    return Promise.resolve({
      status: 'unknown',
      detail: `Provider ${provider.providerId} 不支持对账`,
    });
  }
  return provider.reconcileOperation({
    operationId: command.operationId,
    action: command.action,
    target: command.target,
    args,
    attemptStartedAt: attempt?.startedAt ?? command.createdAt,
  });
}
