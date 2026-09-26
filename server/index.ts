import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import {
  app,
  copilotService,
  memberService,
  localKnowledgeProvider,
  capabilityService,
  capabilityResolver,
  teamService,
  structureService,
  schedulerService,
  workManagement,
  describeWebhookBoundary,
  initTeamScope,
} from './app.js';
import { config } from './config.js';
import { db, migration } from './db.js';
import { RecoveryService } from './recovery-service.js';
import { ConversationMemberService } from './conversation-member-service.js';
import { seedMemberTemplates } from './member-template-seeder.js';
import { describeApiBoundary } from './middleware/apiScope.js';

// 与 app.ts 用同一个基准，避免两处 DIST_DIR 指向不同目录
const DIST_DIR = path.resolve(process.cwd(), 'dist');
if (!fs.existsSync(DIST_DIR)) {
  // eslint-disable-next-line no-console
  console.log('[server] dist/ 不存在，当前使用 dev/API 模式');
}

let server: Server | null = null;

/**
 * 启动顺序很重要：
 *   1. schema 就位（db.ts 在 import 时已完成；空库建，形状不符直接让启动失败）
 *   2. ensure 默认 Team + human owner（TeamScope 门禁与 conversation 归属的前提）
 *   3. Knowledge 兜底（磁盘资料进索引 / personal KB 补齐）—— 模板引用的 team KB
 *      要先存在，所以这一步必须先于 provisioning
 *   4. Member provisioning —— 默认团队要在 recovery 之前就位，否则恢复出来的
 *      execution 可能指向一个还没被创建出来的 Member。
 *      模板里的能力引用在这一步对注册表校验：写错一个 Provider ID 就启动失败。
 *   5. 存量 Member 补 agent membership（provisioning 只建新人，不补旧库）
 *   6. 崩溃恢复 + schedule run 恢复 —— 必须在开始接请求之前，否则客户端会看到
 *      一个正在被改写的中途状态；Scheduler 必须在 Recovery 完成后才启动
 *   7. 重新提交 queued 的 root execution / 重新派发丢失的唤醒（fire-and-forget）
 *   8. 启动 Scheduler → listen
 */
async function bootstrap(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    migration.created
      ? `[server] 新建数据库 schema v${migration.to}`
      : `[server] schema v${migration.to}（已就绪）`,
  );

  // 默认 Team 先行：membership / conversation team_id / teamScope 都依赖它。
  const team = structureService.ensureDefaultTeam();
  structureService.ensureHumanOwner(team.id, config.localActorId);
  initTeamScope(structureService, team.id);
  // eslint-disable-next-line no-console
  console.log(`[server] team: ${team.name} (${team.id})`);
  for (const member of memberService.list()) {
    structureService.ensureAgentMembership(team.id, member.id);
  }

  // 磁盘同步先于模板 provisioning：模板引用的 team KB key 要求 KB 行已经存在。
  // Personal KB 与 Member 一一对应且创建路径不止一条（API / 模板 / 旧库），
  // 所以在启动时统一兜一遍幂等 ensure，而不是在每个创建入口各记一次。
  for (const member of memberService.list()) {
    localKnowledgeProvider.ensurePersonalKnowledgeBase(member.id, member.name);
  }

  // 磁盘即资料入口：team KB 目录缺行则建，文件按 hash 幂等进索引。
  const synced = localKnowledgeProvider.syncFromDisk(memberService.list().map((m) => m.id));
  // eslint-disable-next-line no-console
  console.log(
    `[server] knowledge sync: team+${synced.teamBases} personal+${synced.personalBases} indexed=${synced.indexed}`,
  );

  if (config.seedDefaultMembers) {
    const seeded = seedMemberTemplates(
      memberService,
      config.memberTemplatesDir,
      capabilityService,
      capabilityResolver,
    );
    // 启动日志里必须能看出「这次是建了人还是只是确认过」：两种都会让 Member 列表
    // 是满的，但只有 created 非空时才说明模板目录真的被读到了。
    // eslint-disable-next-line no-console
    console.log(
      `[server] member provisioning: created=${seeded.created.length}` +
        `${seeded.created.length ? ` (${seeded.created.join(', ')})` : ''} ` +
        `skipped=${seeded.skipped.length}`,
    );
  }

  // provisioning 建的新人也要进 Team（seed 路径不走 TeamService.createMember）。
  for (const member of memberService.list()) {
    structureService.ensureAgentMembership(team.id, member.id);
  }

  // 已有 DB 里的坏 binding 必须在接请求前挡掉：模板只校验新创建的 Member，
  // 而旧库里可能留着当前 build 已不注册的 Provider（比如换了构建、删了插件）。
  // 等到真正执行 turn 才炸，症状是「回答变奇怪」而不是一条错误。
  for (const member of memberService.list()) {
    capabilityResolver.validate(capabilityService.get(member.id));
  }

  if (config.recoverOnStartup) {
    const report = new RecoveryService(db, new ConversationMemberService(db)).recover();
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

    // schedule run 恢复：queued/running 且无 execution 的重新建 execution。
    // 依靠 UNIQUE(schedule_id, scheduled_for) 不会重复 fire。
    schedulerService.recoverQueuedRuns();
  }

  // Scheduler 在 Recovery 完成后才启动：否则旧 execution 的 interrupted 标记
  // 与 schedule 触发会同时碰同一个 Member。
  schedulerService.start();

  server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on http://localhost:${config.port}`);
    // 边界只在日志里说出来才存在：没配 token 时得让人知道这个服务只该待在本机。
    // eslint-disable-next-line no-console
    console.log(`[server] ${describeApiBoundary()}`);
    // 外部工作系统的接入状态也要说出来：没接 Provider 时「工单引用」会静默
    // 退化成「只有 key 的引用」，而这件事从数据上看不出来。
    // eslint-disable-next-line no-console
    console.log(
      `[server] work management: ${workManagement.size ? 'jira' : '未配置（无外部工作上下文）'}`,
    );
    // eslint-disable-next-line no-console
    console.log(`[server] ${describeWebhookBoundary()}`);
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
    schedulerService.stop();
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
