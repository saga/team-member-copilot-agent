import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { app, copilotService, teamService } from './app.js';
import { config } from './config.js';
import { db, migration } from './db.js';
import { RecoveryService } from './recovery-service.js';

// 与 app.ts 用同一个基准，避免两处 DIST_DIR 指向不同目录
const DIST_DIR = path.resolve(process.cwd(), 'dist');
if (!fs.existsSync(DIST_DIR)) {
  // eslint-disable-next-line no-console
  console.log('[server] dist/ 不存在，当前使用 dev/API 模式');
}

let server: Server | null = null;

/**
 * 启动顺序很重要：
 *   1. schema 迁移（db.ts 在 import 时已完成）
 *   2. 崩溃恢复 —— 必须在开始接请求之前，否则客户端会看到一个正在被改写的中途状态
 *   3. 重新提交 queued 的 root execution / 重新派发丢失的唤醒（fire-and-forget）
 *   4. listen
 */
async function bootstrap(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    migration.fresh
      ? `[server] 新建数据库 schema v${migration.to}`
      : `[server] schema ${migration.from} → ${migration.to}（${migration.applied.join(', ') || '无变更'}）`,
  );

  if (config.recoverOnStartup) {
    const report = new RecoveryService(db).recover();
    // eslint-disable-next-line no-console
    console.log(
      `[server] recovery: interrupted=${report.interrupted} ` +
        `orphanChildren=${report.interruptedOrphanChildren} ` +
        `runtimesReset=${report.runtimesReset} ` +
        `activeCleared=${report.activeExecutionCleared} ` +
        `requeue=${report.requeuedExecutionIds.length} ` +
        `lostWakes=${report.lostWakes.length}`,
    );

    // 这些 execution 从来没开始跑过（进程在真正执行前就挂了），重跑是安全的。
    for (const executionId of report.requeuedExecutionIds) {
      void teamService.resumeQueuedExecution(executionId);
    }

    // 同理：wake_status 还是 queued 的唤醒也从来没开始跑过。
    // 顺序上放在 execution 之后 —— 先让已存在的 execution 跑起来，
    // 再补那些连 execution 都还没创建的唤醒。
    for (const wake of report.lostWakes) {
      teamService.redispatchWake(wake);
    }
  }

  server = app.listen(config.port, () => {
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
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[server] received ${signal}, draining...`);
  try {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await copilotService.stop();
  } finally {
    process.exit(0);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

void bootstrap();
