import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { db } from './db.js';
import { MemberService } from './member-service.js';
import { CopilotService } from './copilot.js';
import { TeamService } from './team-service.js';
import { healthRouter } from './routes/health.js';
import { membersRouter } from './routes/members.js';
import { internalRouter } from './routes/internal.js';
import { conversationsRouter } from './routes/conversations.js';
import { executionsRouter } from './routes/executions.js';
import { errorHandler } from './middleware/errorHandler.js';

/**
 * 依赖装配集中在这里，index.ts 和 route 都不再各自 new service()。
 *
 * CopilotService 需要回调 TeamService，TeamService 又需要 CopilotService，
 * 所以先用延迟求值的箭头函数打破循环，再补上真正的实例。
 */
let teamService!: TeamService;

const copilotService = new CopilotService({
  delegateMember: (input) => teamService.delegateMember(input),
  rememberMember: (input) => teamService.rememberMember(input),
  messageMember: (input) => teamService.messageMember(input),
});

const memberService = new MemberService(db);
teamService = new TeamService(db, memberService, copilotService);

export const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));

app.use('/api/health', healthRouter);
app.use('/api/members', membersRouter(teamService));
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

export { copilotService, memberService, teamService };
