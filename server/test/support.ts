import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { CopilotService, RunMemberTurnInput } from '../copilot.js';
import type { WakePlan } from '../group-dispatcher.js';
import type { TeamService } from '../team-service.js';
import { NO_REPLY_SENTINEL } from '../member-decision.js';

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
 * group 房间默认是「共享讨论」：用户消息以 open_discussion 广播给全体，
 * Member 发言后 follow_up 还会顺带唤醒别人。runtime / event / delegation
 * 这些机制类用例要的是「一次显式点名 = 一轮」，被自动唤醒的讨论搅进来只会
 * 让断言之间的时序变得不可预测。
 *
 * 显式 `targetMemberId` 不经过静音判断（它等价于一次 mention），
 * 所以静音之后每一轮仍然由用例自己驱动。
 */
export function muteAllMembers(team: TeamService, conversationId: string): void {
  for (const member of team.getConversation(conversationId).members) {
    team.setMemberMuted(conversationId, member.id, true);
  }
}

/** 一次 turn 的观察记录。断言身份 / 记忆隔离时看的是 `systemPrompt`。 */
export interface StubTurn {
  executionId: string;
  memberId: string;
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

  async runMemberTurn(input: RunMemberTurnInput): Promise<string> {
    this.turns.push({
      executionId: input.executionId,
      memberId: input.member.id,
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
    });
    if (this.hold) await this.hold;
    return this.mode === 'skip' ? NO_REPLY_SENTINEL : `reply from ${input.member.name}`;
  }

  reset(): void {
    this.turns.length = 0;
    this.mode = 'reply';
    this.hold = null;
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
