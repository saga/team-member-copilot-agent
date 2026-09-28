import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeCapabilities } from './capabilities/types.js';
import { config } from './config.js';
import { hashText } from './content-hash.js';
import { CopilotService } from './copilot.js';
import { now } from './db.js';
import type { Conversation, ExecutionConfigSnapshot, ExecutionRecord, Member, PendingWake, TurnMode, WakeReason } from './domain.js';
import { conflict, notFound } from './http-error.js';
import { BUILTIN_POLICY_REVISION } from './policy.js';
import type { TeamInternals } from './team-internals.js';
import { ACTIVE_STATUSES, CANCEL_REASON, ExecutionCancelledError, TERMINAL_STATUSES, mapExecution } from './team-shared.js';
import type { ExecutionRow } from './team-shared.js';
import { LEASE_RESOURCE_EXECUTION } from './worker-lease.js';

/**
 * ExecutionService
 *
 * 原先是 TeamService 的一组方法，按 §31 拆出来。共享基础设施由 TeamInternals
 * 注入 —— 这个类不认识 TeamService，只认识那张表面。
 */
export class ExecutionService {
  constructor(private readonly internals: TeamInternals) {}

  /**
   * 在 execution 租约保护下跑一段逻辑。
   *
   * ── 为什么普通 execution 也需要租约 ─────────────────────────────────
   *
   * 租约原先只加在 scheduled execution 上（SchedulerService 那条路径），
   * 而普通 execution —— 聊天消息唤醒、retry、崩溃恢复重新提交 —— 是**另外
   * 三条**入口，它们直接调 executeMemberTurn，一个租约都没有。多副本时：
   *
   *   副本 A 收到消息 → 建 execution → 开始跑
   *   副本 B 启动恢复 → 看到这条 queued/running → 也跑一遍
   *
   * 于是同一轮跑两遍，而 Jira 评论、流转这类外部副作用不可撤销。scheduled
   * 路径上的租约挡不住它 —— 那是**另一条**路径。
   *
   * ── 为什么放在这里而不是各入口各写一遍 ──────────────────────────────
   *
   * 四条入口共用同一个「抢 → 心跳 → 释放」时序。分开写的话，「忘了在 finally
   * 里释放」会出现在其中一处，而它的表现是「这条 execution 要等到 TTL 到期
   * 才有人能接手」—— 一条几乎不可能被联想到是租约的 bug。
   *
   * 不传 leases（单进程）时直接跑，与以前完全一致：单机模式下「running」必然
   * 属于自己，抢租约只是多一次写库。
   *
   * ── 为什么是 public ────────────────────────────────────────────────
   *
   * `resumeQueuedExecution` / `runScheduledExecution` 还在 TeamService 上
   * （它们要用 CopilotService 和 schedule 记账），但它们的**第一步**必须是
   * 抢这把租约。让它们各自再写一遍时序等于把这段时序分叉成三份 —— 而其中
   * 两份不会在同一个用例里被跑到。
   */
  async withExecutionLease<T>(
    executionId: string,
    fn: () => Promise<T>,
  ): Promise<{ ran: false } | { ran: true; value: T }> {
    const leases = this.internals.leases;
    if (!leases) return { ran: true, value: await fn() };
    return leases.runWithLease(LEASE_RESOURCE_EXECUTION, executionId, fn);
  }

  getExecution(id: string): ExecutionRecord {
    const row = this.internals.db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
      | ExecutionRow
      | undefined;
    if (!row) throw notFound(`Execution 不存在：${id}`);
    return mapExecution(row);
  }

  /**
   * 某 conversation 的 execution 列表，按创建时间正序（最新 limit 条）。
   *
   * 刻意不提供 `/executions/:id/tree`：调用方按 `parentExecutionId` 自己组树就够了，
   * 服务端算一次树只是在缓存一个随时会变的视图。
   */
  listExecutions(conversationId: string, limit = 200): ExecutionRecord[] {
    this.internals.getConversation(conversationId);

    const rows = this.internals.db
      .prepare(
        `
        SELECT *
        FROM execution
        WHERE conversation_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
        `,
      )
      .all(conversationId, limit) as unknown as ExecutionRow[];

    return rows.reverse().map(mapExecution);
  }

  /**
   * 显式 retry。绝不自动重跑被中断的 execution：
   * Copilot session 可能已经执行完工具但没来得及落库，自动重跑会重复执行。
   *
   * retry 生成一条全新的 execution，并用 retry_of_execution_id 指回原记录，
   * 审计链不会断。
   */
  retryExecution(executionId: string): { executionId: string } {
    const original = this.getExecution(executionId);
    if (ACTIVE_STATUSES.has(original.status)) {
      throw conflict(`execution 仍在进行中（${original.status}），不能 retry`);
    }

    const conversation = this.internals.getConversation(original.conversationId);
    // 归档的 Member 不接新活 —— retry 也是一次新活
    const member = this.internals.requireActiveMember(conversation, original.memberId);

    const retry: ExecutionRecord = {
      id: randomUUID(),
      conversationId: original.conversationId,
      memberId: original.memberId,
      goalRevision: original.goalRevision,
      taskId: original.taskId,
      externalWorkRef: original.externalWorkRef,
      externalWorkSnapshot: null,
      runtimeId: null,
      parentExecutionId: original.parentExecutionId,
      delegationPath: [...original.delegationPath],
      kind: original.kind,
      status: 'queued',
      prompt: original.prompt,
      response: null,
      error: null,
      waitingForRuntimeId: null,
      retryOfExecutionId: original.id,
      decision: null,
      // 触发消息与唤醒原因原样带过来：retry 是「把同一轮再跑一次」，
      // 不是「当成一条新消息」。这样它仍然能看到当时的房间上下文。
      triggerMessageSequence: original.triggerMessageSequence,
      wakeReason: original.wakeReason,
      // 刻意**不**继承原记录的快照：这一轮的快照必须是它自己开跑那一刻的配置。
      // 「配置漂移」因此是可查的 —— 把新记录的快照和 retry_of_execution_id
      // 指回去的那条比一比，就知道这次重跑换掉的是哪一样。
      configSnapshot: null,
      startedAt: null,
      endedAt: null,
      createdAt: now(),
    };
    this.internals.insertExecution(retry);
    this.internals.emitExecution(retry);

    // retry 是一条**新**的 execution，走和普通唤醒一样的租约路径。
    // 以前这里直接 executeMemberTurn：多副本时两个副本各自 retry 一次，
    // 同一个动作跑两遍，而 retry 的语义恰恰是「把同一轮再跑一次」——
    // 跑两次就是两次副作用。
    void this.withExecutionLease(retry.id, () =>
      this.executeMemberTurn({
        conversation,
        member,
        execution: retry,
        prompt: retry.prompt,
        triggerMessageSequence: retry.triggerMessageSequence,
        turnMode: this.internals.turnModeFor(conversation, retry),
        wakeReason: retry.wakeReason,
      }),
    ).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(
        '[team] retry execution failed:',
        error instanceof Error ? error.message : error,
      );
    });

    return { executionId: retry.id };
  }

  /**
   * 取消一条 execution。
   *
   * 顺序很重要：**先让引擎真的停下来，再决定终态**。反过来写
   * `UPDATE ... status = 'cancelled'` 会造出「DB 说已取消、Agent 还在跑」的假取消，
   * 比不取消更危险 —— 它让操作者以为副作用已经停了。
   *
   * 不支持 waiting_for_member 的 cascade cancel：
   *
   *   A → waiting B → waiting C
   *
   * 取消一棵正在等待的子树属于 cancellation propagation，要连子树的执行体一起处理。
   * 这里的范围只覆盖 queued / running。
   */
  async cancelExecution(executionId: string): Promise<ExecutionRecord> {
    const execution = this.getExecution(executionId);

    if (execution.status === 'cancelled') return execution;
    if (TERMINAL_STATUSES.has(execution.status)) {
      throw conflict(`这条任务已经结束（${execution.status}），无法取消`);
    }
    if (execution.status === 'waiting_for_member') {
      throw conflict(
        '这条任务正在等其他成员回话，不能直接取消：取消它要连带取消一串相关任务',
      );
    }

    if (execution.status === 'queued') {
      // 还没进引擎，落库即可。runTurn 开跑前会重新确认状态，不会偷偷跑起来。
      this.internals.updateExecution(executionId, {
        status: 'cancelled',
        error: CANCEL_REASON,
        endedAt: now(),
      });
      this.internals.emitExecution(this.getExecution(executionId));
      return this.getExecution(executionId);
    }

    // running：先发信号 + abort，再等这一轮的 turn 自己收尾。
    const runtimeId = execution.runtimeId;
    this.internals.cancelRequests.add(executionId);
    let result: Awaited<ReturnType<CopilotService['cancelTurn']>>;
    try {
      result = await this.internals.copilot.cancelTurn(executionId);
      if (runtimeId) await this.internals.waitForRuntimeIdle(runtimeId);
    } finally {
      this.internals.cancelRequests.delete(executionId);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[team] cancel ${executionId}: found=${result.found} aborted=${result.aborted} idle=${result.idle}`,
    );

    const final = this.getExecution(executionId);
    if (ACTIVE_STATUSES.has(final.status)) {
      // 引擎收尾后状态还是活的 —— 说明 cancel 没真正生效。绝不硬写成 cancelled：
      // 那会留下一条「DB 说取消、实际还在跑」的记录。
      throw conflict(
        `cancel 未生效，execution 仍处于 ${final.status}（abort found=${result.found} aborted=${result.aborted}）`,
      );
    }
    return final;
  }

  /**
   * 真正跑一次唤醒。
   *
   * execution 在这里创建（而不是在 sendMessage 里）：scheduler 已经保证了
   * 同一个 (conversation, member) 同时只有一个 wake 在跑，所以「一轮 = 一条
   * execution」，不会出现「一条消息唤醒两次、留下一条永远 queued 的 execution」。
   *
   * `markStarted` 由 scheduler 传入：它必须在 execution 落库之后调用一次，
   * 表示这条 wake 已不可安全重放。scheduler 用它区分「跑失败了」和
   * 「连跑都没跑起来」——后者要把 durable 的 pending 标记清掉，否则每次重启
   * 都会重派一条注定失败的唤醒。
   *
   * ── 这里为什么不抢 execution 租约 ───────────────────────────────────
   *
   * 因为抢不到它：execution id 是**这一刻**才 randomUUID() 出来的，另一副本
   * 不可能持有同一个 id。两个副本各跑一遍同一轮时，它们生成的是**两个不同
   * 的 execution id**，所以按 id 抢的租约天然挡不住这件事。
   *
   * 挡住它的是 scheduler 那一层的 **wake 租约**（键是 conversation:member，
   * 不随 id 变化）。两条路径的租约分工：
   *
   *   wake 租约       同一轮唤醒不被两个副本各跑一遍（键与 id 无关）
   *   execution 租约  同一条**已存在**的 execution 不被两个副本各跑一遍
   *                   （retry / 崩溃恢复的重新提交 —— 那里 id 是已知的）
   */
  async runWake(wake: PendingWake, markStarted: () => void): Promise<void> {
    const conversation = this.internals.getConversation(wake.conversationId);
    const member = this.internals.requireActiveMember(conversation, wake.memberId);

    // bootstrap 的最后一道闸：scheduler 把它从 pending 拿走、还没 INSERT
    // execution 的间隙里，用户消息可能已经到了。触发之后才来的用户消息
    // 证明这一轮已经没人要 —— 直接丢掉，不建 execution。
    if (wake.reason === 'lead_bootstrap') {
      const newerUserMessage = this.internals.db
        .prepare(
          `SELECT 1 AS ok FROM conversation_message
           WHERE conversation_id = ? AND sender_type = 'user' AND message_sequence > ?
           LIMIT 1`,
        )
        .get(wake.conversationId, wake.triggerSequence ?? 0) as unknown as
        | { ok: number }
        | undefined;
      if (newerUserMessage) {
        // 预期内的丢弃，不走 onError（那会打一条失败日志）：durable 标记要亲手
        // 收回，否则重启恢复会把这轮已丢弃的 bootstrap 重派回来。
        this.internals.states.abandonPendingWake(wake.conversationId, wake.memberId, wake);
        return;
      }
    }

    const task = wake.taskId ? this.internals.tasks.get(wake.taskId) : null;
    if (wake.taskId && !task) throw new ExecutionCancelledError('Task 已不存在，不再执行');
    if (task && task.conversationId !== conversation.id) {
      throw new ExecutionCancelledError('Task 不属于这个工作区，不再执行');
    }
    // stale wake 保护：Goal 已经往前走了，这个唤醒是对旧计划点的名。
    // crash / recovery 可能把它重派回来 —— 直接取消，不执行旧 Task。
    if (task && task.goalRevision !== conversation.goalRevision) {
      throw new ExecutionCancelledError(
        `Task 属于 Goal v${task.goalRevision}，当前已经是 Goal v${conversation.goalRevision}`,
      );
    }
    const trigger = wake.triggerSequence !== null && wake.triggerSequence !== undefined
      ? this.internals.findMessageBySequence(wake.conversationId, wake.triggerSequence)
      : null;

    // retry 链：Task 当前挂的那条 execution 就是上一轮失败的运行，
    // 新 execution 指回去，审计链不断。首次执行时为 null。
    const retryOfExecutionId = task?.currentExecutionId ?? null;

    const execution: ExecutionRecord = {
      id: randomUUID(),
      conversationId: conversation.id,
      memberId: member.id,
      goalRevision: conversation.goalRevision,
      taskId: task?.id ?? null,
      externalWorkRef: conversation.externalWorkRef,
      externalWorkSnapshot: null,
      runtimeId: null,
      parentExecutionId: null,
      delegationPath: [member.id],
      kind: task ? 'member_work' : 'interactive',
      status: 'queued',
      prompt: task ? task.description || task.title : (trigger?.content ?? ''),
      response: null,
      error: null,
      waitingForRuntimeId: null,
      retryOfExecutionId,
      decision: null,
      triggerMessageSequence: wake.triggerSequence,
      wakeReason: wake.reason,
      // 快照在 runTurn 里写：它由「当时真的拼出来的 system prompt」决定，
      // 而那一步在 runtime 锁内。见 buildConfigSnapshot。
      configSnapshot: null,
      startedAt: null,
      endedAt: null,
      createdAt: now(),
    };

    this.internals.transaction(() => {
      this.internals.insertExecution(execution);
      this.internals.states.beginWake(wake.conversationId, wake.memberId);
      if (task) this.internals.tasks.markRunning(task.id, execution.id);
    });
    markStarted();
    this.internals.emitExecution(execution);
    if (task) this.internals.emit(task.conversationId, { type: 'task.updated', data: this.internals.tasks.get(task.id) });

    try {
      // user_mention / member_message 都不是 Lead turn：否则被唤醒的 Member
      // 会拿到 Lead 的指令、写 Lead 的消息头，还可能触发 Lead 的自唤醒。
      const turnMode: TurnMode = task
        ? 'task'
        : wake.reason === 'user_mention'
          ? 'mention'
          : wake.reason === 'member_message'
            ? 'member_message'
            : 'lead';
      await this.executeMemberTurn({
        conversation,
        member,
        execution,
        prompt: execution.prompt,
        taskId: task?.id ?? null,
        triggerMessageSequence: wake.triggerSequence,
        turnMode,
        wakeReason: wake.reason,
      });
    } catch (error) {
      if (task) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = error instanceof ExecutionCancelledError;
        // turn 跑的是旧 Goal（中途 reviseGoal 已经收口）：旧 Task 行不动，
        // 也不推进 —— 新计划由 replan + 新 wake 驱动。
        const stale = this.internals.tasks.get(task.id).goalRevision !== this.internals.currentGoalRevision(task.conversationId);
        if (!cancelled && !stale) {
          this.internals.tasks.markFailed(task.id, message);
          this.internals.orchestrator.onTaskChanged(task.id);
        } else {
          this.internals.emit(task.conversationId, { type: 'task.updated', data: this.internals.tasks.get(task.id) });
        }
      }
      throw error;
    }
  }

  async executeMemberTurn(input: {
    conversation: Conversation;
    member: Member;
    execution: ExecutionRecord;
    prompt: string;
    sourceMemberId?: string;
    taskId?: string | null;
    triggerMessageSequence: number | null;
    turnMode: TurnMode;
    wakeReason: WakeReason | null;
  }): Promise<string> {
    const runtime = this.internals.ensureRuntime(input.conversation, input.member);
    // 整个 turn（含 DB 写入）都在 runtime 锁内，保证单写者。
    return this.internals.withRuntimeLock(runtime.id, () => this.internals.runTurn({ ...input, runtime }));
  }

  /**
   * 记录这一轮开跑时的配置，供事后对账。
   *
   * 只存指纹不存全文：system prompt 和 memory 都能从 member 行 + 磁盘重算，
   * 存全文只会制造第二份真相源（而且它和第一份迟早会不一致）。
   *
   * `memoryHash` 取的是**两份记忆文件合起来**的指纹，而注入 prompt 的只是各自
   * 的尾部 16000 字符（见 MemberService.readMemory）。两者刻意不同：快照回答的是
   * 「当时是哪一份记忆」，不是「当时塞进去了哪些字节」。
   *
   * ── 指纹 + 明细 ──────────────────────────────────────────────────────
   *
   * `capabilityManifestHash` 回答「和上次一样吗」，`effectiveConfig` 回答
   * 「这次是什么」。只有前者时，排查「这轮它能调哪些工具」需要把 Provider 注册
   * 顺序、模板、默认值全部复现一遍才可能重算出同一个哈希 —— 那等于要求排查的
   * 人重建整个装配。名字清单直接取自**解析结果**（不是配置原文）：原文会漂移，
   * 解析结果就是当时真正生效的那一份。
   *
   * `canonicalHash` 覆盖 `effectiveConfig` 的规范化 JSON，写入时算一次原样存下：
   * JSON 的键序 / 数组顺序都会影响哈希，让每个读的人自己算会出现「同一个配置
   * 两个值」。存下来之后，「这两轮是不是同一份配置」可以直接比字符串。
   */
  buildConfigSnapshot(
    member: Member,
    teamId: string,
    systemPrompt: string,
    capabilities: RuntimeCapabilities,
    turnMode: TurnMode,
    model: string,
    modelPurpose: ExecutionConfigSnapshot['modelPurpose'],
  ): ExecutionConfigSnapshot {
    const policyRevision = this.internals.authorization?.policy() ?? BUILTIN_POLICY_REVISION;
    const entitlementRevision = this.internals.authorization?.entitlement() ?? '';

    // 排序后进快照：解析结果的顺序取决于 Provider 注册顺序，而「同一套能力」
    // 不该因为注册顺序变了就产生两个不同的 canonicalHash。
    const effectiveConfig: NonNullable<ExecutionConfigSnapshot['effectiveConfig']> = {
      memberId: member.id,
      teamId,
      toolNames: capabilities.tools.map((tool) => tool.name).sort(),
      skillNames: capabilities.skills.map((skill) => skill.name).sort(),
      knowledgeNames: capabilities.knowledge
        .flatMap((binding) => binding.sources.map((source) => source.id))
        .sort(),
      mcpServers: capabilities.mcpServers.map((server) => server.id).sort(),
      turnMode,
      policyRevision,
      entitlementRevision,
    };

    return {
      memberRevision: member.updatedAt,
      model,
      modelPurpose,
      policyRevision,
      entitlementRevision,
      systemPromptHash: hashText(systemPrompt),
      memoryHash: hashText(
        `${this.internals.members.getMemory(member.id).content}\0${this.internals.members.getTeamMemory(member.id, teamId).content}`,
      ),
      capabilityManifestHash: capabilities.manifestHash,
      hostToolsEnabled: config.allowHostCodingTools,
      effectiveConfig,
      canonicalHash: createHash('sha256').update(JSON.stringify(effectiveConfig)).digest('hex'),
    };
  }
}
