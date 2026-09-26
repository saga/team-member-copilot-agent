import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopilotService } from '../copilot.js';

/**
 * 业务控制测试。这里刻意不碰真实的 Copilot runtime：
 * 用临时 DATA_DIR + stub Copilot，验证 Member / Conversation / Execution /
 * delegation 这四层关系是否真的成立。
 *
 * 重点不是 AI 行为，而是 delegation 的「业务正确性」：
 *   A → B            OK
 *   A → B → C        OK
 *   A → B → A        reject（cycle）
 *   A → B → C → D → E reject（depth）
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-test-'));
// 必须在 import config.ts 之前设好，否则 db 会落到仓库的 .data/
process.env.DATA_DIR = dataDir;
process.env.MAX_DELEGATION_DEPTH = '4';
process.env.COPILOT_WARMUP = 'false';

const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { singleExecutionId, muteAllMembers, createTestStack } = await import('./support.js');

interface RunTurnInput {
  runtime: { id: string; copilotSessionId: string; workspacePath: string };
  member: { id: string };
  prompt: string;
}

class StubCopilot {
  readonly turns: RunTurnInput[] = [];
  /** 挂住 turn，把一个 execution 稳定地钉在 running 上。 */
  hold: Promise<void> | null = null;

  async runMemberTurn(input: RunTurnInput): Promise<string> {
    this.turns.push(input);
    if (this.hold) await this.hold;
    return `stub reply from ${input.member.id}`;
  }
}

interface ExecutionRow {
  id: string;
  conversation_id: string;
  member_id: string;
  runtime_id: string | null;
  parent_execution_id: string | null;
  delegation_path: string;
  kind: string;
  status: string;
  response: string | null;
  error: string | null;
}

interface RuntimeRow {
  id: string;
  conversation_id: string;
  member_id: string;
  copilot_session_id: string;
  workspace_path: string;
  status: string;
  last_context_message_sequence: number;
}

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub as unknown as CopilotService);

const sendRaw = team.sendMessage.bind(team);

/**
 * `POST /messages` 返回的是 `wakes[]`（group 房间一条消息可以唤醒多个 Member），
 * 不再有单个 executionId。这个文件里的用例都是「一个收件人」的场景，
 * 包一层把那条 execution 找回来，断言本身不用改。
 */
async function sendMessage(input: {
  conversationId: string;
  content: string;
  targetMemberId?: string;
  replyToMessageId?: string;
}) {
  const result = await sendRaw(input);
  return { ...result, executionId: singleExecutionId(db, input.conversationId, result.wakes) };
}

function executionRow(id: string): ExecutionRow {
  const row = db.prepare(`SELECT * FROM execution WHERE id = ?`).get(id) as unknown as
    | ExecutionRow
    | undefined;
  assert.ok(row, `execution ${id} 不存在`);
  return row;
}

function runtimeRow(conversationId: string, memberId: string): RuntimeRow | undefined {
  return db
    .prepare(
      `SELECT * FROM member_runtime WHERE conversation_id = ? AND member_id = ?`,
    )
    .get(conversationId, memberId) as unknown as RuntimeRow | undefined;
}

async function waitForStatus(id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (executionRow(id).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`execution ${id} 未在预期时间内变成 ${status}（当前 ${executionRow(id).status}）`);
}

/** 等到该 conversation 没有 queued / running / waiting_for_member 的 execution，避免断言时还有异步写入。 */
async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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

let researcher: { id: string; name: string };
let coder: { id: string; name: string };
let reviewer: { id: string; name: string };
let analyst: { id: string; name: string };
let archivist: { id: string; name: string };
let teamConversationId: string;

before(() => {
  researcher = team.createMember({ name: 'Researcher', role: 'Research Analyst' });
  // 「这个人能碰宿主机」现在是一条能力绑定，不再是 createMember 上的一个字段
  // —— 默认能力刻意不含宿主工具，要的话得显式绑。这些用例不考工具能力，
  // 所以它就只是个名字像工程师的普通 Member。
  coder = team.createMember({ name: 'Coder', role: 'Software Engineer' });
  reviewer = team.createMember({ name: 'Reviewer', role: 'Reviewer' });
  analyst = team.createMember({ name: 'Analyst', role: 'Data Analyst' });
  archivist = team.createMember({ name: 'Archivist', role: 'Knowledge Manager' });

  const conversation = team.createConversation({
    kind: 'group',
    title: 'Investment Review Team',
    memberIds: [researcher.id, coder.id, reviewer.id, analyst.id, archivist.id],
  });
  // 这个 group 是给 delegation / 审计链用例当「同一个房间里的多个 Member」用的。
  // 静音全体：这些用例每一轮都显式点名，不需要 open_discussion 广播把 5 个人
  // 同时唤醒。共享讨论本身由 team-chat.test.ts 覆盖。
  muteAllMembers(team, conversation.id);
  teamConversationId = conversation.id;
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Member 是跨 conversation 的长期身份', () => {
  it('member home 落在 .data/members/<id> 下，与 conversation 无关', () => {
    const home = memberService.homePath(researcher.id);
    assert.equal(home, path.join(config.memberHomeRoot, researcher.id));
    assert.ok(fs.existsSync(path.join(home, 'SOUL.md')));
    assert.ok(fs.existsSync(path.join(home, 'memory', 'MEMORY.md')));
    assert.ok(fs.existsSync(path.join(home, 'skills')));
  });

  it('remember_member 默认写入这个 Team 的上下文，不进全局记忆', async () => {
    const result = await team.rememberMember({
      memberId: researcher.id,
      content: '这个 Team 的 review 输出要求先给 P0/P1 风险。',
    });
    assert.match(result, /Team/);
    const teamId = team.getConversation(teamConversationId).teamId;
    assert.match(memberService.readTeamMemory(researcher.id, teamId), /P0\/P1/);
    assert.ok(
      !memberService.readMemory(researcher.id).includes('P0/P1'),
      'Team 上下文不能漏进全局记忆',
    );
  });

  it('remember_member scope=global 才写入跨 Team 的长期记忆', async () => {
    const result = await team.rememberMember({
      memberId: researcher.id,
      content: '用户偏好先看风险再看收益。',
      scope: 'global',
    });
    assert.match(result, /长期记忆/);
    assert.match(memberService.readMemory(researcher.id), /先看风险再看收益/);
  });

  it('Team 上下文读写带版本校验，与全局记忆相互独立', () => {
    const teamId = team.getConversation(teamConversationId).teamId;
    const saved = team.replaceMemberTeamContext(
      researcher.id,
      '# Team Context\n\n这个 Team 更重视 architecture review。',
      teamId,
    );
    assert.match(saved.content, /architecture review/);
    const reloaded = team.getMemberTeamContext(researcher.id, teamId);
    assert.equal(reloaded.version, saved.version);
    assert.ok(!team.getMemberMemory(researcher.id).content.includes('architecture review'));
  });

  it('Member 视角能查到参与过的 conversation 与所属 Team', () => {
    const conversations = team.listMemberConversations(researcher.id);
    assert.ok(conversations.some((item) => item.id === teamConversationId));
    const teams = team.listMemberTeams(researcher.id);
    assert.equal(teams.length, 1);
    assert.equal(teams[0].id, team.getConversation(teamConversationId).teamId);
  });
});

describe('Conversation / Runtime 边界', () => {
  it('同一个 Member 在不同 Conversation 拥有不同 Runtime', async () => {
    const other = team.createConversation({
      kind: 'direct',
      memberIds: [researcher.id],
      defaultMemberId: researcher.id,
    });

    // Runtime 是懒创建的：先各跑一轮，runtime 才落库
    const inTeam = await sendMessage({
      conversationId: teamConversationId,
      content: '团队会话里的一轮',
      targetMemberId: researcher.id,
    });
    const inSolo = await sendMessage({
      conversationId: other.id,
      content: '单独会话里的一轮',
    });
    await waitForStatus(inTeam.executionId, 'completed');
    await waitForStatus(inSolo.executionId, 'completed');

    const runtimeA = runtimeRow(teamConversationId, researcher.id);
    const runtimeB = runtimeRow(other.id, researcher.id);

    assert.ok(runtimeA);
    assert.ok(runtimeB);
    assert.notEqual(runtimeA.id, runtimeB.id);
    assert.notEqual(runtimeA.copilot_session_id, runtimeB.copilot_session_id);
    assert.notEqual(runtimeA.workspace_path, runtimeB.workspace_path);
    assert.ok(fs.existsSync(path.join(runtimeB.workspace_path, 'AGENTS.md')));

    // Member identity 是跨 conversation 的：home 不随 conversation 变化
    assert.equal(
      memberService.homePath(researcher.id),
      path.join(config.memberHomeRoot, researcher.id),
    );
  });

  it('只有 group 允许增减成员，direct / work 的成员固定', () => {
    const solo = team.createConversation({
      kind: 'direct',
      memberIds: [coder.id],
      defaultMemberId: coder.id,
    });
    assert.throws(() => team.removeMember(solo.id, coder.id), /只有 group 允许增减成员/);
    assert.throws(() => team.addMember(solo.id, reviewer.id), /只有 group 允许增减成员/);

    const work = team.createConversation({
      kind: 'work',
      memberIds: [coder.id],
      defaultMemberId: coder.id,
    });
    assert.throws(() => team.addMember(work.id, reviewer.id), /只有 group 允许增减成员/);
  });

  it('kind 的形状约束在 Service 层强制（API 是公开的）', () => {
    // direct 允许 1~2 个 Member：1 个 = 用户 ↔ Member，2 个 = Member ↔ Member 私聊。
    // 3 个就不是 direct 了。
    assert.throws(
      () =>
        team.createConversation({
          kind: 'direct',
          memberIds: [coder.id, reviewer.id, analyst.id],
        }),
      /direct conversation 需要一个 Member/,
    );
    assert.equal(
      team.createConversation({ kind: 'direct', memberIds: [coder.id, reviewer.id] }).members.length,
      2,
      '两个 Member 的 direct = Member 私聊，必须允许',
    );
    assert.throws(
      () => team.createConversation({ kind: 'group', memberIds: [coder.id] }),
      /group conversation 至少需要两个 Member/,
    );
    assert.throws(
      () => team.createConversation({ kind: 'work', memberIds: [coder.id, reviewer.id] }),
      /work conversation 当前必须只有一个 Member/,
    );
  });

  it('defaultMemberId 只对 1:1 房间成立：越界报 400，group 直接拒绝', () => {
    // 1:1 房间：必须是 roster 里的人
    assert.throws(
      () =>
        team.createConversation({
          kind: 'direct',
          memberIds: [coder.id, reviewer.id],
          defaultMemberId: 'not-in-conversation',
        }),
      /defaultMemberId 必须属于 conversation member/,
    );

    // group：这个字段在这里没有语义，显式传了要报错而不是被默默忽略 ——
    // 静默忽略会让调用方以为自己设置成功了，然后把它当成默认收件人。
    assert.throws(
      () =>
        team.createConversation({
          kind: 'group',
          memberIds: [coder.id, reviewer.id],
          defaultMemberId: coder.id,
        }),
      /group conversation 不接受 defaultMemberId/,
    );

    const group = team.createConversation({
      kind: 'group',
      memberIds: [coder.id, reviewer.id],
    });
    assert.equal(group.defaultMemberId, null);
  });

  it('listMessages 返回最近 N 条且按时间正序', async () => {
    const conversation = team.createConversation({
      kind: 'direct',
      memberIds: [reviewer.id],
      defaultMemberId: reviewer.id,
    });

    let lastExecutionId = '';
    for (const text of ['first', 'second', 'third']) {
      const result = await sendMessage({ conversationId: conversation.id, content: text });
      lastExecutionId = result.executionId;
      // 必须等这一轮收尾再发下一条：scheduler 会把同一个 Member 上排队的
      // 唤醒合并成一轮，连着发会让后两条并进前一轮，拿不到各自的 execution。
      await waitForStatus(lastExecutionId, 'completed');
    }
    await waitForConversationIdle(conversation.id);

    const all = team.listMessages(conversation.id, 500);
    assert.ok(all.length > 2, '前置条件：消息数应大于 2');

    const recent = team.listMessages(conversation.id, 2);
    assert.equal(recent.length, 2);
    // 关键契约：取的是「尾部」而不是「头部」
    assert.deepEqual(
      recent.map((message) => message.id),
      all.slice(-2).map((message) => message.id),
    );
    assert.equal(recent[0].createdAt <= recent[1].createdAt, true, '必须按时间正序返回');
  });
});

describe('Member 生命周期边界', () => {
  /**
   * 把 `fn` 包在「引擎被按住」的窗口里执行。
   *
   * 归档 / 移出必须等手上的活收尾，所以断言前得先造出「真的有活在跑」这个状态，
   * 而不是靠 sleep 撞运气。
   */
  async function whileBusy(fn: () => Promise<void>): Promise<void> {
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await fn();
    } finally {
      release();
      stub.hold = null;
    }
  }

  it('还有 execution 在跑时不能归档，跑完就可以', async () => {
    const conversation = team.createConversation({ kind: 'direct', memberIds: [archivist.id] });

    await whileBusy(async () => {
      const { executionId } = await sendMessage({
        conversationId: conversation.id,
        content: '先别停',
      });
      await waitForStatus(executionId, 'running');

      assert.throws(
        () => team.updateMember(archivist.id, { status: 'archived' }),
        /不能归档/,
        '归档会把正在跑的 execution 悬空（消息在、execution 在、执行体却没了）',
      );
      // 归档被拒绝后 Member 仍然是可用的
      assert.equal(team.getMember(archivist.id).status, 'active');
    });

    await waitForConversationIdle(conversation.id);
    assert.equal(team.updateMember(archivist.id, { status: 'archived' }).status, 'archived');
    // 还原，后面的用例还要用它
    team.updateMember(archivist.id, { status: 'active' });
  });

  it('排队中的唤醒同样算「有活」，不能归档也不能移出', async () => {
    const group = team.createConversation({
      kind: 'group',
      memberIds: [archivist.id, reviewer.id],
    });
    muteAllMembers(team, group.id);

    await whileBusy(async () => {
      const first = await sendMessage({
        conversationId: group.id,
        content: '第一轮',
        targetMemberId: archivist.id,
      });
      await waitForStatus(first.executionId, 'running');

      // 第二轮落进 pending，还没开跑 —— 用 sendRaw：这一轮此刻还没有 execution，
      // 这正是要断言的状态。
      await sendRaw({
        conversationId: group.id,
        content: '第二轮',
        targetMemberId: archivist.id,
      });

      const state = team
        .listConversationState(group.id)
        .find((item) => item.memberId === archivist.id);
      assert.equal(state?.pendingWake, true, '前置条件：应该有一条排队的唤醒');

      assert.throws(() => team.updateMember(archivist.id, { status: 'archived' }), /不能归档/);
      assert.throws(() => team.removeMember(group.id, archivist.id), /不能移出/);
    });

    await waitForConversationIdle(group.id);
  });

  it('移出再重新加入拿到全新的 Copilot session，不从旧上下文续写', async () => {
    const group = team.createConversation({
      kind: 'group',
      memberIds: [coder.id, reviewer.id, analyst.id],
    });
    muteAllMembers(team, group.id);

    // 先让 analyst 在房间里跑一轮，把 runtime 用起来
    const first = await sendMessage({
      conversationId: group.id,
      content: '记录一下',
      targetMemberId: analyst.id,
    });
    await waitForStatus(first.executionId, 'completed');
    await waitForConversationIdle(group.id);

    const before = runtimeRow(group.id, analyst.id);
    assert.ok(before, '跑过一轮后 runtime 应该存在');

    team.removeMember(group.id, analyst.id);
    const afterRemove = runtimeRow(group.id, analyst.id);
    assert.ok(afterRemove, 'runtime 槽位保留（execution.runtime_id 还在引用它）');
    assert.notEqual(
      afterRemove.copilot_session_id,
      before.copilot_session_id,
      '移出即断代：旧 session 里记着它在这张桌子上的全部历史',
    );

    const rejoined = team.addMember(group.id, analyst.id);
    const watermark = rejoined.messageSequence;
    const afterAdd = runtimeRow(group.id, analyst.id);
    assert.equal(
      afterAdd?.last_context_message_sequence,
      watermark,
      '上下文水位要对齐到重新加入时的房间位置，否则第一轮会把离开期间的消息全灌进去',
    );
    assert.equal(
      team
        .listConversationState(group.id)
        .find((item) => item.memberId === analyst.id)?.lastSeenMessageSequence,
      watermark,
    );
  });
});

describe('Execution 审计链', () => {
});

describe('delegation 业务控制', () => {
  it('A → B 成功，并留下 parent + delegationPath', async () => {
    const { executionId } = await sendMessage({
      conversationId: teamConversationId,
      content: '先研究这个问题',
      targetMemberId: researcher.id,
    });
    await waitForStatus(executionId, 'completed');

    const result = await team.delegateMember({
      conversationId: teamConversationId,
      fromMemberId: researcher.id,
      parentExecutionId: executionId,
      targetMemberId: coder.id,
      task: '根据结论写一个验证脚本',
    });
    assert.match(result, /stub reply/);

    const child = db
      .prepare(`SELECT * FROM execution WHERE parent_execution_id = ?`)
      .get(executionId) as unknown as ExecutionRow;

    assert.equal(child.member_id, coder.id);
    assert.equal(child.kind, 'member_delegate');
    assert.equal(child.status, 'completed');
    assert.deepEqual(JSON.parse(child.delegation_path), [researcher.id, coder.id]);

    // 子 execution 用的是 Coder 在这个 conversation 里的独立 runtime
    assert.equal(child.runtime_id, runtimeRow(teamConversationId, coder.id)?.id);
  });

  it('A → B → C → A 被拒绝（cycle 跨层级）', async () => {
    const { executionId } = await sendMessage({
      conversationId: teamConversationId,
      content: '多层 cycle 测试起点',
      targetMemberId: researcher.id,
    });
    await waitForStatus(executionId, 'completed');

    // researcher → coder
    const second = await team.delegateMember({
      conversationId: teamConversationId,
      fromMemberId: researcher.id,
      parentExecutionId: executionId,
      targetMemberId: coder.id,
      task: 'delegate to coder',
    });
    assert.match(second, /stub reply/);

    const coderExecution = db
      .prepare(`SELECT * FROM execution WHERE parent_execution_id = ?`)
      .get(executionId) as unknown as ExecutionRow;

    // coder → reviewer
    await team.delegateMember({
      conversationId: teamConversationId,
      fromMemberId: coder.id,
      parentExecutionId: coderExecution.id,
      targetMemberId: reviewer.id,
      task: 'delegate to reviewer',
    });
    const reviewerExecution = db
      .prepare(`SELECT * FROM execution WHERE parent_execution_id = ?`)
      .get(coderExecution.id) as unknown as ExecutionRow;
    assert.deepEqual(JSON.parse(reviewerExecution.delegation_path), [
      researcher.id,
      coder.id,
      reviewer.id,
    ]);

    // reviewer → researcher 应该被 cycle 拦住
    await assert.rejects(
      () =>
        team.delegateMember({
          conversationId: teamConversationId,
          fromMemberId: reviewer.id,
          parentExecutionId: reviewerExecution.id,
          targetMemberId: researcher.id,
          task: 'back to the start',
        }),
      /cycle/i,
    );
  });

  it('超过 maxDelegationDepth 被拒绝（depth）', async () => {
    const { executionId } = await sendMessage({
      conversationId: teamConversationId,
      content: 'depth 测试起点',
      targetMemberId: researcher.id,
    });
    await waitForStatus(executionId, 'completed');

    let parentId = executionId;
    const chain = [
      { from: researcher.id, to: coder.id },
      { from: coder.id, to: reviewer.id },
      { from: reviewer.id, to: analyst.id },
    ];

    for (const step of chain) {
      await team.delegateMember({
        conversationId: teamConversationId,
        fromMemberId: step.from,
        parentExecutionId: parentId,
        targetMemberId: step.to,
        task: `delegate ${step.from} → ${step.to}`,
      });
      const child = db
        .prepare(`SELECT * FROM execution WHERE parent_execution_id = ?`)
        .get(parentId) as unknown as ExecutionRow;
      parentId = child.id;
    }

    // 到这里 delegationPath 长度 = maxDelegationDepth (4)
    const deepest = executionRow(parentId);
    assert.equal(JSON.parse(deepest.delegation_path).length, config.maxDelegationDepth);

    // 再往下探一层：目标是全新 Member（不是 cycle），必须被 depth 拦住
    await assert.rejects(
      () =>
        team.delegateMember({
          conversationId: teamConversationId,
          fromMemberId: analyst.id,
          parentExecutionId: parentId,
          targetMemberId: archivist.id,
          task: 'one level too deep',
        }),
      /depth/i,
    );
  });

  it('parent execution 不属于当前 Member 时被拒绝', async () => {
    const { executionId } = await sendMessage({
      conversationId: teamConversationId,
      content: 'parent 归属测试',
      targetMemberId: researcher.id,
    });
    await waitForStatus(executionId, 'completed');

    await assert.rejects(
      () =>
        team.delegateMember({
          conversationId: teamConversationId,
          fromMemberId: coder.id,
          parentExecutionId: executionId,
          targetMemberId: reviewer.id,
          task: 'spoofed parent',
        }),
      /parent execution/,
    );
  });

});
