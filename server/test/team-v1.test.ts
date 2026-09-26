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
const { TeamEventService } = await import('../team-event-service.js');
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

/** 测试里的默认人类协调者（与 makeAgent 的 agent 身份相对）。 */
const HUMAN = { kind: 'human' as const, principalId: 'local-user' };

/**
 * 建一条「已到期」的 schedule。
 *
 * createSchedule 要求 runAt 在未来（创建时就拦非法输入），调度类用例要模拟
 * 「过去建的、现在到期了」，用 SQL 回拨 run_at / next_run_at —— 这正是
 * 重启恢复会看到的数据形态。
 */
function createScheduleDue(
  input: Omit<Parameters<typeof structure.createSchedule>[1], 'runAt'>,
  dueAt: string = new Date(Date.now() - 1000).toISOString(),
): ReturnType<typeof structure.createSchedule> {
  const schedule = structure.createSchedule(
    team.id,
    { ...input, runAt: new Date(Date.now() + 3600_000).toISOString() },
    'local-user',
  );
  db.prepare(`UPDATE scheduled_wake SET run_at = ?, next_run_at = ? WHERE id = ?`).run(dueAt, dueAt, schedule.id);
  return structure.getSchedule(schedule.id);
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
    assert.throws(() => structure.createWorkItem(team.id, { title: 'x', projectId: project.id }, { kind: 'human', principalId: 'u' }), /归档/);
  });

  it('project 不建自己的 ACL：同 Team 成员默认可见', () => {
    const projects = structure.listProjects(team.id);
    assert.ok(projects.length >= 1);
  });
});

describe('WorkItem：Assignment 与 Claim 分开', () => {
  it('创建默认 todo；assign 可换人；claimed 时换 assignee 409', () => {
    const agent = makeAgent('Worker');
    const item = structure.createWorkItem(team.id, { title: 'Review proposal' }, HUMAN);
    assert.equal(item.status, 'todo');

    const assigned = structure.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id }, HUMAN);
    assert.equal(assigned.assigneeId, agent.id);

    const claimed = structure.claimWorkItem(item.id, { memberId: agent.id });
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.claimedByMemberId, agent.id);

    assert.throws(() => structure.assignWorkItem(item.id, null, HUMAN), /release/);
    const released = structure.releaseWorkItem(item.id, { kind: 'agent', principalId: agent.id });
    assert.equal(released.claimedByMemberId, null);
    structure.assignWorkItem(item.id, null, HUMAN);
  });

  it('未指定 assignee 时任何 active agent 可 claim；指定后只有它能 claim', () => {
    const a = makeAgent('ClaimA');
    const b = makeAgent('ClaimB');
    const open = structure.createWorkItem(team.id, { title: 'Open task' }, { kind: 'human', principalId: 'u' });
    assert.equal(structure.claimWorkItem(open.id, { memberId: b.id }).claimedByMemberId, b.id);

    const assigned = structure.createWorkItem(team.id, { title: 'Assigned task' }, { kind: 'human', principalId: 'u' });
    structure.assignWorkItem(assigned.id, { kind: 'agent', principalId: a.id }, HUMAN);
    assert.throws(() => structure.claimWorkItem(assigned.id, { memberId: b.id }), /指派/);
    structure.claimWorkItem(assigned.id, { memberId: a.id });
  });

  it('double claim 只赢一个（版本过期/已被占都 409）', () => {
    const a = makeAgent('RaceA');
    const b = makeAgent('RaceB');
    const item = structure.createWorkItem(team.id, { title: 'Race' }, { kind: 'human', principalId: 'u' });
    const version = item.version;
    structure.claimWorkItem(item.id, { memberId: a.id, expectedVersion: version });
    // 旧版本号：version 守卫就能拦。
    assert.throws(() => structure.claimWorkItem(item.id, { memberId: b.id, expectedVersion: version }), /抢先|版本|失败|其他 Member/);
    // 当前版本号：只剩 claimed_by IS NULL 这道闸 —— 拿掉它 B 就能抢走 A 的 claim。
    const current = structure.getWorkItem(item.id).version;
    assert.throws(() => structure.claimWorkItem(item.id, { memberId: b.id, expectedVersion: current }), /抢先|版本|失败|其他 Member/);
  });

  it('done 必须 claimer 或 admin；done 后 claim 自动清空', () => {
    const claimer = makeAgent('DoneClaimer');
    const other = makeAgent('DoneOther');
    const item = structure.createWorkItem(team.id, { title: 'Finish me' }, { kind: 'human', principalId: 'u' });
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
    const created = structure.createWorkItem(team.id, { title: 'Creator only' }, { kind: 'human', principalId: 'some-human' });
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
    const item = structure.createWorkItem(team.id, { title: 'Linked work' }, { kind: 'human', principalId: 'u' });
    structure.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id }, HUMAN);
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
    const once = createScheduleDue({ memberId: agent.id, conversationId: room.id, prompt: 'check once', type: 'once' });
    assert.equal(await scheduler.tick(), 1);
    assert.equal(structure.getSchedule(once.id).status, 'completed');
    assert.equal(await scheduler.tick(), 0);

    // UNIQUE(schedule_id, scheduled_for)：tick 已为 once 建过 run，重复 insert 直接冲突。
    assert.throws(() => structure.insertScheduleRun(once.id, past), /幂等|UNIQUE|已有一条/);

    // interval：离线 8 小时只执行一次，next 跳到未来。
    const old = new Date(Date.now() - 8 * 3600_000).toISOString();
    const interval = createScheduleDue(
      { memberId: agent.id, conversationId: room.id, prompt: 'hourly', type: 'interval', intervalSeconds: 3600 },
      old,
    );
    assert.equal(await scheduler.tick(), 1);
    const after = structure.getSchedule(interval.id);
    assert.equal(after.status, 'active');
    assert.ok(Date.parse(after.nextRunAt) > Date.now(), 'next 必须在未来，不补 8 次');

    // paused 成员不执行。
    structure.setAvailability(team.id, 'agent', agent.id, 'paused');
    const pausedSchedule = createScheduleDue(
      { memberId: agent.id, conversationId: room.id, prompt: 'paused task', type: 'once' },
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
      { memberId: agent.id, conversationId: room.id, prompt: 'scheduled check', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
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
      { memberId: agent.id, conversationId: room.id, prompt: PROMPT, type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
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
    // enqueue 只建不跑：启动由 runScheduledExecution 负责（tick / recovery 共用）。
    await stack.team.runScheduledExecution(executionId);
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

    // dueSchedules 是全 Team 的：先把前面用例留下的到期 schedule 清掉，
    // 这条断言才只针对本用例的目标。
    await scheduler.tick();

    // 创建时成员还 active（创建即校验），随后归档 —— 模拟「建了之后人才走」。
    const schedule = createScheduleDue(
      { memberId: agent.id, conversationId: room.id, prompt: 'never runs', type: 'once' },
    );
    stack.team.updateMember(agent.id, { status: 'archived' });
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

  it('enqueueScheduledWork 只创建并绑定 execution，不启动；重复绑定同一 run 409', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'EnqueueOnly', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const schedule = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: 'not started', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
      'local-user',
    );
    const run = structure.insertScheduleRun(schedule.id, schedule.nextRunAt);

    const executionId = await stack.team.enqueueScheduledWork({
      scheduleRunId: run.id,
      conversationId: room.id,
      memberId: agent.id,
      prompt: 'not started',
    });
    // 启动权在调用方（tick / recovery）：enqueue 自己启动会在极快完成的场景下
    // 与 tick 的 updateScheduleRun('running') 形成竞态。
    assert.equal(stack.team.getExecution(executionId).status, 'queued');
    assert.equal(stub.turns.length, 0, 'enqueue 不触发 turn');

    // run 已绑定：第二次 enqueue 撞 changes=0 → 409，而不是留下孤儿 execution。
    await assert.rejects(
      () =>
        stack.team.enqueueScheduledWork({
          scheduleRunId: run.id,
          conversationId: room.id,
          memberId: agent.id,
          prompt: 'again',
        }),
      /绑定|改变/,
    );
  });

  it('tick 返回时 run 已 running、schedule 已推进，之后 execution 完成并把 run 收口', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'TickOrder', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const scheduler = new SchedulerService(structure, () => stack.team);
    const schedule = createScheduleDue({ memberId: agent.id, conversationId: room.id, prompt: 'ordered', type: 'once' });

    assert.equal(await scheduler.tick(), 1);
    const run = db
      .prepare(`SELECT id, status, execution_id FROM scheduled_wake_run WHERE schedule_id = ?`)
      .get(schedule.id) as unknown as { id: string; status: string; execution_id: string | null };
    // tick 返回的那一刻 run 必须是 running：如果它已经是 completed，说明
    // execution 在 run 标 running 之前就跑完并收口了 —— 那正是被删掉的
    // 「enqueue 内部启动」写法会触发的竞态。
    assert.equal(run.status, 'running');
    assert.equal(structure.getSchedule(schedule.id).status, 'completed', 'schedule 已推进到终态');

    await waitFor(() => stack.team.getExecution(run.execution_id as string).status === 'completed', 'execution 完成');
    await waitFor(() => structure.getScheduleRun(run.id).status === 'completed', 'run 被 settleScheduleRun 收口');
  });

  it('run 时间戳跟语义走：running 写 started_at，终态写 ended_at，终态不顶掉 started_at', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const agent = stack.team.createMember({ name: 'RunTs', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const schedule = structure.createSchedule(
      team.id,
      { memberId: agent.id, conversationId: room.id, prompt: 'ts', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
      'local-user',
    );
    const run = structure.insertScheduleRun(schedule.id, schedule.nextRunAt);
    assert.equal(run.startedAt, null);
    assert.equal(run.endedAt, null);

    const running = structure.updateScheduleRun(run.id, { status: 'running' });
    assert.ok(running.startedAt, '进入 running 才写 started_at');
    assert.equal(running.endedAt, null);

    const completed = structure.updateScheduleRun(run.id, { status: 'completed' });
    assert.equal(completed.startedAt, running.startedAt, '终态不顶掉 started_at');
    assert.ok(completed.endedAt, '终态写 ended_at');

    // 直接从 queued 判 failed（enqueue 失败路径）：started_at 必须保持空。
    const failedRun = structure.insertScheduleRun(
      structure.createSchedule(
        team.id,
        { memberId: agent.id, conversationId: room.id, prompt: 'ts2', type: 'once', runAt: new Date(Date.now() + 120_000).toISOString() },
        'local-user',
      ).id,
      new Date(Date.now() + 120_000).toISOString(),
    );
    const failed = structure.updateScheduleRun(failedRun.id, { status: 'failed', error: 'no target' });
    assert.equal(failed.startedAt, null, '从未 running 过就没有 started_at');
    assert.ok(failed.endedAt);
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
      createScheduleDue({ memberId: agent.id, conversationId: room.id, prompt: 'recover-a', type: 'once' }).id,
      new Date(Date.now() - 1000).toISOString(),
    );

    // C) execution 已完成但 run 停在 running（老代码的遗留形态）→ 收口成 completed。
    const scheduleC = createScheduleDue({ memberId: agent.id, conversationId: room.id, prompt: 'recover-c', type: 'once' }, new Date(Date.now() - 2000).toISOString());
    const runC = structure.insertScheduleRun(scheduleC.id, scheduleC.nextRunAt);
    const execC = await stack.team.enqueueScheduledWork({ scheduleRunId: runC.id, conversationId: room.id, memberId: agent.id, prompt: 'recover-c' });
    await stack.team.runScheduledExecution(execC);
    await waitFor(() => stack.team.getExecution(execC).status === 'completed', 'execC 完成');
    structure.updateScheduleRun(runC.id, { status: 'running' });

    // D) execution failed → run 收口成 failed 且带走原因。
    const scheduleD = createScheduleDue({ memberId: agent.id, conversationId: room.id, prompt: 'recover-d', type: 'once' }, new Date(Date.now() - 3000).toISOString());
    const runD = structure.insertScheduleRun(scheduleD.id, scheduleD.nextRunAt);
    const execD = await stack.team.enqueueScheduledWork({ scheduleRunId: runD.id, conversationId: room.id, memberId: agent.id, prompt: 'recover-d' });
    await stack.team.runScheduledExecution(execD);
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
          { memberId: outsider.id, conversationId: room.id, prompt: 'x', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
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

    const done = structure.createWorkItem(team.id, { title: 'Will finish' }, HUMAN);
    structure.updateWorkItem(done.id, { status: 'done' }, { kind: 'human', principalId: 'local-user', teamRole: 'owner' });
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, workItemId: done.id, prompt: 'x', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() }, 'local-user'),
      /已结束/,
    );

    const mismatch = structure.createWorkItem(team.id, { title: 'Mismatch', projectId: projectA.id }, HUMAN);
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, workItemId: mismatch.id, projectId: projectB.id, prompt: 'x', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() }, 'local-user'),
      /一致/,
    );

    // Schedule 明确属于某 Project 时，游离（无 project）的 WorkItem 也不接受：
    // 产出落在哪个 Project 必须无歧义。
    const floating = structure.createWorkItem(team.id, { title: 'Floating' }, HUMAN);
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, workItemId: floating.id, projectId: projectA.id, prompt: 'x', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() }, 'local-user'),
      /一致/,
    );
  });

  it('schedule 创建即校验 runAt 与成员状态：不把错误留到 scheduler 运行时', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const agent = stack.team.createMember({ name: 'SchedValidate', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });

    // runAt 必须是有效时间。
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'x', type: 'once', runAt: 'not-a-date' }, 'local-user'),
      /有效时间/,
    );
    // runAt 必须在未来：过去的 once 要么永远跑不到、要么下一个 tick 立刻炸出来。
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'x', type: 'once', runAt: new Date(Date.now() - 60_000).toISOString() }, 'local-user'),
      /未来/,
    );
    // 归档的 Agent 不能被调度 —— 在创建时就拦，不等到 run 记录里才失败。
    stack.team.updateMember(agent.id, { status: 'archived' });
    assert.throws(
      () =>
        structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'x', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() }, 'local-user'),
      /归档|停用/,
    );
    stack.team.updateMember(agent.id, { status: 'active' });
  });

  it('已完成的 once schedule 不能 resume', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const agent = stack.team.createMember({ name: 'OnceResume', role: 'E' });
    const room = stack.team.createConversation({ kind: 'work', memberIds: [agent.id] });
    const schedule = structure.createSchedule(team.id, { memberId: agent.id, conversationId: room.id, prompt: 'once', type: 'once', runAt: new Date(Date.now() + 60_000).toISOString() }, 'local-user');
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
    const item = structure.createWorkItem(team.id, { title: 'Rel' }, HUMAN);
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
    const itemA = structure.createWorkItem(team.id, { title: 'A' }, HUMAN);
    const itemB = structure.createWorkItem(team.id, { title: 'B' }, HUMAN);
    structure.assignWorkItem(itemA.id, { kind: 'agent', principalId: agent.id }, HUMAN);
    structure.assignWorkItem(itemB.id, { kind: 'agent', principalId: agent.id }, HUMAN);

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

describe('Claim 生命周期', () => {
  it('Agent 不能 assign（Assignment 是协调动作，Agent 接活走 claim）', () => {
    const agent = makeAgent('AssignAgent');
    const item = structure.createWorkItem(team.id, { title: 'Coordination only' }, HUMAN);
    assert.throws(
      () =>
        structure.assignWorkItem(
          item.id,
          { kind: 'agent', principalId: agent.id },
          { kind: 'agent', principalId: agent.id },
        ),
      /Agent 不能 assign/,
    );
  });

  it('同一 Member 旧 execution 终态后可重绑 claim；别 Member 与未结束的旧轮仍 409', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'RebindAgent', role: 'E' });
    const other = stack.team.createMember({ name: 'RebindOther', role: 'E' });
    // 每个 execution 用独立房间：同一房间的重复唤醒会被 MemberTurnScheduler
    // 合并，造不出「两条并行 execution」。
    const room1 = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
    const room2 = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
    const room3 = stack.team.createConversation({ kind: 'direct', memberIds: [other.id] });
    // 未指派：其他 Member 的 claim 冲突才走「已被其他 Member claim」分支。
    const item = structure.createWorkItem(team.id, { title: 'Retry me' }, HUMAN);

    let release!: () => void;
    const holdTurn = () => {
      stub.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    try {
      // 第一轮：E1 running（agent，room1），正常 claim。
      holdTurn();
      const sent = await stack.team.sendMessage({ conversationId: room1.id, content: '第一轮' });
      const e1 = singleExecutionId(db, room1.id, sent.wakes);
      await waitFor(() => stack.team.getExecution(e1).status === 'running', 'E1 running');
      const claimed = structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e1 });
      assert.equal(claimed.claimedExecutionId, e1);

      // E2 是 agent 在另一个房间的 execution（也 held 在 running）。
      const sent2 = await stack.team.sendMessage({ conversationId: room2.id, content: '第二轮' });
      const e2 = singleExecutionId(db, room2.id, sent2.wakes);
      await waitFor(() => stack.team.getExecution(e2).status === 'running', 'E2 running');

      // 旧 execution 还没结束：连自己也不能换绑到新的一轮。
      assert.throws(
        () => structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e2 }),
        /未结束/,
      );
      // 其他 Member 带自己的 execution 来 claim → 409。
      const sent3 = await stack.team.sendMessage({ conversationId: room3.id, content: '别人的轮' });
      const e3 = singleExecutionId(db, room3.id, sent3.wakes);
      await waitFor(() => stack.team.getExecution(e3).status === 'running', 'E3 running');
      assert.throws(
        () => structure.claimWorkItem(item.id, { memberId: other.id, executionId: e3 }),
        /其他 Member/,
      );

      // 全部放行 → E1 completed（终态）→ 新一轮 E4 可以重绑：
      // claimed_execution_id 永远指向「正在驱动它的那一轮」。
      release();
      stub.hold = null;
      await waitFor(() => stack.team.getExecution(e1).status === 'completed', 'E1 完成');

      holdTurn();
      const sent4 = await stack.team.sendMessage({ conversationId: room1.id, content: '第三轮' });
      const e4 = singleExecutionId(db, room1.id, sent4.wakes);
      await waitFor(() => stack.team.getExecution(e4).status === 'running', 'E4 running');
      const rebound = structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e4 });
      assert.equal(rebound.claimedExecutionId, e4, 'claim 换到新一轮 execution');
      assert.equal(rebound.claimedByMemberId, agent.id, '负责人不变');
      assert.equal(stack.team.getExecution(e4).workItemId, item.id, '双向绑定同步');
      release();
      stub.hold = null;
      await waitFor(() => stack.team.getExecution(e4).status === 'completed', 'E4 完成');

      // E4 failed（retry 场景）→ E5 同样可以重绑。
      db.prepare(`UPDATE execution SET status = 'failed', error = 'boom' WHERE id = ?`).run(e4);
      holdTurn();
      const sent5 = await stack.team.sendMessage({ conversationId: room1.id, content: '重试轮' });
      const e5 = singleExecutionId(db, room1.id, sent5.wakes);
      await waitFor(() => stack.team.getExecution(e5).status === 'running', 'E5 running');
      const retried = structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e5 });
      assert.equal(retried.claimedExecutionId, e5, 'failed 后同 Member 重绑成功');
    } finally {
      stub.hold = null;
      release();
    }
  });

  it('execution cancelled 自动释放 claim；failed 保留给 retry', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'ReleaseAgent', role: 'E' });
    const room = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
    const item = structure.createWorkItem(team.id, { title: 'Cancel releases' }, HUMAN);

    const sent = await stack.team.sendMessage({
      conversationId: room.id,
      content: 'go',
      targetMemberId: agent.id,
    });
    const e1 = singleExecutionId(db, room.id, sent.wakes);
    await waitFor(() => stack.team.getExecution(e1).status === 'completed', 'E1 完成');
    stub.reset();

    // cancelled：把 execution 拨回 queued 模拟「排队中被取消」→
    // cancelExecution 走落库分支，claim 必须同步释放。
    db.prepare(`UPDATE execution SET status = 'queued' WHERE id = ?`).run(e1);
    structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e1 });
    await stack.team.cancelExecution(e1);
    assert.equal(stack.team.getExecution(e1).status, 'cancelled');
    assert.equal(structure.getWorkItem(item.id).claimedByMemberId, null, '取消后锁释放');
    assert.equal(structure.getWorkItem(item.id).claimedExecutionId, null);

    // failed：锁保留 —— retry 是同一个 Member 接着干，不该被别人抢走。
    db.prepare(`UPDATE execution SET status = 'queued' WHERE id = ?`).run(e1);
    structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e1 });
    db.prepare(`UPDATE execution SET status = 'failed', error = 'boom' WHERE id = ?`).run(e1);
    assert.equal(structure.getWorkItem(item.id).claimedByMemberId, agent.id, 'failed 不释放锁');
  });

  it('interrupted 自动释放 claim（恢复路径把 queued 标 interrupted 时）', async () => {
    const { StubCopilot } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'InterruptAgent', role: 'E' });
    const room = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
    const item = structure.createWorkItem(team.id, { title: 'Interrupt releases' }, HUMAN);

    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'go' });
      const e1 = singleExecutionId(db, room.id, sent.wakes);
      structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e1 });
      release();
      stub.hold = null;
      await waitFor(() => stack.team.getExecution(e1).status === 'completed', 'E1 完成');

      // 重放恢复场景：成员先归档（此时 E1 已完成，不挡归档），再把 execution
      // 拨回 queued → resumeQueuedExecution 开跑前校验失败，标 interrupted。
      stack.team.updateMember(agent.id, { status: 'archived' });
      db.prepare(`UPDATE execution SET status = 'queued' WHERE id = ?`).run(e1);
      await stack.team.resumeQueuedExecution(e1);
      assert.equal(stack.team.getExecution(e1).status, 'interrupted');
      assert.equal(structure.getWorkItem(item.id).claimedByMemberId, null, 'interrupted 后锁释放');
    } finally {
      if (stub.hold) {
        release();
        stub.hold = null;
      }
    }
    stack.team.updateMember(agent.id, { status: 'active' });
  });
});

describe('WorkItem Activity History', () => {
  it('create/assign/claim/status/release 每一步都留下流水，顺序完整', () => {
    const agent = makeAgent('HistoryAgent');
    const item = structure.createWorkItem(team.id, { title: 'Audited' }, HUMAN);
    structure.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id }, HUMAN);
    structure.claimWorkItem(item.id, { memberId: agent.id });
    structure.updateWorkItem(item.id, { status: 'blocked' }, { kind: 'agent', principalId: agent.id });
    structure.releaseWorkItem(item.id, { kind: 'agent', principalId: agent.id });

    const events = structure.listWorkItemEvents(team.id, item.id);
    assert.deepEqual(
      events.map((e) => e.eventType),
      ['created', 'assigned', 'claimed', 'status_changed', 'released'],
      '流水按时间正序，且每类 mutation 各有一条',
    );

    const assigned = events.find((e) => e.eventType === 'assigned');
    assert.equal(assigned?.actorKind, 'human');
    assert.equal(assigned?.actorId, 'local-user');
    assert.equal(assigned?.toAssigneeId, agent.id);

    const claimed = events.find((e) => e.eventType === 'claimed');
    assert.equal(claimed?.actorKind, 'agent');
    assert.equal(claimed?.toClaimedByMemberId, agent.id);

    const statusChange = events.find((e) => e.eventType === 'status_changed');
    assert.equal(statusChange?.fromStatus, 'in_progress');
    assert.equal(statusChange?.toStatus, 'blocked');

    const released = events.find((e) => e.eventType === 'released');
    assert.equal(released?.fromClaimedByMemberId, agent.id);
    assert.equal(released?.toClaimedByMemberId, null);
  });

  it('done 收口时的 claim 清空也记 released（actor 是做收口的人）', () => {
    const agent = makeAgent('DoneHistory');
    const item = structure.createWorkItem(team.id, { title: 'Finish with audit' }, HUMAN);
    structure.claimWorkItem(item.id, { memberId: agent.id });
    structure.updateWorkItem(item.id, { status: 'done' }, { kind: 'agent', principalId: agent.id });

    const released = structure
      .listWorkItemEvents(team.id, item.id)
      .filter((e) => e.eventType === 'released');
    assert.equal(released.length, 1);
    assert.equal(released[0].actorKind, 'agent');
    assert.equal(released[0].actorId, agent.id);
  });

  it('execution 被取消时的自动释放记 system 流水并带 execution', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const agent = stack.team.createMember({ name: 'SysRelease', role: 'E' });
    const room = stack.team.createConversation({ kind: 'direct', memberIds: [agent.id] });
    const item = structure.createWorkItem(team.id, { title: 'System release' }, HUMAN);

    const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'go', targetMemberId: agent.id });
    const e1 = singleExecutionId(db, room.id, sent.wakes);
    await waitFor(() => stack.team.getExecution(e1).status === 'completed', 'E1 完成');
    db.prepare(`UPDATE execution SET status = 'queued' WHERE id = ?`).run(e1);
    structure.claimWorkItem(item.id, { memberId: agent.id, executionId: e1 });
    await stack.team.cancelExecution(e1);

    const released = structure
      .listWorkItemEvents(team.id, item.id)
      .find((e) => e.eventType === 'released');
    assert.equal(released?.actorKind, 'system', '这不是人的决定，是引擎收口');
    assert.equal(released?.executionId, e1, '能查到是哪一轮执行触发的释放');
    assert.equal(released?.fromClaimedByMemberId, agent.id);
  });

  it('跨 Team 读流水被拦：先验证归属再查', () => {
    const item = structure.createWorkItem(team.id, { title: 'Owned' }, HUMAN);
    assert.throws(() => structure.listWorkItemEvents('other-team', item.id), /不存在/);
    assert.throws(() => structure.listWorkItemEvents(team.id, 'no-such-item'), /不存在/);
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
    app.use('/api/team', teamRouter(structure, new TeamEventService(db)));
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
    const item = structure.createWorkItem(team.id, { title: 'Spoof' }, HUMAN);
    const res = await fetch(`${base}/api/team/work-items/${item.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': agent.id },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });

  it('Team 成员（human）可以读 work-items 与 events；claim 对 human 也是 403', async () => {
    const read = await fetch(`${base}/api/team/work-items`);
    assert.equal(read.status, 200);

    const item = structure.createWorkItem(team.id, { title: 'Human claim' }, HUMAN);
    const events = await fetch(`${base}/api/team/work-items/${item.id}/events`);
    assert.equal(events.status, 200);
    const body = (await events.json()) as { events: Array<{ eventType: string }> };
    assert.ok(body.events.some((e) => e.eventType === 'created'));

    const res = await fetch(`${base}/api/team/work-items/${item.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });

  it('Agent 经 /api/internal claim：无 token 401；带 token 成功并回写 execution', async () => {
    config.internalApiToken = 'internal-secret';
    const item = structure.createWorkItem(team.id, { title: 'Internal claim' }, HUMAN);
    structure.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id }, HUMAN);

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

describe('Team SSE', () => {
  it('mutation → 同事务落 team_event → commit 后广播；sequence 严格递增', () => {
    const events = new TeamEventService(db);
    // 带 sink 的结构服务实例：真实链路是结构服务回调 → append → commit 后广播。
    const emitting = new TeamStructureService(db, (teamId, type, payload) => events.append(teamId, type, payload));
    const agent = makeAgent('SseAgent');

    const seen: Array<{ type: string; sequence: number }> = [];
    const unsubscribe = events.subscribe(team.id, (event) => {
      seen.push({ type: event.type, sequence: event.sequence });
    });

    try {
      const item = emitting.createWorkItem(team.id, { title: 'Sse item' }, HUMAN);
      emitting.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id }, HUMAN);
      emitting.claimWorkItem(item.id, { memberId: agent.id });

      assert.deepEqual(
        seen.map((e) => e.type),
        ['work_item.changed', 'work_item.changed', 'work_item.changed'],
        '每次 mutation 恰好一条事件',
      );
      for (let i = 1; i < seen.length; i += 1) {
        assert.ok(seen[i].sequence > seen[i - 1].sequence, 'sequence 严格递增');
      }
      // sequence 由 team.event_sequence 分配：与落库行严格一致
      assert.equal(
        (db.prepare(`SELECT event_sequence AS n FROM team WHERE id = ?`).get(team.id) as { n: number }).n,
        (db.prepare(`SELECT COUNT(*) AS n FROM team_event WHERE team_id = ?`).get(team.id) as { n: number }).n,
      );

      // 回放窗口：从 0 回放包含刚才全部事件，不重不漏
      const replayed = events.listSince(team.id, 0);
      assert.equal(replayed.length, seen.length);
      assert.deepEqual(replayed.map((e) => e.sequence), seen.map((e) => e.sequence));
    } finally {
      unsubscribe();
    }
  });

  it('mutation 回滚时 team_event 一起回滚：广播的永远是 DB 承认过的', () => {
    const events = new TeamEventService(db);
    const emitting = new TeamStructureService(db, (teamId, type, payload) => events.append(teamId, type, payload));
    const agent = makeAgent('SseRollback');

    const before = (db.prepare(`SELECT COUNT(*) AS n FROM team_event WHERE team_id = ?`).get(team.id) as { n: number }).n;
    const item = emitting.createWorkItem(team.id, { title: 'Rollback probe' }, HUMAN);
    emitting.claimWorkItem(item.id, { memberId: agent.id });
    // 这个 assign 会 409（已 claim）→ 整个事务回滚 → 不得留下事件行
    assert.throws(() => emitting.assignWorkItem(item.id, { kind: 'agent', principalId: agent.id }, HUMAN));

    const after = (db.prepare(`SELECT COUNT(*) AS n FROM team_event WHERE team_id = ?`).get(team.id) as { n: number }).n;
    // create 与 claim 各落一条事件；409 的 assign 整个事务回滚，不得留下事件行。
    assert.equal(after - before, 2, 'create + claim 各留一条事件，回滚的 assign 没有');
    assert.equal(
      (db.prepare(`SELECT event_sequence AS n FROM team WHERE id = ?`).get(team.id) as { n: number }).n,
      after,
      '游标与行数严格一致 —— 差一条就是 replay 会重放或漏发一条',
    );
  });

  it('HTTP：GET /api/team/events 按 SSE 帧推送（id 带 sequence）', async () => {
    const events = new TeamEventService(db);
    const emitting = new TeamStructureService(db, (teamId, type, payload) => events.append(teamId, type, payload));
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/team', teamRouter(emitting, events));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;

    try {
      const response = await fetch(`${base}/api/team/events`);
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      // 订阅就绪后触发一次 mutation，读到的帧里应包含 work_item.changed + id
      const firstChunk = decoder.decode((await reader.read()).value);
      assert.match(firstChunk, /retry: 3000/);
      assert.match(firstChunk, /event: connected/);

      const item = emitting.createWorkItem(team.id, { title: 'Sse over http' }, HUMAN);
      void item;

      let buffer = firstChunk;
      for (let i = 0; i < 50 && !buffer.includes('work_item.changed'); i += 1) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value);
      }
      assert.match(buffer, /id: \d+\nevent: work_item\.changed/);
      await reader.cancel();
    } finally {
      server.close();
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
