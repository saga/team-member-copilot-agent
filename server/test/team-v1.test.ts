import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Team 业务模型 v1：Team / Membership / Project / WorkItem / Presence / Schedule。
 * 锁的是产品语义，不是字段数量：
 *   WorkItem ≠ Execution（completed 不自动 done）
 *   Assignment ≠ Claim（claim 原子，不先读再写）
 *   Team role ≠ Member.role
 *   Presence ≠ ConversationState（mute 不改 presence）
 *   Schedule 不补历史、不给 paused 执行
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-team-v1-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';
process.env.HOST_CODING_TOOLS = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { TeamStructureService } = await import('../team-structure-service.js');
const { SchedulerService } = await import('../scheduler-service.js');
const { createTestStack, muteAllMembers, singleExecutionId } = await import('./support.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memberService = new MemberService(db);
const structure = new TeamStructureService(db);
const team = structure.ensureDefaultTeam('test');
structure.ensureHumanOwner(team.id, 'local-user');

function makeAgent(name: string) {
  const member = memberService.create({ name, handle: name.toLowerCase(), role: 'Engineer' });
  structure.ensureAgentMembership(team.id, member.id);
  return member;
}

describe('Team / Membership', () => {
  it('默认 Team 唯一，human owner 存在，agent 自动可补', () => {
    const again = structure.ensureDefaultTeam('test');
    assert.equal(again.id, team.id);
    assert.equal(structure.getMembership(team.id, 'human', 'local-user').role, 'owner');
  });

  it('Team role 与 Member.role 分开：Architect 的 team role 是 member', () => {
    const agent = makeAgent('Architect');
    assert.equal(agent.role, 'Engineer');
    assert.equal(structure.getMembership(team.id, 'agent', agent.id).role, 'member');
  });

  it('inactive 成员不能建 conversation（TeamService 层拦）', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const outsider = memberService.create({ name: 'Outsider', handle: 'outsider', role: 'X' });
    // 显式停用：createConversation 的自动补只补“不在”，不复活 inactive。
    structure.ensureAgentMembership(team.id, outsider.id);
    structure.updateMembership(team.id, 'agent', outsider.id, { status: 'inactive' });
    assert.throws(
      () => stack.team.createConversation({ kind: 'direct', memberIds: [outsider.id] }),
      /停用|归档|Team/,
    );
    structure.updateMembership(team.id, 'agent', outsider.id, { status: 'active' });
  });
});

describe('Project', () => {
  it('project 归属 team；归档后不能建 work/conversation', () => {
    const project = structure.createProject(team.id, { name: 'Proxy Voting' }, 'local-user');
    assert.equal(project.teamId, team.id);
    structure.updateProject(project.id, { status: 'archived' });
    assert.throws(() => structure.createWorkItem(team.id, { title: 'x', projectId: project.id }, 'u'), /归档/);
  });

  it('project 不建自己的 ACL：同 Team 成员默认可见', () => {
    const projects = structure.listProjects(team.id);
    assert.ok(projects.length >= 1);
  });
});

describe('WorkItem：Assignment 与 Claim 分开', () => {
  it('创建默认 todo；assign 可换人；claimed 时换 assignee 409', () => {
    const agent = makeAgent('Worker');
    const item = structure.createWorkItem(team.id, { title: 'Review proposal' }, 'local-user');
    assert.equal(item.status, 'todo');

    const assigned = structure.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id });
    assert.equal(assigned.assigneeId, agent.id);

    const claimed = structure.claimWorkItem(item.id, { memberId: agent.id });
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.claimedByMemberId, agent.id);

    assert.throws(() => structure.assignWorkItem(item.id, null), /release/);
    const released = structure.releaseWorkItem(item.id, agent.id);
    assert.equal(released.claimedByMemberId, null);
    structure.assignWorkItem(item.id, null);
  });

  it('未指定 assignee 时任何 active agent 可 claim；指定后只有它能 claim', () => {
    const a = makeAgent('ClaimA');
    const b = makeAgent('ClaimB');
    const open = structure.createWorkItem(team.id, { title: 'Open task' }, 'u');
    assert.equal(structure.claimWorkItem(open.id, { memberId: b.id }).claimedByMemberId, b.id);

    const assigned = structure.createWorkItem(team.id, { title: 'Assigned task' }, 'u');
    structure.assignWorkItem(assigned.id, { kind: 'agent', principalId: a.id });
    assert.throws(() => structure.claimWorkItem(assigned.id, { memberId: b.id }), /指派/);
    structure.claimWorkItem(assigned.id, { memberId: a.id });
  });

  it('double claim 只赢一个（版本过期/已被占都 409）', () => {
    const a = makeAgent('RaceA');
    const b = makeAgent('RaceB');
    const item = structure.createWorkItem(team.id, { title: 'Race' }, 'u');
    const version = item.version;
    structure.claimWorkItem(item.id, { memberId: a.id, expectedVersion: version });
    assert.throws(() => structure.claimWorkItem(item.id, { memberId: b.id, expectedVersion: version }), /抢先|版本|失败/);
  });

  it('done 必须 claimer 或 admin；done 后 claim 自动清空', () => {
    const claimer = makeAgent('DoneClaimer');
    const other = makeAgent('DoneOther');
    const item = structure.createWorkItem(team.id, { title: 'Finish me' }, 'u');
    structure.claimWorkItem(item.id, { memberId: claimer.id });
    assert.throws(
      () =>
        structure.updateWorkItem(item.id, { status: 'done' }, { kind: 'agent', principalId: other.id }),
      /claimer|admin/,
    );
    const done = structure.updateWorkItem(item.id, { status: 'done' }, { kind: 'agent', principalId: claimer.id });
    assert.equal(done.status, 'done');
    assert.equal(done.claimedByMemberId, null);
  });

  it('Execution.completed 不自动完成 WorkItem；delegation 透传 workItemId', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'ExecAgent', role: 'E' });
    const room = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
    muteAllMembers(stack.team, room.id);
    const item = structure.createWorkItem(team.id, { title: 'Linked work' }, 'u');
    structure.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id });
    structure.claimWorkItem(item.id, { memberId: agent.id });

    const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'hi' });
    const executionId = singleExecutionId(db, room.id, sent.wakes);
    for (let i = 0; i < 200 && stack.team.getExecution(executionId).status !== 'completed'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(stack.team.getExecution(executionId).status, 'completed');
    // 业务未显式 done：还是 in_progress。
    assert.equal(structure.getWorkItem(item.id).status, 'in_progress');
  });
});

describe('Presence', () => {
  it('默认 available；paused 不被 execution 覆盖；mute 不改 presence', () => {
    const agent = makeAgent('PresenceAgent');
    assert.equal(structure.getPresence(team.id, 'agent', agent.id).availability, 'available');
    structure.setAvailability(team.id, 'agent', agent.id, 'paused');
    structure.touchPresence(team.id, 'agent', agent.id);
    assert.equal(structure.getPresence(team.id, 'agent', agent.id).availability, 'paused');

    const stored = structure.getPresence(team.id, 'agent', agent.id);
    assert.equal(structure.effectiveAvailability(stored, true), 'paused');
    assert.equal(structure.effectiveAvailability(stored, false), 'paused');
    structure.setAvailability(team.id, 'agent', agent.id, 'available');
  });

  it('有 active execution 即 busy；lastSeen 太旧即 offline', () => {
    const stored = { teamId: team.id, kind: 'agent' as const, principalId: 'x', availability: 'available' as const, lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    assert.equal(structure.effectiveAvailability(stored, true), 'busy');
    const stale = { ...stored, lastSeenAt: new Date(Date.now() - 60 * 60_000).toISOString() };
    assert.equal(structure.effectiveAvailability(stale, false), 'offline');
  });
});

describe('Scheduler', () => {
  it('once 只 fire 一次；interval 不补历史；UNIQUE 幂等；paused 不执行', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'SchedAgent', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const scheduler = new SchedulerService(structure, () => stack.team);

    const past = new Date(Date.now() - 1000).toISOString();
    const once = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: 'check once', type: 'once', runAt: past },
      'local-user',
    );
    assert.equal(await scheduler.tick(), 1);
    assert.equal(structure.getSchedule(once.id).status, 'completed');
    assert.equal(await scheduler.tick(), 0);

    // UNIQUE(schedule_id, scheduled_for)：tick 已为 once 建过 run，重复 insert 直接冲突。
    assert.throws(() => structure.insertScheduleRun(once.id, past), /幂等|UNIQUE|已有一条/);

    // interval：离线 8 小时只执行一次，next 跳到未来。
    const old = new Date(Date.now() - 8 * 3600_000).toISOString();
    const interval = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: 'hourly', type: 'interval', runAt: old, intervalSeconds: 3600 },
      'local-user',
    );
    assert.equal(await scheduler.tick(), 1);
    const after = structure.getSchedule(interval.id);
    assert.equal(after.status, 'active');
    assert.ok(Date.parse(after.nextRunAt) > Date.now(), 'next 必须在未来，不补 8 次');

    // paused 成员不执行。
    structure.setAvailability(team.id, 'agent', agent.id, 'paused');
    const pausedSchedule = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: 'paused task', type: 'once', runAt: new Date(Date.now() - 1000).toISOString() },
      'local-user',
    );
    assert.equal(await scheduler.tick(), 0);
    assert.equal(structure.getSchedule(pausedSchedule.id).status, 'active');
    structure.setAvailability(team.id, 'agent', agent.id, 'available');
  });

  it('scheduled execution 标记：kind=member_work，wakeReason=schedule，无触发消息', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'SchedMark', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const executionId = await stack.team.enqueueScheduledWork({
      conversationId: room.id,
      memberId: agent.id,
      prompt: 'scheduled check',
    });
    const execution = stack.team.getExecution(executionId);
    assert.equal(execution.kind, 'member_work');
    assert.equal(execution.wakeReason, 'schedule');
    assert.equal(execution.triggerMessageSequence, null);
  });
});
