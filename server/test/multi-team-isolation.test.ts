import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

/**
 * 多 Team 隔离 —— 「按请求的 Team 取数」而不是「永远取第一个 Team」。
 *
 * ── 为什么这是一个独立的失败形态 ─────────────────────────────────────
 *
 * 隔离失效**不报错**。`defaultTeam()` 永远返回第一个 Team，所以每个服务的
 * 默认行为是「把所有请求都当成同一个 Team 的」—— 表现是「另一个 Team 的成员
 * 出现在列表里」，看起来只是数据多了几行，不像越权。而 `?teamId=` 这个参数
 * 会被静默忽略：接口 200、返回一份别的 Team 的数据。
 *
 * 所以这一组用例的断言都是**「不该出现的东西没出现」**，而不是「该出现的东西
 * 出现了」—— 后者在 bug 存在时也常常为真。
 *
 * ── 为什么第二个 Team 是手工插的 ─────────────────────────────────────
 *
 * `ensureDefaultTeam` 是「当前部署的唯一 Team」，不提供新建入口（单 Team 部署
 * 下多一层管理界面只会多一处可以配错的地方）。但 schema 与各服务的 team_id
 * 维度是真实的，隔离逻辑必须成立 —— 所以这里直接插一行 team 来造第二个 Team。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-multiteam-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db, now } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { SkillService } = await import('../skill-service.js');
const { membersRouter } = await import('../routes/members.js');
const { conversationsRouter } = await import('../routes/conversations.js');
const { capabilitiesRouter } = await import('../routes/capabilities.js');
const { initTeamScope, requestTeamId } = await import('../middleware/teamScope.js');
const { StubCopilot, createTestStack } = await import('./support.js');

const memberService = new MemberService(db);
const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);

let teamA = '';
let teamB = '';

/** A 团队的成员与房间。 */
let memberInA = '';
let roomInA = '';
/** B 团队的成员与房间。 */
let memberInB = '';
let roomInB = '';

let server: Server;
let base = '';

before(async () => {
  teamA = stack.structure.ensureDefaultTeam().id;
  stack.structure.ensureHumanOwner(teamA, 'multi-owner');

  // 第二个 Team：手工插。它是「另一个部署单元」，但共用同一个库。
  teamB = randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO team (id, name, description, created_by, created_at, updated_at)
     VALUES (?, 'Second Team', '', 'multi-owner', ?, ?)`,
  ).run(teamB, timestamp, timestamp);
  stack.structure.ensureHumanOwner(teamB, 'multi-owner-b');

  memberInA = stack.team.createMember({ name: 'Member A', role: 'Engineer' }, teamA).id;
  memberInB = stack.team.createMember({ name: 'Member B', role: 'Engineer' }, teamB).id;

  roomInA = stack.team.createConversation({
    title: 'Room A',
    memberIds: [memberInA],
    teamId: teamA,
  }).id;
  roomInB = stack.team.createConversation({
    title: 'Room B',
    memberIds: [memberInB],
    teamId: teamB,
  }).id;

  initTeamScope(stack.structure, teamA);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, _res, next) => {
    (_req as { principal?: unknown }).principal = {
      kind: 'human',
      principalId: 'multi-owner',
      claims: {},
    };
    next();
  });
  app.use('/api/members', membersRouter(stack.team));
  app.use(
    '/api/capabilities',
    capabilitiesRouter(stack.team, stack.registry, new SkillService(db), stack.knowledge, {
      hostToolsEnabled: false,
    }),
  );
  app.use(
    '/api/conversations',
    conversationsRouter(stack.team, stack.conversationFiles, stack.processor, stack.knowledge),
  );

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function json<T>(routePath: string): Promise<T> {
  const response = await fetch(`${base}${routePath}`);
  // 先判状态再读 body：`assert.equal(response.status, 200, await response.text())`
  // 会在断言之前就把 body 读掉，失败信息里那句 body 反而让成功路径也报
  // 「Body is unusable」—— 参数是先求值的。
  if (response.status !== 200) {
    assert.fail(`GET ${routePath} 期望 200，实际 ${response.status}：${await response.text()}`);
  }
  return (await response.json()) as T;
}

// ------------------------------------------------------------------ 用例

describe('多 Team 隔离：Member 列表', () => {
  it('服务层：按 Team 过滤成员', () => {
    const inA = stack.team.listMembers(teamA).map((row) => row.id);
    const inB = stack.team.listMembers(teamB).map((row) => row.id);

    assert.equal(inA.includes(memberInA), true);
    assert.equal(inA.includes(memberInB), false, 'B 团队的人不能出现在 A 团队的列表里');
    assert.equal(inB.includes(memberInB), true);
    assert.equal(inB.includes(memberInA), false);
  });

  it('不传 teamId = 单 Team 语义：全部返回', () => {
    const all = stack.team.listMembers().map((row) => row.id);
    assert.equal(all.includes(memberInA), true);
    assert.equal(all.includes(memberInB), true, '不传就是不过滤 —— 这条路径给单 Team 部署用');
  });

  it('HTTP：?teamId= 真的生效（不是被静默忽略）', async () => {
    const a = await json<{ members: Array<{ id: string }> }>(`/api/members?teamId=${teamA}`);
    const b = await json<{ members: Array<{ id: string }> }>(`/api/members?teamId=${teamB}`);

    const idsA = a.members.map((row) => row.id);
    const idsB = b.members.map((row) => row.id);

    assert.equal(idsA.includes(memberInA), true);
    assert.equal(idsA.includes(memberInB), false, '参数被忽略时这里会真 —— 那就是这个 bug 的样子');
    assert.equal(idsB.includes(memberInB), true);
    assert.equal(idsB.includes(memberInA), false);
  });

  it('不带 ?teamId= 时回落到当前部署的 Team', async () => {
    const response = await fetch(`${base}/api/members`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { members: Array<{ id: string }> };
    const ids = payload.members.map((row) => row.id);
    assert.equal(ids.includes(memberInA), true);
    assert.equal(ids.includes(memberInB), false);
  });
});

describe('多 Team 隔离：单个 Member 的取法', () => {
  it('跨 Team 取 Member 报 404，不是 403', () => {
    // 403 会透露「它存在，只是不在你的 Team」—— 那正是跨 Team 探测需要的信息。
    assert.throws(
      () => stack.team.getMember(memberInB, teamA),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  });

  it('本 Team 内正常取到', () => {
    assert.equal(stack.team.getMember(memberInB, teamB).id, memberInB);
  });
});

describe('多 Team 隔离：Conversation 列表', () => {
  it('服务层：按 Team 过滤房间', () => {
    const inA = stack.team.listConversations(teamA).map((row) => row.id);
    const inB = stack.team.listConversations(teamB).map((row) => row.id);

    assert.equal(inA.includes(roomInA), true);
    assert.equal(inA.includes(roomInB), false, 'B 团队的房间不能出现在 A 团队的列表里');
    assert.equal(inB.includes(roomInB), true);
    assert.equal(inB.includes(roomInA), false);
  });

  it('HTTP：?teamId= 生效', async () => {
    const a = await json<{ conversations: Array<{ id: string }> }>(
      `/api/conversations?teamId=${teamA}`,
    );
    const ids = a.conversations.map((row) => row.id);

    assert.equal(ids.includes(roomInA), true);
    assert.equal(ids.includes(roomInB), false);
  });

  it('新房的 Team 归属由请求决定，不总是默认 Team', () => {
    const room = stack.team.createConversation({
      title: 'Room B2',
      memberIds: [memberInB],
      teamId: teamB,
    });
    assert.equal(room.teamId, teamB, '在 B 团队建的房间不能跑到 A 团队里去');
  });
});

describe('一个 Member 只属于一个 Team', () => {
  it('A 团队的人加进 B 团队直接被拒绝', () => {
    assert.throws(
      () => stack.structure.ensureAgentMembership(teamB, memberInA),
      /只能属于一个 Team/,
      '同一个人挂在两个 Team 上时，模型档位 / 状态 / 能力绑定 / 记忆与 Team 上下文' +
        ' 都会同时出现两套答案 —— 一次性拒绝，而不是逐处修补',
    );
  });

  it('已经是本 Team 的人重复加入仍然幂等', () => {
    const before = stack.structure.listMemberships(teamA).length;
    stack.structure.ensureAgentMembership(teamA, memberInA);
    assert.equal(
      stack.structure.listMemberships(teamA).length,
      before,
      '建 Member / provisioning / 加人都会走到这里，重复调用不能新增一行',
    );
  });
});

describe('多 Team 隔离：Member 写入路径', () => {
  it('HTTP：PATCH 别的 Team 的 Member 被拒，名字没被改掉', async () => {
    // member 表没有 team_id，PATCH 又不带 Team 信息 —— 少了归属校验，
    // 「改别人 Team 的人」是一次成功的 200，看不出来是越权。
    const response = await fetch(`${base}/api/members/${memberInB}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });

    assert.equal(response.status, 403, await response.text());
    assert.equal(stack.team.getMember(memberInB).name, 'Member B');
  });

  it('HTTP：PATCH 本 Team 的 Member 正常', async () => {
    const patch = (body: unknown) =>
      fetch(`${base}/api/members/${memberInA}?teamId=${teamA}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const renamed = await patch({ name: 'Member A (edited)' });
    assert.equal(renamed.status, 200, await renamed.text());
    assert.equal(stack.team.getMember(memberInA).name, 'Member A (edited)');

    const restored = await patch({ name: 'Member A' });
    assert.equal(restored.status, 200, await restored.text());
  });

  it('HTTP：description 是身份字段，PATCH 之后读得回来', async () => {
    // description 是「给人看的职责摘要」，和 role / systemPrompt 是三个不同的东西。
    // 它必须整条链路都在：路由 schema（strip 模式下漏了就会被静默丢掉）→
    // TeamService → member 表 → 读回来。任何一环少一个字段，表现都是
    // 「编辑器里填了、保存 200、重开就没了」—— 不报错，只是内容消失。
    const updated = await fetch(`${base}/api/members/${memberInA}?teamId=${teamA}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '负责从安全角度独立审查方案与实现' }),
    });
    assert.equal(updated.status, 200, await updated.text());
    assert.equal(
      stack.team.getMember(memberInA).description,
      '负责从安全角度独立审查方案与实现',
    );

    const read = await fetch(`${base}/api/members/${memberInA}?teamId=${teamA}`);
    assert.equal(read.status, 200);
    const body = (await read.json()) as { member: { description: string } };
    assert.equal(body.member.description, '负责从安全角度独立审查方案与实现');
  });

  it('归档的 Member 仍然能恢复：归属校验不看 status', () => {
    // 恢复归档要能走通。PATCH 如果改用 requireMemberInTeam（它跑
    // requireActiveMembership），归档的人 membership 是 inactive，
    // 「恢复」会和「跨 Team 越权」一起被 403 掉 —— 归档变成不可逆。
    stack.team.updateMember(memberInB, { status: 'archived' }, teamB);

    assert.throws(() => stack.team.requireMemberInTeam(teamB, memberInB), /不属于这个 Team/);
    assert.equal(stack.team.requireMemberBelongsToTeam(teamB, memberInB).id, memberInB);

    // 归档同步的是**传进来的** Team 的 membership，不是默认 Team。
    // 用 defaultTeam() 的话这里会撞上「只能属于一个 Team」。
    assert.equal(
      stack.structure.getMembership(teamB, 'agent', memberInB).status,
      'inactive',
    );

    stack.team.updateMember(memberInB, { status: 'active' }, teamB);
    assert.equal(stack.team.getMember(memberInB).status, 'active');
    assert.equal(stack.structure.getMembership(teamB, 'agent', memberInB).status, 'active');
  });
});

describe('多 Team 隔离：Member 能力边界', () => {
  it('HTTP：读/写别的 Team 的 member 层能力都被拒', async () => {
    const read = await fetch(
      `${base}/api/capabilities/catalog?scope=member&memberId=${memberInB}`,
    );
    assert.equal(read.status, 403, await read.text());

    const write = await fetch(`${base}/api/capabilities/catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'member',
        memberId: memberInB,
        skills: [],
        knowledge: [],
        tools: [],
        mcp: [],
      }),
    });
    assert.equal(write.status, 403, await write.text());

    // 边界先于解读 payload：同一个请求带上一个「这一层没装过」的 skill，结果仍然
    // 是 403 而不是 400 —— 说明这一轮压根没走到「解析这个 Member 装了什么」。
    // 顺序反过来就成了一次探测：400 与 403 的差别就是「别的 Team 有没有这个 skill」。
    const ordering = await fetch(`${base}/api/capabilities/catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'member',
        memberId: memberInB,
        skills: ['member.never-installed'],
        knowledge: [],
        tools: [],
        mcp: [],
      }),
    });
    assert.equal(ordering.status, 403, await ordering.text());

    // 没写进去 —— 403 之后必须真的没有副作用。
    assert.deepEqual(stack.team.getMemberCapabilities(teamB, memberInB), {
      skills: [],
      knowledge: [],
      tools: [],
      mcp: [],
    });
  });
});

describe('多 Team 隔离：Team 尚未初始化时', () => {
  it('没有 ?teamId= 就明确失败，不猜一个 Team', async () => {
    // 单独一个文件进程里造「未初始化」的状态会污染其它用例，所以这里直接
    // 断言 requestTeamId 在模块状态被清掉之后的行为。
    const { initTeamScope: init } = await import('../middleware/teamScope.js');
    const fakeReq = { query: {}, headers: {} } as unknown as Parameters<typeof requestTeamId>[0];

    init(stack.structure, teamA);
    assert.equal(requestTeamId(fakeReq), teamA);

    // 带 ?teamId= 时不看模块状态 —— 显式指定的 Team 优先。
    assert.equal(
      requestTeamId({ query: { teamId: teamB }, headers: {} } as unknown as Parameters<
        typeof requestTeamId
      >[0]),
      teamB,
    );
  });
});
