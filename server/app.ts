import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { db } from './db.js';
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
import { KnowledgeToolProvider } from './capabilities/providers/knowledge-tools.js';
import { HostCodingToolProvider } from './capabilities/providers/host-tools.js';
import { JiraToolProvider } from './capabilities/providers/jira-tools.js';
import { JiraClient } from './jira/client.js';
import { JiraProvider } from './work-management/jira-provider.js';
import { WorkManagementRegistry } from './work-management/types.js';
import { DefaultToolPolicy } from './tool-policy.js';
import { DenyHighRiskPolicyService } from './policy.js';
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
import { executionsRouter } from './routes/executions.js';
import { teamRouter } from './routes/team.js';
import { workManagementRouter, describeWebhookBoundary } from './routes/work-management.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initTeamScope } from './middleware/teamScope.js';

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

const memberService = new MemberService(db);
const capabilityService = new CapabilityService(db);

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
  }),
);
registry.registerToolProvider(new KnowledgeToolProvider());
registry.registerToolProvider(new HostCodingToolProvider());

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
  registry.registerToolProvider(new JiraToolProvider(jiraProvider));
}

const capabilityResolver = new CapabilityResolver(registry);

// Skill 内容的统一存储与安装。三个 scope（global / team / member）共用这一个
// 服务 —— 它按 scope 决定落盘位置，并在这里统一执行 zip 的三道安全闸。
const skillService = new SkillService(db);

const copilotService = new CopilotService({
  toolPolicy: new DefaultToolPolicy(
    { allowHostTools: config.allowHostCodingTools },
    new DenyHighRiskPolicyService(),
  ),
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
);

schedulerService = new SchedulerService(structureService, () => teamService);

// teamScope 的默认 Team 在 index 启动时 ensure 后再 init（库尚未就位时无 id 可用）。
// 这里先给一个占位，index 会用真实 teamId 重新 init。

// Skill / KB 的目录是「放进去就生效」的磁盘约定，必须先存在。
// KB 行本身由启动时的 syncFromDisk 按 directory 建，这里只兜目录。
// team 级 skill 的实际根是 <teamSkillRoot>/<teamId>，由 Provider 在解析时拼；
// 这里兜的是它们的父目录。
fs.mkdirSync(config.globalSkillRoot, { recursive: true });
fs.mkdirSync(config.teamSkillRoot, { recursive: true });
fs.mkdirSync(config.teamKnowledgeRoot, { recursive: true });

export const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));

app.use('/api/health', healthRouter);
app.use('/api/members', membersRouter(teamService));
// 更具体的先挂：/api/capabilities/skills/* 是「磁盘上装了哪些 skill」，
// /api/capabilities/* 是「启用了哪些能力来源」。两者刻意分开。
app.use('/api/capabilities/skills', skillsRouter(skillService));
app.use(
  '/api/capabilities',
  capabilitiesRouter(teamService, registry, skillService, localKnowledgeProvider, {
    hostToolsEnabled: config.allowHostCodingTools,
  }),
);
app.use('/api/knowledge', knowledgeRouter(localKnowledgeProvider));
app.use('/api/team', teamRouter(structureService, teamEvents));
app.use('/api/work-management', workManagementRouter(teamService, workManagement));
app.use('/api/conversations', conversationsRouter(teamService));
app.use('/api/executions', executionsRouter(teamService));
// 以某个 Member 的身份说话 —— 独立的命名空间 + token 门禁，见 middleware/apiScope.ts
app.use('/api/internal', internalRouter(teamService));

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
  localKnowledgeProvider,
  registry,
  skillService,
  teamService,
  structureService,
  schedulerService,
  teamEvents,
  workManagement,
  describeWebhookBoundary,
};

export { initTeamScope };
