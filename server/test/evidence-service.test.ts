import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 依据链的契约测试。
 *
 * 这条链的价值全在边界上，所以这里测的不是「能打分」，而是五件必须一直成立的事：
 *
 *   1. 分数只由「来源权威等级 × 支持程度」决定，Agent 报不了分
 *   2. 引用必须是**这一轮真的检索过**的 —— 真实存在但没看过的 citation 记 0 分，
 *      而且留在记录里，让人看得出发生过什么
 *   3. 「引用了什么」不等于「结论对不对」：三个状态字段互不代替
 *   4. 审核要求只能来自任务上的开关（人设的），而且已经判过的不被开关拨回去
 *   5. 没跑完 / 跑挂了 / 跑完了但没依据，三种情况在审计里长得不一样
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-evidence-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { TaskService } = await import('../task-service.js');
const { createCapabilityStack, capabilityContext } = await import('./support.js');
const { TeamStructureService } = await import('../team-structure-service.js');
const { CoreTeamToolProvider } = await import('../capabilities/providers/core-tools.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memberService = new MemberService(db);
const stack = createCapabilityStack(db, memberService, () => {
  throw new Error('这条用例不该执行 team 工具');
});
const knowledge = stack.knowledge;
const capabilities = stack.capabilities;
const evidence = stack.evidence;
const team = new TeamStructureService(db).ensureDefaultTeam();
const tasks = new TaskService(db);

const member = memberService.create({ name: 'Analyst', handle: 'analyst', role: 'Analyst' });
const outsider = memberService.create({ name: 'Outsider', handle: 'outsider', role: 'Analyst' });

/** 建一个库 + 一份文档，返回它的 citation。authority 由用例指定。 */
function baseWithDocument(
  key: string,
  authority: 'authoritative' | 'approved' | 'reference',
  content: string,
): { citation: string; knowledgeBaseId: string } {
  const kb = knowledge.createTeamKnowledgeBase({ key, name: key, authority });
  const document = knowledge.writeDocument({
    knowledgeBaseId: kb.id,
    title: `${key} policy`,
    relativePath: 'policy.md',
    content,
  });
  return { citation: `[KB:${kb.key}/${document.id}]`, knowledgeBaseId: kb.id };
}

function bind(memberId: string, selectors: string[]): void {
  capabilities.replaceMember(memberId, {
    skills: [],
    knowledge: selectors.map((selector) => ({ providerId: knowledge.id, selector })),
    tools: [{ providerId: 'knowledge.tools' }, { providerId: 'team.core-tools' }],
  });
}

/**
 * 一条真实存在的 execution。
 *
 * 依据链外键到 execution，而「这一轮」这个概念只在它存在时才成立 —— 用编出来的
 * id 会让写入撞外键，而失败表现是「检索挂了」，真正的原因却被藏起来了。
 */
function newConversation(memberId: string): string {
  const conversationId = `conv-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversation (id, team_id, title, kind, created_by, created_at, updated_at)
     VALUES (?, ?, 'evidence fixture', 'task', ?, ?, ?)`,
  ).run(conversationId, team.id, memberId, timestamp, timestamp);
  return conversationId;
}

function newExecution(memberId: string, taskId: string | null = null): string {
  const executionId = `exec-${randomUUID()}`;
  db.prepare(
    `INSERT INTO execution (id, conversation_id, member_id, task_id, goal_revision, kind, status, prompt, created_at)
     VALUES (?, ?, ?, ?, 0, 'interactive', 'running', 'fixture', ?)`,
  ).run(executionId, newConversation(memberId), memberId, taskId, new Date().toISOString());
  return executionId;
}

/**
 * 真的调一次 `search_knowledge`，返回它给的 citation。
 *
 * 走完整链路（resolver → 检索工具 → EvidenceService），不是直接调 recordSeen：
 * 依据链的地基是「检索工具会回写足迹」，只测 EvidenceService 的话，这条接线
 * 断掉也全绿 —— 而断了之后整条链就退回成 Agent 自述。
 */
async function retrieve(memberId: string, executionId: string, query: string): Promise<string[]> {
  const context = { ...capabilityContext(memberId, team.id), executionId };
  const resolved = await stack.resolver.resolve(
    context,
    capabilities.getEffective(team.id, memberId),
  );
  const search = resolved.toolIndex.get('search_knowledge');
  assert.ok(search, '检索工具没解析出来：这条用例靠它写检索足迹');

  const payload = JSON.parse(
    String(await search.execute!({ ...context, toolName: 'search_knowledge' }, { query })),
  ) as { hits: Array<{ citation: string }> };
  return payload.hits.map((hit) => hit.citation);
}

function report(
  executionId: string,
  claims: Array<{ claim: string; citations: string[]; support: 'direct' | 'partial' | 'weak' }>,
): Promise<import('../evidence-service.js').ExecutionEvidence> {
  return evidence.recordEvidence(executionId, claims).then(() => evidence.get(executionId)!);
}

// ------------------------------------------------------------------ 打分

describe('依据强度：只由来源等级与支持程度决定', () => {
  it('正式来源 + 直接支持 = 100（high）', async () => {
    baseWithDocument('authoritative-base', 'authoritative', 'annual fee is 1.2%');
    bind(member.id, ['authoritative-base']);
    const executionId = newExecution(member.id);
    const [citation] = await retrieve(member.id, executionId, 'annual');

    const result = await report(executionId, [
      { claim: '年费是 1.2%', citations: [citation], support: 'direct' },
    ]);
    assert.equal(result.evidenceScore, 100);
    assert.equal(result.evidenceLevel, 'high');
  });

  it('已审核来源 + 直接支持 = 80（medium）', async () => {
    baseWithDocument('approved-base', 'approved', 'annual fee is 1.2%');
    bind(member.id, ['approved-base']);
    const executionId = newExecution(member.id);
    const [citation] = await retrieve(member.id, executionId, 'annual');

    const result = await report(executionId, [
      { claim: '年费是 1.2%', citations: [citation], support: 'direct' },
    ]);
    assert.equal(result.evidenceScore, 80);
    assert.equal(result.evidenceLevel, 'medium');
  });

  it('参考来源 + 部分支持 = 30（low）', async () => {
    baseWithDocument('reference-base', 'reference', 'annual fee is 1.2%');
    bind(member.id, ['reference-base']);
    const executionId = newExecution(member.id);
    const [citation] = await retrieve(member.id, executionId, 'annual');

    const result = await report(executionId, [
      { claim: '年费大约是 1.2%', citations: [citation], support: 'partial' },
    ]);
    assert.equal(result.evidenceScore, 30);
    assert.equal(result.evidenceLevel, 'low');
  });

  /**
   * 只取最强的那份材料，不累加。
   *
   * 反过来写（把 authority 加起来或取平均）就等于说「五份笔记顶得上一份正式
   * 政策」—— 那正是堆引用数换分数的动机所在。
   */
  it('多份引用只取最强的一份，不会因为引用多就变高', async () => {
    baseWithDocument('weak-base', 'reference', 'annual fee is 1.2%');
    baseWithDocument('strong-base', 'authoritative', 'annual fee is 1.2%');
    bind(member.id, ['weak-base', 'strong-base']);
    const executionId = newExecution(member.id);
    const citations = await retrieve(member.id, executionId, 'annual');
    assert.equal(citations.length, 2, '两份材料都要被检索到，否则这条用例没在测「多份」');

    const result = await report(executionId, [
      { claim: '年费是 1.2%', citations: [...citations, ...citations], support: 'direct' },
    ]);
    assert.equal(result.evidenceScore, 100);
  });
});

// ------------------------------------------------------- 引用必须真的检索过

describe('引用必须是这一轮真的检索过的', () => {
  it('编造的 citation（格式对、材料不存在）= 0 分', async () => {
    baseWithDocument('forged-base', 'authoritative', 'annual fee is 1.2%');
    bind(member.id, ['forged-base']);
    const executionId = newExecution(member.id);
    const forged = '[KB:forged-base/not-a-real-document]';
    // 真的检索过一次（拿到的是真 citation），但申报时用的是编的那个。
    await retrieve(member.id, executionId, 'annual');

    const result = await report(executionId, [
      { claim: '年费是 1.2%', citations: [forged], support: 'direct' },
    ]);
    assert.equal(result.evidenceScore, 0);
    assert.deepEqual(result.claims[0].sources, []);
  });

  /**
   * 这一条是「citation 洗衣」的正面用例：材料真实存在、格式也对，但这一轮
   * 根本没检索过它。
   *
   * 少了它，「引用」就只是 Agent 的一句自述 —— 它可以拿团队政策库里任何一份
   * 文档去支持任何结论，而分数照样是 100。
   */
  it('材料真实存在但这一轮没检索过 = 0 分，并记进 unseen', async () => {
    const { citation } = baseWithDocument('unseen-base', 'authoritative', 'annual fee is 1.2%');
    bind(member.id, ['unseen-base']);
    const executionId = newExecution(member.id);
    // 刻意不调 retrieve：这一轮没看过它。

    const result = await report(executionId, [
      { claim: '年费是 1.2%', citations: [citation], support: 'direct' },
    ]);
    assert.equal(result.evidenceScore, 0);
    assert.deepEqual(
      result.claims[0].unseen,
      [citation],
      '没检索过的引用要留在记录里 —— 审计里只剩一个 0 分，看不出为什么是 0',
    );
  });

  it('这个 Member 看不到的库，引用它也不算依据', async () => {
    const { citation } = baseWithDocument('forbidden-base', 'authoritative', 'annual fee is 1.2%');
    bind(outsider.id, ['forbidden-base']);
    const executionId = newExecution(outsider.id);
    await retrieve(outsider.id, executionId, 'annual');

    // 拿掉这条 binding：同一个 citation 它就解析不出来了，于是不算依据。
    bind(outsider.id, []);
    const result = await report(executionId, [
      { claim: '年费是 1.2%', citations: [citation], support: 'direct' },
    ]);
    assert.equal(result.evidenceScore, 0);
  });
});

// -------------------------------------------------------------- Agent 报不了分

describe('分数只能由服务器算', () => {
  it('report_evidence 的参数里没有 score，多传会被拒绝', async () => {
    const provider = new CoreTeamToolProvider({
      delegateMember: async () => '',
      rememberMember: async () => '',
      messageMember: async () => ({ conversationId: '', messageId: '' }),
      requestClarification: async () => '',
      planTasks: async () => '',
      addTask: async () => '',
      reassignTask: async () => '',
      updateGoal: async () => '',
      replanTasks: async () => '',
      updateTask: async () => '',
      reportEvidence: async () => 'ok',
    });
    const tools = await provider.resolve(
      {
        ...capabilityContext(member.id, team.id),
        executionId: 'exec-x',
        memberCapabilities: capabilities.getEffective(team.id, member.id),
        knowledge: [],
      },
      { providerId: 'team.core-tools' } as never,
    );
    const tool = tools.find((item) => item.name === 'report_evidence');
    assert.ok(tool, 'report_evidence 必须出现在核心工具里，否则 Agent 根本没法申报依据');

    // custom tool 的 parameters 一定是 zod schema（类型上是联合，因为 builtin
    // 工具可能只带 JSON Schema 对象）。
    const schema = tool.parameters as { safeParse: (value: unknown) => { success: boolean } };
    // zod 默认是「剥掉多余键」，那样「Agent 给自己打 97 分」会变成一个无声通过
    // 的请求。这里要的是拒绝。
    assert.equal(
      schema.safeParse({
        claims: [{ claim: 'x', citations: ['[KB:a/b]'], support: 'direct', score: 97 }],
      }).success,
      false,
      'Agent 不能给自己打分：多传 score 必须被拒绝，而不是被静默忽略',
    );
  });
});

// ------------------------------------------------------------------ 收口

describe('收口：三个状态互不代替', () => {
  it('跑完但一次都没申报 → 0 分记录存在，而不是查不到', () => {
    const executionId = newExecution(member.id);
    const result = evidence.finalizeExecution(executionId);
    assert.equal(result.evidenceScore, 0);
    assert.equal(result.evidenceLevel, 'low');
    assert.equal(result.reviewStatus, 'not_required');
    assert.deepEqual(result.claims, []);
  });

  /**
   * 「没提供依据」和「没跑完」必须分得开：前者是一次 0 分记录，后者是查不到。
   * 合在一起的话，审计里「这一轮什么都没查」就会有两种长得一样的原因。
   */
  it('跑挂的 execution 也收口，留下 0 分记录', () => {
    const executionId = newExecution(member.id);
    db.prepare(`UPDATE execution SET status = 'failed' WHERE id = ?`).run(executionId);
    const result = evidence.finalizeExecution(executionId);
    assert.equal(result.evidenceScore, 0);
    assert.equal(result.evidenceLevel, 'low');
  });

  it('任务标了要人看 → 收口后是 pending，审核后变 approved', async () => {
    const task = tasks.add({
      conversationId: newConversation(member.id),
      title: '核对年费',
      description: '',
      assigneeMemberId: member.id,
    });
    // Agent 的写入路径上这个开关永远是关的。
    assert.equal(task.requiresHumanReview, false);

    const executionId = newExecution(member.id, task.id);
    tasks.setRequiresHumanReview(task.id, true);

    const finalized = evidence.finalizeExecution(executionId);
    assert.equal(finalized.reviewRequired, true);
    assert.equal(finalized.reviewStatus, 'pending');
    assert.equal(finalized.verificationLevel, 'none');

    const reviewed = evidence.review(executionId, 'human-1', 'approved', '对照现行政策看过');
    assert.equal(reviewed.reviewStatus, 'approved');
    assert.equal(reviewed.verificationLevel, 'human');
    assert.equal(reviewed.reviewedBy, 'human-1');
  });

  it('已经判过的不被开关拨回 pending', () => {
    const task = tasks.add({
      conversationId: newConversation(member.id),
      title: '复核',
      description: '',
      assigneeMemberId: member.id,
    });

    const executionId = newExecution(member.id, task.id);
    tasks.setRequiresHumanReview(task.id, true);
    evidence.finalizeExecution(executionId);
    evidence.review(executionId, 'human-1', 'rejected', '依据和政策不一致');

    // 开关来回拨动不该把人做过的决定抹掉。
    tasks.setRequiresHumanReview(task.id, false);
    assert.equal(evidence.finalizeExecution(executionId).reviewStatus, 'rejected');
    tasks.setRequiresHumanReview(task.id, true);
    assert.equal(evidence.finalizeExecution(executionId).reviewStatus, 'rejected');
  });

  it('没标要人看的执行，不能审核', () => {
    const executionId = newExecution(member.id);
    evidence.finalizeExecution(executionId);
    assert.throws(
      () => evidence.review(executionId, 'human-1', 'approved', ''),
      /不用审核/,
    );
  });
});

// ------------------------------------------------------------- 来源等级

describe('资料来源等级', () => {
  it('个人库固定是参考：再怎么设也不 authoritative', () => {
    const personal = knowledge.ensurePersonalKnowledgeBase(member.id, member.name);
    assert.equal(personal.authority, 'reference');
    assert.throws(
      () => knowledge.updateTeamKnowledgeBaseAuthority(personal.id, 'authoritative'),
      /只有团队资料库/,
    );
  });

  it('团队库的等级可以改，并影响后续打分', async () => {
    const { knowledgeBaseId } = baseWithDocument('mutable-base', 'reference', 'fee is 1.2%');
    bind(member.id, ['mutable-base']);

    const executionId = newExecution(member.id);
    const [citation] = await retrieve(member.id, executionId, 'fee');
    const before = await report(executionId, [
      { claim: '费率 1.2%', citations: [citation], support: 'direct' },
    ]);
    assert.equal(before.evidenceScore, 50);

    knowledge.updateTeamKnowledgeBaseAuthority(knowledgeBaseId, 'authoritative');
    const after = await report(executionId, [
      { claim: '费率 1.2%', citations: [citation], support: 'direct' },
    ]);
    assert.equal(after.evidenceScore, 100);
  });
});
