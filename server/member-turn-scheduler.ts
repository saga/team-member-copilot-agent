import type { WakeReason } from './domain.js';
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
 * 2. **合并（coalescing）**：一轮还在跑的时候又来了新唤醒，不新起一轮，只把
 *    triggerSequence 推高、把 reason 升级成更具体的那个，跑完再补一轮。
 *    这就是「一批 group activity 尽量收敛成一次处理」。
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
    private readonly run: (wake: PendingWake) => Promise<void>,
    private readonly onError: (wake: PendingWake, error: unknown) => void,
  ) {}

  /**
   * 入队一次唤醒。立即返回 —— 调用方（sendMessage / runTurn）不该等 Agent 跑完。
   *
   * 合并规则：
   *   - 已经有 pending → 不新建，reason 取更具体的那个（mention > direct >
   *     follow_up > open_discussion），triggerSequence 取更大的
   *   - 正在跑 → 同样记进 pending，pump 的循环跑完这一轮会接着处理
   */
  enqueue(wake: PendingWake): void {
    const key = keyOf(wake);
    const existing = this.pending.get(key);

    this.pending.set(key, existing ? mergeWake(existing, wake) : wake);

    // durable 视图：pending_wake = 1 表示「有个唤醒还没处理完」。
    // 进程在排队期间挂掉时，RecoveryService 靠它把唤醒重新派出去。
    this.states.setPendingWake(wake.conversationId, wake.memberId, true);
    if (!this.inFlight.has(key)) {
      this.states.setWakeStatus(wake.conversationId, wake.memberId, 'queued');
    }

    this.pump(key);
  }

  /** 这个 Member 在房间里有没有待处理 / 进行中的唤醒（UI 与测试用）。 */
  isBusy(conversationId: string, memberId: string): boolean {
    const key = `${conversationId}:${memberId}`;
    return this.inFlight.has(key) || this.pending.has(key);
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

          // 从「排队」变成「在跑」。清掉 durable 的 pending 标记：如果进程在这里
          // 挂掉，这条 wake 属于「已经进过引擎」，和 execution 的 running 一样
          // 不能自动重跑。
          this.states.setPendingWake(wake.conversationId, wake.memberId, false);
          this.states.setWakeStatus(wake.conversationId, wake.memberId, 'running');

          try {
            await this.run(wake);
          } catch (error) {
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

export interface PendingWake {
  conversationId: string;
  memberId: string;
  reason: WakeReason;
  triggerSequence: number;
}

function keyOf(wake: PendingWake): string {
  return `${wake.conversationId}:${wake.memberId}`;
}

/**
 * reason 的「具体程度」。
 *
 * 合并时保留更具体的那一个：被 @ 到比「顺带唤醒」更值得回答，
 * 反过来降级会让一次明确的点名被吞掉。
 */
const REASON_PRIORITY: Record<WakeReason, number> = {
  mention: 3,
  direct: 2,
  follow_up: 1,
  open_discussion: 0,
};

function mergeWake(current: PendingWake, incoming: PendingWake): PendingWake {
  return {
    ...current,
    reason:
      REASON_PRIORITY[incoming.reason] > REASON_PRIORITY[current.reason]
        ? incoming.reason
        : current.reason,
    triggerSequence: Math.max(current.triggerSequence, incoming.triggerSequence),
  };
}
