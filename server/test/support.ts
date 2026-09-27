import assert from 'node:assert/strict';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import type { CopilotService, RunMemberTurnInput } from '../copilot.js';
import type { WakePlan } from '../team-service.js';
import { TeamService } from '../team-service.js';
import type { CapabilityContext } from '../capabilities/types.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { CapabilityResolver } from '../capabilities/resolver.js';
import { CapabilityService } from '../capabilities/service.js';
import { FilesystemSkillProvider } from '../capabilities/providers/filesystem-skill.js';
import { LocalFilesystemKnowledgeProvider } from '../capabilities/providers/filesystem-knowledge.js';
import { CoreTeamToolProvider } from '../capabilities/providers/core-tools.js';
import {
  ConversationFileToolProvider,
  conversationFileToolHost,
} from '../capabilities/providers/conversation-file-tools.js';
import { ConversationFileService } from '../conversation-file-service.js';
import { ConversationFileProcessor } from '../conversation-file-processor.js';
import { KnowledgeToolProvider } from '../capabilities/providers/knowledge-tools.js';
import { HostCodingToolProvider } from '../capabilities/providers/host-tools.js';
import type { MemberService } from '../member-service.js';
import { TeamStructureService } from '../team-structure-service.js';
import type { WorkManagementRegistry } from '../work-management/types.js';

/**
 * 测试用的能力装配。
 *
 * 形状与 `server/app.ts` 一致（同一个顺序、同一组 Provider），所以用例里跑的是
 * 真实链路，而不是一份「测试专用」的简化装配 —— 后者会让人在 app.ts 里漏接一个
 * Provider 而测试全绿。
 *
 * 与 app.ts 的差别只有两点，都是测试需要：
 *   - CopilotService 是 stub（不拉起真实 CLI 进程）
 *   - 不注册 routes
 */
export interface CapabilityStack {
  capabilities: CapabilityService;
  knowledge: LocalFilesystemKnowledgeProvider;
  registry: CapabilityRegistry;
  resolver: CapabilityResolver;
  /** 会话文件（聊天附件）。工具注册与 TeamService 都用同一个实例。 */
  conversationFiles: ConversationFileService;
}

export interface TestStack extends CapabilityStack {
  team: TeamService;
  structure: TeamStructureService;
  processor: ConversationFileProcessor;
}

/**
 * 只装能力层（不需要 TeamService / Copilot）。
 *
 * 模板 provisioning、Provider 契约这些用例只用得上能力层，但它们必须与
 * TeamService 的用例走**同一份**注册表 —— 否则「模板里写的 Provider ID 在部署里
 * 存不存在」这件事就有两套答案。
 *
 * `resolveTeam` 是 CoreTeamToolProvider 的反向依赖（它执行的是业务编排），
 * 用惰性回调打断循环；纯能力层的用例可以传一个直接抛的实现 —— 那些工具在
 * 这些用例里只会被「解析出来」，不会被真正执行。
 */
export function createCapabilityStack(
  db: DatabaseSync,
  _members: MemberService,
  resolveTeam: () => TeamService,
): CapabilityStack {
  const capabilities = new CapabilityService(db);
  const knowledge = new LocalFilesystemKnowledgeProvider(db, capabilities);

  const registry = new CapabilityRegistry();
  // 三个 scope 都要注册，顺序与 app.ts 一致：global / team / member 三层 skill。
  // 只注册后两个的话，能力模板里引用的 `global.filesystem-skills` 在测试里
  // 会变成「未注册 Provider」—— 而它在生产里是存在的。
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
  registry.registerKnowledgeProvider(knowledge);

  registry.registerToolProvider(
    new CoreTeamToolProvider({
      delegateMember: (input) => resolveTeam().delegateMember(input),
      rememberMember: (input) => resolveTeam().rememberMember(input),
      messageMember: (input) => resolveTeam().messageMember(input),
      requestClarification: (input) => resolveTeam().requestClarification(input),
      planTasks: (input) => resolveTeam().planTasks(input),
      addTask: (input) => resolveTeam().addTask(input),
      reassignTask: (input) => resolveTeam().reassignTask(input),
      learnExperience: (input) => resolveTeam().learnExperience(input),
      updateTask: (input) => resolveTeam().updateTask(input),
    }),
  );
  registry.registerToolProvider(new KnowledgeToolProvider());
  registry.registerToolProvider(new HostCodingToolProvider());

  // 会话文件：和 app.ts 一样先建服务再注册工具 —— 全局能力模板引用了
  // `conversation.file-tools`，注册表里没有它的话，模板 provisioning 会在
  // 「Provider ID 未注册」这一步直接失败。
  const conversationFiles = new ConversationFileService(db, {
    root: config.conversationFileRoot,
    maxBytesPerFile: config.maxConversationFileBytes,
    maxFilesPerConversation: config.maxConversationFilesPerConversation,
    maxFilesPerMessage: config.maxConversationFilesPerMessage,
  });
  registry.registerToolProvider(
    new ConversationFileToolProvider(conversationFileToolHost(conversationFiles)),
  );

  return {
    capabilities,
    knowledge,
    registry,
    resolver: new CapabilityResolver(registry),
    conversationFiles,
  };
}

export function createTestStack(
  db: DatabaseSync,
  members: MemberService,
  copilot: CopilotService,
  /**
   * 外部工作系统适配层。默认不传 —— 绝大多数用例跑的是「这套部署没接外部
   * 工作系统」的路径，那本身就是要保证的默认行为（引用退化成只有 key，
   * 取证安静地拿不到东西，而不是抛错）。
   */
  workManagement?: WorkManagementRegistry,
): TestStack {
  let team!: TeamService;
  const stack = createCapabilityStack(db, members, () => team);
  const structure = new TeamStructureService(db);
  const processor = new ConversationFileProcessor(
    stack.conversationFiles,
    config.maxExtractedTextChars,
  );
  team = new TeamService(
    db,
    members,
    copilot,
    stack.capabilities,
    stack.resolver,
    structure,
    undefined,
    workManagement,
    stack.conversationFiles,
  );
  return { ...stack, team, structure, processor };
}

/**
 * 直接调 Provider 时用的最小上下文。
 *
 * `teamId` 有默认值，因为绝大多数用例只关心「这个 Member 拿到什么」而不关心
 * 是哪个 Team。但 Provider 侧会用它去校验 Team 级能力（skill 根目录、knowledge
 * binding），所以需要真 Team 的用例必须显式传 —— 编造的 teamId 会在
 * `assertTeamExists` 那里变成 404。
 */
export function capabilityContext(memberId: string, teamId = 'test-team'): CapabilityContext {
  return {
    teamId,
    memberId,
    conversationId: 'test-conversation',
    executionId: 'test-execution',
    userId: 'test-user',
  };
}

/**
 * 测试共享助手。放在 support.ts 而不是 *.test.ts，避免被 `npm test` 的
 * glob 当成一个空的用例文件跑起来。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 *
 * `POST /messages` 返回的是 `wakes[]`，不是单个 executionId：group 房间里
 * 一条消息可以唤醒多个 Member，各自产生一条 execution，一个字段表达不了。
 *
 * 但绝大多数用例是「发一条消息 → 等这一条跑完」的单收件人场景。与其在每个
 * 断言里手工去查 execution，不如把「这条 wake 对应哪条 execution」收成一个
 * 函数 —— 用例读起来仍然是一句话。
 *
 * ── 时序 ────────────────────────────────────────────────────────────
 *
 * `scheduler.enqueue()` 是同步的：它会一路同步走到 `runWake()` 里的
 * `insertExecution()` 才在 `await executeMemberTurn()` 处让出控制权。
 * 因此 `sendMessage()` 返回时，对应的 execution 行**已经落库**，这里可以
 * 直接查，不需要轮询。
 */
export function executionIdForWake(
  db: DatabaseSync,
  conversationId: string,
  wake: WakePlan,
): string {
  if (wake.triggerSequence === null || wake.triggerSequence === undefined) {
    const taskRow = db
      .prepare(
        `
        SELECT id
        FROM execution
        WHERE conversation_id = ?
          AND member_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
        `,
      )
      .get(conversationId, wake.memberId) as unknown as { id: string } | undefined;
    assert.ok(taskRow, `找不到 wake(${wake.memberId}) 对应的 execution`);
    return taskRow.id;
  }
  const row = db
    .prepare(
      `
      SELECT id
      FROM execution
      WHERE conversation_id = ?
        AND member_id = ?
        AND trigger_message_sequence = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
      `,
    )
    .get(conversationId, wake.memberId, wake.triggerSequence) as unknown as
    | { id: string }
    | undefined;

  assert.ok(row, `找不到 wake(${wake.memberId} @${wake.triggerSequence}) 对应的 execution`);
  return row.id;
}

/**
 * 单收件人场景的便捷版：断言这条消息恰好唤醒了一个 Member，并返回它的
 * execution。唤醒数不是 1 说明房间形状或 roster 与用例预期不符 —— 那时
 * 继续断言只会得到一堆无关的失败，所以这里直接失败。
 */
export function singleExecutionId(
  db: DatabaseSync,
  conversationId: string,
  wakes: WakePlan[],
): string {
  assert.equal(wakes.length, 1, `期望恰好一个唤醒，实际 ${wakes.length} 个`);
  return executionIdForWake(db, conversationId, wakes[0]);
}

/**
 * 静音房间里全部成员。
 *
 * 用户消息（无 mention）会以 everyone 广播给全体未静音成员；
 * 机制类用例要的是确定性（一次发送 = 可数的 execution），广播进来只会
 * 让断言之间的时序变得不可预测。
 *
 * 注意 mute 会挡掉一切唤醒。用户消息只唤醒 Lead，不再有点名单轮。
 */
export function muteAllMembers(team: TeamService, conversationId: string): void {
  for (const member of team.getConversation(conversationId).members) {
    team.setMemberMuted(conversationId, member.id, true);
  }
}

/** 一次 turn 的观察记录。断言身份 / 记忆隔离时看的是 `systemPrompt`，断言模型策略时看 `model`。 */
export interface StubTurn {
  executionId: string;
  memberId: string;
  model: string;
  systemPrompt: string;
  prompt: string;
}

/**
 * 只回一句话的 Copilot stub。
 *
 * 它存在的理由不只是「别调真的引擎」：`systemPrompt` 是**真正下发**给引擎的那份文本，
 * 断言「两个 Member 拿到不同的人格」时必须看它 —— 只查数据库里存了两个不同字段，
 * 证明不了隔离有没有真的生效。
 *
 * `skip` 模式模拟「这个 Member 判断自己没什么可补的」。
 */
export class StubCopilot {
  mode: 'reply' | 'skip' = 'reply';
  readonly turns: StubTurn[] = [];
  /**
   * 挂住 turn，用来把一个 execution 稳定地钉在 running 上。
   *
   * 测试「同一轮还在跑的时候又来了唤醒」必须靠它：不等住第一轮，第二轮永远
   * 落在「已经跑完」之后，走的是另一条路径。
   */
  hold: Promise<void> | null = null;
  /**
   * 只按住这些 Member 的 turn；`null` = 按住全部。
   *
   * 构造「有人已收口、有人还在跑」的中间态时用：全局 `hold` 表达不了它 ——
   * 那会把所有人都按住，于是谁都不收口，被考的那条分支根本走不到。
   */
  holdMemberIds: Set<string> | null = null;
  /**
   * 这些 Member 的 turn 直接抛错，用来模拟引擎执行失败。
   *
   * 走正常 turn 永远落不到 `failed`：成功就 completed，取消就 cancelled。
   * 要覆盖 Task failed → 下游 blocked → 工作区 blocked 这条链，必须让引擎真炸一次。
   */
  readonly failMemberIds = new Set<string>();
  /**
   * 逐字符把回复喂给 `onDelta`，模拟真实引擎的流式输出。
   *
   * 必须显式打开：哨兵过滤（NoReplyStreamGate）只在流式路径上有意义 ——
   * 整段一次性到达时它只是原样转发一次。不开这个开关，那条接线就完全没被
   * 跑到：过滤器单测全绿，而集成路径可以是断的。
   */
  streamDeltas = false;
  /**
   * 保留字段：Task 模式下每轮都必须有结果，不再有沉默语义。
   * 留着它是为了不改各用例的装配，只是不再产生效果。
   */
  readonly skipMemberIds = new Set<string>();
  /**
   * 只在这些 wake_reason 上开口，其余一律沉默。
   *
   * 用来表达「**同一个人**：某种唤醒原因开口、其他原因沉默」。按 member
   * 或按全局开关都说不清这件事 —— 只有按**唤醒原因**才说得清。
   *
   * 需要 `wakeReasonOf` 配合（StubCopilot 不持有 db）。
   */
  speakOnlyOnReasons: Set<string> | null = null;
  /**
   * 查一条 execution 的 wake_reason。由用例注入 —— 让 stub 自己拿着 db
   * 会把「假引擎」和「数据库」耦在一起，而它本来只该模拟引擎。
   */
  wakeReasonOf: ((executionId: string) => string | null) | null = null;

  /**
   * turn 开始时的钩子：模拟「Agent 在 turn 内调了 tool」。
   *
   * 真实 Agent 靠 update_task 报告完成/阻塞，stub 默认不调任何 tool ——
   * 那等于永远扮演「不守规矩的 Agent」。用 reportTaskTurns 接上后，
   * 它才是一个会正常完工的执行人；P0-3 的静默测试显式置空它。
   * reset 不动它（和 wakeReasonOf 一样是装配期接线）。
   */
  onTurnStart: ((input: RunMemberTurnInput) => void) | null = null;

  async runMemberTurn(input: RunMemberTurnInput): Promise<string> {
    this.turns.push({
      executionId: input.executionId,
      memberId: input.member.id,
      model: input.model,
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
    });
    if (this.hold && (!this.holdMemberIds || this.holdMemberIds.has(input.member.id))) {
      await this.hold;
    }
    if (this.failMemberIds.has(input.member.id)) {
      throw new Error(`stub engine failure (${input.member.name})`);
    }
    this.onTurnStart?.(input);

    const reason = this.wakeReasonOf?.(input.executionId) ?? null;
    const skip =
      this.mode === 'skip' ||
      this.skipMemberIds.has(input.member.id) ||
      (this.speakOnlyOnReasons !== null && !this.speakOnlyOnReasons.has(reason ?? ''));

    const reply = `reply from ${input.member.name}`;
    void skip;
    if (this.streamDeltas) {
      for (const char of reply) input.onDelta?.(char);
    }
    return reply;
  }

  reset(): void {
    this.turns.length = 0;
    this.mode = 'reply';
    this.hold = null;
    this.holdMemberIds = null;
    this.failMemberIds.clear();
    this.streamDeltas = false;
    this.skipMemberIds.clear();
    this.speakOnlyOnReasons = null;
    // wakeReasonOf 是用例在 before() 里接上的接线，reset 不动它
  }

  turnFor(executionId: string): StubTurn {
    const turn = this.turns.find((item) => item.executionId === executionId);
    assert.ok(turn, `没有捕获到 execution ${executionId} 的 turn`);
    return turn;
  }

  /**
   * 以 CopilotService 的身份传给 TeamService。
   *
   * TeamService 只会调 `this.copilot.runMemberTurn(...)`（方法调用，`this` 是 stub
   * 自己），所以传 stub 本体是安全的，不需要 bind。
   */
  get asCopilot(): CopilotService {
    return this as unknown as CopilotService;
  }
}

/**
 * 让 stub 扮演守规矩的 Agent：Task turn 内调 update_task(completed)。
 *
 * 只对还处在 running 的任务报告 —— 测试里显式 updateTask(blocked/failed) 之后，
 * turn 才结束是正常情况（Agent 正在干活时任务被外部置终态），重复上报不该覆盖。
 * 和测试的显式调用撞车（对方先置终态）时吞掉：重复报告完成是无害的。
 */
export function reportTaskTurns(team: TeamService, stub: StubCopilot): void {
  stub.onTurnStart = (input) => {
    let taskId: string | null;
    try {
      taskId = team.getExecution(input.executionId).taskId;
    } catch {
      return;
    }
    if (!taskId) return;
    if (team.getTask(taskId).status !== 'running') return;
    try {
      team.updateTask({
        conversationId: team.getExecution(input.executionId).conversationId,
        memberId: input.member.id,
        taskId,
        status: 'completed',
        summary: `done by ${input.member.name}`,
      });
    } catch {
      // 和测试里的显式 updateTask 撞车：任务已被置成终态，重复报告无害
    }
  };
}
