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
  conversationFileProcessor,
  workManagement,
  workerLease,
  describeWebhookBoundary,
  initTeamScope,
} from './app.js';
import { config } from './config.js';
import { db, migration } from './db.js';
import { RecoveryService } from './recovery-service.js';
import { ConversationMemberService } from './conversation-member-service.js';
import { CapabilityProvisioner } from './capabilities/provisioner.js';
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
  // 生产模式必须配 OIDC：没有真实用户系统就拒绝启动，而不是悄悄回落
  // 到 LOCAL_ACTOR_ID。本地开发与测试走 AUTH_DEV_MODE=true。
  if (!config.authDevMode) {
    if (!config.oidc.issuer || !config.oidc.audience || !config.oidc.jwksUrl) {
      throw new Error('生产模式必须配置 OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URL');
    }
  }
  // 多副本 + 启动恢复 + 没有租约 = 一定会双跑。
  //
  // 具体怎么坏：两个副本同时启动，各自把对方正在跑的 execution 标成 interrupted，
  // 然后各自重新提交一遍 —— 同一个 Jira 评论写两次。这类副作用不可撤销，
  // 所以宁可拒绝启动，也不要「先跑起来再说」。
  //
  // 只警告不拦是不行的：日志里的警告不会阻止部署，而这个配置一旦上线，
  // 表现是「偶尔有一条评论重复」，几乎不可能被联想到启动参数。
  if (config.recoverOnStartup && config.workerReplicas > 1 && !config.workerLeaseEnabled) {
    throw new Error('WORKER_REPLICAS > 1 时必须启用 WORKER_LEASE_ENABLED=true');
  }
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

  // global / team 两层能力的 provisioning 必须在 Member 之前：它们决定
  // 「所有人 / 这个团队默认能用什么」，而 Member 的能力只是增量。顺序反过来的话，
  // 第一轮 turn 会跑在一个还没有任何基线能力的 Member 上。
  //
  // 幂等靠 capability_scope 的 INSERT OR IGNORE：只有第一次会真的写入。
  // 管理员把某一层清空之后，重启不会再灌回来。
  const capabilityProvisioner = new CapabilityProvisioner(
    capabilityService,
    capabilityResolver,
    config.capabilityTemplatesDir,
  );
  const seededGlobal = capabilityProvisioner.seedGlobal();
  const seededTeam = capabilityProvisioner.seedTeam(team.id);
  // eslint-disable-next-line no-console
  console.log(
    `[server] capability provisioning: global=${seededGlobal ? 'seeded' : 'existing'} ` +
      `team=${seededTeam ? 'seeded' : 'existing'}`,
  );

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
  //
  // 校验的是 **effective**（三层叠加）而不是 member 层：真正下发给引擎的就是
  // 叠加后的那一份，只校验增量会让 global / team 层里的坏 ID 溜过去。
  for (const member of memberService.list()) {
    capabilityResolver.validate(capabilityService.getEffective(team.id, member.id));
  }

  // 会话文件恢复：上次进程在提取途中挂掉时，那些文件停在 processing。
  // 放在 execution recovery 之前 —— 一轮 turn 可能正等着某个文件的附件，
  // 先把文件补完，恢复出来的 execution 才拿到它该拿的东西。
  const recoveredFiles = conversationFileProcessor.recoverProcessing();
  // eslint-disable-next-line no-console
  console.log(`[server] conversation files recovery: requeued=${recoveredFiles}`);

  if (config.recoverOnStartup) {
    // 传 leases 只在多副本部署下有意义：单进程时「running」必然属于刚崩掉的
    // 自己，全部回收是对的；多副本时必须先问「有没有别的副本正持有它」。
    //
    // 注意这里传的是**同一个** workerLease 实例（来自 app.ts）：租约的 owner
    // 是本进程的身份，换一个实例就等于换一个身份，恢复流程会把自己正在跑的活
    // 当成别人的。当前恢复在 listen 之前、还没有 claim 发生，但共用实例让这个
    // 前提不依赖于「启动顺序恰好如此」。
    const recovery = new RecoveryService(
      db,
      new ConversationMemberService(db),
      config.workerLeaseEnabled ? workerLease : undefined,
    );
    const report = recovery.recover();
    // eslint-disable-next-line no-console
    console.log(
      `[server] recovery: interrupted=${report.interrupted} ` +
        `orphanChildren=${report.interruptedOrphanChildren} ` +
        `runtimesReset=${report.runtimesReset} ` +
        `activeCleared=${report.activeExecutionCleared} ` +
        `requeue=${report.requeuedExecutionIds.length} ` +
        `lostWakes=${report.lostWakes.length} ` +
        // 「跳过了几条」必须打出来：多副本时这个数字不为零是正常的，但没人
        // 知道它就等于「有些 execution 莫名没被回收」，而那是要查的事。
        `skippedLeased=${report.skippedLeased}`,
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
