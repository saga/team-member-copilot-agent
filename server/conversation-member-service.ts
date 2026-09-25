import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.js';
import type {
  ConversationMemberState,
  ConversationMemberStateChange,
  PendingWake,
  WakeReason,
  WakeStatus,
} from './domain.js';

interface StateRow {
  conversation_id: string;
  member_id: string;
  last_seen_message_sequence: number;
  last_replied_message_sequence: number;
  wake_status: WakeStatus;
  pending_wake: number;
  pending_wake_trigger_sequence: number | null;
  pending_wake_reason: string | null;
  muted: number;
  updated_at: string;
}

/**
 * Member 在 Conversation 里的**房间状态**。
 *
 * 这里只回答一个问题：「这个 Member 在房间里看到哪里了、要不要被唤醒」。
 * 「这个 Member 的 Agent 怎么运行」是 MemberRuntime 的事（copilotSessionId /
 * workspacePath / lastContextMessageSequence），两者刻意分开：
 *
 *   lastContextMessageSequence  —— 已经注入过 Copilot session 的水位
 *   lastSeenMessageSequence     —— 已经读过房间的水位
 *
 * 它们会分叉。Member 读完房间但选择不发言（decision = 'skip'）时，房间游标前进，
 * 而 session checkpoint 不动 —— 下一轮它确实需要重新看到那些消息，因为它的
 * Copilot session 从来没读过。
 *
 * 每次变化都会回调 `onChange`，由 TeamService 落成 durable 事件。刻意不做
 * 「只在字段真的变了才回调」的比对：这张表只有 9 列、每轮改动个位数，
 * 而代价是多一次 SELECT 和一套容易写错的比较逻辑。回调出去的永远是完整状态，
 * 重复投递是无害的（应用方按 memberId 整体替换）。
 */
export class ConversationMemberService {
  constructor(
    private readonly db: DatabaseSync,
    /**
     * 状态行发生变化后回调一次。
     *
     * TeamService 传入的实现把它打成 `conversation_member_state.updated` 事件；
     * RecoveryService 与测试不传 —— 恢复期没有任何订阅者，那里也不需要广播。
     *
     * 第一个参数是 conversationId 而不是从 state 里取：状态**消失**时
     * （成员被移出房间）state 是 null，但它同样属于某个房间的事件流。
     */
    private readonly onChange: (
      conversationId: string,
      change: ConversationMemberStateChange,
    ) => void = () => {},
  ) {}

  /**
   * 幂等地保证状态行存在。
   *
   * `lastSeen` 的初值给 0 而不是当前 message_sequence：新建 conversation 时
   * 本来就没有历史。加入已有 group 的新成员则由 addMember 传入当时的房间水位，
   * 免得它一进来就要读全部历史。
   */
  ensure(
    conversationId: string,
    memberId: string,
    lastSeenMessageSequence = 0,
  ): ConversationMemberState {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO conversation_member_state (
          conversation_id,
          member_id,
          last_seen_message_sequence,
          last_replied_message_sequence,
          wake_status,
          pending_wake,
          muted,
          updated_at
        )
        VALUES (?, ?, ?, 0, 'idle', 0, 0, ?)
        `,
      )
      .run(conversationId, memberId, lastSeenMessageSequence, now());

    const state = this.get(conversationId, memberId);
    this.onChange(conversationId, { memberId, state });
    return state;
  }

  get(conversationId: string, memberId: string): ConversationMemberState {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_member_state
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .get(conversationId, memberId) as unknown as StateRow | undefined;

    if (!row) return this.ensure(conversationId, memberId);
    return mapState(row);
  }

  list(conversationId: string): ConversationMemberState[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversation_member_state
        WHERE conversation_id = ?
        `,
      )
      .all(conversationId) as unknown as StateRow[];
    return rows.map(mapState);
  }

  /**
   * 房间读游标前进。
   *
   * 只在**成功**的一轮结束时调用，而且传入的是「这一轮真正读到的最大序号」
   * （ContextAssembler.consumedThroughSequence），不是「当前房间最大序号」——
   * 后者会把这一轮进行期间新到的消息也标成已读，那些消息就再也不会唤醒它了。
   *
   * 用 MAX 保证单调：并发的 markSeen 不会让游标倒退。
   */
  markSeen(conversationId: string, memberId: string, sequence: number): void {
    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          last_seen_message_sequence = MAX(last_seen_message_sequence, ?),
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(sequence, now(), conversationId, memberId);
    this.emitState(conversationId, memberId);
  }

  markReplied(conversationId: string, memberId: string, sequence: number): void {
    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          last_replied_message_sequence = MAX(last_replied_message_sequence, ?),
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(sequence, now(), conversationId, memberId);
    this.emitState(conversationId, memberId);
  }

  setWakeStatus(conversationId: string, memberId: string, status: WakeStatus): void {
    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          wake_status = ?,
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(status, now(), conversationId, memberId);
    this.emitState(conversationId, memberId);
  }

  /**
   * 记下 / 清掉「有个唤醒在排队」。
   *
   * `pending = true` 时必须带上触发消息与原因 —— 这两样会一起落库，恢复时按它们
   * 原样重放（见 PendingWake 的注释）。`pending = false` 时一并清空，避免留下
   * 一条「没有排队、却还记得上次为什么排队」的幽灵记录。
   */
  setPendingWake(
    conversationId: string,
    memberId: string,
    pending: boolean,
    wake?: { triggerSequence: number; reason: WakeReason },
  ): void {
    if (pending && !wake) {
      // 这是调用方的编程错误，不是用户输入问题：能落库的 pending 必须可重放。
      throw new Error('setPendingWake(true) 必须带上 triggerSequence 与 reason');
    }

    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          pending_wake = ?,
          pending_wake_trigger_sequence = ?,
          pending_wake_reason = ?,
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(
        pending ? 1 : 0,
        pending && wake ? wake.triggerSequence : null,
        pending && wake ? wake.reason : null,
        now(),
        conversationId,
        memberId,
      );
    this.emitState(conversationId, memberId);
  }

  /**
   * 「排队」→「在跑」：这条唤醒已经进了引擎。
   *
   * 调用方必须在 **execution 落库之后、同一个事务里** 调它。这个状态翻转等价的
   * 语义是「副作用可能已经发生过」，所以重启恢复不会再重派它。
   *
   * 反过来先清 pending 再建 execution 的话，进程死在中间会同时丢掉 wake 和
   * execution —— 恢复时两边都看不见，这一轮凭空消失。
   */
  beginWake(conversationId: string, memberId: string): void {
    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          pending_wake = 0,
          pending_wake_trigger_sequence = NULL,
          pending_wake_reason = NULL,
          wake_status = 'running',
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(now(), conversationId, memberId);
    this.emitState(conversationId, memberId);
  }

  /**
   * 丢弃一条**从未开始跑**的唤醒（run 在建 execution 之前就失败了）。
   *
   * 带上 `expected` 是为了不误伤并发到达的那条新唤醒：只有持久化的那一条仍然
   * 是失败者本人时才清。否则「成员被归档导致这一轮失败」会把紧随其后的新一轮
   * 的 pending 标记一起抹掉。
   */
  abandonPendingWake(conversationId: string, memberId: string, expected: PendingWake): void {
    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          pending_wake = 0,
          pending_wake_trigger_sequence = NULL,
          pending_wake_reason = NULL,
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
          AND pending_wake = 1
          AND pending_wake_trigger_sequence IS ?
          AND pending_wake_reason IS ?
        `,
      )
      .run(
        now(),
        conversationId,
        memberId,
        expected.triggerSequence,
        expected.reason,
      );
    this.emitState(conversationId, memberId);
  }

  setMuted(conversationId: string, memberId: string, muted: boolean): void {
    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          muted = ?,
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(muted ? 1 : 0, now(), conversationId, memberId);
    this.emitState(conversationId, memberId);
  }

  /** 成员被移出 conversation（或成员归档）时清理。 */
  remove(conversationId: string, memberId: string): void {
    this.db
      .prepare(
        `
        DELETE FROM conversation_member_state
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(conversationId, memberId);

    // state = null：这个成员在这个房间里已经没有任何状态。前端据此删掉本地那份，
    // 而不是继续显示一个已经被移出房间的成员。
    this.onChange(conversationId, { memberId, state: null });
  }

  /**
   * 变更回调的统一入口。读回整行再回调，保证投出去的是**落库后**的状态 ——
   * 拿内存里拼的值会让「前端看到的状态」和「dispatcher 读到的事实」出现分叉。
   */
  private emitState(conversationId: string, memberId: string): void {
    this.onChange(conversationId, { memberId, state: this.get(conversationId, memberId) });
  }

  /**
   * 这个 Member 在房间里未读的消息数（`lastSeen` 之后）。
   * UI 上就是「Alice 有 3 条没看」。
   */
  unreadCount(conversationId: string, memberId: string): number {
    const state = this.get(conversationId, memberId);
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM conversation_message
        WHERE conversation_id = ?
          AND message_sequence > ?
        `,
      )
      .get(conversationId, state.lastSeenMessageSequence) as unknown as { count: number };
    return row.count;
  }

  /**
   * 重启恢复用：把「排队中被进程挂掉带走的」唤醒挑出来，连同触发消息与原因。
   *
   * 和 execution 的恢复策略一致 —— `queued` 表示还没开始跑，可以安全重派；
   * `running` 表示已经进过引擎，不能自动重跑（副作用可能已经发生），
   * 只把状态清回 idle，交给 execution 那侧的 interrupted 处理。
   *
   * 元数据为 NULL 的行只可能来自 v3→v4 迁移的瞬间（极端罕见），这时退回
   * triggerSequence = 0 + open_discussion：宁可重放成一次允许沉默的唤醒，
   * 也不要把一条 unknown 的原因当成 mention 逼出一条消息。调用方看到
   * triggerSequence = 0 会用房间当前水位兜底。
   */
  findLostWakes(): PendingWake[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          conversation_id,
          member_id,
          pending_wake_trigger_sequence,
          pending_wake_reason
        FROM conversation_member_state
        WHERE pending_wake = 1
          AND wake_status = 'queued'
        `,
      )
      .all() as unknown as Array<{
      conversation_id: string;
      member_id: string;
      pending_wake_trigger_sequence: number | null;
      pending_wake_reason: string | null;
    }>;

    return rows.map((row) => ({
      conversationId: row.conversation_id,
      memberId: row.member_id,
      triggerSequence: row.pending_wake_trigger_sequence ?? 0,
      reason: asWakeReason(row.pending_wake_reason),
    }));
  }

  /** 恢复时把所有非 idle 的唤醒状态清回 idle，连同 pending 的元数据。 */
  resetWakeStatuses(): number {
    const result = this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          wake_status = 'idle',
          pending_wake = 0,
          pending_wake_trigger_sequence = NULL,
          pending_wake_reason = NULL,
          updated_at = ?
        WHERE wake_status <> 'idle'
           OR pending_wake = 1
        `,
      )
      .run(now());
    return Number(result.changes ?? 0);
  }
}

/**
 * 把落库的 reason 收窄回联合类型。
 *
 * 数据库里是自由 TEXT（加 CHECK 要重建表，见 db-migrations 的 v4 注释），所以
 * 读回来必须过这一层：认不出来的一律按最宽松的 open_discussion 处理。
 * RecoveryService 也用它，两处读同一列不能有两套判据。
 */
export function asWakeReason(value: string | null): WakeReason {
  return value === 'direct' || value === 'mention' || value === 'follow_up'
    ? value
    : 'open_discussion';
}

function mapState(row: StateRow): ConversationMemberState {
  return {
    conversationId: row.conversation_id,
    memberId: row.member_id,
    lastSeenMessageSequence: row.last_seen_message_sequence,
    lastRepliedMessageSequence: row.last_replied_message_sequence,
    wakeStatus: row.wake_status,
    pendingWake: row.pending_wake === 1,
    pendingWakeTriggerSequence: row.pending_wake_trigger_sequence,
    pendingWakeReason: row.pending_wake_reason ? asWakeReason(row.pending_wake_reason) : null,
    muted: row.muted === 1,
    updatedAt: row.updated_at,
  };
}
