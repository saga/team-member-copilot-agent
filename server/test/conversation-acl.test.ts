import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

/**
 * Conversation 的 human ACL —— 「谁能进这间房」。
 *
 * ── 为什么必须是两道闸 ───────────────────────────────────────────────
 *
 * 只做「是这个 Team 的成员」曾经是够的：单机单用户时「Team 成员」和「这间房
 * 的人」是同一批人。多用户之后它们分开了 —— 同一个 Team 的两个 human 各自在
 * 不同房间里工作，而 message / execution / task / file 是**房间里的东西**
 * （prompt、工具调用、文件引用全在里面）。少了第二道，任何 Team 成员都能按 id
 * 遍历别人的房间，而这件事从界面上完全看不出来，因为 UI 只列出自己的房间。
 *
 * ── 这张表为什么是新的而不是复用 conversation_member ─────────────────
 *
 * `conversation_member.member_id` 有外键指向 `member(id)` —— human 根本进不去。
 * 而且两者回答的是不同的问题：前者是「哪些 Agent 是成员」（决定唤醒与上下文
 * 派发），后者是「哪些 human 可以访问」（决定 ACL）。合并会让「被唤醒但读不到
 * 房间」或者反过来成为可能。
 *
 * ── 为什么 owner/admin 保留兜底 ──────────────────────────────────────
 *
 * 收紧到「只认 participant」会让现有 owner 立刻看不见已有房间（这张表是新加的，
 * 历史房间没有回填）。那是**迁移问题**，不是权限问题。而 owner/admin 本来就能
 * 改 capability boundary，让他们多看几间房不构成实质性的权限提升 —— 越权面从
 * 「全体 Team 成员」缩到「owner/admin」，这才是这次收紧真正关掉的东西。
 *
 * ── 为什么用真实 express + 真实 fetch ────────────────────────────────
 *
 * 直接调 `canAccessConversation` 证明不了 403 / 404 的分野，而那正是调用方唯一
 * 看得见的东西：把「房间不存在」误报成 403 会让人去查权限配置，而真正的问题是
 * id 拼错了。这一组里专门有一条钉它。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-acl-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { conversationsRouter } = await import('../routes/conversations.js');
const { initTeamScope } = await import('../middleware/teamScope.js');
const { StubCopilot, createTestStack } = await import('./support.js');

const memberService = new MemberService(db);
const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);

const OWNER = 'acl-owner';
const OUTSIDER = 'acl-outsider';
const CREATOR = 'acl-creator';

let teamId = '';
let server: Server;
let base = '';

/** 当前请求以谁的身份发出 —— 生产由 requireHumanAuth 写，这里手动切。 */
let actingPrincipal = CREATOR;

before(async () => {
  const member = stack.team.createMember({ name: 'AclMember', role: 'Engineer' });

  const defaultTeam = stack.structure.ensureDefaultTeam();
  teamId = defaultTeam.id;
  stack.structure.ensureHumanOwner(teamId, OWNER);
  // 两个普通成员：有 Team 身份，但没有 owner/admin 角色。
  stack.structure.ensureHumanOwner(teamId, OUTSIDER);
  stack.structure.updateMembership(teamId, 'human', OUTSIDER, { role: 'member' });
  stack.structure.ensureHumanOwner(teamId, CREATOR);
  stack.structure.updateMembership(teamId, 'human', CREATOR, { role: 'member' });

  initTeamScope(stack.structure, teamId);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, _res, next) => {
    (_req as { principal?: unknown }).principal = {
      kind: 'human',
      principalId: actingPrincipal,
      claims: {},
    };
    next();
  });
  app.use(
    '/api/conversations',
    conversationsRouter(stack.team, stack.conversationFiles, stack.processor, stack.knowledge),
  );

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 建一间房（创建者是 CREATOR），后面的用例都以它为对象。
  actingPrincipal = CREATOR;
  const created = await post('/', { title: 'ACL room', memberIds: [member.id] });
  assert.equal(created.status, 201, await created.text());
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 工具

function post(routePath: string, body: unknown) {
  return fetch(`${base}/api/conversations${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 以某个身份发一次请求，跑完自动恢复成 CREATOR。 */
async function as<T>(principalId: string, fn: () => Promise<T>): Promise<T> {
  const previous = actingPrincipal;
  actingPrincipal = principalId;
  try {
    return await fn();
  } finally {
    actingPrincipal = previous;
  }
}

async function roomIds(): Promise<string[]> {
  const response = await fetch(`${base}/api/conversations`);
  const payload = (await response.json()) as { conversations: Array<{ id: string }> };
  return payload.conversations.map((row) => row.id);
}

let roomId = '';

// ------------------------------------------------------------------ 用例

describe('Conversation ACL：participant 决定 human 能不能进', () => {
  before(async () => {
    roomId = (await roomIds())[0];
    assert.ok(roomId, 'before() 里建的那间房必须能列出来');
  });

  it('创建者自动成为 participant', () => {
    const participants = stack.team.listConversationParticipants(roomId);
    const creator = participants.find((row) => row.principalId === CREATOR);
    assert.ok(creator, '建房的人必须进得来 —— 否则他建完就看不见自己的房间');
    assert.equal(creator.principalType, 'human');
  });

  it('创建者能读到自己的房间', async () => {
    const response = await as(CREATOR, () => fetch(`${base}/api/conversations/${roomId}`));
    assert.equal(response.status, 200);
  });

  it('同 Team 的普通成员（不是 participant）被挡在 403', async () => {
    const response = await as(OUTSIDER, () => fetch(`${base}/api/conversations/${roomId}`));
    assert.equal(
      response.status,
      403,
      'Team 成员身份只回答「你是这个 Team 的人」，不回答「你能不能看这间房」',
    );
  });

  it('owner 不是 participant 也能读（Team 级兜底）', async () => {
    const participants = stack.team.listConversationParticipants(roomId);
    assert.equal(
      participants.some((row) => row.principalId === OWNER),
      false,
      'owner 本来就不在这间房的名单里，这条用例才有意义',
    );

    const response = await as(OWNER, () => fetch(`${base}/api/conversations/${roomId}`));
    assert.equal(response.status, 200);
  });

  it('加进 participant 之后就能读，移除之后立刻不能读', async () => {
    stack.team.addConversationParticipant({
      conversationId: roomId,
      principalType: 'human',
      principalId: OUTSIDER,
      addedBy: OWNER,
    });

    const granted = await as(OUTSIDER, () => fetch(`${base}/api/conversations/${roomId}`));
    assert.equal(granted.status, 200);

    stack.team.removeConversationParticipant(roomId, 'human', OUTSIDER);

    const revoked = await as(OUTSIDER, () => fetch(`${base}/api/conversations/${roomId}`));
    assert.equal(revoked.status, 403, '移除必须立刻生效，不能靠缓存过期');
  });

  it('不存在的房间回 404，不是 403', async () => {
    // 「房间不存在」和「存在但你没权限」对调用方是两件不同的事：
    // 后者会让人去查权限配置，而真正的问题是 id 拼错了。
    const response = await as(OWNER, () =>
      fetch(`${base}/api/conversations/no-such-room`),
    );
    assert.equal(response.status, 404);
  });

  it('participant 列表只包含真实存在的人，且不重复', async () => {
    stack.team.addConversationParticipant({
      conversationId: roomId,
      principalType: 'human',
      principalId: OUTSIDER,
      addedBy: OWNER,
    });
    // 再加一次：ON CONFLICT DO NOTHING，不该攒出第二行。
    stack.team.addConversationParticipant({
      conversationId: roomId,
      principalType: 'human',
      principalId: OUTSIDER,
      addedBy: OWNER,
    });

    const participants = stack.team.listConversationParticipants(roomId);
    assert.equal(
      participants.filter((row) => row.principalId === OUTSIDER).length,
      1,
      '重复添加不能变成两条 —— 移除时删一条会留下另一条，权限看起来「删不掉」',
    );

    stack.team.removeConversationParticipant(roomId, 'human', OUTSIDER);
  });

  it('给不存在的房间加 participant 回 404', () => {
    assert.throws(
      () =>
        stack.team.addConversationParticipant({
          conversationId: 'no-such-room',
          principalType: 'human',
          principalId: OUTSIDER,
          addedBy: OWNER,
        }),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  });

  it('agent 的判定仍然只看 conversation_member（唤醒与上下文是同一份名单）', () => {
    // agent 不看 participant：给它再加一层只会让「被唤醒但读不到房间」
    // 这种状态成为可能。
    const conversation = stack.team.getConversation(roomId);
    const agentIds = conversation.members.map((row) => row.id);
    const agentParticipants = stack.team
      .listConversationParticipants(roomId)
      .filter((row) => row.principalType === 'agent')
      .map((row) => row.principalId);

    assert.equal(agentParticipants.length, 0, 'participant 表是给 human 用的');
    assert.equal(agentIds.length > 0, true, 'Agent 成员关系在 conversation_member 上');
  });
});
