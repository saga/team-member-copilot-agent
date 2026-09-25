import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { copilotService } from './copilot.js';
import { healthRouter } from './routes/health.js';
import { sessionsRouter } from './routes/sessions.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tsc 把 server/ 编译到 dist-server/，运行时 DIST_DIR 回到仓库根的 dist/
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));

// React 前端统一调用 /api/*
app.use('/api/health', healthRouter);
app.use('/api/sessions', sessionsRouter);

app.use(errorHandler);

// 生产：Express 直接 serve Vite 构建产物（dev 由 vite dev server 提供页面，
// 仅 /api 走 proxy；两种模式前端都用同源相对路径，无 CORS 分支）。
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => {
    res.type('text').send(
      '未找到 dist/ 构建目录。请先运行 `npm run build`，再启动本服务（`npm start`）。\n' +
        '开发模式请用 `npm run dev`（Vite :5173 + Express :3001）。',
    );
  });
}

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${config.port}`);
  if (config.warmup) {
    void copilotService.warmup().then((r) => {
      if (r.ok) console.log('[server] copilot runtime 预热完成');
      else console.warn(`[server] copilot runtime 预热失败：${r.error}（首个会话请求会重试）`);
    });
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, draining...`);
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await copilotService.stop();
  } finally {
    process.exit(0);
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void shutdown(sig));
}
