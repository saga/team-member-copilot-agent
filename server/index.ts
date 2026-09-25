import fs from 'node:fs';
import path from 'node:path';
import { app, copilotService } from './app.js';
import { config } from './config.js';

// 与 app.ts 用同一个基准，避免两处 DIST_DIR 指向不同目录
const DIST_DIR = path.resolve(process.cwd(), 'dist');
if (!fs.existsSync(DIST_DIR)) {
  // eslint-disable-next-line no-console
  console.log('[server] dist/ 不存在，当前使用 dev/API 模式');
}

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${config.port}`);
  if (config.warmup) {
    void copilotService.warmup().then((result) => {
      if (result.ok) {
        // eslint-disable-next-line no-console
        console.log('[server] copilot runtime 预热完成');
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[server] copilot runtime 预热失败：${result.error}（首个 turn 会重试）`);
      }
    });
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[server] received ${signal}, draining...`);
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await copilotService.stop();
  } finally {
    process.exit(0);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}
