import type { PendingWake, WakeReason } from './domain.js';
import type { ConversationMemberService } from './conversation-member-service.js';

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
     */
    private readonly run: (wake: PendingWake, markStarted: () => void) => Promise<void>,
    private readonly onError: (wake: PendingWake, error: unknown) => void,
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

    // durable 视图：连同触发消息与原因一起落库。进程在排队期间挂掉时，
    // RecoveryService 靠这三样把同一轮原样重放出来（而不是猜一个）。
    this.states.setPendingWake(wake.conversationId, wake.memberId, true, {
      triggerSequence: merged.triggerSequence,
      reason: merged.reason,
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
          try {
            // 「排队 → 在跑」的 durable 翻转由 run() 负责，因为它必须与
            // execution 的落库同一个事务。这里只记录它有没有发生。
            await this.run(wake, () => {
              started = true;
            });
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
            if (!this.pending.has(key)) {
              this.states.setWakeStatus(wake.conversationId, wake.memberId, 'idle');
            }
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
 * reason 的「具体程度」。
 *
 * 合并时保留更具体的那一个：被 @ 到比「顺带唤醒」更值得回答，
 * 反过来降级会让一次明确的点名被吞掉。
 *
 * escalation 排在最前：它代表「整个房间都没接话」，是所有唤醒理由里最不该
 * 被别的理由顶掉的一个。负责人身上**确实可能同时**挂着一条更弱的唤醒
 * （比如它作为普通成员被 open_discussion 顺带唤醒，还没轮到跑），
 * 这时合并结果必须是兜底 —— 否则「房间没人接话」这件事会被悄悄降级成
 * 「顺带看看」，负责人就不知道该由自己收尾了。
 */
const REASON_PRIORITY: Record<Exclude<WakeReason, 'schedule'>, number> = {
  escalation: 4,
  mention: 3,
  direct: 2,
  follow_up: 1,
  open_discussion: 0,
};

/**
 * 合并两条落在同一个 (conversation, member) 上的唤醒。
 *
 * **整条保留，不做字段级拼装。** 早先的实现是「reason 取更明确的、triggerSequence
 * 取更大的」分别计算，于是可能拼出一条并不存在的事件：
 *
 *   #10 "@bob 看一下"   → mention @10
 *   #11 "大家再看一下"   → open_discussion @11
 *   合并结果           → mention @11      ← #11 并没有点名 Bob
 *
 * ContextAssembler 会照 reason 给出「你被明确点名，必须回答」，但它指的是一条
 * 谁都没点名的消息。所以规则是：
 *
 *   更明确的 wake → 保留原来那一条（连同它的 trigger）
 *   同级 wake     → 用更新的那一条
 *   更弱的 wake   → 不覆盖已有的明确 wake
 *
 * 被丢掉的那条消息并没有消失：ContextAssembler 注入的是「自 checkpoint 以来的
 * 全部消息」，不是「触发消息」一条，所以两条消息都会进 prompt。
 */
function mergeWake(current: PendingWake, incoming: PendingWake): PendingWake {
  const currentPriority = REASON_PRIORITY[current.reason];
  const incomingPriority = REASON_PRIORITY[incoming.reason];

  if (incomingPriority > currentPriority) return incoming;
  if (incomingPriority === currentPriority) {
    return incoming.triggerSequence > current.triggerSequence ? incoming : current;
  }
  return current;
}
