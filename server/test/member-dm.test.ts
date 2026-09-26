import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Member } from '../domain.js';

/**
 * Member ↔ Member 私聊。
 *
 * 这一块有两个容易做错、且做错了很难在下游发现的地方，用例就盯这两点：
 *
 * 1. **房间的唯一性**。私聊房间在库里是「两个 Member 的 direct conversation」，
 *    和「用户 ↔ 单个 Member」共用同一个 kind。查找时必须校验 roster 恰好两个人，
 *    否则用户点 Alice 的 Chat 会一头撞进 Alice 和 Bob 的私聊。
 *
 * 2. **自动对谈必须断掉**。唤醒只由「显式发一条消息」触发。如果 Member 发言后
 *    还照常派发唤醒，A 问 → B 答 → 唤醒 A → A 答 → ... 就是一条没有终点的链，
 *    没有人在旁边看着，会一直烧下去。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-dm-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { executionIdForWake, StubCopilot, createTestStack } = await import('./support.js');

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot);

/** 每对成员只服务一个用例，避免 (a, b) 的房间唯一性把用例互相串起来。 */
let seq = 0;
function newPair(): [Member, Member] {
  seq += 1;
  return [
    team.createMember({ name: `Peer${seq}A`, role: 'Analyst' }),
    team.createMember({ name: `Peer${seq}B`, role: 'Engineer' }),
  ];
}

function executionIds(conversationId: string): string[] {
  const rows = db
    .prepare(`SELECT id FROM execution WHERE conversation_id = ? ORDER BY rowid`)
    .all(conversationId) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function executionStatus(id: string): string {
  const row = db.prepare(`SELECT status FROM execution WHERE id = ?`).get(id) as unknown as
    | { status: string }
    | undefined;
  assert.ok(row, `execution ${id} 不存在`);
  return row.status;
}

async function waitForStatus(id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (executionStatus(id) === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`execution ${id} 未在预期时间内变成 ${status}（当前 ${executionStatus(id)}）`);
}

async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const row = db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM execution
        WHERE conversation_id = ?
          AND status IN ('queued', 'running', 'waiting_for_member')
        `,
      )
      .get(conversationId) as unknown as { n: number };
    if (row.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`conversation ${conversationId} 仍有未完成的 execution`);
}

afterEach(() => {
  stub.reset();
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('私聊房间', () => {
  it('同一对 Member 只有一个房间，顺序无关', () => {
    const [a, b] = newPair();

    const first = team.openDirectMessage(a.id, b.id);
    const again = team.openDirectMessage(b.id, a.id);

    assert.equal(first.id, again.id, 'a↔b 和 b↔a 必须是同一个房间');
    assert.equal(first.members.length, 2);
    assert.equal(first.kind, 'direct');
    // 标题写双方，别落到「第一个 Member 的名字」上 —— 那和用户单聊分不清
    assert.equal(first.title, `${a.name} · ${b.name}`);
  });

  it('用户 ↔ Member 的单聊不会被当成私聊', () => {
    const [a, b] = newPair();
    const solo = team.createConversation({ kind: 'direct', title: a.name, memberIds: [a.id] });

    const dm = team.openDirectMessage(a.id, b.id);

    assert.notEqual(dm.id, solo.id, '私聊必须另建房间，不能复用用户单聊');
    assert.equal(solo.members.length, 1);

    const inbox = team.listDirectMessages(a.id);
    assert.equal(inbox.length, 1, '列表只算 roster 恰好两人的房间');
    assert.equal(inbox[0].conversation.id, dm.id);
    assert.equal(inbox[0].peer.id, b.id);
  });
});

describe('私聊消息', () => {
  it('A → B 落一条 member 消息，并且只唤醒 B', async () => {
    const [a, b] = newPair();

    const result = await team.sendDirectMessage({
      fromMemberId: a.id,
      toMemberId: b.id,
      content: '帮我看一下这个方案的风险',
    });

    assert.equal(result.message.senderType, 'member');
    assert.equal(result.message.senderId, a.id);
    assert.equal(result.message.targetMemberId, b.id);
    assert.equal(result.peer.id, b.id);

    assert.equal(result.wakes.length, 1);
    assert.equal(result.wakes[0].memberId, b.id);
    // 显式收件人 → reason 是 direct（等价一次点名），不是 open_discussion
    assert.equal(result.wakes[0].reason, 'direct');

    const executionId = executionIdForWake(db, result.conversation.id, result.wakes[0]);
    await waitForStatus(executionId, 'completed');
    await waitForConversationIdle(result.conversation.id);

    // B 的回复也落在同一个房间
    const messages = team.listMessages(result.conversation.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].senderType, 'member');
    assert.equal(messages[1].senderId, b.id);
  });

  it('B 的回复不再唤醒 A —— 私聊不会自己一直对谈下去', async () => {
    const [a, b] = newPair();

    const opened = await team.sendDirectMessage({
      fromMemberId: a.id,
      toMemberId: b.id,
      content: '你怎么看？',
    });
    const executionId = executionIdForWake(db, opened.conversation.id, opened.wakes[0]);
    await waitForStatus(executionId, 'completed');
    await waitForConversationIdle(opened.conversation.id);

    // 关键断言：房间里始终只有「B 那一轮」，B 发言之后没有连锁唤醒 A。
    // 少了这道闸，两个 Member 会一直互相回复到把 token 烧完。
    assert.deepEqual(executionIds(opened.conversation.id), [executionId]);
    assert.equal(stub.turns.filter((turn) => turn.memberId === a.id).length, 0);
  });

});

describe('私聊是 Member 之间的对话，用户只能旁观', () => {
  it('用户不能以 user 身份在私聊房间里发言', async () => {
    const [a, b] = newPair();
    const dm = team.openDirectMessage(a.id, b.id);

    await assert.rejects(
      () => team.sendMessage({ conversationId: dm.id, content: '我插一句' }),
      /Member 之间的私聊/,
    );

    assert.equal(team.listMessages(dm.id).length, 0, '被拒绝的消息不该落库');
  });
});
