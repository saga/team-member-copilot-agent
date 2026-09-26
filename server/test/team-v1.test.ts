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
const { runInTransaction } = await import('../db-tx.js');
const { MemberService } = await import('../member-service.js');
const { TeamStructureService } = await import('../team-structure-service.js');
const { SchedulerService } = await import('../scheduler-service.js');
const { TeamEventService } = await import('../team-event-service.js');
const { createTestStack, muteAllMembers } = await import('./support.js');

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
    // kind 标记是 Scheduler / UI 区分「调度产生」与「聊天产生」的依据
    assert.equal(stack.team.getExecution(executionId).kind, 'member_work');
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
      emitting.setAvailability(team.id, 'agent', agent.id, 'away');
      emitting.setAvailability(team.id, 'agent', agent.id, 'available');

      assert.deepEqual(
        seen.map((e) => e.type),
        ['presence.changed', 'presence.changed'],
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

  it('事务回滚时 team_event 一起回滚：广播的永远是 DB 承认过的', () => {
    const events = new TeamEventService(db);
    let sawBroadcast = 0;
    const unsubscribe = events.subscribe(team.id, () => {
      sawBroadcast += 1;
    });

    const before = (db.prepare(`SELECT COUNT(*) AS n FROM team_event WHERE team_id = ?`).get(team.id) as { n: number }).n;
    try {
      // 事务内先写事件行再抛错：回滚必须把事件行一起吃掉，且不触发广播。
      assert.throws(
        () =>
          runInTransaction(db, () => {
            events.append(team.id, 'presence.changed', { probe: true });
            throw new Error('rollback-probe');
          }),
        /rollback-probe/,
      );

      const after = (db.prepare(`SELECT COUNT(*) AS n FROM team_event WHERE team_id = ?`).get(team.id) as { n: number }).n;
      assert.equal(after - before, 0, '回滚的事务不得留下事件行');
      assert.equal(sawBroadcast, 0, '回滚的事务不得广播');
      assert.equal(
        (db.prepare(`SELECT event_sequence AS n FROM team WHERE id = ?`).get(team.id) as { n: number }).n,
        after,
        '游标与行数严格一致 —— 差一条就是 replay 会重放或漏发一条',
      );
    } finally {
      unsubscribe();
    }
  });

});

describe('Jira 引用：本地只有 key，业务事实在 Jira', () => {
  it('conversation 的 jiraIssueKey 往返；不传为 null', async () => {
    const { StubCopilot } = await import('./support.js');
    const stack = createTestStack(db, memberService, new StubCopilot().asCopilot);
    const someone = stack.team.createMember({ name: 'JiraHolder', role: 'E' });
    const other = stack.team.createMember({ name: 'JiraSecond', role: 'E' });

    const conv = stack.team.createConversation({ kind: 'work', title: 'Policy Service', jiraIssueKey: ' ABC-123 ', memberIds: [someone.id] });
    assert.equal(stack.team.getConversation(conv.id).jiraIssueKey, 'ABC-123', '前后空格要去掉');

    const plain = stack.team.createConversation({ kind: 'group', memberIds: [someone.id, other.id] });
    assert.equal(stack.team.getConversation(plain.id).jiraIssueKey, null);
  });

  it('execution 开始时快照 jiraIssueKey，delegation 继承', async () => {
    const { StubCopilot, singleExecutionId } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'JiraWorker', role: 'E' });
    const room = stack.team.createConversation({
      kind: 'work',
      title: 'ABC-128',
      jiraIssueKey: 'ABC-128',
      memberIds: [agent.id],
    });

    const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'start work' });
    assert.equal(
      stack.team.getExecution(singleExecutionId(db, room.id, sent.wakes)).jiraIssueKey,
      'ABC-128',
      '快照取自 conversation',
    );
  });

  it('Current Activity：跑着的是 active，跑完就消失', async () => {
    const { StubCopilot, singleExecutionId } = await import('./support.js');
    const stub = new StubCopilot();
    const stack = createTestStack(db, memberService, stub.asCopilot);
    const agent = stack.team.createMember({ name: 'ActivityProbe', role: 'E' });
    const room = stack.team.createConversation({
      kind: 'work',
      title: 'ABC-130',
      jiraIssueKey: 'ABC-130',
      memberIds: [agent.id],
    });
    let release!: () => void;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sent = await stack.team.sendMessage({ conversationId: room.id, content: 'go' });
    const executionId = singleExecutionId(db, room.id, sent.wakes);
    await waitFor(() => stack.team.getExecution(executionId).status === 'running', 'execution 进入 running');
    assert.ok(
      structure.listCurrentActivity(team.id).some((a) => a.executionId === executionId && a.jiraIssueKey === 'ABC-130'),
      '运行中的 execution 必须出现在 Current Activity',
    );

    release();
    stub.hold = null;
    await waitFor(() => {
      const rows = structure.listCurrentActivity(team.id);
      return !rows.some((a) => a.executionId === executionId);
    }, 'execution 完成后从 Current Activity 消失');
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
