import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config, modelPolicy } from './config.js';
import { resolveMemberModel } from './model-policy.js';
import { runInTransaction } from './db-tx.js';
import { now } from './db.js';
import { ContextAssembler } from './context-assembler.js';
import { ConversationMemberService } from './conversation-member-service.js';
import { MemberTurnScheduler } from './member-turn-scheduler.js';
import { TaskOrchestrator } from './task-orchestrator.js';
import { TaskService, parseRequirements, parseStringArray, type TaskPlanInput } from './task-service.js';
import { badRequest, conflict, forbidden, notFound } from './http-error.js';
import { MemberConversationService, type MemberDirectMessage } from './member-conversation-service.js';
import type { ConversationFileService } from './conversation-file-service.js';
import type { EvidenceService } from './evidence-service.js';
import {
  MemberService,
  type CreateMemberInput,
  type MemberMemory,
  type UpdateMemberInput,
} from './member-service.js';
import type { CopilotService } from './copilot.js';
import type { CapabilityResolver } from './capabilities/resolver.js';
import type { CapabilityService } from './capabilities/service.js';
import type { TeamStructureService } from './team-structure-service.js';
import {
  normalizeExternalWorkRef,
  parseExternalWorkRef,
  serializeExternalWorkRef,
  serializeExternalWorkSnapshot,
  WorkManagementRegistry,
  type ExternalWorkSnapshot,
} from './work-management/types.js';
import type {
  Conversation,
  ConversationEvent,
  ConversationEventType,
  ConversationFile,
  ConversationMemberState,
  ConversationMessage,
  ConversationParticipant,
  ConversationPrincipalType,
  ConversationTask,
  ExecutionConfigSnapshot,
  ExecutionDecision,
  ExecutionRecord,
  ExecutionStatus,
  GoalRevision,
  Member,
  MemberCapabilities,
  MemberRuntime,
  PendingWake,
  StoredConversationEvent,
  TaskRequirements,
  Team,
  TeamChangeSink,
  TeamMembership,
  TurnMode,
  WakeReason,
} from './domain.js';
import { CollaborationService } from './collaboration-service.js';
import { ConversationService } from './conversation-service.js';
import { ExecutionService } from './execution-service.js';
import { TaskApplicationService } from './task-application-service.js';
import type { TeamInternals } from './team-internals.js';
import type { LeaseGrant, WorkerLeaseService } from './worker-lease.js';
import { mapExecution, mapMessage, mapRuntime, sessionModeOf } from './team-shared.js';
import type { ConversationRow, ExecutionRow, MessageRow, RuntimeRow } from './team-shared.js';
export { ExecutionCancelledError } from './team-shared.js';

/**
 * 这里的 member 行类型是**刻意重复声明**的，不复用 member-service 的那一份：
 * 两份查询取的不是同一组数据（这里只取构成 Conversation.members 需要的列），
 * 共用一个类型等于让「列表页要显示的字段」和「会话里要显示的字段」互相牵制。
 * 代价是给 member 加列时两处都要看一眼。
 */
interface MemberRow {
  id: string;
  handle: string;
  name: string;
  role: string;
  system_prompt: string;
  model: string | null;
  status: 'active' | 'archived';
  seed_key: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  conversation_id: string;
  sequence: number;
  event_type: ConversationEventType;
  payload: string;
  created_at: string;
}

interface TeamRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function mapTeamRow(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateConversationInput {
  title?: string;
  kind?: 'task' | 'direct';
  memberIds: string[];
  leadMemberId?: string;
  /**
   * 这间会话围绕哪条外部工作（Jira 工单）。
   *
   * 只收引用，不收工单内容 —— 传标题/状态进来会被静默丢掉，因为本地没有
   * 存它们的地方。存在性也不在这里校验：那是网络调用，Jira 抖一下就不让人
   * 开会话是错的。真正的校验与取证发生在 execution 开始时（控制面，不经 LLM）。
   */
  externalWorkRef?: { provider?: string | null; key: string; externalId?: string | null } | null;
  /**
   * 建房者（human principalId，生产里是 OIDC 的 `sub`）。
   *
   * 它决定**谁被写进 conversation_participant**，也就是谁能在 ACL 收紧之后
   * 进这间房。不传时回落到 `config.localActorId`（本地 dev / 测试路径，
   * 那时两者本来就是同一个身份）。
   *
   * 为什么必须由调用方传而不是在服务里读 `config.localUserId`：那个常量是
   * 「本机单用户」的占位，而真实的 human 身份是每个请求各自的 token sub。
   * 服务层读不到请求，只能靠调用方把身份传下来。
   */
  createdBy?: string;
  /**
   * 这间房属于哪个 Team。
   *
   * 不传 = 默认 Team（单 Team 部署与测试路径）。多 Team 部署下必须由请求传入 ——
   * 以前这里只能落到默认 Team，于是「在 B 团队建的工作区」会被记成 A 团队的，
   * 而它的表现是侧栏里多了一间不该出现的房，不像权限问题。
   */
  teamId?: string;
}

export interface WakePlan {
  memberId: string;
  reason: Exclude<WakeReason, 'schedule'>;
  taskId: string | null;
  triggerSequence: number | null;
}

/**
 * 发一条消息的结果。
 *
 * Task 工作区里一条用户消息只唤醒 Lead，`wakes` 最多一项。
 * 每条 execution 的进展通过 SSE 的 `execution.updated` 到达。
 */
export interface SendMessageResult {
  message: ConversationMessage;
  /** 这条消息唤醒的 Member（Task 模式下最多是 Lead 一个）。 */
  wakes: WakePlan[];
  /**
   * 这次请求命中了幂等键：返回的是**已经存在的**那条消息，没有新建、也没有
   * 重新派发唤醒。`wakes` 在这种情况下一律为空。
   */
  deduplicated: boolean;
}

/**
 * 订阅回调拿到的是 **落库后** 的事件。
 *
 * `message.delta` 例外：它是 token 级高频事件，不落库，所以 id / sequence 为 null，
 * SSE 帧也不带 `id:`，浏览器不会因此推进 Last-Event-ID。
 */
type Listener = (event: StoredConversationEvent) => void;

/** 回放分页大小。 */
const REPLAY_BATCH = 500;
/**
 * 单次回放的事件上限。超过就截断并告警 —— 继续翻页会长时间阻塞事件循环，
 * 而客户端本来就有 `GET /messages` 这条完整状态的兜底路径。
 */
const REPLAY_MAX_EVENTS = 5000;

/**
 * 两个授权层的版本读取口。
 *
 * 做成回调而不是两个字符串常量，是因为版本会变：Policy 换成远程服务、
 * Entitlement 表被改过，都应当在**下一次** execution 的快照里体现出来。
 * 传常量的话，快照记的是「装配那一刻的版本」，而它和「这一轮执行的版本」
 * 在长跑进程里会分叉 —— 那正是快照要避免的事。
 *
 * 不传时回落到内置 Policy 的版本常量（见 buildConfigSnapshot）：测试与
 * 不带授权层的装配仍然能产出快照，而不是让快照缺一块。
 */
export interface AuthorizationRevisions {
  policy(): string;
  entitlement(): string;
}

/**
 * 项目的核心：把 Member / Conversation / Runtime / Execution 串起来。
 *
 * Member → Member 的协作不是「Agent A 直接 new Agent B」，而是：
 *
 *   Copilot Session
 *     → ask_member (custom tool)
 *     → TeamService.delegateMember()
 *     → target Member Runtime
 *
 * 所以每一次协作都会在服务端留下 Execution.parent_execution_id +
 * delegation_path，而不是散落成无法关联的 Copilot 日志。
 *
 * ── 这个类现在的形状：门面 + 共享基础设施 ────────────────────────────
 *
 * 方法体已经按 §31 拆进四个领域服务，这里只保留一行转发：
 *
 *   conversation-service.ts     房间 / 消息 / 成员 / Goal
 *   task-application-service.ts Task 的增删改与推进
 *   execution-service.ts        执行链（runWake / executeMemberTurn / 快照）
 *   collaboration-service.ts    Member 之间的委派、私聊、经验与记忆
 *
 * 留在本文件的是**四个服务共享的基础设施**：DB、事务、durable 事件与订阅、
 * execution / runtime 的读写、per-runtime 串行锁。它们通过 `buildInternals()`
 * 以 `TeamInternals` 的形式交出去 —— 不是改成 public。
 *
 * 可靠性相关的三件事仍然在这里收口：
 *
 *   1. 单写者    —— per-runtime 串行锁 + member_runtime.active_execution_id
 *   2. 增量上下文 —— ContextAssembler + last_context_message_sequence checkpoint
 *   3. 可靠事件   —— conversation_event 落库后再广播（SSE replay 的 source of truth）
 */
export class TeamService {
  private readonly listeners = new Map<string, Set<Listener>>();

  /** 事务期间攒下的 durable 事件，COMMIT 之后再广播。 */
  private readonly broadcastLogFile = path.join(config.dataDir, 'team-agent-copilot.log');
  /**
   * per-runtime 串行锁。一个 MemberRuntime 同时只能跑一个 turn，
   * 否则同一个 Copilot session 会被并发 sendAndWait 撕裂。
   */
  private readonly runtimeLocks = new Map<string, Promise<unknown>>();
  /**
   * 已请求取消、但 turn 还没收尾的 executionId。
   *
   * 为什么需要内存标记而不是只改 DB：一条 running 的 execution 由它自己的
   * turn 负责写终态，外部抢先写 `cancelled` 会被 turn 的收尾覆盖。所以取消是
   * 「先发信号 → turn 观察到信号后自己写成 cancelled」。
   *
   * 这也意味着取消信号只在**本进程内**有效 —— 和 RecoveryService 一样，
   * 当前实现假设单进程独占。多副本要升级成 DB 层的 cancel_requested 标记。
   */
  private readonly cancelRequests = new Set<string>();
  private readonly contextAssembler: ContextAssembler;
  /**
   * Member 在房间里的读游标 / 唤醒状态。
   * 和 MemberRuntime 是两件事，见 conversation-member-service.ts。
   */
  private readonly states: ConversationMemberService;
  /** 「消息到了」和「Agent 开始跑」之间的那一层：串行 + 合并。 */
  private readonly scheduler: MemberTurnScheduler;
  /** Task 状态的唯一业务入口。 */
  private readonly tasks: TaskService;
  /** Task 就绪 → 入队、完成 → 推进下一批。 */
  private readonly orchestrator: TaskOrchestrator;
  /** Member ↔ Member 私聊的房间拓扑（find-or-create / 列表 / 发送）。 */
  private readonly memberConversations: MemberConversationService;
  /**
   * 事务期间攒下的 durable 事件，COMMIT 之后再广播。
   *
   * 为什么不在事务里直接广播：广播是「告诉订阅者这件事发生了」，而事务里的
   * 事情还没发生完 —— 一旦回滚，前端已经看到的状态就是 DB 从没承认过的。
   * 先落库、后广播的纪律在事务边界上同样要成立，否则它只在单条 SQL 上成立。
   */
  private inTransaction = false;
  private deferredEvents: StoredConversationEvent[] = [];

  /**
   * 交给四个领域服务的内部表面（见 team-internals.ts）。
   *
   * 在构造函数**末尾**构建：它按值捕获 db / states / tasks 这些字段，而那些
   * 字段在构造过程中才陆续就位。方法一律 `bind(this)`，因此即使将来某次重构
   * 把构建时机提前，调用也不会丢 this。
   */
  private readonly internals: TeamInternals;
  /**
   * 按 §31 拆出去的四组方法。TeamService 保留门面 + 共享基础设施。
   *
   * 它们是 readonly、只在构造函数里赋值一次 —— 拆分的目的是让每个文件职责单一，
   * 不是引入「可替换实现」的多态。所有跨组调用都经由 `internals`，因此这四个
   * 服务彼此不 import，不存在循环依赖。
   */
  private readonly conversations: ConversationService;
  private readonly taskApplication: TaskApplicationService;
  private readonly executions: ExecutionService;
  private readonly collaboration: CollaborationService;

  constructor(
    private readonly db: DatabaseSync,
    private readonly members: MemberService,
    private readonly copilot: CopilotService,
    /** Member 的能力组成的读写。 */
    private readonly capabilities: CapabilityService,
    /**
     * 能力引用 → 这一轮实际生效的能力。
     *
     * 它是执行路径上唯一的解析入口。这里不保留任何「直接去读 config.teamSkillRoot
     * / 直接调某个 Knowledge 实现」的旁路 —— 有了旁路，`capabilityManifestHash`
     * 就不再反映这一轮真的用了什么。
     */
    private readonly capabilityResolver: CapabilityResolver,
    /**
     * 依据链。**必填**，而且排在可选参数之前：不传的话 execution 收口时不会建
     * 依据记录，而「没有记录」和「没这个功能」在审计里长得一模一样 —— 那正是
     * 这类可选依赖最容易留下的静默缺口。
     */
    private readonly evidence: EvidenceService,
    private readonly structure?: TeamStructureService,
    /** Member Activity 的 Team 级广播口。结构服务不认识 execution，所以在这里发。 */
    private readonly onTeamActivity?: TeamChangeSink,
    /**
     * 外部工作系统适配层。
     *
     * 未配置（没有 Jira 连接）时整个模块缺席 —— 此时控制面走「无业务上下文」
     * 路径：不取证、不校验存在性，也不假装有。它**不是**可选的功能开关，
     * 而是「这套部署接没接外部工作系统」的事实。
     */
    private readonly workManagement?: WorkManagementRegistry,
    /**
     * 聊天里的文件。
     *
     * 装配顺序上它必须早于 TeamService（TeamService 要用它挂附件、取附件），
     * 而它广播状态变化要回到 TeamService 的事件流 —— 用箭头函数打断这个环：
     * 事件发生在文件真的变化时，那时 TeamService 早就在了。
     */
    private readonly conversationFiles?: ConversationFileService,
    /**
     * 授权层的版本来源，进 execution 快照。
     *
     * 可选：不传时回落到内置 Policy 的版本常量。这样「快照永远有 policyRevision」
     * 这条纪律不依赖于装配处记不记得传 —— 忘了传的后果只是版本可能不准，
     * 而不是快照缺一块。
     */
    private readonly authorization?: AuthorizationRevisions,
    /**
     * Worker 租约。多副本部署下「谁在跑这一轮」的唯一仲裁点。
     *
     * 不传 = 单进程语义（照常执行，不抢）。测试与本地单机跑这条路径；
     * 生产多副本必须传，否则同一个 execution 会被两个副本各跑一遍。
     *
     * 它必须是**装配处那一个**实例（app.ts 的 workerLease），不能在这里
     * new 一个：租约的 owner 是进程身份，换实例就等于换身份，于是「自己
     * 正在跑的活」会被自己的恢复流程当成别人的。
     */
    private readonly leases?: WorkerLeaseService,
  ) {
    this.contextAssembler = new ContextAssembler(db);
    this.states = new ConversationMemberService(db, (conversationId, change) => {
      // 房间状态变化（读游标 / 唤醒状态 / 静音）也走同一条 durable 事件通道。
      this.emit(conversationId, { type: 'conversation_member_state.updated', data: change });
    });
    this.tasks = new TaskService(db);
    this.scheduler = new MemberTurnScheduler(
      this.states,
      (wake, markStarted, grant) => this.runWake(wake, markStarted, grant),
      (wake, error) => {
        // 一轮唤醒失败已经被 runTurn 记进 execution 并广播了，这里只是别让它
        // 变成 unhandled rejection，也不要让调度器的循环静默吞掉。
        // eslint-disable-next-line no-console
        console.error(
          `[team] wake ${wake.memberId} 失败:`,
          error instanceof Error ? error.message : error,
        );
      },
      // 多副本时每个 (conversation, member) 的唤醒只由一个副本处理。
      leases,
    );
    this.orchestrator = new TaskOrchestrator(db, this.tasks, this.states, this.scheduler, {
      onTask: (task) => this.emit(task.conversationId, { type: 'task.updated', data: task }),
      onConversation: (conversationId) => {
        try {
          this.emit(conversationId, { type: 'conversation.updated', data: this.getConversation(conversationId) });
        } catch {
          // 房间没了就不用广播
        }
      },
    });
    this.memberConversations = new MemberConversationService(db, this, () => this.internals);
    // 四个服务必须最后构造：它们共享的 internals 按值捕获上面那些字段。
    this.internals = this.buildInternals();
    this.conversations = new ConversationService(this.internals);
    this.taskApplication = new TaskApplicationService(this.internals);
    this.executions = new ExecutionService(this.internals);
    this.collaboration = new CollaborationService(this.internals);
  }

  /**
   * 把内部表面交给四个服务。
   *
   * ── 为什么是 bind 而不是箭头转发 ────────────────────────────────────
   *
   * 两者都能保住 this，但 bind 保留完整的泛型签名（transaction<T> /
   * withRuntimeLock<T>），不需要在转发时重新声明类型参数，也不会因为漏写一个
   * 形参而让可选参数悄悄变成必填。
   *
   * ── 为什么字段是直接读、方法才 bind ─────────────────────────────────
   *
   * 字段（db / states / tasks…）是共享的**对象引用**，服务要看到的是
   * 同一个实例；bind 一个字段没有意义。方法则必须绑定，否则 `internals.emit(...)`
   * 里的 this 会指向 internals 自己。
   */
  private buildInternals(): TeamInternals {
    return {
      alignRuntimeCheckpoint: this.alignRuntimeCheckpoint.bind(this),
      assertMemberNotBusy: this.assertMemberNotBusy.bind(this),
      authorization: this.authorization,
      // executions 在 buildInternals 之后才构造：这里不能 bind，只能闭包延迟求值。
      // （memberConversations 的 () => this.internals 是同一手法，方向反过来。）
      cancelExecutionTree: (executionId, visited) =>
        this.executions.cancelExecutionTree(executionId, visited),
      cancelRequests: this.cancelRequests,
      isCancellationRequested: this.isCancellationRequested.bind(this),
      capabilities: this.capabilities,
      capabilityResolver: this.capabilityResolver,
      contextAssembler: this.contextAssembler,
      evidence: this.evidence,
      conversationFiles: this.conversationFiles,
      copilot: this.copilot,
      currentGoalRevision: this.currentGoalRevision.bind(this),
      db: this.db,
      defaultTeam: this.defaultTeam.bind(this),
      detectDelegationWaitCycle: (parentRuntimeId, targetRuntimeId) =>
        this.executions.detectDelegationWaitCycle(parentRuntimeId, targetRuntimeId),
      emit: this.emit.bind(this),
      emitExecution: this.emitExecution.bind(this),
      ensureRuntime: this.ensureRuntime.bind(this),
      executeMemberTurn: this.executeMemberTurn.bind(this),
      findExecution: this.findExecution.bind(this),
      findMessageByClientRequestId: this.findMessageByClientRequestId.bind(this),
      findMessageBySequence: this.findMessageBySequence.bind(this),
      findRuntime: this.findRuntime.bind(this),
      getConversation: this.getConversation.bind(this),
      getExecution: this.getExecution.bind(this),
      hydrateConversation: this.hydrateConversation.bind(this),
      insertExecution: this.insertExecution.bind(this),
      insertMemberMessage: this.insertMemberMessage.bind(this),
      insertMessage: this.insertMessage.bind(this),
      latestExecutionFor: (conversationId, memberId) =>
        this.executions.latestExecutionFor(conversationId, memberId),
      leases: this.leases,
      memberConversations: this.memberConversations,
      members: this.members,
      nextMessageSequence: this.nextMessageSequence.bind(this),
      orchestrator: this.orchestrator,
      relationForNewMessage: this.relationForNewMessage.bind(this),
      requireActiveMember: this.requireActiveMember.bind(this),
      requireConversationFiles: this.requireConversationFiles.bind(this),
      requireConversationMember: this.requireConversationMember.bind(this),
      requireMessageInConversation: this.requireMessageInConversation.bind(this),
      resolveExternalWorkRef: (input) => this.executions.resolveExternalWorkRef(input),
      retireRuntime: this.retireRuntime.bind(this),
      scheduler: this.scheduler,
      states: this.states,
      structure: this.structure,
      tasks: this.tasks,
      touchConversation: this.touchConversation.bind(this),
      transaction: this.transaction.bind(this),
      turnModeFor: (conversation, execution) => this.executions.turnModeFor(conversation, execution),
      updateExecution: this.updateExecution.bind(this),
      waitForRuntimeIdle: this.waitForRuntimeIdle.bind(this),
      withRuntimeLock: this.withRuntimeLock.bind(this),
      workManagement: this.workManagement,
    };
  }

  // ---------------------------------------------------------------- Member

  /**
   * Member 列表。
   *
   * 传 `teamId` 时只返回**这个 Team 的**成员。不传 = 全部（单 Team 部署与
   * 内部工具用）。
   *
   * 为什么需要这个参数：`member` 表本身没有 team_id —— 一个 Member 可以同时
   * 在几个 Team 里（关系在 team_membership）。所以「按 Team 过滤」不能靠表上的
   * 列，必须 join。以前这里不传就是全部，于是多 Team 部署下 `/api/members`
   * 会把别的 Team 的人也列出来 —— 而那个列表是 Member Profile / 任务创建窗口
   * 的数据源，看起来只是「人多了几个」，不像越权。
   */
  listMembers(teamId?: string): Member[] {
    const all = this.members.list();
    if (!teamId || !this.structure) return all;

    const rows = this.db
      .prepare(
        `SELECT principal_id FROM team_membership
         WHERE team_id = ? AND kind = 'agent' AND status = 'active'`,
      )
      .all(teamId) as unknown as Array<{ principal_id: string }>;
    const inTeam = new Set(rows.map((row) => row.principal_id));
    return all.filter((member) => inTeam.has(member.id));
  }

  /**
   * 单个 Member。传 `teamId` 时校验它确实在这个 Team 里。
   *
   * 校验失败报 404 而不是 403：对调用方来说「这个 Team 里没有这个人」和
   * 「这个人不存在」是同一件事 —— 而 403 会透露「它存在，只是不在你的 Team」，
   * 那正是跨 Team 探测需要的信息。
   */
  getMember(id: string, teamId?: string): Member {
    const member = this.members.get(id);
    if (teamId && this.structure) {
      try {
        this.structure.requireActiveMembership(teamId, 'agent', id);
      } catch {
        throw notFound(`Member 不存在：${id}`);
      }
    }
    return member;
  }

  /**
   * Member 维度子资源的统一门禁：member 必须存在且属于该 Team。
   *
   * 和 getMember(id, teamId) 的区别：那个是身份查询，用 404 抹平「不存在」与
   * 「不在本 Team」（防跨 Team 探测）；这里是资源门禁，不存在报 404，
   * 存在但不在本 Team 报 403。各 member-target 路由统一走这里，
   * 不要自己写查询。
   */
  requireMemberInTeam(teamId: string, memberId: string): Member {
    const member = this.members.get(memberId);
    if (this.structure) {
      try {
        this.structure.requireActiveMembership(teamId, 'agent', memberId);
      } catch {
        throw forbidden('Member 不属于这个 Team');
      }
    }
    return member;
  }

  /**
   * 归属校验：这个人**必须已经是**这个 Team 的成员，但**不看 status**。
   *
   * 和 requireMemberInTeam 的差别只有一处，但这一处是必需的：归档会把
   * membership 置成 inactive，而恢复归档要能走通 —— 用 requireActiveMembership
   * 会把「恢复」这条路和「跨 Team 越权」一起关掉，Archived Member 再也回不来。
   * 所以这里只查 membership 行在不在。
   *
   * 写入路径（PATCH member、改 member 层能力）走这里；只读子资源仍走
   * requireMemberInTeam —— 归档的人不该能发消息、查对话。
   */
  requireMemberBelongsToTeam(teamId: string, memberId: string): Member {
    const member = this.members.get(memberId);
    if (this.structure) {
      try {
        this.structure.getMembership(teamId, 'agent', memberId);
      } catch {
        throw forbidden('Member 不属于这个 Team');
      }
    }
    return member;
  }

  /**
   * 手工创建 Member。
   *
   * 刻意**不写任何能力绑定**：能力现在是 global + team + member 三层叠加，
   * 新建的人自动继承前两层。给它写一份「默认能力」等于把公司级/团队级的
   * 基线复制到这个人的私有层 —— 之后管理员改 Team 能力，这个人不会跟着变，
   * 而且没有任何地方看得出原因。
   *
   * `teamId` 决定它加入哪个 Team。不传时回落到默认 Team（单 Team 部署与测试
   * 路径）。以前这里**只能**加入默认 Team —— 多 Team 部署下在 B 团队建的
   * Member 会跑到 A 团队里去。
   */
  createMember(input: CreateMemberInput, teamId?: string): Member {
    if (input.model?.trim()) resolveMemberModel(modelPolicy, input.model);
    const member = this.members.create(input);
    // 新 Agent 自动加入 Team。membership 是组织状态，不是 persona 的一部分。
    if (this.structure) {
      const team = teamId ?? this.defaultTeam().id;
      this.structure.ensureAgentMembership(team, member.id);
      this.structure.touchPresence(team, 'agent', member.id);
    }
    return member;
  }

  private defaultTeam(): { id: string } {
    if (!this.structure) throw notFound('Team 尚未初始化');
    return this.structure.ensureDefaultTeam();
  }

  // --------------------------------------------------------------- 能力

  /** 这个 Member 的**私有增量**能力。上面两层继承来的不在这里，看目录接口。 */
  getMemberCapabilities(teamId: string, memberId: string): MemberCapabilities {
    this.requireMemberBelongsToTeam(teamId, memberId);
    return this.capabilities.getMember(memberId);
  }

  getGlobalCapabilities(): MemberCapabilities {
    return this.capabilities.getGlobal();
  }

  getTeamCapabilities(teamId: string): MemberCapabilities {
    return this.capabilities.getTeam(teamId);
  }

  /**
   * 全量替换 global 层能力。
   *
   * 先校验再落库：一个拼错的 Provider ID 必须在这里就失败，而不是等到下一轮
   * turn 才发现「所有人的能力都少了一块」—— 那时错误会表现为一个奇怪的回答，
   * 而不是一条错误。
   */
  updateGlobalCapabilities(capabilities: MemberCapabilities): MemberCapabilities {
    this.capabilityResolver.validate(capabilities);
    return this.capabilities.replaceGlobal(capabilities);
  }

  updateTeamCapabilities(teamId: string, capabilities: MemberCapabilities): MemberCapabilities {
    this.capabilityResolver.validate(capabilities);
    return this.capabilities.replaceTeam(teamId, capabilities);
  }

  /**
   * 全量替换某个 Member 的**增量**能力。
   *
   * 只动 member 层：global / team 两层是继承来的，不属于这个人。所以「把某人
   * 的能力清空」= 它退回团队基线，而不是变成一个什么都不会的人。
   *
   * 归属校验放在这里而不是只放在路由上：`CapabilityService.replaceMember` 按
   * memberId 写行，多一条绕过路由的调用路径就等于没有边界。路由上的那次校验
   * 是为了在写之前就失败，不是唯一一道闸。
   */
  updateMemberCapabilities(
    teamId: string,
    memberId: string,
    capabilities: MemberCapabilities,
  ): MemberCapabilities {
    this.requireMemberBelongsToTeam(teamId, memberId);
    this.capabilityResolver.validate(capabilities);
    return this.capabilities.replaceMember(memberId, capabilities);
  }

  /**
   * 更新 Member 身份 / 状态。`teamId` 决定归档/恢复时同步哪个 Team 的 membership。
   *
   * 不传 `teamId` 时回落到默认 Team（单 Team 部署与测试路径）。传了就必须用传的
   * —— 以前这里**只认**默认 Team，多 Team 部署下 PATCH B 团队的人会把 A 团队
   * 的 membership 改掉，而那个人在 B 团队的 membership 一动不动。
   */
  updateMember(id: string, input: UpdateMemberInput, teamId?: string): Member {
    // 普通任务模型只能是 Member 列表里的低档模型：Lead 模型与拼错的名字在这里就拒绝，
    // 不能等到下一轮 turn 才发现这个人跑不起来。null/省略 = 回落默认，不校验。
    if (input.model?.trim()) resolveMemberModel(modelPolicy, input.model);
    // 归档意味着「不再接活」，所以它必须等手上的活干完再落地。不然会留下
    // 「消息有、wake 有、execution 没有」的洞 —— 见 assertMemberNotBusy。
    const before = this.members.get(id);
    if (input.status === 'archived' && before.status !== 'archived') {
      this.assertMemberNotBusy(id, '归档');
    }
    const member = this.members.update(id, input);
    // 成员归档/恢复后同步 TeamMembership：Member.status 与 membership.status
    // 不能漂移成「已归档但仍 active」。
    if (this.structure && input.status && input.status !== before.status) {
      const team = teamId ?? this.defaultTeam().id;
      this.structure.ensureAgentMembership(team, member.id);
      this.structure.updateMembership(team, 'agent', member.id, {
        status: member.status === 'active' ? 'active' : 'inactive',
      });
    }
    return member;
  }

  // ---------------------------------------------------------- Conversation

  /** 房间列表。传 teamId 时只返回这个 Team 的（多 Team 隔离，见 ConversationService）。 */
  listConversations(teamId?: string): Conversation[] {
    return this.conversations.listConversations(teamId);
  }

  /**
   * Member 视角的历史：它参与过哪些 conversation，按最后活动倒序。
   *
   * 不建新表 —— conversation_member 本来就是 roster 事实，这只是一条 join。
   * UI 的 Member Profile 用它渲染 Recent activity。
   */
  listMemberConversations(memberId: string): Conversation[] {
    this.members.get(memberId);
    const rows = this.db
      .prepare(
        `
        SELECT c.*
        FROM conversation c
        JOIN conversation_member cm ON cm.conversation_id = c.id
        WHERE cm.member_id = ?
        ORDER BY c.updated_at DESC
        `,
      )
      .all(memberId) as unknown as ConversationRow[];
    return rows.map((row) => this.hydrateConversation(row));
  }

  /**
   * Member 视角的 Team 列表：哪些 Team 里有它的 membership。
   *
   * 同样只是 join，不建新模型。单 Team 部署下永远只回一个。
   */
  listMemberTeams(memberId: string): Team[] {
    this.members.get(memberId);
    if (!this.structure) return [];
    const rows = this.db
      .prepare(
        `
        SELECT t.*
        FROM team t
        JOIN team_membership m ON m.team_id = t.id
        WHERE m.kind = 'agent' AND m.principal_id = ?
        ORDER BY t.created_at
        `,
      )
      .all(memberId) as unknown as TeamRow[];
    return rows.map(mapTeamRow);
  }

  getConversation(id: string): Conversation {
    return this.conversations.getConversation(id);
  }

  /**
   * Human 访问 Conversation 的**第一道**前提：是这个 Conversation 所在 Team
   * 的 active 成员。返回 membership，因为调用方还需要它的 role 判断兜底访问
   * （owner/admin 可访问 Team 内全部房间）。
   */
  requireTeamHumanAccess(teamId: string, principalId: string): TeamMembership {
    if (!this.structure) {
      throw forbidden('Team structure 未初始化');
    }
    try {
      return this.structure.requireActiveMembership(teamId, 'human', principalId);
    } catch (error) {
      // Team 里查无此人也是 403：这不是“资源不存在”，是“你没资格”。
      // conversation 本身不存在是另一回事，getConversation 在前面报 404。
      if ((error as { status?: unknown }).status === 404) {
        throw forbidden(`不是这个 Team 的成员：${principalId}`);
      }
      throw error;
    }
  }

  /**
   * 第二道：这个 human 在不在这间房的参与者名单里。
   *
   * 两道**都要过**，不能互相替代。第一道回答「你是这个 Team 的人」，第二道
   * 回答「这间房允许你进」—— 同一个 Team 的两个 human 各自在不同房间里工作，
   * 能进 Team 不等于能看另一个房间的执行记录（里面有 prompt、工具调用、文件引用）。
   */
  isConversationParticipant(
    conversationId: string,
    principalType: ConversationPrincipalType,
    principalId: string,
  ): boolean {
    return this.conversations.isConversationParticipant(conversationId, principalType, principalId);
  }

  addConversationParticipant(input: {
    conversationId: string;
    principalType: ConversationPrincipalType;
    principalId: string;
    addedBy?: string | null;
  }): void {
    this.conversations.addConversationParticipant(input);
  }

  removeConversationParticipant(
    conversationId: string,
    principalType: ConversationPrincipalType,
    principalId: string,
  ): void {
    this.conversations.removeConversationParticipant(conversationId, principalType, principalId);
  }

  listConversationParticipants(conversationId: string): ConversationParticipant[] {
    return this.conversations.listConversationParticipants(conversationId);
  }

  createConversation(input: CreateConversationInput, opts?: { autoStartLead?: boolean }): Conversation {
    return this.conversations.createConversation(input, opts);
  }

  addMember(conversationId: string, memberId: string): Conversation {
    return this.conversations.addMember(conversationId, memberId);
  }

  removeMember(conversationId: string, memberId: string): Conversation {
    return this.conversations.removeMember(conversationId, memberId);
  }

  // ------------------------------------------------------------- Messages

  listMessages(conversationId: string, limit = 100): ConversationMessage[] {
    return this.conversations.listMessages(conversationId, limit);
  }

  /**
   * 给一页消息装配附件：一条 SQL 取完再分组，不是每条消息查一次。
   *
   * 绝大多数消息没有附件，而附件信息是 UI 的一部分（气泡里那张卡片），
   * 所以它必须随消息一起来 —— 让前端拿 messageId 一个个去取，一页 100 条
   * 就是 100 次请求。
   */
  /**
   * 发一条消息：只负责落库 + 唤醒 Lead。
   *
   * Task 工作区里用户消息不再经过任何 dispatcher：只唤醒 Lead，由 Lead 决定
   * 是澄清、规划还是调整任务。Lead 正在执行时不重复入队 —— 消息已经落库，
   * checkpoint 机制会让下一轮看到它。
   */

  async sendMessage(input: {
    conversationId: string;
    /** 当前登录用户（OIDC sub）。用户消息的归属，不再是写死的 local user。 */
    actorId: string;
    content: string;
    replyToMessageId?: string;
    clientRequestId?: string;
    fileIds?: string[];
  }): Promise<SendMessageResult> {
    return this.conversations.sendMessage(input);
  }

  /**
   * 一条消息第一次挂某个文件 = attachment，再次挂 = reference。
   *
   * 判据是「这个文件在**本会话**里之前有没有被任何消息挂过」，而不是「这条消息
   * 是不是第一条消息」：用户把同一份文件再拖一次，得到的应该是引用而不是
   * 第二份副本（副本也进不来 —— UNIQUE(conversation_id, content_hash,
   * original_name) 会把它收敛成同一行）。
   */
  private relationForNewMessage(
    conversationId: string,
    message: ConversationMessage,
    fileId: string,
  ): 'attachment' | 'reference' {
    const row = this.db
      .prepare(
        `
        SELECT 1 AS ok
        FROM conversation_message_file mf
        JOIN conversation_message m ON m.id = mf.message_id
        WHERE m.conversation_id = ?
          AND mf.file_id = ?
          AND m.id != ?
        LIMIT 1
        `,
      )
      .get(conversationId, fileId, message.id) as unknown as { ok: number } | undefined;
    return row ? 'reference' : 'attachment';
  }

  /** fileIds → 文件对象；没有会话文件服务时（测试装配）一律拒绝，不静默忽略。 */
  private requireConversationFiles(conversationId: string, fileIds: string[]) {
    if (fileIds.length === 0) return [];
    if (!this.conversationFiles) {
      throw badRequest('当前部署没有启用会话文件，不能带附件发送');
    }
    return this.conversationFiles.validateForMessage(conversationId, fileIds);
  }

  /**
   * 触发这条 turn 的消息挂了哪些文件。
   *
   * 只认 `status = 'ready'` 的：还在提取中的文件交给引擎也是一个它读不了的路径，
   * 而这一轮的回答会变成「文件好像没内容」。

  /**
   * 会话文件状态变化 → 走会话事件流广播。
   *
   * 文件服务不认识事件流（它只碰 DB 与磁盘），广播口在这里 —— 这样「哪些变化
   * 该让前端知道」仍然只有一个地方决定，和 message / execution / 房间状态一样。
   */
  conversationFileChanged(
    conversationId: string,
    type: 'file.created' | 'file.updated' | 'file.deleted',
    file: ConversationFile,
  ): void {
    this.emit(conversationId, { type, data: file });
  }

  /**
   * MCP 工具调用被放行（引擎 hook 回调）。
   *
   * 只记「用过什么」供 Activity 展示：放行 ≠ 执行完成（引擎没有跑完回调），
   * 所以不做审计、不做计费。重复求值可能带来重复事件，前端按
   * (executionId, serverId, toolName) 去重展示。
   */
  notifyMcpToolUse(input: {
    executionId: string;
    conversationId: string;
    memberId: string;
    serverId: string;
    toolName: string;
  }): void {
    this.emit(input.conversationId, {
      type: 'mcp.tool.called',
      data: {
        executionId: input.executionId,
        memberId: input.memberId,
        serverId: input.serverId,
        toolName: input.toolName,
      },
    });
  }

  /**
   * 以某个 Member 的身份发一条消息 —— Member ↔ Member 私聊的写入路径。
   *
   * 私聊直接唤醒对端，不经过任何 dispatcher。
   *
   * 刻意不复用 delegateMember：那条路是**阻塞**的（父 execution 进
   * waiting_for_member，一直等到子 execution 跑完并返回结果），适合 ask_member
   * 的「我必须拿到答案才能继续」。DM 是一条消息，发出去就该返回。
   */
  async sendMemberMessage(input: {
    conversationId: string;
    fromMemberId: string;
    targetMemberId: string;
    content: string;
  }): Promise<SendMessageResult> {
    return this.memberConversations.sendMemberMessage(input);
  }

  // ------------------------------------------------ Member ↔ Member 私聊

  /**
   * 下面四个是 MemberConversationService 的门面。
   *
   * 房间拓扑（find-or-create / 唯一性 / 列表）在那边，消息写入在 sendMemberMessage，
   * 这里只做转发 —— 让 route、CopilotHost、测试都只依赖 TeamService 一个入口，
   * 不必各自知道该 new 哪个 service。
   */

  listDirectMessages(memberId: string): MemberDirectMessage[] {
    return this.memberConversations.list(memberId);
  }

  /**
   * 找到或创建两个 Member 之间的私聊房间。
   *
   * teamId 是必填参数而不是从别处推出来的：DM 房间属于某个 Team，
   * 「两个人在同一 Team 里」是它成立的前提，不是事后校验的附属条件。
   */
  openDirectMessage(teamId: string, a: string, b: string): Conversation {
    return this.memberConversations.open(teamId, a, b);
  }

  sendDirectMessage(input: {
    teamId: string;
    fromMemberId: string;
    toMemberId: string;
    content: string;
  }): Promise<SendMessageResult & { conversation: Conversation; peer: Member }> {
    return this.collaboration.sendDirectMessage(input);
  }

  async messageMember(input: {
    teamId: string;
    fromMemberId: string;
    targetMemberId: string;
    content: string;
  }): Promise<{ conversationId: string; messageId: string }> {
    return this.collaboration.messageMember(input);
  }

  // ---------------------------------------------------- Conversation state

  listConversationState(conversationId: string): ConversationMemberState[] {
    return this.conversations.listConversationState(conversationId);
  }

  // ------------------------------------------------------------------ Task

  listTasks(conversationId: string): ConversationTask[] {
    return this.taskApplication.listTasks(conversationId);
  }

  getTask(taskId: string): ConversationTask {
    return this.taskApplication.getTask(taskId);
  }

  listGoalRevisions(conversationId: string): GoalRevision[] {
    return this.conversations.listGoalRevisions(conversationId);
  }

  retryTask(taskId: string): ConversationTask {
    return this.taskApplication.retryTask(taskId);
  }

  cancelTask(taskId: string): ConversationTask {
    return this.taskApplication.cancelTask(taskId);
  }

  async requestClarification(input: {
    conversationId: string;
    memberId: string;
    questions: string[];
    assumptions?: string[];
    summary?: string;
  }): Promise<string> {
    return this.collaboration.requestClarification(input);
  }

  async updateGoal(input: {
    conversationId: string;
    actorType: 'user' | 'member' | 'system';
    actorId: string;
    executionId?: string | null;
    objective: string;
    requirements?: TaskRequirements;
    changeKind:
      | 'clarification'
      | 'scope_change'
      | 'success_criteria_change'
      | 'correction';
    reason?: string;
  }): Promise<{
    conversation: Conversation;
    revision: GoalRevision;
  }> {
    return this.conversations.updateGoal(input);
  }

  async planTasks(input: {
    conversationId: string;
    memberId: string;
    objective: string;
    requirements: TaskRequirements;
    tasks: Array<{
      key: string;
      title: string;
      description?: string;
      assigneeMemberId?: string;
      dependencies?: string[];
      acceptanceCriteria?: string[];
      modelTier?: 'cheap' | 'standard' | 'strong';
      independentContext?: boolean;
    }>;
  }): Promise<string> {
    return this.taskApplication.planTasks(input);
  }

  /** CoreToolHost：Lead 修改 Goal（update_goal 工具）。 */
  async updateGoalTool(input: {
    conversationId: string;
    memberId: string;
    executionId: string;
    objective: string;
    requirements?: TaskRequirements;
    changeKind:
      | 'clarification'
      | 'scope_change'
      | 'success_criteria_change'
      | 'correction';
    reason?: string;
  }): Promise<string> {
    return this.conversations.updateGoalTool(input);
  }

  async replanTasks(input: {
    conversationId: string;
    memberId: string;
    tasks: TaskPlanInput[];
  }): Promise<string> {
    return this.taskApplication.replanTasks(input);
  }

  async addTask(input: {
    conversationId: string;
    memberId: string;
    title: string;
    description?: string;
    assigneeMemberId: string;
    dependencies?: string[];
    acceptanceCriteria?: string[];
    modelTier?: 'cheap' | 'standard' | 'strong';
    independentContext?: boolean;
  }): Promise<string> {
    return this.taskApplication.addTask(input);
  }

  async reassignTask(input: {
    conversationId: string;
    memberId: string;
    taskId: string;
    assigneeMemberId: string;
  }): Promise<string> {
    return this.taskApplication.reassignTask(input);
  }

  async updateTask(input: {
    conversationId: string;
    memberId: string;
    taskId: string;
    status: 'running' | 'completed' | 'blocked';
    summary: string;
    blocker?: string;
  }): Promise<string> {
    return this.taskApplication.updateTask(input);
  }

  /**
   * 设置「这个任务的结果要不要人看过」。
   *
   * 这是**人**的开关，Agent 的工具路径上没有它（planTasks / addTask / updateTask
   * 都不认这个字段）。把审核要求放进 Agent 的写入面，等于让被审核的一方决定
   * 自己要不要被审核。
   *
   * 改的是任务行，不是已有证据：已经跑完的那几轮各自记着自己的审核状态，
   * 不会因为这里开关一下就被改写。
   */
  setTaskHumanReview(taskId: string, required: boolean): ConversationTask {
    return this.taskApplication.setTaskHumanReview(taskId, required);
  }

  // ------------------------------------------------- 外部工作变更（最小投影）

  /**
   * 外部工作系统的变更通知 → **最小投影**。
   *
   * 它不写任何工单内容，只做两件事：
   *
   *   1. 找出本地哪些房间挂在这条引用上（key 或不可变 id 命中）
   *   2. 给每个房间发一条 durable 事件：「这条外部工作变了，变的是哪些字段」
   *
   * ── 为什么 payload 里没有新值 ──────────────────────────────────────
   *
   * 通知和事实必须分开。payload 里放 status 的新值，本地就有了第二份状态，
   * 而它只在 webhook 到达时才更新 —— 一次丢包、一次顺序颠倒、一次重放，
   * 它就永久偏离 Jira。表现是「本地显示 Done，Jira 里其实是 In Review」，
   * 这种 bug 最难查，因为两边看起来都对。
   *
   * 所以这里只说「变了什么字段」，UI 收到后自己去 Jira 读那一份真相。
   *
   * ── 为什么不做全量轮询 ──────────────────────────────────────────────
   *
   * 轮询整个 Jira 是拿「我们关心的很少」去换「每次都全量拉」，成本随租户
   * 规模线性增长而收益恒定。webhook 只推我们挂着的那些引用，正好是反过来的。
   */
  applyExternalWorkChange(input: {
    provider: string;
    key: string;
    externalId?: string | null;
    changedFields: string[];
  }): { conversations: string[] } {
    const normalized = normalizeExternalWorkRef(input);
    if (!normalized) return { conversations: [] };

    // key 会随项目改名而变，不可变 id 不会。两个都试：改名之后 webhook 里带的是
    // 新 key，而本地房间记的是老 key，只按 key 匹配会静默漏掉这批房间。
    const rows = this.db
      .prepare(
        `
        SELECT id, team_id
        FROM conversation
        WHERE json_extract(external_work_ref, '$.key') = ?
           OR (
             ? IS NOT NULL
             AND json_extract(external_work_ref, '$.externalId') = ?
           )
        `,
      )
      .all(normalized.key, normalized.externalId, normalized.externalId) as unknown as Array<{
      id: string;
      team_id: string;
    }>;

    if (rows.length === 0) return { conversations: [] };

    const payload = {
      ref: this.executions.resolveExternalWorkRef(normalized),
      changedFields: input.changedFields,
      receivedAt: now(),
    };

    // 先落库再广播（this.emit 内部就是这条纪律），断线重连能补发 ——
    // 否则一次页面刷新就会永久错过「工单状态变了」这个通知。
    for (const row of rows) {
      this.emit(row.id, { type: 'external_work.changed', data: payload });
    }

    if (this.onTeamActivity) {
      for (const teamId of new Set(rows.map((row) => row.team_id))) {
        this.onTeamActivity(teamId, 'external_work.changed', payload);
      }
    }

    return { conversations: rows.map((row) => row.id) };
  }

  setMemberMuted(conversationId: string, memberId: string, muted: boolean): ConversationMemberState {
    return this.conversations.setMemberMuted(conversationId, memberId, muted);
  }

  private async runWake(
    wake: PendingWake,
    markStarted: () => void,
    lease: LeaseGrant | null,
  ): Promise<void> {
    return this.executions.runWake(wake, markStarted, lease);
  }

  /** conversation 当前 Goal 版本号（单字段快读，给 turn 收尾判新旧用）。 */
  private currentGoalRevision(conversationId: string): number {
    const row = this.db
      .prepare(`SELECT goal_revision FROM conversation WHERE id = ?`)
      .get(conversationId) as unknown as { goal_revision: number } | undefined;
    return row?.goal_revision ?? 0;
  }

  private findMessageBySequence(
    conversationId: string,
    sequence: number | null | undefined,
  ): ConversationMessage | null {
    if (sequence === null || sequence === undefined) return null;
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_message
        WHERE conversation_id = ?
          AND message_sequence = ?
        `,
      )
      .get(conversationId, sequence) as unknown as MessageRow | undefined;
    return row ? mapMessage(row) : null;
  }

  private findMessageByClientRequestId(
    conversationId: string,
    clientRequestId: string,
  ): ConversationMessage | null {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_message
        WHERE conversation_id = ?
          AND client_request_id = ?
        `,
      )
      .get(conversationId, clientRequestId) as unknown as MessageRow | undefined;
    return row ? mapMessage(row) : null;
  }

  /**
   * 校验 `replyToMessageId` 指向的消息就在这个房间里。
   *
   * 不校验的后果不是「报错难看」，而是「错得看不出来」：一个指向别的房间（或
   * 根本不存在）的 id 会被原样落库，之后每个读它的人都只能看到一个悬空引用。
   * 省略 / 空串 = 不是引用回复，返回 null。
   */
  private requireMessageInConversation(
    conversationId: string,
    messageId: string | undefined,
  ): string | null {
    const id = messageId?.trim();
    if (!id) return null;

    const row = this.db
      .prepare(
        `
        SELECT conversation_id
        FROM conversation_message
        WHERE id = ?
        `,
      )
      .get(id) as unknown as { conversation_id: string } | undefined;

    if (!row) throw badRequest(`replyToMessageId 指向的消息不存在：${id}`);
    if (row.conversation_id !== conversationId) {
      throw badRequest('replyToMessageId 指向的消息不属于这个 conversation');
    }
    return id;
  }

  // ----------------------------------------------------------- Delegation

  async delegateMember(input: {
    conversationId: string;
    fromMemberId: string;
    parentExecutionId: string;
    targetMemberId: string;
    task: string;
    reason?: string;
  }): Promise<string> {
    return this.collaboration.delegateMember(input);
  }

  /** Agent 在 turn 里记下一条长期记忆（`remember_member` 工具）。 */
  rememberMember(input: { memberId: string; content: string }): Promise<string> {
    return Promise.resolve(this.members.appendMemory(input.memberId, input.content));
  }

  /**
   * Member 长期记忆的读写。
   *
   * 落在 `.data/members/<id>/memory/MEMORY.md`，不进数据库：记忆是自然语言
   * 文本，用户会想直接看 / 直接改，一个文件比一张两列表更好用。
   * Member 级（跨 conversation 稳定），不是 runtime 级。
   *
   * 读写都带 `version`：这条路径有两个人写同一个文件（人在 UI 编辑、Agent 在
   * turn 里调 remember_member），没有版本校验的全文覆盖会把中间那次写入吃掉。
   */
  getMemberMemory(memberId: string): MemberMemory {
    return this.members.getMemory(memberId);
  }

  replaceMemberMemory(memberId: string, content: string, expectedVersion?: string): MemberMemory {
    return this.members.replaceMemory(memberId, content, expectedVersion);
  }

  // ------------------------------------------------------------- Execution

  getExecution(id: string): ExecutionRecord {
    return this.executions.getExecution(id);
  }

  listExecutions(conversationId: string, limit = 200): ExecutionRecord[] {
    return this.executions.listExecutions(conversationId, limit);
  }

  /** `requestedBy` 落进 `cancel_requested_by`：谁点的取消，事后要答得出来。 */
  async cancelExecution(executionId: string, requestedBy = 'unknown'): Promise<ExecutionRecord> {
    return this.executions.cancelExecution(executionId, requestedBy);
  }

  /**
   * 这一轮有没有人请求过取消。
   *
   * 判据是 **DB，不是进程内的 Set**。Set 只活在收到请求的那个进程里：
   * 另一个副本（或重启后接手这条 execution 的 worker）看不到它，于是
   * 「点了取消但还在跑」没有解释。DB 是权威信号，Set 只是本进程的快路径。
   */
  isCancellationRequested(executionId: string): boolean {
    const row = this.db
      .prepare(`SELECT cancel_requested_at FROM execution WHERE id = ?`)
      .get(executionId) as unknown as { cancel_requested_at: string | null } | undefined;
    return row?.cancel_requested_at != null;
  }

  retryExecution(executionId: string): { executionId: string } {
    return this.executions.retryExecution(executionId);
  }

  /** 重启恢复用：重新派发被进程带走的唤醒（实现在 execution-service）。 */
  redispatchWake(wake: PendingWake): void {
    return this.executions.redispatchWake(wake);
  }

  /** 启动恢复用：重新提交从未跑过的 root execution（实现在 execution-service）。 */
  async resumeQueuedExecution(executionId: string): Promise<void> {
    return this.executions.resumeQueuedExecution(executionId);
  }

  /**
   * Scheduler 入口：为一次到期的 scheduled wake 建 execution。
   *
   * 执行链：ScheduledWake → ScheduledWakeRun → Execution →
   * runScheduledExecution → executeMemberTurn。不经过 MemberTurnScheduler：
   * scheduled work 与「某条聊天消息触发的 turn」不是同一种 wake，不能 coalesce。
   */
  async enqueueScheduledWork(input: {
    scheduleRunId: string;
    conversationId: string;
    memberId: string;
    prompt: string;
  }): Promise<string> {
    const conversation = this.getConversation(input.conversationId);
    if (conversation.kind !== 'task') throw badRequest('定时任务只能挂在 Task 工作区上');
    const member = this.requireActiveMember(conversation, input.memberId);
    // paused 只拦自动唤醒，@ 点名仍走聊天路径；这里是自动路径，必须检查。
    const team = this.defaultTeam();
    const presence = this.structure?.getPresence(team.id, 'agent', member.id);
    if (presence?.availability === 'paused') {
      throw badRequest('Member 已暂停，不接受自动唤醒');
    }

    const prompt = input.prompt.trim();
    if (!prompt) throw badRequest('Schedule prompt 不能为空');

    const execution: ExecutionRecord = {
      id: randomUUID(),
      conversationId: conversation.id,
      memberId: member.id,
      goalRevision: conversation.goalRevision,
      taskId: null,
      externalWorkRef: conversation.externalWorkRef,
      externalWorkSnapshot: null,
      runtimeId: null,
      workerFencingToken: null,
      parentExecutionId: null,
      delegationPath: [member.id],
      kind: 'member_work',
      sessionMode: sessionModeOf({ kind: 'member_work' }),
      initiatedBy: { type: 'system', id: 'scheduler' },
      status: 'queued',
      prompt,
      response: null,
      error: null,
      waitingForRuntimeId: null,
      retryOfExecutionId: null,
      decision: null,
      triggerMessageSequence: null,
      wakeReason: 'schedule',
      configSnapshot: null,
      startedAt: null,
      endedAt: null,
      createdAt: now(),
    };

    this.transaction(() => {
      this.insertExecution(execution);
      // 绑定必须是原子的且必须成功：changes ≠ 1 说明这个 run 已经绑了别的
      // execution（或状态已变）。放过它会造出一个孤儿 execution —— 建了、
      // 却没有任何 run 记得它，恢复逻辑永远不会重派它。
      const result = this.db
        .prepare(
          `
          UPDATE scheduled_wake_run
          SET
            execution_id = ?,
            status = 'queued'
          WHERE id = ?
            AND execution_id IS NULL
            AND status = 'queued'
          `,
        )
        .run(execution.id, input.scheduleRunId);
      if (Number(result.changes) !== 1) {
        throw conflict('这条定时记录已被其他任务认领，或状态刚刚发生了变化');
      }
    });

    this.emitExecution(execution);

    // 刻意**不**在这里启动 execution：调用方（scheduler tick / recovery）要先
    // 把 run 标成 running、把 schedule 推进到下一次，然后再启动。如果在这里
    // 就跑，一轮极快的 execution 会在 tick 返回前完成并把 run 收口，随后
    // tick 的 updateScheduleRun('running') 又把终态顶回 running。
    return execution.id;
  }

  /**
   * 跑一条 scheduled execution。
   *
   * `lease` 是调用方（SchedulerService.startExecution）已经抢到并正在心跳的
   * **execution** 租约凭证。这里刻意**不**再抢一次（不再走 withExecutionLease）：
   * 租约的心跳必须只有一处 —— 两处心跳各自续期，任何一处失败都不会让这一轮停
   * 下来，「租约丢了却还在跑」就变成不可观测的了。
   *
   * 代次由这里钉到 execution 行上（bindExecutionFencingToken），之后这一轮所有
   * 写回都带它 —— 旧副本即便复活也写不进去。
   */
  async runScheduledExecution(
    executionId: string,
    lease: LeaseGrant | null = null,
  ): Promise<void> {
    const execution = this.getExecution(executionId);
    if (execution.kind !== 'member_work' || execution.wakeReason !== 'schedule') {
      throw badRequest(`不是 scheduled execution：${executionId}`);
    }
    if (execution.status !== 'queued') return;
    const fencingToken = lease?.fencingToken ?? null;
    try {
      if (fencingToken !== null) {
        this.executions.bindExecutionFencingToken(executionId, fencingToken);
      }
      const conversation = this.getConversation(execution.conversationId);
      const member = this.requireActiveMember(conversation, execution.memberId);
      await this.executeMemberTurn({
        conversation,
        member,
        execution,
        prompt: execution.prompt,
        triggerMessageSequence: null,
        turnMode: 'lead',
        wakeReason: 'schedule',
        lease,
      });
    } catch (error) {
      // executeMemberTurn 已经收口 execution 状态，这里不再重写终态，避免二次终态。
      // 开跑前的校验失败（房间没了 / Member 归档）会让 execution 停在 queued，
      // 恢复逻辑每个 tick 都会重派这条注定失败的执行 —— 把它标成 interrupted 断掉重试。
      //
      // 带 fencing：若租约已被夺走（另一副本接手并已推进），这一笔「放弃」不该
      // 把对方的状态顶掉。被挡下不抛 —— 对方会自己收口。
      const current = this.findExecution(executionId);
      if (current && current.status === 'queued') {
        this.updateExecution(
          executionId,
          {
            status: 'interrupted',
            error: error instanceof Error ? error.message : String(error),
            endedAt: now(),
          },
          fencingToken,
        );
      }
      // eslint-disable-next-line no-console
      console.error(
        `[team] scheduled execution ${executionId} failed:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.settleScheduleRun(executionId);
    }
  }

  /**
   * 把 scheduled_wake_run 的终态对齐到 execution：run 停在 running 上没有下文，
   * 事后审计「这次调度到底成没成」就断了。收口放在 runScheduledExecution 而不是
   * SchedulerService，tick 与 recovery 两条入口共用同一份记账。
   * waiting_for_member 等中间态不猜 —— 引擎收口后的下一次 recover 会再走到这里。
   */
  private settleScheduleRun(executionId: string): void {
    const run = this.db
      .prepare(
        `SELECT id FROM scheduled_wake_run WHERE execution_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(executionId) as { id: string } | undefined;
    if (!run) return;
    const execution = this.getExecution(executionId);
    if (execution.status === 'completed') {
      this.db
        .prepare(
          `UPDATE scheduled_wake_run SET status = 'completed', ended_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(now(), run.id);
      return;
    }
    if (
      execution.status === 'failed' ||
      execution.status === 'cancelled' ||
      execution.status === 'interrupted'
    ) {
      this.db
        .prepare(
          `UPDATE scheduled_wake_run SET status = 'failed', error = ?, ended_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(execution.error ?? execution.status, now(), run.id);
    }
  }

  // ------------------------------------------------------- Durable events

  /** 从 sinceSequence（不含）开始回放 durable events，时间正序。 */
  listEventsSince(
    conversationId: string,
    sinceSequence: number,
    limit = 500,
  ): StoredConversationEvent[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_event
        WHERE conversation_id = ?
          AND sequence > ?
        ORDER BY sequence
        LIMIT ?
        `,
      )
      .all(conversationId, sinceSequence, limit) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  /** 只订阅实时事件（不回放）。 */
  subscribe(conversationId: string, listener: Listener): () => void {
    this.getConversation(conversationId);

    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(listener);

    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(conversationId);
    };
  }

  /**
   * 回放 + 订阅，且两者之间不留缝。
   *
   * 先挂上实时监听并缓冲，再回放 DB，最后把缓冲里「比回放水位更新」的事件补发。
   * 这样重连期间产生的事件不会既不在回放里、也不在实时流里。
   * 重复投递由 sequence 去重（message.delta 没有 sequence，永远透传）。
   *
   * 回放按 batch 翻页而不是一次 `LIMIT 500` 了事：一次截断会在「回放末尾」和
   * 「实时流开头」之间留下一段**静默空洞**，比不回放更糟。
   */
  replayAndSubscribe(
    conversationId: string,
    sinceSequence: number,
    listener: Listener,
  ): () => void {
    this.getConversation(conversationId);

    const buffered: StoredConversationEvent[] = [];
    let live = false;
    let highWater = sinceSequence;

    const deliver = (event: StoredConversationEvent): void => {
      if (event.sequence !== null) {
        if (event.sequence <= highWater) return;
        highWater = event.sequence;
      }
      listener(event);
    };

    const unsubscribe = this.subscribe(conversationId, (event) => {
      if (!live) {
        buffered.push(event);
        return;
      }
      deliver(event);
    });

    let replayed = 0;
    let cursor = sinceSequence;
    for (;;) {
      const batch = this.listEventsSince(conversationId, cursor, REPLAY_BATCH);
      if (batch.length === 0) break;

      for (const event of batch) deliver(event);
      replayed += batch.length;

      if (batch.length < REPLAY_BATCH) break;
      if (replayed >= REPLAY_MAX_EVENTS) {
        // 极端情况：离线太久，事件量超过回放上限。这里主动放弃「无缝」，
        // 因为继续翻页会长时间阻塞事件循环。durable 的 message.created 仍在，
        // 前端可以再拉一次 GET /messages 拿到完整状态。
        // eslint-disable-next-line no-console
        console.warn(
          `[team] conversation ${conversationId} 回放事件超过 ${REPLAY_MAX_EVENTS} 条，已截断；客户端应重新拉取完整消息列表`,
        );
        break;
      }

      const last = batch[batch.length - 1].sequence;
      if (last === null) break;
      cursor = last;
    }

    live = true;
    for (const event of buffered) {
      deliver(event);
    }

    return unsubscribe;
  }

  // ------------------------------------------------------------- 内部实现

  private async executeMemberTurn(input: {
    conversation: Conversation;
    member: Member;
    execution: ExecutionRecord;
    prompt: string;
    sourceMemberId?: string;
    taskId?: string | null;
    triggerMessageSequence: number | null;
    turnMode: TurnMode;
    wakeReason: WakeReason | null;
    lease?: LeaseGrant | null;
  }): Promise<string> {
    return this.executions.executeMemberTurn(input);
  }












  /**
   * Runtime = 某 Member 在某 Conversation 中的运行实例。
   * 同一 (conversation, member) 永远复用同一个 Copilot session，
   * 换 conversation 就换一个 runtime，上下文天然隔离。
   *
   * 新建时的上下文水位取自该 Member 的房间读游标，而不是 0。
   * 这两条分支都要对：
   *
   *   全新房间的第一轮   读游标 = 0  → 水位 0，本轮消息照常注入
   *   中途加入 / 重新加入 读游标 = 加入时的房间水位 → 不灌整个历史
   *
   * 取 0 会把「它进来之前这个房间说过的每一句话」当成它漏读的上下文塞进
   * prompt；取「当前水位」又会把触发消息本身排除在外，让讨论模式的一轮
   * 在空房间里做「要不要发言」的判断。读游标恰好是这两者之间唯一正确的点。
   */
  private ensureRuntime(conversation: Conversation, member: Member): MemberRuntime {
    const existing = this.findRuntime(conversation.id, member.id);
    if (existing) return existing;

    const id = randomUUID();
    const copilotSessionId = `member-${member.id}-${randomUUID()}`;
    const workspacePath = path.join(config.workspaceRoot, conversation.id, member.id);
    const initialCheckpoint = this.states.get(conversation.id, member.id).lastSeenMessageSequence;

    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'AGENTS.md'),
      [
        `# ${member.name}`,
        '',
        `Role: ${member.role}`,
        `Member ID: ${member.id}`,
        `Conversation ID: ${conversation.id}`,
        '',
        'This workspace belongs only to this Member in this Conversation.',
        '',
      ].join('\n'),
      'utf8',
    );

    // INSERT OR IGNORE + 回读：并发首轮时不会撞 UNIQUE(conversation_id, member_id)
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO member_runtime (
          id,
          conversation_id,
          member_id,
          copilot_session_id,
          workspace_path,
          status,
          active_execution_id,
          last_context_message_sequence,
          last_used_at
        )
        VALUES (?, ?, ?, ?, ?, 'idle', NULL, ?, NULL)
        `,
      )
      .run(id, conversation.id, member.id, copilotSessionId, workspacePath, initialCheckpoint);

    const row = this.db
      .prepare(
        `
        SELECT *
        FROM member_runtime
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(conversation.id, member.id) as unknown as RuntimeRow;

    return mapRuntime(row);
  }

  private findRuntime(conversationId: string, memberId: string): MemberRuntime | null {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM member_runtime
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(conversationId, memberId) as unknown as RuntimeRow | undefined;
    return row ? mapRuntime(row) : null;
  }

  private insertMessage(message: ConversationMessage): void {
    this.db
      .prepare(
        `
        INSERT INTO conversation_message (
          id,
          conversation_id,
          message_sequence,
          sender_type,
          sender_id,
          reply_to_message_id,
          task_id,
          client_request_id,
          content,
          execution_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        message.id,
        message.conversationId,
        message.messageSequence,
        message.senderType,
        message.senderId,
        message.replyToMessageId,
        message.taskId,
        message.clientRequestId,
        message.content,
        message.executionId,
        message.createdAt,
      );
  }

  private insertMemberMessage(input: {
    conversationId: string;
    memberId: string;
    content: string;
    executionId: string;
    taskId?: string | null;
    replyToMessageId?: string | null;
  }): ConversationMessage {
    const message: ConversationMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      messageSequence: this.nextMessageSequence(input.conversationId),
      senderType: 'member',
      senderId: input.memberId,
      replyToMessageId: input.replyToMessageId ?? null,
      taskId: input.taskId ?? null,
      // Member 的回复由服务端产生，不存在「同一次发送被重试」的场景
      clientRequestId: null,
      content: input.content,
      executionId: input.executionId,
      files: [],
      createdAt: now(),
    };

    this.insertMessage(message);
    return message;
  }

  /**
   * roster 里能找到就行（含已归档）—— 用于查历史、校验父 execution 归属。
   */
  private requireConversationMember(conversation: Conversation, memberId: string): Member {
    const member = conversation.members.find((item) => item.id === memberId);
    if (!member) {
      throw badRequest(`Member ${memberId} 不属于 conversation ${conversation.id}`);
    }
    return member;
  }

  /**
   * 能派新活。已归档的 Member 保留在 roster 里（历史事实），但不能作为新的
   * 执行目标 —— 「它在历史上参与过」和「它现在可以接活」是两件事。
   */
  private requireActiveMember(conversation: Conversation, memberId: string): Member {
    const member = this.requireConversationMember(conversation, memberId);
    if (member.status !== 'active') {
      throw badRequest(`Member ${member.name} 已归档，不能作为新的执行目标`);
    }
    return member;
  }

  /**
   * 「这个 Member 手上有没有还没收尾的活」——归档 / 移出前的闸门。
   *
   * 不做这个检查的话，一条已经排队的 wake 会在 operator 归档之后才开始处理，
   * 在 runWake 里撞上 requireActiveMember 抛错。结果是「消息留着、wake 有过、
   * execution 没有」：审计链上出现一段无法解释的空洞，而操作者以为自己只是
   * 移走了一个人。
   *
   * 三个来源都要看，缺一不可：
   *
   *   execution                    queued / running / waiting_for_member
   *   conversation_member_state    pending_wake 或非 idle 的 wake_status
   *   scheduler 内存态             已入队但还没落库到 state 行的那一瞬
   *
   * 刻意选「拒绝操作」而不是「边跑边踢」：中断一个正在写文件的 Agent
   * 需要取消传播（连同它的 delegation 子树），那是另一件事。
   */
  private assertMemberNotBusy(memberId: string, action: string, conversationId?: string): void {
    const scope = conversationId ? ' AND conversation_id = ?' : '';
    const args = conversationId ? [memberId, conversationId] : [memberId];

    const active = this.db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM execution
        WHERE member_id = ?
          AND status IN ('queued', 'running', 'waiting_for_member')${scope}
        `,
      )
      .get(...args) as unknown as { n: number };

    const pending = this.db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM conversation_member_state
        WHERE member_id = ?
          AND (pending_wake = 1 OR wake_status <> 'idle')${scope}
        `,
      )
      .get(...args) as unknown as { n: number };

    const queued = conversationId
      ? this.scheduler.isBusy(conversationId, memberId)
      : this.scheduler.hasWork(memberId);

    if (active.n === 0 && pending.n === 0 && !queued) return;

    throw conflict(
      `Member 还有未完成的工作（${[
        active.n > 0 ? `${active.n} 条未结束的 execution` : '',
        pending.n > 0 || queued ? '待处理的唤醒' : '',
      ]
        .filter(Boolean)
        .join('、')}），不能${action}。请等它跑完，或先取消对应的 execution。`,
    );
  }

  /**
   * 退休某个 (conversation, member) 的运行时：下一个 turn 起用全新的 Copilot session。
   *
   * 为什么不直接删 member_runtime 行：execution.runtime_id 引用它（**没有**
   * ON DELETE 子句，删了会踩外键），而且「runtime 槽位」与「引擎 session」本来就是
   * 两件事 —— 槽位属于 (conversation, member) 这个关系，session 属于其中一段连续
   * 的任职。换掉 sessionId 就等于「上一次任职的上下文不再继承」，历史 execution
   * 的 runtime 链接也仍然有效。
   *
   * `last_context_message_sequence` 不在这里动：归零会让新 session 的第一轮被灌进
   * 整个房间历史。真正的对齐发生在重新加入时（见 alignRuntimeCheckpoint）。
   *
   * 工作区目录保留 —— 那是这个 Member 在这个房间里的产出，不是引擎状态。
   * 旧 session 的数据留在 copilot base directory 里，但它已经没有任何引用，
   * 不会被 resumeSession 找回。
   */
  private retireRuntime(conversationId: string, memberId: string): void {
    this.db
      .prepare(
        `
        UPDATE member_runtime
        SET
          copilot_session_id = ?,
          active_execution_id = NULL,
          status = 'idle',
          last_used_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(
        `member-${memberId}-${randomUUID()}`,
        now(),
        conversationId,
        memberId,
      );
  }

  /**
   * 把 runtime 的上下文水位对齐到某个序号。
   *
   * 加入房间时用：新加入（或被移出后重新加入）的成员不应该被灌进整个房间历史。
   * runtime 尚不存在时什么都不做 —— 它创建时会自己取房间状态里的读游标作为初值，
   * 那正好就是「加入时的水位」。
   */
  private alignRuntimeCheckpoint(
    conversationId: string,
    memberId: string,
    sequence: number,
  ): void {
    this.db
      .prepare(
        `
        UPDATE member_runtime
        SET
          last_context_message_sequence = ?,
          last_used_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(sequence, now(), conversationId, memberId);
  }

  private hydrateConversation(
    row: ConversationRow,
    progress?: Map<string, { total: number; completed: number }>,
  ): Conversation {
    // 刻意**不**过滤 m.status = 'active'。
    //
    // conversation_member / default_member_id / conversation_message / execution
    // 都还指向已归档的 Member，把它们从 roster 里抹掉只会让「历史事实」和
    // 「当前可用性」混在一起：UI 会突然少一个人，而 DB 里到处是它的引用。
    // 正确做法是保留完整 roster，由 requireActiveMember() 单独拦「能不能派活」。
    const memberRows = this.db
      .prepare(
        `
        SELECT m.*
        FROM member m
        JOIN conversation_member cm
          ON cm.member_id = m.id
        WHERE cm.conversation_id = ?
        ORDER BY cm.joined_at
        `,
      )
      .all(row.id) as unknown as MemberRow[];

    const requirements = parseRequirements(row.requirements_json);
    const openQuestions = parseStringArray(row.open_questions_json);
    return {
      id: row.id,
      teamId: row.team_id,
      externalWorkRef: parseExternalWorkRef(row.external_work_ref),
      title: row.title,
      kind: row.kind,
      objective: row.objective ?? '',
      goalRevision: row.goal_revision ?? 0,
      leadMemberId: row.lead_member_id,
      status: row.status ?? 'intake',
      requirements,
      openQuestions,
      createdBy: row.created_by,
      eventSequence: row.event_sequence,
      messageSequence: row.message_sequence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      taskProgress: progress?.get(row.id) ?? this.taskProgressOf(row.id),
      members: memberRows.map((member) => ({
        id: member.id,
        handle: member.handle,
        name: member.name,
        role: member.role,
        systemPrompt: member.system_prompt,
        model: member.model,
        status: member.status,
        seedKey: member.seed_key,
        createdAt: member.created_at,
        updatedAt: member.updated_at,
      })),
    };
  }

  /** 单个工作区的任务进度：列表页走批量聚合，只有这里走单查。只看当前 Goal。 */
  private taskProgressOf(conversationId: string): { total: number; completed: number } {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed
        FROM conversation_task
        WHERE conversation_id = ?
          AND goal_revision = (
            SELECT goal_revision
            FROM conversation
            WHERE id = ?
          )
        `,
      )
      .get(conversationId, conversationId) as unknown as { total: number; completed: number };
    return { total: row.total, completed: row.completed };
  }

  private insertExecution(execution: ExecutionRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO execution (
          id,
          conversation_id,
          member_id,
          goal_revision,
          task_id,
          external_work_ref,
          external_work_snapshot,
          runtime_id,
          worker_fencing_token,
          parent_execution_id,
          delegation_path,
          kind,
          session_mode,
          initiated_by_type,
          initiated_by_id,
          status,
          prompt,
          response,
          error,
          waiting_for_runtime_id,
          retry_of_execution_id,
          decision,
          trigger_message_sequence,
          wake_reason,
          config_snapshot,
          started_at,
          ended_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        execution.id,
        execution.conversationId,
        execution.memberId,
        execution.goalRevision,
        execution.taskId,
        serializeExternalWorkRef(execution.externalWorkRef),
        serializeExternalWorkSnapshot(execution.externalWorkSnapshot),
        execution.runtimeId,
        execution.workerFencingToken,
        execution.parentExecutionId,
        JSON.stringify(execution.delegationPath),
        execution.kind,
        execution.sessionMode,
        execution.initiatedBy.type,
        execution.initiatedBy.id,
        execution.status,
        execution.prompt,
        execution.response,
        execution.error,
        execution.waitingForRuntimeId,
        execution.retryOfExecutionId,
        execution.decision,
        execution.triggerMessageSequence,
        execution.wakeReason,
        execution.configSnapshot ? JSON.stringify(execution.configSnapshot) : null,
        execution.startedAt,
        execution.endedAt,
        execution.createdAt,
      );
  }

  private findExecution(id: string): ExecutionRecord | null {
    const row = this.db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
      | ExecutionRow
      | undefined;
    return row ? mapExecution(row) : null;
  }

  /**
   * 用 `!== undefined` 而不是 `??`：这两个语义不同。
   * `??` 会让「显式清空为 null」失效，而 waiting_for_runtime_id /
   * active_execution_id 恰恰需要能被显式清空。
   *
   * ── fencingToken：Agent 工作路径必须传 ───────────────────────────────
   *
   * 传了它就会变成 SQL 的 `AND worker_fencing_token = ?`：租约被重新夺取过
   * （代次 +1）时，旧持有者的写回命中 0 行，而不是把新持有者的结果覆盖掉。
   *
   * 不传 = 无 fencing，适用于**控制面**写入（cancel / recovery 标 interrupted）。
   * 那些写入不来自「某一轮 Agent 工作」，没有代次可言，也不该被代次挡住 ——
   * 用户取消一条 execution 不能被「租约属于谁」影响。
   *
   * 返回 `changes === 1`：SQLite 的 UPDATE 在 WHERE 不成立时是**静默 0 行**
   * （不抛异常）。调用方必须能区分「写成功」和「被 fencing 挡下」，否则
   * 「旧 worker 悄悄什么都没写」会看起来和「写成功了」一模一样。
   */
  private updateExecution(
    id: string,
    patch: Partial<{
      runtimeId: string | null;
      status: ExecutionStatus;
      response: string | null;
      error: string | null;
      waitingForRuntimeId: string | null;
      decision: ExecutionDecision | null;
      configSnapshot: ExecutionConfigSnapshot | null;
      externalWorkSnapshot: ExternalWorkSnapshot | null;
      startedAt: string | null;
      endedAt: string | null;
    }>,
    fencingToken?: number | null,
  ): boolean {
    const current = this.getExecution(id);
    const result = this.db
      .prepare(
        `
        UPDATE execution
        SET
          runtime_id = ?,
          status = ?,
          response = ?,
          error = ?,
          waiting_for_runtime_id = ?,
          decision = ?,
          config_snapshot = ?,
          external_work_snapshot = ?,
          started_at = ?,
          ended_at = ?
        WHERE id = ?
          AND (? IS NULL OR worker_fencing_token = ?)
        `,
      )
      .run(
        patch.runtimeId !== undefined ? patch.runtimeId : current.runtimeId,
        patch.status !== undefined ? patch.status : current.status,
        patch.response !== undefined ? patch.response : current.response,
        patch.error !== undefined ? patch.error : current.error,
        patch.waitingForRuntimeId !== undefined
          ? patch.waitingForRuntimeId
          : current.waitingForRuntimeId,
        patch.decision !== undefined ? patch.decision : current.decision,
        patch.configSnapshot !== undefined
          ? patch.configSnapshot
            ? JSON.stringify(patch.configSnapshot)
            : null
          : current.configSnapshot
            ? JSON.stringify(current.configSnapshot)
            : null,
        // 取证是一次性的：写了就不再被覆盖（patch 显式传 null 才能清掉）。
        // 没有这条纪律的话，一轮 turn 里任何一次 updateExecution 都可能把它抹掉。
        patch.externalWorkSnapshot !== undefined
          ? serializeExternalWorkSnapshot(patch.externalWorkSnapshot)
          : serializeExternalWorkSnapshot(current.externalWorkSnapshot),
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.endedAt !== undefined ? patch.endedAt : current.endedAt,
        id,
        fencingToken ?? null,
        fencingToken ?? null,
      );
    return Number(result.changes) === 1;
  }

  private emitExecution(execution: ExecutionRecord): void {
    this.emit(execution.conversationId, { type: 'execution.updated', data: execution });
    // Team 级 activity 广播：业务工作在 Jira，本地只广播「谁在跑哪张工单的这一轮」。
    // 与 conversation 事件同一触发点，订阅方不需要同时挂两种 SSE 才能拼出 Current Work。
    if (!this.onTeamActivity) return;
    const row = this.db
      .prepare(`SELECT team_id FROM conversation WHERE id = ?`)
      .get(execution.conversationId) as unknown as { team_id: string } | undefined;
    if (!row) return;
    this.onTeamActivity(row.team_id, 'member.activity.changed', {
      executionId: execution.id,
      conversationId: execution.conversationId,
      memberId: execution.memberId,
      externalWorkRef: execution.externalWorkRef,
      kind: execution.kind,
      status: execution.status,
    });
  }

  private touchConversation(conversationId: string): void {
    this.db
      .prepare(`UPDATE conversation SET updated_at = ? WHERE id = ?`)
      .run(now(), conversationId);
  }

  /** 会话内单调递增的 message 游标。同步 SQL，天然原子。 */
  private nextMessageSequence(conversationId: string): number {
    this.db
      .prepare(`UPDATE conversation SET message_sequence = message_sequence + 1 WHERE id = ?`)
      .run(conversationId);

    const row = this.db
      .prepare(`SELECT message_sequence FROM conversation WHERE id = ?`)
      .get(conversationId) as unknown as { message_sequence: number } | undefined;
    if (!row) throw notFound(`Conversation 不存在：${conversationId}`);
    return row.message_sequence;
  }

  /** 会话内单调递增的 event 游标，SSE Last-Event-ID 就是它。 */
  private nextEventSequence(conversationId: string): number {
    this.db
      .prepare(`UPDATE conversation SET event_sequence = event_sequence + 1 WHERE id = ?`)
      .run(conversationId);

    const row = this.db
      .prepare(`SELECT event_sequence FROM conversation WHERE id = ?`)
      .get(conversationId) as unknown as { event_sequence: number } | undefined;
    if (!row) throw notFound(`Conversation 不存在：${conversationId}`);
    return row.event_sequence;
  }

  /**
   * DB 是 source of truth，广播只是投递手段：
   * 先落 conversation_event，再 fan-out 给内存里的 SSE consumer。
   *
   * message.delta 是唯一例外 —— token 级高频，落库会把 DB 写爆。
   * 它没有 id / sequence，浏览器不会推进 Last-Event-ID，重连时无需回放；
   * 丢掉的增量文本由 durable 的 message.created（含完整内容）收敛。
   */
  private emit(conversationId: string, event: ConversationEvent): void {
    if (event.type === 'message.delta') {
      this.broadcast(conversationId, {
        id: null,
        conversationId,
        sequence: null,
        type: event.type,
        data: event.data,
        createdAt: now(),
      });
      return;
    }

    const stored = this.persistEvent(conversationId, event);

    // 在事务里就攒着。事件本身已经落库（回滚会一起撤掉），但广播必须等到
    // COMMIT —— 否则一次回滚会留下「前端看到过、DB 不承认」的状态。
    if (this.inTransaction) {
      this.deferredEvents.push(stored);
      return;
    }

    this.broadcast(conversationId, stored);
  }

  private persistEvent(
    conversationId: string,
    event: ConversationEvent,
  ): StoredConversationEvent {
    const stored: StoredConversationEvent = {
      id: randomUUID(),
      conversationId,
      sequence: this.nextEventSequence(conversationId),
      type: event.type,
      data: event.data,
      createdAt: now(),
    };

    this.db
      .prepare(
        `
        INSERT INTO conversation_event (
          id,
          conversation_id,
          sequence,
          event_type,
          payload,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        stored.id,
        conversationId,
        stored.sequence,
        stored.type,
        JSON.stringify(stored.data),
        stored.createdAt,
      );

    return stored;
  }

  private broadcast(conversationId: string, event: StoredConversationEvent): void {
    fs.appendFileSync(
      this.broadcastLogFile,
      `${JSON.stringify({
        event: "broadcast",
        conversationId,
        type: event.type,
        createdAt: event.createdAt,
        data: event.data,
      })}\n`,
      'utf8',
    );

    const listeners = this.listeners.get(conversationId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 一个 SSE consumer 挂掉不能影响其它 consumer
      }
    }
  }

  private async withRuntimeLock<T>(runtimeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.runtimeLocks.get(runtimeId) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => {}).then(() => gate);
    this.runtimeLocks.set(runtimeId, current);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.runtimeLocks.get(runtimeId) === current) this.runtimeLocks.delete(runtimeId);
    }
  }

  /**
   * 等某个 runtime 上正在跑的那一轮结束。
   *
   * 靠的是 runtimeLocks 里的 promise：它在锁释放时才 resolve。cancel 需要它来保证
   * 「cancel 返回时这一轮真的已经收尾」，而不是只把 abort 请求丢出去就返回。
   */
  private async waitForRuntimeIdle(runtimeId: string): Promise<void> {
    const current = this.runtimeLocks.get(runtimeId);
    if (current) await current.catch(() => {});
  }

  /**
   * 把若干次写收成一个原子块。
   *
   * `fn` 必须是**同步**的：node:sqlite 是同步 API，一旦里面出现 await，事务就会
   * 跨过事件循环边界，别的请求能挤进同一个连接上的 BEGIN/COMMIT 之间 ——
   * 那不是事务，是陷阱。所以这里对返回值不做 Promise 处理。
   *
   * 事务期间产生的事件先落库、攒起来，COMMIT 之后才广播；回滚就把它们一起丢掉。
   * 支持嵌套调用（内层不再 BEGIN）：recovery 之类的路径会从外面包一层，
   * 而里面的写又各自想用事务。BEGIN/COMMIT 的深度由 db-tx 统一追踪 ——
   * 结构服务的事务可能嵌在这层里面（execution 收口释放 claim），
   * 各自维护 BEGIN 标志就会撞上「事务里再开事务」。
   */
  private transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();

    this.inTransaction = true;
    this.deferredEvents = [];
    const flush = () => {
      const pending = this.deferredEvents;
      this.deferredEvents = [];
      for (const event of pending) this.broadcast(event.conversationId, event);
    };
    try {
      return runInTransaction(this.db, fn, flush);
    } finally {
      // onCommit 的 flush 在 COMMIT 之后、这里之前执行；回滚时 deferredEvents
      // 由 db-tx 丢弃 hook（flush 不会执行），这里只负责还原标志并清空残留。
      this.inTransaction = false;
      this.deferredEvents = [];
    }
  }
}

function mapEvent(row: EventRow): StoredConversationEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    type: row.event_type,
    data: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

