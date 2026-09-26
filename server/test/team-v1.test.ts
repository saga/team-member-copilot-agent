import { after, before, describe, it } from 'node:test';
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
const { createTestStack, muteAllMembers, singleExecutionId, StubCopilot } = await import('./support.js');
const { teamRouter } = await import('../routes/team.js');
const { internalRouter } = await import('../routes/internal.js');
const { initTeamScope } = await import('../middleware/teamScope.js');
const { config } = await import('../config.js');
const express = (await import('express')).default;

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
    const released = structure.releaseWorkItem(item.id, { kind: 'agent', principalId: agent.id });
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
    // 旧版本号：version 守卫就能拦。
    assert.throws(() => structure.claimWorkItem(item.id, { memberId: b.id, expectedVersion: version }), /抢先|版本|失败/);
    // 当前版本号：只剩 claimed_by IS NULL 这道闸 —— 拿掉它 B 就能抢走 A 的 claim。
    const current = structure.getWorkItem(item.id).version;
    assert.throws(() => structure.claimWorkItem(item.id, { memberId: b.id, expectedVersion: current }), /抢先|版本|失败/);
  });

  it('done 必须 claimer 或 admin；done 后 claim 自动清空', () => {
    const claimer = makeAgent('DoneClaimer');
    const other = makeAgent('DoneOther');
    const item = structure.createWorkItem(team.id, { title: 'Finish me' }, 'u');
    structure.claimWorkItem(item.id, { memberId: claimer.id });
    assert.throws(
      () =>
        structure.updateWorkItem(item.id, { status: 'done' }, { kind: 'agent', principalId: other.id }),
      /claimer|admin|权限/,
    );
    const done = structure.updateWorkItem(item.id, { status: 'done' }, { kind: 'agent', principalId: claimer.id });
    assert.equal(done.status, 'done');
    assert.equal(done.claimedByMemberId, null);

    // 内层状态闸门的专属场景：人类创建者过得了顶层对象级授权，
    // 但工作状态流转只属于 claimer/admin —— 创建者不能把别人的任务改成 blocked。
    const created = structure.createWorkItem(team.id, { title: 'Creator only' }, 'some-human');
    structure.updateWorkItem(created.id, { title: 'Renamed' }, { kind: 'human', principalId: 'some-human' });
    assert.throws(
      () => structure.updateWorkItem(created.id, { status: 'blocked' }, { kind: 'human', principalId: 'some-human' }),
      /claimer|admin|状态/,
    );
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
    const schedule = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: 'scheduled check', type: 'once', runAt: new Date(Date.now() - 1000).toISOString() },
      'local-user',
    );
    const run = structure.insertScheduleRun(schedule.id, schedule.nextRunAt);
    const executionId = await stack.team.enqueueScheduledWork({
      scheduleRunId: run.id,
      conversationId: room.id,
      memberId: agent.id,
      prompt: 'scheduled check',
    });
    const execution = stack.team.getExecution(executionId);
    assert.equal(execution.kind, 'member_work');
    assert.equal(execution.wakeReason, 'schedule');
    assert.equal(execution.triggerMessageSequence, null);
  });

  it('scheduled prompt 不被最近一条聊天消息顶替；一次调度只产生一条 execution', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'SchedPrompt', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    // 先制造一条聊天消息：messageSequence > 0。旧的实现会把 scheduled prompt
    // 伪装成「最近一条消息」重放 —— 这条断言锁死 prompt 保真。
    muteAllMembers(stack.team, room.id);
    await stack.team.sendMessage({ conversationId: room.id, content: '聊天里最后一条消息' });

    const PROMPT = '严格按 schedule 的 prompt 执行';
    const schedule = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: PROMPT, type: 'once', runAt: new Date(Date.now() - 1000).toISOString() },
      'local-user',
    );
    const run = structure.insertScheduleRun(schedule.id, schedule.nextRunAt);
    const executionId = await stack.team.enqueueScheduledWork({
      scheduleRunId: run.id,
      conversationId: room.id,
      memberId: agent.id,
      prompt: PROMPT,
    });

    const rows = db
      .prepare(
        `SELECT id, prompt, trigger_message_sequence FROM execution
         WHERE conversation_id = ? AND member_id = ? AND wake_reason = 'schedule'`,
      )
      .all(room.id, agent.id) as unknown as Array<{ id: string; prompt: string; trigger_message_sequence: number | null }>;
    assert.equal(rows.length, 1, '一次调度只允许一条 execution —— 双执行等于重复执行业务动作');
    assert.equal(rows[0].id, executionId);
    assert.equal(rows[0].prompt, PROMPT);
    assert.equal(rows[0].trigger_message_sequence, null);
    await waitFor(() => stub.turns.some((turn) => turn.executionId === executionId), 'turn 开始');
    // stub 收到的是渲染后的 prompt：schedule prompt 必须是「当前消息」本身，
    // 聊天消息只能作为共享上下文出现 —— 而不是被当成最近一条消息重放。
    const rendered = stub.turnFor(executionId).prompt;
    assert.ok(rendered.includes(`Current message:\n\n${PROMPT}`), '当前消息必须是 schedule 的 prompt');
    assert.ok(rendered.includes('[User] 聊天里最后一条消息'), '聊天消息只作为共享上下文');

    await waitFor(() => stack.team.getExecution(executionId).status === 'completed', 'execution 完成');
    await waitFor(() => structure.getScheduleRun(run.id).status === 'completed', 'run 收口');
  });

  it('tick 遇到不可执行目标：run 标 failed 带原因，schedule 仍推进，不当成 duplicate', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'SchedArchived', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const scheduler = new SchedulerService(structure, () => stack.team);
    stack.team.updateMember(agent.id, { status: 'archived' });

    // dueSchedules 是全 Team 的：先把前面用例留下的到期 schedule 清掉，
    // 这条断言才只针对本用例的目标。
    await scheduler.tick();

    const schedule = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: 'never runs', type: 'once', runAt: new Date(Date.now() - 1000).toISOString() },
      'local-user',
    );
    assert.equal(await scheduler.tick(), 0);
    const run = db
      .prepare(`SELECT status, error FROM scheduled_wake_run WHERE schedule_id = ?`)
      .get(schedule.id) as unknown as { status: string; error: string | null };
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /归档/);
    // once 推进到 completed（带 last_error），而不是卡在 active 每 tick 重试。
    const after = structure.getSchedule(schedule.id);
    assert.equal(after.status, 'completed');
    assert.match(after.lastError ?? '', /归档/);
    void stub;
  });

  it('恢复：无 executionId 的 run 重建 execution；遗留 running 的 run 按 execution 终态收口', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'RecoverAgent', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const scheduler = new SchedulerService(structure, () => stack.team);

    // A) run 建了、execution 还没建（崩溃点）→ 恢复必须重建并跑完。
    const runA = structure.insertScheduleRun(
      structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'recover-a', type: 'once', runAt: new Date(Date.now() - 1000).toISOString() }, 'local-user').id,
      new Date(Date.now() - 1000).toISOString(),
    );

    // C) execution 已完成但 run 停在 running（老代码的遗留形态）→ 收口成 completed。
    const scheduleC = structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'recover-c', type: 'once', runAt: new Date(Date.now() - 2000).toISOString() }, 'local-user');
    const runC = structure.insertScheduleRun(scheduleC.id, scheduleC.nextRunAt);
    const execC = await stack.team.enqueueScheduledWork({ scheduleRunId: runC.id, conversationId: room.id, memberId: agent.id, prompt: 'recover-c' });
    await waitFor(() => stack.team.getExecution(execC).status === 'completed', 'execC 完成');
    structure.updateScheduleRun(runC.id, { status: 'running' });

    // D) execution failed → run 收口成 failed 且带走原因。
    const scheduleD = structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'recover-d', type: 'once', runAt: new Date(Date.now() - 3000).toISOString() }, 'local-user');
    const runD = structure.insertScheduleRun(scheduleD.id, scheduleD.nextRunAt);
    const execD = await stack.team.enqueueScheduledWork({ scheduleRunId: runD.id, conversationId: room.id, memberId: agent.id, prompt: 'recover-d' });
    await waitFor(() => stack.team.getExecution(execD).status === 'completed', 'execD 完成');
    db.prepare(`UPDATE execution SET status = 'failed', error = 'boom' WHERE id = ?`).run(execD);
    structure.updateScheduleRun(runD.id, { status: 'running' });

    scheduler.recoverQueuedRuns();

    await waitFor(() => !!structure.getScheduleRun(runA.id).executionId, 'runA 重建 execution');
    const execA = structure.getScheduleRun(runA.id).executionId as string;
    await waitFor(() => stack.team.getExecution(execA).status === 'completed', 'execA 完成');
    await waitFor(() => structure.getScheduleRun(runA.id).status === 'completed', 'runA 收口');
    await waitFor(() => structure.getScheduleRun(runC.id).status === 'completed', 'runC 收口');
    await waitFor(() => structure.getScheduleRun(runD.id).status === 'failed', 'runD 收口');
    assert.equal(structure.getScheduleRun(runD.id).error, 'boom');
  });
});

// ------------------------------------------------------- Schedule / Membership 约束

describe('Schedule 约束', () => {
  it('被调度的 Member 必须在绑定的 work conversation 里（创建时就拦，不等到运行时）', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const insider = stack.team.createMember({ name: 'RoomInsider', role: 'E' });
    const outsider = stack.team.createMember({ name: 'RoomOutsider', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [insider.id] });
    assert.throws(
      () =>
        structure.createSchedule(
          team.id,
          { memberId: outsider.id, conversationId: room.id, prompt: 'x', type: 'once', runAt: new Date().toISOString() },
          'local-user',
        ),
      /必须属于/,
    );
  });

  it('已结束的 WorkItem 不能建自动任务；projectId 与 WorkItem 不一致要拦', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const agent = stack.team.createMember({ name: 'SchedWI', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const projectA = structure.createProject(team.id, { name: 'ProjA' }, 'local-user');
    const projectB = structure.createProject(team.id, { name: 'ProjB' }, 'local-user');

    const done = structure.createWorkItem(team.id, { title: 'Will finish' }, 'local-user');
    structure.updateWorkItem(done.id, { status: 'done' }, { kind: 'human', principalId: 'local-user', teamRole: 'owner' });
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, workItemId: done.id, prompt: 'x', type: 'once', runAt: new Date().toISOString() }, 'local-user'),
      /已结束/,
    );

    const mismatch = structure.createWorkItem(team.id, { title: 'Mismatch', projectId: projectA.id }, 'local-user');
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, workItemId: mismatch.id, projectId: projectB.id, prompt: 'x', type: 'once', runAt: new Date().toISOString() }, 'local-user'),
      /不一致/,
    );
  });

  it('已完成的 once schedule 不能 resume', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const agent = stack.team.createMember({ name: 'OnceResume', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const schedule = structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'once', type: 'once', runAt: new Date().toISOString() }, 'local-user');
    structure.updateScheduleStatus(schedule.id, 'completed');
    assert.throws(() => structure.updateScheduleStatus(schedule.id, 'active'), /resume|已完成/);
  });
});

describe('Membership 不变量', () => {
  it('Member 归档/恢复与 TeamMembership 同步，不漂移成「已归档仍 active」', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const agent = stack.team.createMember({ name: 'SyncAgent', role: 'E' });
    assert.equal(structure.getMembership(team.id, 'agent', agent.id).status, 'active');

    stack.team.updateMember(agent.id, { status: 'archived' });
    assert.equal(structure.getMembership(team.id, 'agent', agent.id).status, 'inactive');
    assert.throws(() => structure.requireActiveMembership(team.id, 'agent', agent.id), /停用|归档/);

    stack.team.updateMember(agent.id, { status: 'active' });
    assert.equal(structure.getMembership(team.id, 'agent', agent.id).status, 'active');
  });

  it('membership active 但 Member 已归档的漂移也会被拦下（防线不依赖同步路径）', () => {
    const agent = makeAgent('DriftAgent');
    // 绕过 updateMember 直接改 member 行，模拟运维 SQL / 历史数据造成的漂移。
    db.prepare(`UPDATE member SET status = 'archived' WHERE id = ?`).run(agent.id);
    assert.throws(() => structure.requireActiveMembership(team.id, 'agent', agent.id), /归档/);
    db.prepare(`UPDATE member SET status = 'active' WHERE id = ?`).run(agent.id);
  });

  it('最后一个 active owner 不能降级；Agent 永远不能成为 owner', () => {
    assert.throws(() => structure.updateMembership(team.id, 'human', 'local-user', { role: 'member' }), /owner/);
    const agent = makeAgent('OwnerWant');
    assert.throws(() => structure.updateMembership(team.id, 'agent', agent.id, { role: 'owner' }), /owner/);
  });
});

describe('WorkItem 权限与 execution 绑定', () => {
  it('release 只允许 claimer 或 admin/owner', () => {
    const claimer = makeAgent('RelClaimer');
    const other = makeAgent('RelOther');
    const item = structure.createWorkItem(team.id, { title: 'Rel' }, 'local-user');
    structure.claimWorkItem(item.id, { memberId: claimer.id });
    assert.throws(
      () => structure.releaseWorkItem(item.id, { kind: 'agent', principalId: other.id, teamRole: 'member' }),
      /claimer|admin/,
    );
    structure.releaseWorkItem(item.id, { kind: 'agent', principalId: claimer.id });
  });

  it('claim 绑定真实 execution：归属校验、execution.work_item_id 双向回写、一条 execution 只绑一个 WorkItem', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'ClaimExec', role: 'E' });
    const other = stack.team.createMember({ name: 'ClaimExecOther', role: 'E' });
    const room = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
    const itemA = structure.createWorkItem(team.id, { title: 'A' }, 'local-user');
    const itemB = structure.createWorkItem(team.id, { title: 'B' }, 'local-user');
    structure.assignWorkItem(itemA.id, { kind: 'agent', principalId: agent.id });
    structure.assignWorkItem(itemB.id, { kind: 'agent', principalId: agent.id });

    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'start work' });
      const executionId = singleExecutionId(db, room.id, sent.wakes);
      await waitFor(() => stack.team.getExecution(executionId).status === 'running', 'execution 进入 running');

      // 别人的 execution 不能拿来 claim —— 否则 audit 链上挂的是假 execution。
      await assert.rejects(
        () => stack.team.claimWorkItemForAgent({ memberId: other.id, executionId, workItemId: itemA.id }),
        /不属于/,
      );

      const result = JSON.parse(
        await stack.team.claimWorkItemForAgent({ memberId: agent.id, executionId, workItemId: itemA.id }),
      ) as { workItemId: string };
      assert.equal(result.workItemId, itemA.id);
      assert.equal(structure.getWorkItem(itemA.id).claimedExecutionId, executionId);
      assert.equal(stack.team.getExecution(executionId).workItemId, itemA.id, 'execution.work_item_id 必须回写');

      // 同一条 execution 已经绑了 A，不能再绑 B。
      await assert.rejects(
        () => stack.team.claimWorkItemForAgent({ memberId: agent.id, executionId, workItemId: itemB.id }),
        /另一个/,
      );
    } finally {
      release();
      stub.hold = null;
    }
  });
});

// ------------------------------------------------------- HTTP actor 边界

describe('HTTP actor 边界', () => {
  let server: import('node:http').Server;
  let base: string;
  const originalInternal = config.internalApiToken;

  const stub = new StubCopilot();
  const stack = createTestStack(db, memberService, stub.asCopilot);
  const agent = stack.team.createMember({ name: 'HttpAgent', role: 'E' });

  before(async () => {
    initTeamScope(structure, team.id);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/team', teamRouter(structure));
    app.use('/api/internal', internalRouter(stack.team));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });

  after(async () => {
    config.internalApiToken = originalInternal;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('X-Agent-Id 头伪造不出 Agent 身份：HTTP claim 一律 403', async () => {
    const item = structure.createWorkItem(team.id, { title: 'Spoof' }, 'local-user');
    const res = await fetch(`${base}/api/team/work-items/${item.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': agent.id },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });

  it('Team 成员（human）可以读 work-items；claim 对 human 也是 403', async () => {
    const read = await fetch(`${base}/api/team/work-items`);
    assert.equal(read.status, 200);

    const item = structure.createWorkItem(team.id, { title: 'Human claim' }, 'local-user');
    const res = await fetch(`${base}/api/team/work-items/${item.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });

  it('Agent 经 /api/internal claim：无 token 401；带 token 成功并回写 execution', async () => {
    config.internalApiToken = 'internal-secret';
    const item = structure.createWorkItem(team.id, { title: 'Internal claim' }, 'local-user');
    structure.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id });

    const noToken = await fetch(`${base}/api/internal/members/${agent.id}/work-item-claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workItemId: item.id, executionId: 'exec-x' }),
    });
    assert.equal(noToken.status, 401);

    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const room = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
      const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'go' });
      const executionId = singleExecutionId(db, room.id, sent.wakes);
      await waitFor(() => stack.team.getExecution(executionId).status === 'running', 'execution 进入 running');

      const withToken = await fetch(`${base}/api/internal/members/${agent.id}/work-item-claims`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer internal-secret' },
        body: JSON.stringify({ workItemId: item.id, executionId }),
      });
      assert.equal(withToken.status, 200);
      const body = (await withToken.json()) as { workItemId: string };
      assert.equal(body.workItemId, item.id);
      assert.equal(stack.team.getExecution(executionId).workItemId, item.id);
    } finally {
      release();
      stub.hold = null;
    }
  });
});

/** 轮询直到条件成立或超时 —— 火灾报警式断言的前置等待。 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等待超时：${what}`);
}
