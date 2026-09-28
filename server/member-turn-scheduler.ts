import type { PendingWake, WakeReason } from './domain.js';
import type { ConversationMemberService } from './conversation-member-service.js';
import { LEASE_RESOURCE_WAKE, wakeLeaseId, type LeaseGrant, type WorkerLeaseService } from './worker-lease.js';

/**
 * 把「消息到了」和「Agent 开始跑」分成两个阶段。
 *
 * 一条消息可能唤醒三个 Member。如果 dispatcher 直接 `await executeMemberTurn()`，
 * 那就是三个 chatbot 同时抢答 —— 也正是「group chat 变成三个并行 chatbot」的成因。
 * 所以 dispatcher 只做**入队**，由这里决定什么时候、以什么顺序真正开跑。
 *
 * 这一层负责三件事：
 *
 * 1. **串行**：同一个 (conversation, member) 同时只有一个 turn。跨 Member 可以并行
 *    （它们本来就是独立大脑），同一个 Member 的多次唤醒必须排队。
 * 2. **合并（coalescing）**：一轮还在跑的时候又来了新唤醒，不新起一轮，只保留
 *    更明确的那一条（见 mergeWake），跑完再补一轮。这就是「一批 group activity
 *    尽量收敛成一次处理」。
 * 3. **不丢**：一轮跑失败不会让这个 key 永久卡死 —— 循环继续处理剩下的 pending。
 *
 * 真正的 runtime 锁在 TeamService.withRuntimeLock()（按 runtime 串行）。这一层
 * 的排队是「唤醒」层面的，粒度更粗，两者职责不重叠。
 *
 * ── 多副本：pending Map 之外还要一把 DB 租约 ─────────────────────────
 *
 * `pending` / `inFlight` 的前提是「只有我一个进程」。多副本之后它们各自成立、
 * 合起来失效：两个副本都从恢复流程里拿到同一个「丢失的唤醒」，各自 enqueue，
 * 各自 pump —— 同一个 (conversation, member) 上跑了两轮。
 *
 * 所以真正开跑前先抢一把 `('wake', conversationId:memberId)` 的 DB 租约。
 * 抢不到 = 另一个副本正在处理它，**直接跳过**：不等待（会让这一轮卡住）、
 * 不重试（TTL 内也不会成功）、也不碰 durable 行（那是对方的在途状态，
 * 动它等于替别人写状态）。
 *
 * 为什么不复用 `inFlight`：它只在**一个进程内**互斥。而这里要挡的恰恰是
 * 跨进程的那一次重复 —— 进程内互斥对它无能为力。
 */
export class MemberTurnScheduler {
  /** key = `${conversationId}:${memberId}` → 还没开跑的唤醒。 */
  private readonly pending = new Map<string, PendingWake>();
  /** 正在 pump 的 key。 */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly states: ConversationMemberService,
    /**
     * 真正跑一轮。第二个参数 `markStarted` 必须在 **execution 落库之后** 调用一次，
     * 它告诉调度器「这条 wake 不再是可以安全重派的排队项了」。
     * 不调 = 这一轮压根没进引擎，可以放心把 durable 的 pending 标记丢掉。
     *
     * 第三个参数是本轮 **wake 租约的凭证**（没传 leases 时为 null）。它必须一路
     * 传下去：runWake 会把它钉到新建的 execution 上，于是这一轮所有的写回都带
     * 上这一代 —— 租约被别的副本接手之后，本进程的写回会命中 0 行。只传一个
     * 布尔「抢到了」是不够的，凭证里才有代次。
     */
    private readonly run: (
      wake: PendingWake,
      markStarted: () => void,
      grant: LeaseGrant | null,
    ) => Promise<void>,
    private readonly onError: (wake: PendingWake, error: unknown) => void,
    /**
     * 不传 = 单进程语义（照常执行，不抢）。用「传没传」而不是一个布尔开关，
     * 是为了让单机模式和多副本模式共用同一条代码路径 —— 分叉出一条从来没被
     * 跑过的单机分支是更糟的选择（与 RecoveryService / SchedulerService 同一约定）。
     */
    private readonly leases?: WorkerLeaseService,
  ) {}

  /**
   * 入队一次唤醒。立即返回 —— 调用方（sendMessage / runTurn）不该等 Agent 跑完。
   *
   * 合并规则：
   *   - 已经有 pending → 不新建，只保留更明确的那一条（见 mergeWake）
   *   - 正在跑 → 同样记进 pending，pump 的循环跑完这一轮会接着处理
   */
  enqueue(wake: PendingWake): void {
    const key = keyOf(wake.conversationId, wake.memberId);
    const existing = this.pending.get(key);
    const merged = existing ? mergeWake(existing, wake) : wake;

    this.pending.set(key, merged);

    // durable 视图：连同触发消息、原因、Task 一起落库。进程在排队期间挂掉时，
    // RecoveryService 靠这几样把同一轮原样重放出来（而不是猜一个）。
    this.states.setPendingWake(wake.conversationId, wake.memberId, true, {
      triggerSequence: merged.triggerSequence,
      reason: merged.reason,
      taskId: merged.taskId,
    });
    if (!this.inFlight.has(key)) {
      this.states.setWakeStatus(wake.conversationId, wake.memberId, 'queued');
    }

    this.pump(key);
  }

  /** 这个 Member 在指定房间里有没有待处理 / 进行中的唤醒。 */
  isBusy(conversationId: string, memberId: string): boolean {
    const key = keyOf(conversationId, memberId);
    return this.inFlight.has(key) || this.pending.has(key);
  }

  /**
   * 有没有还没开跑的 pending wake（不含正在跑的那一轮）。
   *
   * startReadyTasks 用它而不是 isBusy 做跳过判据：turn 收尾的 onTaskChanged
   * 跑在 inFlight 释放之前，用 isBusy 会把“刚跑完、等着接下一棒”的 Task
   * 也跳掉，而收尾之后再也没有人 kick —— 任务烂在 ready。用 hasPending 只跳
   * 过“真有排队的”，在跑的那一轮收尾时会自己把下一棒推进来。
   */
  hasPendingWake(conversationId: string, memberId: string): boolean {
    return this.pending.has(keyOf(conversationId, memberId));
  }

  /**
   * 按条件删掉还没开跑的 pending wake（用户消息取消 bootstrap 用）。
   *
   * 只动 pending：在跑的轮次碰不得（abort 是 execution 层的事）。
   * durable 视图一起收回，否则重启恢复会把删掉的轮次重派回来。
   */
  cancelPending(
    conversationId: string,
    memberId: string,
    predicate: (wake: PendingWake) => boolean,
  ): boolean {
    const key = keyOf(conversationId, memberId);
    const wake = this.pending.get(key);
    if (!wake || !predicate(wake)) return false;

    this.pending.delete(key);
    this.states.abandonPendingWake(conversationId, memberId, wake);
    if (!this.inFlight.has(key)) {
      this.states.setWakeStatus(conversationId, memberId, 'idle');
    }
    return true;
  }

  /**
   * 这个 Member 在**任意**房间里有没有待处理 / 进行中的唤醒。
   *
   * 归档是全局动作（一个 Member 可能同时在几个房间里），所以不能用 isBusy。
   */
  hasWork(memberId: string): boolean {
    const suffix = `:${memberId}`;
    for (const key of this.pending.keys()) if (key.endsWith(suffix)) return true;
    for (const key of this.inFlight) if (key.endsWith(suffix)) return true;
    return false;
  }

  /** 只在测试里用：等所有 key 都跑空。 */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0 || this.pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private pump(key: string): void {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);

    void (async () => {
      try {
        while (this.pending.has(key)) {
          const wake = this.pending.get(key);
          if (!wake) break;
          this.pending.delete(key);

          let started = false;
          // 被别人抢走时为 true。它同时决定两件事：不再往下跑，以及**不碰**
          // durable 行（那是对方的在途状态，替它写会把它那一轮的状态覆盖掉）。
          let skipped = false;
          try {
            // 「排队 → 在跑」的 durable 翻转由 run() 负责，因为它必须与
            // execution 的落库同一个事务。这里只记录它有没有发生。
            const task = (grant: LeaseGrant | null) =>
              this.run(wake, () => {
                started = true;
              }, grant);

            if (this.leases) {
              const outcome = await this.leases.runWithLease(
                LEASE_RESOURCE_WAKE,
                wakeLeaseId(wake.conversationId, wake.memberId),
                task,
              );
              skipped = !outcome.ran;
            } else {
              await task(null);
            }
          } catch (error) {
            if (!started) {
              // 连 execution 都没建起来（成员在这中间被归档 / 房间被删）。
              // 这条 wake 从来没开始跑，不能一直占着 durable 的「有个唤醒在排队」，
              // 否则每次重启恢复都会重派它、每次都以同样的方式失败。
              this.states.abandonPendingWake(wake.conversationId, wake.memberId, wake);
            }
            // 一轮失败不能把 key 卡死：日志交给调用方，循环继续。
            this.onError(wake, error);
          } finally {
            // 只有在没有新 pending 时才回到 idle，否则下一轮紧接着就要跑，
            // 中间闪一下 idle 会让 UI 抖。
            if (!skipped && !this.pending.has(key)) {
              this.states.setWakeStatus(wake.conversationId, wake.memberId, 'idle');
            }
          }

          if (skipped) {
            // 跳过是**预期行为**（另一个副本在跑），不是错误：不打 onError，
            // 否则多副本下每个正常轮次都会在日志里留下一条「失败」。
            // 但必须留痕 —— 「这一轮为什么没跑」是排查时最需要知道的。
            // eslint-disable-next-line no-console
            console.log(
              `[scheduler] wake ${wake.memberId}@${wake.conversationId} 由其他副本处理，跳过`,
            );
          }
        }
      } finally {
        this.inFlight.delete(key);
        // pump 期间又 enqueue 了（竞态窗口）→ 重新拉起来，不能留 pending 没人管
        if (this.pending.has(key)) this.pump(key);
      }
    })();
  }
}

function keyOf(conversationId: string, memberId: string): string {
  return `${conversationId}:${memberId}`;
}

/**
 * reason 的「具体程度」。Task 执行优先于 Lead 处理用户输入：
 * 同一个 Member 身上，Task wake 不能被一条 Lead wake 顶掉。
 * 三种 Lead 原因同级：都是「Lead 要说话」，谁的新消息序号大听谁的。
 */
const REASON_PRIORITY: Record<Exclude<WakeReason, 'schedule'>, number> = {
  goal_changed: 5,
  member_message: 4,
  // 用户明确点名高于普通自动 Task wake，但低于 Goal 重新规划。
  user_mention: 3,
  task_ready: 2,
  lead_message: 1,
  lead_clarification: 1,
  lead_recovery: 1,
  // 自动首轮垫底：同一个 Lead 的 pending 里它永远输给真正的用户消息，
  // bootstrap 和 user message 不会各跑一遍。
  lead_bootstrap: 0,
};

/**
 * 合并两条落在同一个 (conversation, member) 上的唤醒。
 *
 * **整条保留，不做字段级拼装。** 不同 Task 的 wake 不合并：它们是两件不同的事，
 * 拼起来会让执行人对着错误的 Task 跑。
 */
function mergeWake(current: PendingWake, incoming: PendingWake): PendingWake {
  if ((current.taskId ?? null) !== (incoming.taskId ?? null)) {
    const currentPriority = REASON_PRIORITY[current.reason] ?? 0;
    const incomingPriority = REASON_PRIORITY[incoming.reason] ?? 0;
    if (incomingPriority > currentPriority) return incoming;
    return current;
  }
  const currentPriority = REASON_PRIORITY[current.reason] ?? 0;
  const incomingPriority = REASON_PRIORITY[incoming.reason] ?? 0;
  if (incomingPriority > currentPriority) return incoming;
  if (incomingPriority === currentPriority) {
    const currentSeq = current.triggerSequence ?? 0;
    const incomingSeq = incoming.triggerSequence ?? 0;
    return incomingSeq > currentSeq ? incoming : current;
  }
  return current;
}
