import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from './db-tx.js';
import { now } from './db.js';
import type { StoredTeamEvent, TeamEventType } from './domain.js';

export type { StoredTeamEvent, TeamEventType };

/**
 * Team 级实时事件：WorkItem / Schedule / Presence / Project / Membership。
 *
 * 和 Conversation SSE 是两套边界、共用同一套纪律：
 *
 *   Conversation SSE —— message / execution / delegation（房间内的事）
 *   Team SSE         —— Team 业务对象的状态变化（跨房间的事）
 *
 * 落库是 source of truth：事件先写 team_event（sequence 由 team.event_sequence
 * 分配，UNIQUE(team_id, sequence) 是 replay 不丢不重的锚点），COMMIT 之后才
 * broadcast —— 一旦回滚，前端已经看到的状态就是 DB 从没承认过的。
 *
 * 注意分工：这里是**通知层**。WorkItem 的审计真相在 work_item_event（列式、
 * 可查询）；team_event 的 payload 是「什么变了」，消费方据此决定刷哪块 UI，
 * 不承担审计职责。
 */

/** 回放分页大小。 */
const REPLAY_BATCH = 500;
/** 单次回放上限，超过截断并告警（与 Conversation SSE 同样的阻塞保护）。 */
const REPLAY_MAX_EVENTS = 5000;

type Listener = (event: StoredTeamEvent) => void;

interface TeamEventRow {
  id: string;
  team_id: string;
  sequence: number;
  event_type: TeamEventType;
  payload: string;
  created_at: string;
}

export class TeamEventService {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly db: DatabaseSync) {}

  /**
   * 记录一条 Team 事件并在 COMMIT 后广播。
   *
   * 必须与业务写入在同一个事务里调用（结构服务通过 onTeamChange 回调做到）：
   * 业务行回滚时事件也一起回滚。事务外调用时这里自己开短事务 —— 那时业务行
   * 已经提交，丢了通知只是少刷一次 UI，不是丢事实。
   */
  append(teamId: string, type: TeamEventType, data: unknown): void {
    const id = randomUUID();
    const createdAt = now();
    let stored: StoredTeamEvent | null = null;
    const broadcast = () => {
      if (stored) this.broadcast(stored);
    };
    runInTransaction(this.db, () => {
      this.db
        .prepare(`UPDATE team SET event_sequence = event_sequence + 1 WHERE id = ?`)
        .run(teamId);
      const row = this.db.prepare(`SELECT event_sequence AS n FROM team WHERE id = ?`).get(teamId) as
        | { n: number }
        | undefined;
      if (!row) return;
      this.db
        .prepare(
          `INSERT INTO team_event (id, team_id, sequence, event_type, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, teamId, row.n, type, JSON.stringify(data), createdAt);
      stored = { id, teamId, sequence: row.n, type, data, createdAt };
    }, broadcast);
  }

  /** 从 sinceSequence（不含）开始回放，sequence 正序。 */
  listSince(teamId: string, sinceSequence: number, limit = 500): StoredTeamEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM team_event WHERE team_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all(teamId, sinceSequence, limit) as unknown as TeamEventRow[];
    return rows.map(mapTeamEvent);
  }

  /** 只订阅实时事件（不回放）。 */
  subscribe(teamId: string, listener: Listener): () => void {
    let set = this.listeners.get(teamId);
    if (!set) {
      set = new Set();
      this.listeners.set(teamId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(teamId);
    };
  }

  /**
   * 回放 + 订阅，且两者之间不留缝。
   * 机制与 Conversation SSE 的 replayAndSubscribe 相同：先挂实时监听并缓冲，
   * 再回放 DB，最后把「比回放水位更新」的缓冲补发。重复由 sequence 去重。
   */
  replayAndSubscribe(teamId: string, sinceSequence: number, listener: Listener): () => void {
    const buffered: StoredTeamEvent[] = [];
    let live = false;
    let highWater = sinceSequence;

    const deliver = (event: StoredTeamEvent): void => {
      if (event.sequence <= highWater) return;
      highWater = event.sequence;
      listener(event);
    };

    const unsubscribe = this.subscribe(teamId, (event) => {
      if (!live) {
        buffered.push(event);
        return;
      }
      deliver(event);
    });

    let replayed = 0;
    let cursor = sinceSequence;
    for (;;) {
      const batch = this.listSince(teamId, cursor, REPLAY_BATCH);
      if (batch.length === 0) break;

      for (const event of batch) deliver(event);
      replayed += batch.length;

      if (batch.length < REPLAY_BATCH) break;
      if (replayed >= REPLAY_MAX_EVENTS) {
        // eslint-disable-next-line no-console
        console.warn(
          `[team-events] team ${teamId} 回放事件超过 ${REPLAY_MAX_EVENTS} 条，已截断；` +
            `客户端应重新拉取完整状态列表`,
        );
        break;
      }
      cursor = batch[batch.length - 1].sequence;
    }

    live = true;
    for (const event of buffered) deliver(event);

    return unsubscribe;
  }

  private broadcast(event: StoredTeamEvent): void {
    const listeners = this.listeners.get(event.teamId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 一个 SSE consumer 挂掉不能影响其它 consumer
      }
    }
  }
}

function mapTeamEvent(row: TeamEventRow): StoredTeamEvent {
  return {
    id: row.id,
    teamId: row.team_id,
    sequence: row.sequence,
    type: row.event_type,
    data: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}
