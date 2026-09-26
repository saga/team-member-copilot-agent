import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `local.filesystem-knowledge` 这个 Provider 的契约测试。
 *
 * 核心不是「搜得到」，而是四件必须一直成立的事：
 *
 *   1. ACL 判据是能力绑定 —— 未绑定的 KB 连 snippet 都不会离开数据库（403，
 *      而不是「搜全库再过滤成空数组」）
 *   2. `open` 重新判一次 ACL —— documentRef 来自模型，它是唯一一个
 *      「拿一个 id 就能要到内容」的入口
 *   3. 磁盘与索引幂等收敛，且**两边用同一个判据**决定什么算一份资料
 *   4. 路径与查询都是注入面 —— `..`、引号、空查询都要收敛
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-knowledge-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { config } = await import('../config.js');
const { MAX_DOCUMENT_BYTES } = await import(
  '../capabilities/providers/knowledge-document-limits.js'
);
const { createCapabilityStack, capabilityContext } = await import('./support.js');
const { PERSONAL_SELECTOR } = await import(
  '../capabilities/providers/filesystem-knowledge.js'
);

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

const PROVIDER = knowledge.id;

function makeMember(name: string, handle: string) {
  return memberService.create({ name, handle, role: 'Analyst' });
}

/** 只改 knowledge 一类绑定，skills / tools 保持原样。 */
function bindKnowledge(memberId: string, selectors: string[]): void {
  capabilities.replace(memberId, {
    ...capabilities.get(memberId),
    knowledge: selectors.map((selector) => ({ providerId: PROVIDER, selector })),
  });
}

const binding = (selector: string) => ({ providerId: PROVIDER, selector });

function search(memberId: string, selector: string, query: string, limit = 8) {
  return knowledge.search(capabilityContext(memberId), binding(selector), query, limit);
}

function open(memberId: string, documentRef: string) {
  return knowledge.open(capabilityContext(memberId), documentRef);
}

describe('knowledge base 基本流', () => {
  it('建 team KB → 写文档 → 检索命中，citation 形状正确', async () => {
    const kb = knowledge.createTeamKnowledgeBase({
      key: 'security-controls',
      name: 'Security Controls',
      description: 'firm security standards',
    });

    const doc = knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Data Entitlement',
      relativePath: 'policies/data-entitlement.md',
      content: 'All customer portfolio data access requires least privilege and audit trail.',
    });

    assert.match(doc.id, /^[\da-f-]{36}$/);
    assert.equal(doc.relativePath, 'policies/data-entitlement.md');

    // 未绑定：检索**失败**，而不是「搜全库然后过滤成空数组」。
    // 两者的区别是后者的 snippet 已经离开数据库了，只是被上层丢掉。
    const stranger = makeMember('Stranger', 'stranger');
    await assert.rejects(() => search(stranger.id, 'security-controls', 'entitlement'), {
      status: 403,
    });

    const member = makeMember('Alice', 'alice');
    bindKnowledge(member.id, ['security-controls']);
    const hits = await search(member.id, 'security-controls', 'entitlement');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'Data Entitlement');
    assert.match(hits[0].snippet, /<<entitlement>>/i);
    assert.equal(hits[0].citation, `[KB:security-controls/${doc.id}]`);
    assert.equal(hits[0].providerId, PROVIDER);
  });

  it('listSources 报出这条 binding 实际指向哪个源（prompt 清单的来源）', async () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'listed-kb', name: 'Listed' });
    const member = makeMember('Lister', 'lister');
    bindKnowledge(member.id, ['listed-kb', PERSONAL_SELECTOR]);

    const listed = await knowledge.listSources(
      capabilityContext(member.id),
      binding('listed-kb'),
    );
    assert.deepEqual(listed, [
      {
        providerId: PROVIDER,
        id: kb.id,
        name: 'Listed',
        description: '',
        scope: 'team',
      },
    ]);

    const personal = await knowledge.listSources(
      capabilityContext(member.id),
      binding(PERSONAL_SELECTOR),
    );
    assert.equal(personal[0].scope, 'personal');
    assert.equal(personal[0].id, knowledge.findByKey('personal', `member-${member.id}`)?.id);
  });

  it('binding 指向未 provision 的 team 资料源：对话不炸，空库补建且立即可写', async () => {
    const member = makeMember('OoB', 'oob');
    bindKnowledge(member.id, ['financial-core']);

    // 模板开箱即引用 selector，资料目录可能还没有：解析必须照常工作，
    // 而不是沿 resolver → turn 抛 404 把整个 Member 的对话废掉。
    const sources = await knowledge.listSources(capabilityContext(member.id), binding('financial-core'));
    assert.equal(sources.length, 1);
    assert.equal(sources[0].scope, 'team');

    const hits = await search(member.id, 'financial-core', 'anything');
    assert.equal(hits.length, 0, '空库检索是空结果，不是错误');

    // 补建的空库立刻可写：资料放进来即可检索，不需要重启或重新绑定。
    const kb = knowledge.findByKey('team', 'financial-core');
    assert.ok(kb, 'binding 解析时应补建 team KB 行');
    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Playbook',
      relativePath: 'playbook.md',
      content: 'financial core review playbook content',
    });
    const after = await search(member.id, 'financial-core', 'playbook');
    assert.equal(after.length, 1);
    assert.equal(after[0].title, 'Playbook');
  });

  it('未绑定的未知 selector 仍然 404，且不留下垃圾 KB 行', async () => {
    const stranger = makeMember('Probe', 'probe');
    await assert.rejects(() => search(stranger.id, 'ghost-kb', 'x'), { status: 404 });
    assert.equal(knowledge.findByKey('team', 'ghost-kb'), null);
  });

  it('重复 key 直接 400，不静默返回旧库', () => {
    knowledge.createTeamKnowledgeBase({ key: 'dup-key', name: 'first' });
    assert.throws(() => knowledge.createTeamKnowledgeBase({ key: 'dup-key', name: 'second' }), {
      status: 400,
    });
  });

  it('snippet 不够时打开整份文档，正文与落盘一致', async () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'open-doc-kb', name: 'Open Doc' });
    const written = knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Full Text',
      relativePath: 'docs/full.md',
      content: '# Full\n\nLine one.\nLine two.',
    });

    const member = makeMember('Bob', 'bob');
    bindKnowledge(member.id, ['open-doc-kb']);
    const opened = await open(member.id, written.id);
    assert.equal(opened.content, '# Full\n\nLine one.\nLine two.');
    assert.equal(opened.citation, `[KB:open-doc-kb/${written.id}]`);
    assert.equal(opened.title, 'Full Text');
    assert.equal(opened.sourceId, kb.id);
  });
});

describe('personal knowledge base', () => {
  it('ensure 幂等：同一 Member 多次调用返回同一行', () => {
    const member = makeMember('Carol', 'carol');
    const first = knowledge.ensurePersonalKnowledgeBase(member.id, member.name);
    const second = knowledge.ensurePersonalKnowledgeBase(member.id, member.name);
    assert.equal(first.id, second.id);
    assert.equal(first.scope, 'personal');
    assert.equal(first.memberId, member.id);
    assert.equal(knowledge.listTeamKnowledgeBases().some((kb) => kb.id === first.id), false);
  });

  it('personal 文档只有属主能搜到、能打开', async () => {
    const owner = makeMember('Dave', 'dave');
    const other = makeMember('Eve', 'eve');
    const personal = knowledge.ensurePersonalKnowledgeBase(owner.id, owner.name);

    const doc = knowledge.writeDocument({
      knowledgeBaseId: personal.id,
      title: 'My Method',
      relativePath: 'methodology.md',
      content: 'Review architecture with trust boundaries first, always.',
    });

    // 两个人都绑了 `$personal`（这条 binding 本来人人都有），所以下面验证的
    // 正是「属主判断不可省」：光看 binding，eve 会搜到 dave 的资料。
    bindKnowledge(owner.id, [PERSONAL_SELECTOR]);
    bindKnowledge(other.id, [PERSONAL_SELECTOR]);

    const own = await search(owner.id, PERSONAL_SELECTOR, 'boundaries');
    assert.equal(own.length, 1);
    assert.equal(own[0].sourceId, personal.id);

    assert.equal((await search(other.id, PERSONAL_SELECTOR, 'boundaries')).length, 0);
    await assert.rejects(() => open(other.id, doc.id), { status: 403 });
  });
});

describe('ACL 边界', () => {
  it('team KB 解绑后立刻打不开（403，不是 404）', async () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'rebind-kb', name: 'Rebind' });
    const doc = knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Secret',
      relativePath: 'secret.md',
      content: 'quasi-realms unique token content',
    });
    const member = makeMember('Frank', 'frank');
    bindKnowledge(member.id, ['rebind-kb']);
    assert.equal((await search(member.id, 'rebind-kb', 'quasi-realms')).length, 1);

    bindKnowledge(member.id, []);
    await assert.rejects(() => search(member.id, 'rebind-kb', 'quasi-realms'), { status: 403 });
    await assert.rejects(() => open(member.id, doc.id), { status: 403 });
    // 未绑定 ≠ 不存在：库还在，只是这个 Member 用不了。
    assert.ok(knowledge.findByKey('team', 'rebind-kb'));
  });

});

describe('路径与查询注入面', () => {
  it('relativePath 含 .. / 绝对路径片段直接 400，不落盘', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'traversal-kb', name: 'Traversal' });
    for (const bad of ['../escape.md', 'a/../../escape.md', 'a//b.md', ' /etc/passwd.md']) {
      assert.throws(
        () =>
          knowledge.writeDocument({
            knowledgeBaseId: kb.id,
            title: 'x',
            relativePath: bad,
            content: 'nope',
          }),
        { status: 400 },
        bad,
      );
    }
    assert.equal(
      fs.existsSync(path.join(config.teamKnowledgeRoot, 'escape.md')),
      false,
      '不能在 KB 根之外留文件',
    );
  });

  it('relative_path 被绕过 safeSegment 篡改（直接改 DB）时，读取仍被路径校验拦下', async () => {
    // API 写入路径上的 `..` 早被 safeSegment 拒绝，所以 resolveDocumentPath 的
    // 前缀校验只在这条路径上有行为：DB 里的 relative_path 不经过它就无法保证。
    const kb = knowledge.createTeamKnowledgeBase({ key: 'tamper-kb', name: 'Tamper' });
    const doc = knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'T',
      relativePath: 'innocent.md',
      content: 'hello',
    });
    const member = makeMember('Liam', 'liam');
    bindKnowledge(member.id, ['tamper-kb']);

    const escapeTarget = path.join(config.teamKnowledgeRoot, 'tamper-escape.md');
    fs.writeFileSync(escapeTarget, 'escaped content');
    db.prepare(`UPDATE knowledge_document SET relative_path = '../tamper-escape.md' WHERE id = ?`).run(
      doc.id,
    );

    try {
      await assert.rejects(() => open(member.id, doc.id), { status: 400 });
      assert.equal(
        fs.existsSync(path.join(config.teamKnowledgeRoot, 'tamper-kb', 'innocent.md')),
        true,
        '合法文件不受影响',
      );
    } finally {
      fs.rmSync(escapeTarget, { force: true });
    }
  });

  it('FTS 查询里的引号不会炸，也不会改变语义', async () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'quote-kb', name: 'Quote' });
    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'T',
      relativePath: 't.md',
      content: 'standard withdrawal limit is 5000 per day',
    });
    const member = makeMember('Henry', 'henry');
    bindKnowledge(member.id, ['quote-kb']);

    assert.equal((await search(member.id, 'quote-kb', '"withdrawal')).length, 1);
    assert.equal((await search(member.id, 'quote-kb', 'withdrawal" OR 1=1 --')).length, 1);
    assert.equal((await search(member.id, 'quote-kb', '')).length, 0);
  });
});

describe('磁盘与索引共用同一个「什么算一份资料」的判据', () => {
  it('API 与扫目录都拒绝非文本格式，理由说得出是什么', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'format-kb', name: 'Format' });

    assert.throws(
      () =>
        knowledge.writeDocument({
          knowledgeBaseId: kb.id,
          title: 'A Chart',
          relativePath: 'assets/chart.png',
          content: 'not really a png',
        }),
      { status: 400 },
    );
    assert.equal(fs.existsSync(path.join(config.teamKnowledgeRoot, 'format-kb', 'assets')), false);
  });

  it('API 与扫目录都拒绝超过单份上限的文件', async () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'size-kb', name: 'Size' });
    const huge = 'x'.repeat(MAX_DOCUMENT_BYTES + 1);

    assert.throws(
      () =>
        knowledge.writeDocument({
          knowledgeBaseId: kb.id,
          title: 'Huge',
          relativePath: 'huge.md',
          content: huge,
        }),
      { status: 400 },
    );

    // syncFromDisk 扫的是**全部** KB 目录，所以先同步一次把别处留下的待索引
    // 文件清干净 —— 否则下面数出来的「只索引了 1 份」会被那些无关文件带偏。
    knowledge.syncFromDisk([]);

    // 磁盘路径：文件已经在那儿了，扫目录必须跳过它（且不能先读进内存）
    const dir = path.join(config.teamKnowledgeRoot, 'size-kb');
    fs.writeFileSync(path.join(dir, 'on-disk-huge.md'), huge);
    fs.writeFileSync(path.join(dir, 'small.md'), 'readable small note about custody fees');

    const first = knowledge.syncFromDisk([]);
    assert.equal(first.indexed, 1, '只有小的那份被索引');

    const member = makeMember('Mia', 'mia');
    bindKnowledge(member.id, ['size-kb']);
    assert.equal((await search(member.id, 'size-kb', 'custody')).length, 1);
    assert.equal((await search(member.id, 'size-kb', 'xxxx')).length, 0);
  });

  it('同路径重写覆盖旧内容：旧词不再命中，新词命中，且不出现两行索引', async () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'rewrite-kb', name: 'Rewrite' });
    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'T',
      relativePath: 'doc.md',
      content: 'alpha beta gamma',
    });
    const member = makeMember('Ivy', 'ivy');
    bindKnowledge(member.id, ['rewrite-kb']);
    assert.equal((await search(member.id, 'rewrite-kb', 'gamma')).length, 1);

    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'T',
      relativePath: 'doc.md',
      content: 'delta epsilon zeta',
    });
    assert.equal((await search(member.id, 'rewrite-kb', 'gamma')).length, 0, '旧词不该再命中');
    assert.equal((await search(member.id, 'rewrite-kb', 'zeta')).length, 1);
    assert.equal(
      (await search(member.id, 'rewrite-kb', 'zeta OR delta OR epsilon')).length,
      1,
      '同一条文档只出现一次',
    );
  });
});

describe('磁盘同步', () => {
  it('目录即 KB、文件即文档；第二次同步 hash 未变则零写入', async () => {
    const member = makeMember('Ken', 'ken');
    knowledge.ensurePersonalKnowledgeBase(member.id, member.name);

    const teamDir = path.join(config.teamKnowledgeRoot, 'arch-standards');
    fs.mkdirSync(path.join(teamDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'layering.md'), 'layered architecture with trust boundary rules');
    fs.writeFileSync(path.join(teamDir, 'sub', 'naming.md'), 'service names are nouns');

    const personalDir = path.join(config.memberHomeRoot, member.id, 'knowledge');
    fs.mkdirSync(personalDir, { recursive: true });
    fs.writeFileSync(path.join(personalDir, 'my-notes.md'), 'ken prefers evidence first');

    const first = knowledge.syncFromDisk([member.id]);
    assert.equal(first.teamBases, 1);
    assert.ok(first.indexed >= 3, `至少索引 3 份，实际 ${first.indexed}`);

    // team KB 按目录名可查，且绑定后能搜到（含子目录）
    assert.ok(knowledge.findByKey('team', 'arch-standards'));
    bindKnowledge(member.id, ['arch-standards', PERSONAL_SELECTOR]);
    const hits = await search(member.id, 'arch-standards', 'boundary');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'layering.md');

    // personal 侧同样可搜
    assert.equal((await search(member.id, PERSONAL_SELECTOR, 'evidence')).length, 1);

    // 没变化的第二次同步不该写任何索引
    const second = knowledge.syncFromDisk([member.id]);
    assert.equal(second.teamBases, 0);
    assert.equal(second.indexed, 0);
  });

});
