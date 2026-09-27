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
  assertModelPolicy,
  buildModelPolicy,
  parseModelList,
  parseModelStrengths,
  resolveMemberModel,
} = await import('../model-policy.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack, singleExecutionId } = await import('./support.js');
import type { CopilotService } from '../copilot.js';

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot as unknown as CopilotService);

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
  it('Lead 强度高于所有 Member 模型，默认取第一个', () => {
    const policy = buildModelPolicy({
      leadModel: 'gpt-5',
      memberModels: ['gpt-5-mini', 'gpt-4.1-mini'],
      strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":60,"gpt-4.1-mini":40}'),
    });
    assert.equal(policy.lead.id, 'gpt-5');
    assert.equal(policy.defaultMemberModel, 'gpt-5-mini');
    for (const member of policy.members) {
      assert.ok(policy.lead.strength > member.strength);
    }
  });

  it('同 strength 的 Member 模型启动失败', () => {
    assert.throws(
      () =>
        buildModelPolicy({
          leadModel: 'gpt-5',
          memberModels: ['gpt-5-mini'],
          strengths: parseModelStrengths('{"gpt-5":100,"gpt-5-mini":100}'),
        }),
      /strength/,
    );
  });

  it('比 Lead 更强的 Member 模型启动失败', () => {
    assert.throws(
      () =>
        assertModelPolicy({
          lead: { id: 'gpt-5', strength: 100 },
          members: [{ id: 'gpt-6', strength: 120 }],
          defaultMemberModel: 'gpt-6',
        }),
      /gpt-6/,
    );
  });

  it('强度表里缺模型直接抛，不静默补默认值', () => {
    assert.throws(
      () =>
        buildModelPolicy({
          leadModel: 'gpt-5',
          memberModels: ['gpt-5-mini'],
          strengths: parseModelStrengths('{"gpt-5":100}'),
        }),
      /gpt-5-mini/,
    );
  });

  it('parseModelList 按逗号切分并去空', () => {
    assert.deepEqual(parseModelList('a, b,,c '), ['a', 'b', 'c']);
  });

  it('不存在的 Member 模型被拒绝', () => {
    assert.throws(() => resolveMemberModel(modelPolicy, 'gpt-不存在'), /未知模型/);
  });

  it('Lead 模型不能当普通任务模型', () => {
    assert.throws(() => resolveMemberModel(modelPolicy, modelPolicy.lead.id), /Lead 模型/);
  });

  it('空模型回落默认 Member 模型', () => {
    assert.equal(resolveMemberModel(modelPolicy, null), modelPolicy.defaultMemberModel);
    assert.equal(resolveMemberModel(modelPolicy, '  '), modelPolicy.defaultMemberModel);
  });

  it('建 Member / 改 Member 时越级与拼错都被拒绝', () => {
    const member = team.createMember({ name: 'Model Pam', role: 'Engineer' });
    assert.throws(() => team.updateMember(member.id, { model: modelPolicy.lead.id }), /Lead 模型/);
    assert.throws(() => team.updateMember(member.id, { model: 'gpt-拼错了' }), /未知模型/);
    assert.throws(
      () => team.createMember({ name: 'Model Evil', role: 'X', model: modelPolicy.lead.id }),
      /Lead 模型/,
    );
    // 合法的低档模型能写进去，清空能回落
    const updated = team.updateMember(member.id, { model: modelPolicy.members[0].id });
    assert.equal(updated.model, modelPolicy.members[0].id);
    assert.equal(team.updateMember(member.id, { model: null }).model, null);
  });
});

describe('执行时模型选择', () => {
  it('Lead turn 即使 Member 配了便宜模型，也用 leadModel', async () => {
    stub.reset();
    const cheap = modelPolicy.members[0].id;
    const lead = team.createMember({ name: 'Model Lead', role: 'Lead', model: cheap });
    const room = team.createConversation({
      kind: 'task',
      title: 'LeadModel',
      memberIds: [lead.id],
      leadMemberId: lead.id,
    });
    const sent = await team.sendMessage({ conversationId: room.id, content: '开始吧' });
    const executionId = singleExecutionId(db, room.id, sent.wakes);
    await waitForConversationIdle(room.id);

    assert.equal(stub.turnFor(executionId).model, modelPolicy.lead.id);
    const snapshot = team.getExecution(executionId).configSnapshot;
    assert.ok(snapshot, 'Lead turn 必须留下配置快照');
    assert.equal(snapshot.model, modelPolicy.lead.id, '快照记录的必须是真实运行模型');
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
      const turn = stub.turnFor(execution.id);
      const expected =
        task.assigneeMemberId === cheap.id ? cheap.model! : modelPolicy.defaultMemberModel;
      assert.equal(turn.model, expected, `任务 ${task.title} 用的模型不对`);
      assert.equal(
        team.getExecution(execution.id).configSnapshot?.model,
        expected,
        '快照记录的必须是真实运行模型',
      );
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
