import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Member } from '../domain.js';

/**
 * `/api/conversations` 的 HTTP 边界。
 *
 * 这一层要证明的不是业务逻辑（那些在 team-chat.test.ts 里按房间行为断言），
 * 而是**边界本身有没有把字段吃掉**。zod 默认会剥掉 schema 没声明的键，所以
 * 「调用方传了、服务端当没看见」不会报任何错 —— 它是静默的。
 *
 * 真实踩过一次：Pivot B 把 `conversation.jiraIssueKey` 换成 `externalWorkRef`，
 * 前端跟着改了，而 createConversationSchema 没跟着改。表现是「用 Jira 工单开
 * 的会话，引用是 null」，接口 201、日志干净、没有任何地方报错。
 *
 * 所以这里必须走**真实 express + 真实 fetch**：直接调 TeamService 证明不了
 * 边界，因为那样 schema 根本不参与。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-convapi-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { conversationsRouter } = await import('../routes/conversations.js');
const { StubCopilot, createTestStack } = await import('./support.js');

const memberService = new MemberService(db);
const stub = new StubCopilot();
const stack = createTestStack(db, memberService, stub.asCopilot);

let alice: Member;
let bob: Member;
let server: Server;
let base: string;

before(async () => {
  alice = stack.team.createMember({ name: 'ConvApiA', role: 'A' });
  bob = stack.team.createMember({ name: 'ConvApiB', role: 'B' });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/conversations', conversationsRouter(stack.team));
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function post(body: unknown) {
  return fetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchState(conversationId: string, memberId: string, body: unknown) {
  return fetch(
    `${base}/api/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(memberId)}/state`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

async function makeGroup(title: string): Promise<string> {
  const response = await post({ kind: 'group', title, memberIds: [alice.id, bob.id] });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { conversation: { id: string } };
  return body.conversation.id;
}

describe('POST /conversations：externalWorkRef 必须穿过边界', () => {
  it('带引用的会话拿得到引用（schema 漏声明会让它静默变成 null）', async () => {
    const response = await post({
      kind: 'work',
      title: 'ABC-900',
      memberIds: [alice.id],
      externalWorkRef: { provider: 'jira', key: ' ABC-900 ', externalId: '100900' },
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      conversation: { externalWorkRef: { provider: string; key: string; externalId: string } | null };
    };

    assert.ok(body.conversation.externalWorkRef, '引用被 schema 吃掉了');
    assert.equal(body.conversation.externalWorkRef.key, 'ABC-900', '前后空格要去掉');
    assert.equal(body.conversation.externalWorkRef.provider, 'jira');
    assert.equal(body.conversation.externalWorkRef.externalId, '100900');
  });

  it('空 key 的引用 = 没有引用（不炸，也不造一条指向空工单的记录）', async () => {
    const response = await post({
      kind: 'work',
      title: 'ABC-901',
      memberIds: [alice.id],
      externalWorkRef: { provider: 'jira', key: '   ' },
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { conversation: { externalWorkRef: unknown } };
    assert.equal(body.conversation.externalWorkRef, null);
  });

  it('不支持的外部系统回 400，而不是 500', async () => {
    const response = await post({
      kind: 'work',
      title: 'ABC-902',
      memberIds: [alice.id],
      externalWorkRef: { provider: 'github', key: 'X-1' },
    });
    // 客户端输入错误不该表现成服务端故障 —— 那会把排查方向带偏
    assert.equal(response.status, 400);
  });
});

describe('PATCH /members/:memberId/state：muted', () => {
  it('静音 / 解除静音回 200，状态落库', async () => {
    const conversationId = await makeGroup('Mute Api Room');
    const muted = await patchState(conversationId, alice.id, { muted: true });
    assert.equal(muted.status, 200);
    assert.equal(((await muted.json()) as { state: { muted: boolean } }).state.muted, true);

    const states = stack.team.listConversationState(conversationId);
    assert.equal(states.find((state) => state.memberId === alice.id)?.muted, true);

    const unmuted = await patchState(conversationId, alice.id, { muted: false });
    assert.equal(unmuted.status, 200);
    assert.equal(((await unmuted.json()) as { state: { muted: boolean } }).state.muted, false);
  });

  it('空 patch 回 400，而不是「什么都不改但回 200」', async () => {
    const conversationId = await makeGroup('Empty Patch Room');
    const response = await patchState(conversationId, alice.id, {});
    // 静默 no-op 是最难查的一类「接口没问题但没生效」
    assert.equal(response.status, 400);
  });

  it('不属于这个房间的成员回 400', async () => {
    const conversationId = await makeGroup('Stranger Room');
    const stranger = stack.team.createMember({ name: 'Stranger', role: 'X' });
    const response = await patchState(conversationId, stranger.id, { muted: true });
    assert.equal(response.status, 400);
  });
});

describe('GET /events：客户端看到的东西里没有哨兵', () => {
  interface SseFrame {
    event: string;
    data: Record<string, unknown>;
  }

  /**
   * 把 SSE 字节流还原成客户端收到的事件序列。
   *
   * **必须解析，不能在原始 body 上找字符串。** `message.delta` 是逐字符的，
   * 每个字符各自包在一帧 `data: {...}` 里，所以 `<NO_REPLY>` 这十个字符在原始
   * 字节流里**从来不会连续出现** —— `body.includes('NO_REPLY')` 永远为 false，
   * **包括哨兵真的漏出去的时候**。第一版就是这么写的，变异验证发现它是空绿。
   */
  function parseSse(body: string): SseFrame[] {
    const frames: SseFrame[] = [];
    for (const block of body.split('\n\n')) {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '));
      const data = lines.find((line) => line.startsWith('data: '));
      if (!event || !data) continue; // `retry:` 与 `: ping` 没有这两个字段
      frames.push({
        event: event.slice('event: '.length),
        data: JSON.parse(data.slice('data: '.length)) as Record<string, unknown>,
      });
    }
    return frames;
  }

  /** 客户端把 delta 拼起来之后看到的那段文字。 */
  function streamedText(body: string): string {
    return parseSse(body)
      .filter((frame) => frame.event === 'message.delta')
      .map((frame) => String(frame.data.delta))
      .join('');
  }

  function completedCount(body: string): number {
    return parseSse(body).filter(
      (frame) => frame.event === 'execution.updated' && frame.data.status === 'completed',
    ).length;
  }

  /**
   * 等到第 n 条终态事件真的到达客户端。
   *
   * 不能只等 DB 收口：delta 与终态事件是两条路径，DB 收口不代表字节已经到客户端。
   * 终态事件排在它那一轮所有 delta **之后**，所以读到它就说明前面的字节都读过了 ——
   * 这是「没看到哨兵」与「还没读到」的唯一区分办法。
   */
  async function waitForCompleted(read: () => string, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (completedCount(read()) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`没等到第 ${expected} 条终态事件，这条流是死的`);
  }

  it('哨兵整条被扣住（客户端一个字都收不到），而正常回复仍然逐字到达', async () => {
    const created = await post({ kind: 'direct', title: 'SSE Room', memberIds: [alice.id] });
    assert.equal(created.status, 201);
    const { conversation } = (await created.json()) as { conversation: { id: string } };

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/conversations/${conversation.id}/events`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);

    let body = '';
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
      } catch {
        // abort 关掉连接时的正常退出
      }
    })();

    const send = (content: string) =>
      fetch(`${base}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

    // 真实引擎逐字吐；不打开这个开关，过滤路径根本没被走到
    stub.streamDeltas = true;

    try {
      // 第一轮：这个 Member 判断自己没什么可补的
      stub.mode = 'skip';
      assert.equal((await send('你还有补充吗')).status, 202);
      await waitForCompleted(() => body, 1);
      assert.equal(
        streamedText(body),
        '',
        `哨兵漏到客户端了 —— 用户会先看到它再看着它消失：${JSON.stringify(streamedText(body))}`,
      );

      // 第二轮：同一个 Member 这次开口。它证明这条流是活的 ——
      // 上面那个空字符串是「被扣住了」，不是「流断了」。
      stub.mode = 'reply';
      assert.equal((await send('那你现在说点什么')).status, 202);
      await waitForCompleted(() => body, 2);
      assert.equal(streamedText(body), 'reply from ConvApiA', '正常回复必须逐字到达客户端');
    } finally {
      stub.mode = 'reply';
      stub.streamDeltas = false;
      controller.abort();
      await pump;
    }
  });
});
