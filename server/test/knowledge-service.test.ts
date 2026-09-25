import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Knowledge Base 测试。核心不是「搜得到」，而是三件必须一直成立的事：
 *
 *   1. ACL 在 SQL 里 —— 搜不到的 KB 连 snippet 都不会离开数据库
 *   2. 磁盘与索引幂等收敛 —— 同一份文件同步多少次都只有一份索引
 *   3. 路径与查询都是注入面 —— `..`、引号、空查询都要收敛
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-knowledge-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { KnowledgeService } = await import('../knowledge-service.js');
const { MemberService } = await import('../member-service.js');
const { config } = await import('../config.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const knowledge = new KnowledgeService(db);
const memberService = new MemberService(db);

function makeMember(name: string, handle: string) {
  return memberService.create({ name, handle, role: 'Analyst' });
}

describe('knowledge base 基本流', () => {
  it('建 team KB → 写文档 → 检索命中，citation 形状正确', () => {
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

    const hits = knowledge.searchTeam('nonexistent-member', 'entitlement');
    assert.equal(hits.length, 0, '没绑定的 Member 搜不到任何东西');

    const member = makeMember('Alice', 'alice');
    knowledge.setTeamKnowledgeBases(member.id, [kb.id]);
    const bound = knowledge.searchTeam(member.id, 'entitlement');
    assert.equal(bound.length, 1);
    assert.equal(bound[0].title, 'Data Entitlement');
    assert.match(bound[0].snippet, /<<entitlement>>/i);
    assert.equal(bound[0].citation, `[KB:security-controls/${doc.id}]`);
  });

  it('重复 key 直接 400，不静默返回旧库', () => {
    knowledge.createTeamKnowledgeBase({ key: 'dup-key', name: 'first' });
    assert.throws(() => knowledge.createTeamKnowledgeBase({ key: 'dup-key', name: 'second' }), {
      status: 400,
    });
  });

  it('snippet 不够时打开整份文档，正文与落盘一致', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'open-doc-kb', name: 'Open Doc' });
    const written = knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Full Text',
      relativePath: 'docs/full.md',
      content: '# Full\n\nLine one.\nLine two.',
    });

    const member = makeMember('Bob', 'bob');
    knowledge.setTeamKnowledgeBases(member.id, [kb.id]);
    const opened = knowledge.getDocumentForMember(member.id, written.id);
    assert.equal(opened.content, '# Full\n\nLine one.\nLine two.');
    assert.equal(opened.citation, `[KB:open-doc-kb/${written.id}]`);
    assert.equal(opened.document.title, 'Full Text');
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

    const profile = knowledge.listForMember(member.id);
    assert.equal(profile.personalKnowledgeBases.length, 1);
    assert.equal(profile.teamKnowledgeBases.length, 0);
  });

  it('personal 文档只有属主能搜到、能打开', () => {
    const owner = makeMember('Dave', 'dave');
    const other = makeMember('Eve', 'eve');
    knowledge.ensurePersonalKnowledgeBase(owner.id, owner.name);

    const profile = knowledge.listForMember(owner.id);
    const doc = knowledge.writeDocument({
      knowledgeBaseId: profile.personalKnowledgeBases[0].id,
      title: 'My Method',
      relativePath: 'methodology.md',
      content: 'Review architecture with trust boundaries first, always.',
    });

    const own = knowledge.searchPersonal(owner.id, 'boundaries');
    assert.equal(own.length, 1);
    assert.equal(own[0].scope, 'personal');

    assert.equal(knowledge.searchPersonal(other.id, 'boundaries').length, 0);
    assert.throws(() => knowledge.getDocumentForMember(other.id, doc.id), { status: 403 });
  });
});

describe('ACL 边界', () => {
  it('team KB 解绑后立刻搜不到、打不开', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'rebind-kb', name: 'Rebind' });
    const doc = knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Secret',
      relativePath: 'secret.md',
      content: 'quasi-realms unique token content',
    });
    const member = makeMember('Frank', 'frank');
    knowledge.setTeamKnowledgeBases(member.id, [kb.id]);
    assert.equal(knowledge.searchTeam(member.id, 'quasi-realms').length, 1);

    knowledge.setTeamKnowledgeBases(member.id, []);
    assert.equal(knowledge.searchTeam(member.id, 'quasi-realms').length, 0);
    assert.throws(() => knowledge.getDocumentForMember(member.id, doc.id), { status: 403 });
  });

  it('setTeamKnowledgeBases 拒绝把 personal KB 绑给 Member', () => {
    const member = makeMember('Grace', 'grace');
    const personal = knowledge.ensurePersonalKnowledgeBase(member.id, member.name);
    assert.throws(() => knowledge.setTeamKnowledgeBases(member.id, [personal.id]), {
      status: 400,
    });
  });
});

describe('路径与查询注入面', () => {
  it('relativePath 含 .. / 绝对路径片段直接 400，不落盘', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'traversal-kb', name: 'Traversal' });
    for (const bad of ['../escape.md', 'a/../../escape.md', 'a//b.md', ' /etc/passwd']) {
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

  it('relative_path 被绕过 safeSegment 篡改（直接改 DB）时，读取仍被路径校验拦下', () => {
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
    knowledge.setTeamKnowledgeBases(member.id, [kb.id]);

    const escapeTarget = path.join(config.teamKnowledgeRoot, 'tamper-escape.md');
    fs.writeFileSync(escapeTarget, 'escaped content');
    db.prepare(`UPDATE knowledge_document SET relative_path = '../tamper-escape.md' WHERE id = ?`).run(
      doc.id,
    );

    try {
      assert.throws(() => knowledge.getDocumentForMember(member.id, doc.id), { status: 400 });
      assert.equal(
        fs.existsSync(path.join(config.teamKnowledgeRoot, 'tamper-kb', 'innocent.md')),
        true,
        '合法文件不受影响',
      );
    } finally {
      fs.rmSync(escapeTarget, { force: true });
    }
  });

  it('FTS 查询里的引号不会炸，也不会改变语义', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'quote-kb', name: 'Quote' });
    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'T',
      relativePath: 't.md',
      content: 'standard withdrawal limit is 5000 per day',
    });
    const member = makeMember('Henry', 'henry');
    knowledge.setTeamKnowledgeBases(member.id, [kb.id]);

    assert.equal(knowledge.searchTeam(member.id, '"withdrawal').length, 1);
    assert.equal(knowledge.searchTeam(member.id, 'withdrawal" OR 1=1 --').length, 1);
    assert.equal(knowledge.searchTeam(member.id, '').length, 0);
  });
});

describe('索引幂等', () => {
  it('同路径重写覆盖旧内容：旧词不再命中，新词命中，且不出现两行索引', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'rewrite-kb', name: 'Rewrite' });
    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'T',
      relativePath: 'doc.md',
      content: 'alpha beta gamma',
    });
    const member = makeMember('Ivy', 'ivy');
    knowledge.setTeamKnowledgeBases(member.id, [kb.id]);
    assert.equal(knowledge.searchTeam(member.id, 'gamma').length, 1);

    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'T',
      relativePath: 'doc.md',
      content: 'delta epsilon zeta',
    });
    assert.equal(knowledge.searchTeam(member.id, 'gamma').length, 0, '旧词不该再命中');
    assert.equal(knowledge.searchTeam(member.id, 'zeta').length, 1);
    assert.equal(
      knowledge.searchTeam(member.id, 'zeta OR delta OR epsilon').length,
      1,
      '同一条文档只出现一次',
    );
  });
});

describe('磁盘同步', () => {
  it('目录即 KB、文件即文档；第二次同步 hash 未变则零写入', () => {
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
    const kb = knowledge.findByKey('team', 'arch-standards');
    assert.ok(kb);
    knowledge.setTeamKnowledgeBases(member.id, [kb.id]);
    const hits = knowledge.searchTeam(member.id, 'boundary');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'layering.md');

    // personal 侧同样可搜
    assert.equal(knowledge.searchPersonal(member.id, 'evidence').length, 1);

    // 没变化的第二次同步不该写任何索引
    const second = knowledge.syncFromDisk([member.id]);
    assert.equal(second.teamBases, 0);
    assert.equal(second.indexed, 0);
  });

  it('API 写的文档和磁盘同步指向同一棵树', () => {
    const kb = knowledge.createTeamKnowledgeBase({ key: 'shared-tree', name: 'Shared' });
    knowledge.writeDocument({
      knowledgeBaseId: kb.id,
      title: 'Via API',
      relativePath: 'api-doc.md',
      content: 'written through the API path',
    });
    assert.equal(
      fs.existsSync(path.join(config.teamKnowledgeRoot, 'shared-tree', 'api-doc.md')),
      true,
    );

    // 同一份内容再走一遍磁盘同步：hash 相同 → 不重复索引
    const synced = knowledge.syncFromDisk([]);
    assert.equal(synced.indexed, 0);
  });
});
