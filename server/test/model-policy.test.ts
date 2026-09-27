import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-model-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { modelPolicy } = await import('../config.js');
const {
  buildModelPolicy,
  parseModelList,
  parseModelStrengths,
  resolveMemberModel,
  classifyLeadTurn,
  chooseLeadModel,
} = await import('../model-policy.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack, reportTaskTurns, singleExecutionId } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);
// 同 task-service.test.ts：stub 扮演守规矩的 Agent，Task turn 内正常完工。
reportTaskTurns(team, stub);

const requirements = { facts: [], assumptions: [], constraints: [], successCriteria: [] };

async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_for_member')`,
      )
      .get(conversationId) as unknown as { n: number };
    if (row.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`conversation ${conversationId} 仍有未完成的 execution`);
}

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('模型策略配置', () => {
  it('Strong Lead > Standard Lead >= Member', () => {
    const policy = buildModelPolicy({
      strongLeadModel: 'gpt-5',
      standardLeadModel: 'gpt-5-mini',
      memberModels: ['gpt-5-mini', 'gpt-4.1-mini'],
      strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":60,"gpt-4.1-mini":40}'),
    });
    assert.equal(policy.lead.strong.id, 'gpt-5');
    assert.equal(policy.lead.standard.id, 'gpt-5-mini');
    assert.equal(policy.members[0].tier, 'standard');
    assert.equal(policy.members[1].tier, 'cheap');
    assert.equal(policy.defaultMemberModel, 'gpt-5-mini');
    assert.ok(policy.lead.strong.strength > policy.lead.standard.strength);
    for (const member of policy.members) {
      assert.ok(policy.lead.standard.strength >= member.strength);
    }
  });

  it('Strong Lead 不强于 Standard Lead 时启动失败', () => {
    assert.throws(
      () =>
        buildModelPolicy({
          strongLeadModel: 'gpt-5',
          standardLeadModel: 'gpt-5-mini',
          memberModels: ['gpt-4.1-mini'],
          strengths: parseModelStrengths('{"gpt-5":60,"gpt-5-mini":100,"gpt-4.1-mini":40}'),
        }),
      /必须强于/,
    );
  });

  it('Member 不得超过 Standard Lead', () => {
    assert.throws(
      () =>
        buildModelPolicy({
          strongLeadModel: 'gpt-5',
          standardLeadModel: 'gpt-5-mini',
          memberModels: ['gpt-6'],
          strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":60,"gpt-6":80}'),
        }),
      /高于 Standard Lead/,
    );
  });

  it('Member strength 等于 Standard Lead 时为 Standard', () => {
    const policy = buildModelPolicy({
      strongLeadModel: 'gpt-5',
      standardLeadModel: 'gpt-5-mini',
      memberModels: ['gpt-5-mini'],
      strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":60}'),
    });
    assert.equal(policy.members[0].tier, 'standard');
  });

  it('低于 Standard Lead 的 Member 是 Cheap', () => {
    const policy = buildModelPolicy({
      strongLeadModel: 'gpt-5',
      standardLeadModel: 'gpt-5-mini',
      memberModels: ['gpt-4.1-mini'],
      strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":60,"gpt-4.1-mini":40}'),
    });
    assert.equal(policy.members[0].tier, 'cheap');
  });

  it('Strong Lead 不能作为普通 Task 模型', () => {
    const policy = buildModelPolicy({
      strongLeadModel: 'gpt-5',
      standardLeadModel: 'gpt-5-mini',
      memberModels: ['gpt-5-mini', 'gpt-4.1-mini'],
      strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":60,"gpt-4.1-mini":40}'),
    });
    assert.throws(() => resolveMemberModel(policy, 'gpt-5'), /Strong Lead/);
  });

  it('不存在的 Member 模型被拒绝，空回落默认', () => {
    assert.throws(() => resolveMemberModel(modelPolicy, 'gpt-不存在'), /未知模型/);
    assert.equal(resolveMemberModel(modelPolicy, null), modelPolicy.defaultMemberModel);
  });

  it('建 Member / 改 Member 时 Strong 与拼错都被拒绝', () => {
    const member = team.createMember({ name: 'Model Pam', role: 'Engineer' });
    assert.throws(() => team.updateMember(member.id, { model: modelPolicy.lead.strong.id }), /Strong Lead/);
    assert.throws(() => team.updateMember(member.id, { model: 'gpt-拼错了' }), /未知模型/);
    assert.throws(
      () => team.createMember({ name: 'Model Evil', role: 'X', model: modelPolicy.lead.strong.id }),
      /Strong Lead/,
    );
    const updated = team.updateMember(member.id, { model: modelPolicy.members[0].id });
    assert.equal(updated.model, modelPolicy.members[0].id);
    assert.equal(team.updateMember(member.id, { model: null }).model, null);
  });

  it('parseModelList 按逗号切分并去空', () => {
    assert.deepEqual(parseModelList('a, b,,c '), ['a', 'b', 'c']);
  });
});

describe('Lead model routing', () => {
  const policy = buildModelPolicy({
    strongLeadModel: 'gpt-5',
    standardLeadModel: 'gpt-5-mini',
    memberModels: ['gpt-5-mini', 'gpt-4.1-mini'],
    strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":60,"gpt-4.1-mini":40}'),
  });

  it('没有 Task 时 Strong', () => {
    assert.deepEqual(
      chooseLeadModel(policy, classifyLeadTurn({ wakeReason: 'lead_message', taskCount: 0, prompt: '开始' })),
      { model: 'gpt-5', purpose: 'lead:planning' },
    );
  });

  it('普通 Lead 输入使用 Standard', () => {
    assert.deepEqual(
      chooseLeadModel(
        policy,
        classifyLeadTurn({ wakeReason: 'lead_message', taskCount: 3, prompt: '现在进展怎么样？' }),
      ),
      { model: 'gpt-5-mini', purpose: 'lead:routine' },
    );
  });

  it('用户回答 clarification 使用 Strong', () => {
    assert.deepEqual(
      chooseLeadModel(
        policy,
        classifyLeadTurn({ wakeReason: 'lead_clarification', taskCount: 2, prompt: '生产环境是 us-east-1。' }),
      ),
      { model: 'gpt-5', purpose: 'lead:clarification' },
    );
  });

  it('Task recovery 使用 Strong', () => {
    assert.deepEqual(
      chooseLeadModel(policy, classifyLeadTurn({ wakeReason: 'lead_recovery', taskCount: 4, prompt: '请继续处理' })),
      { model: 'gpt-5', purpose: 'lead:recovery' },
    );
  });

  it('明确要求重新规划时使用 Strong', () => {
    assert.deepEqual(
      chooseLeadModel(
        policy,
        classifyLeadTurn({ wakeReason: 'lead_message', taskCount: 4, prompt: '重新规划当前任务并调整成员分工' }),
      ),
      { model: 'gpt-5', purpose: 'lead:synthesis' },
    );
  });

  it('普通的进度追问不升级 Strong', () => {
    assert.equal(
      classifyLeadTurn({ wakeReason: 'lead_message', taskCount: 4, prompt: '现在怎么样了' }),
      'routine',
    );
  });
});

describe('执行时模型选择', () => {
  it('首次 Lead turn 使用 Strong', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Dynamic Lead', role: 'Lead', model: modelPolicy.members[0].id });
    const room = team.createConversation({
      kind: 'task',
      title: 'DynamicLead',
      memberIds: [lead.id],
      leadMemberId: lead.id,
    });
    const result = await team.sendMessage({ conversationId: room.id, content: '帮我开始这个工作' });
    const executionId = singleExecutionId(db, room.id, result.wakes);
    await waitForConversationIdle(room.id);

    assert.equal(stub.turnFor(executionId).model, modelPolicy.lead.strong.id);
    assert.equal(team.getExecution(executionId).configSnapshot?.modelPurpose, 'lead:planning');
  });

  it('已有 Task 时普通 Lead 输入使用 Standard', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Routine Lead', role: 'Lead' });
    const worker = team.createMember({ name: 'Routine Worker', role: 'Engineer' });
    const room = team.createConversation({
      kind: 'task',
      title: 'RoutineLead',
      memberIds: [lead.id, worker.id],
      leadMemberId: lead.id,
    });
    // 执行人静音：任务保持 ready 不开跑，Lead 这一轮的 taskCount 才稳定
    team.setMemberMuted(room.id, worker.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: lead.id,
      objective: '普通 Lead 测试',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: worker.id }],
    });
    const result = await team.sendMessage({ conversationId: room.id, content: '现在进展怎么样？' });
    const executionId = singleExecutionId(db, room.id, result.wakes);
    await waitForConversationIdle(room.id);

    assert.equal(stub.turnFor(executionId).model, modelPolicy.lead.standard.id);
    assert.equal(team.getExecution(executionId).configSnapshot?.modelPurpose, 'lead:routine');
  });

  it('用户回答 clarification 时 Lead 使用 Strong', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Clarification Lead', role: 'Lead' });
    const room = team.createConversation({
      kind: 'task',
      title: 'ClarificationLead',
      memberIds: [lead.id],
      leadMemberId: lead.id,
    });
    await team.requestClarification({
      conversationId: room.id,
      memberId: lead.id,
      questions: ['生产环境是什么？'],
    });
    const result = await team.sendMessage({ conversationId: room.id, content: '生产环境是 us-east-1。' });
    const executionId = singleExecutionId(db, room.id, result.wakes);
    await waitForConversationIdle(room.id);

    assert.equal(stub.turnFor(executionId).model, modelPolicy.lead.strong.id);
    assert.equal(team.getExecution(executionId).configSnapshot?.modelPurpose, 'lead:clarification');
  });

  it('Task turn 用执行人配的模型，未配用默认 Member 模型', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Model Lead2', role: 'Lead' });
    const cheap = team.createMember({
      name: 'Model Cheap',
      role: 'Engineer',
      model: modelPolicy.members[modelPolicy.members.length - 1].id,
    });
    const plain = team.createMember({ name: 'Model Plain', role: 'Engineer' });
    assert.equal(plain.model, null);
    const room = team.createConversation({
      kind: 'task',
      title: 'TaskModel',
      memberIds: [lead.id, cheap.id, plain.id],
      leadMemberId: lead.id,
    });
    await team.planTasks({
      conversationId: room.id,
      memberId: lead.id,
      objective: '模型分流',
      requirements,
      tasks: [
        { key: 'a', title: '便宜模型做', assigneeMemberId: cheap.id },
        { key: 'b', title: '默认模型做', assigneeMemberId: plain.id },
      ],
    });
    await waitForConversationIdle(room.id);

    const tasks = team.listTasks(room.id);
    assert.ok(tasks.every((task) => task.status === 'completed'));
    for (const task of tasks) {
      const execution = db
        .prepare(`SELECT id FROM execution WHERE task_id = ? ORDER BY created_at LIMIT 1`)
        .get(task.id) as unknown as { id: string };
      const expected = task.assigneeMemberId === cheap.id ? cheap.model! : modelPolicy.defaultMemberModel;
      assert.equal(stub.turnFor(execution.id).model, expected, `任务 ${task.title} 用的模型不对`);
      const snapshot = team.getExecution(execution.id).configSnapshot;
      assert.equal(snapshot?.model, expected, '快照记录的必须是真实运行模型');
      assert.equal(snapshot?.modelPurpose, 'member:task');
    }
    // Task 完成不唤醒 Lead：Lead 全程没有 execution
    const leadRuns = db
      .prepare(`SELECT COUNT(*) AS n FROM execution WHERE conversation_id = ? AND member_id = ?`)
      .get(room.id, lead.id) as unknown as { n: number };
    assert.equal(leadRuns.n, 0, 'Task 完成不该唤醒 Lead');
    assert.equal(team.getConversation(room.id).status, 'completed');
    // Task Agent 的回答只进 Task，不进 Activity：这个房间没有任何人发过消息
    assert.equal(team.listMessages(room.id).length, 0, 'Task 执行静默，不写 conversation_message');
  });

  it('updateTask 只发 task.updated，不插消息', async () => {
    stub.reset();
    const lead = team.createMember({ name: 'Model Lead3', role: 'Lead' });
    const worker = team.createMember({ name: 'Model Worker', role: 'Engineer' });
    const room = team.createConversation({
      kind: 'task',
      title: 'UpdateSilent',
      memberIds: [lead.id, worker.id],
      leadMemberId: lead.id,
    });
    // 执行人静音：任务保持 ready 不开跑，updateTask 的调用环境才稳定
    team.setMemberMuted(room.id, worker.id, true);
    await team.planTasks({
      conversationId: room.id,
      memberId: lead.id,
      objective: '静默上报',
      requirements,
      tasks: [{ key: 'a', title: 'A', assigneeMemberId: worker.id }],
    });
    const task = team.listTasks(room.id)[0];
    const seen: string[] = [];
    const off = team.subscribe(room.id, (event) => seen.push(event.type));
    try {
      await team.updateTask({
        conversationId: room.id,
        memberId: worker.id,
        taskId: task.id,
        status: 'blocked',
        summary: '卡住了',
        blocker: '缺权限',
      });
      await waitForConversationIdle(room.id);
    } finally {
      off();
    }
    assert.ok(seen.includes('task.updated'), '进展必须广播 task.updated');
    const after = team.listMessages(room.id).filter((message) => message.senderId === worker.id);
    assert.equal(after.length, 0, 'updateTask 的 summary 不进 Activity，Task 面板即事实源');
  });
});
