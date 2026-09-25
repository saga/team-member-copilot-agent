import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.js';
import type { ConversationMemberState, WakeStatus } from './domain.js';

interface StateRow {
  conversation_id: string;
  member_id: string;
  last_seen_message_sequence: number;
  last_replied_message_sequence: number;
  wake_status: WakeStatus;
  pending_wake: number;
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
 */
export class ConversationMemberService {
  constructor(private readonly db: DatabaseSync) {}

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

    return this.get(conversationId, memberId);
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
  }

  setPendingWake(conversationId: string, memberId: string, pending: boolean): void {
    this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          pending_wake = ?,
          updated_at = ?
        WHERE conversation_id = ?
          AND member_id = ?
        `,
      )
      .run(pending ? 1 : 0, now(), conversationId, memberId);
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
   * 重启恢复用：把「排队中被进程挂掉带走的」唤醒挑出来。
   *
   * 和 execution 的恢复策略一致 —— `queued` 表示还没开始跑，可以安全重派；
   * `running` 表示已经进过引擎，不能自动重跑（副作用可能已经发生），
   * 只把状态清回 idle，交给 execution 那侧的 interrupted 处理。
   */
  findLostWakes(): Array<{ conversationId: string; memberId: string }> {
    const rows = this.db
      .prepare(
        `
        SELECT conversation_id, member_id
        FROM conversation_member_state
        WHERE pending_wake = 1
          AND wake_status = 'queued'
        `,
      )
      .all() as unknown as Array<{ conversation_id: string; member_id: string }>;
    return rows.map((row) => ({ conversationId: row.conversation_id, memberId: row.member_id }));
  }

  /** 恢复时把所有非 idle 的唤醒状态清回 idle。 */
  resetWakeStatuses(): number {
    const result = this.db
      .prepare(
        `
        UPDATE conversation_member_state
        SET
          wake_status = 'idle',
          pending_wake = 0,
          updated_at = ?
        WHERE wake_status <> 'idle'
           OR pending_wake = 1
        `,
      )
      .run(now());
    return Number(result.changes ?? 0);
  }
}

function mapState(row: StateRow): ConversationMemberState {
  return {
    conversationId: row.conversation_id,
    memberId: row.member_id,
    lastSeenMessageSequence: row.last_seen_message_sequence,
    lastRepliedMessageSequence: row.last_replied_message_sequence,
    wakeStatus: row.wake_status,
    pendingWake: row.pending_wake === 1,
    muted: row.muted === 1,
    updatedAt: row.updated_at,
  };
}
