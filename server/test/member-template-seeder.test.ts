import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Member template provisioning 测试。
 *
 * 这一组锁的是「模板只负责第一次」这条语义。它很容易在后续改动里被悄悄破坏 ——
 * 把 provisioning 写成「启动时对齐模板」，测试全绿、功能照跑，但用户改过的
 * 人设会在某次重启后无声消失。
 *
 * 所以重点不在「三个默认 Member 建出来了」，而在四个**不能发生**的事：
 *
 *   第二次启动不再建           （幂等）
 *   用户改过的不被覆盖         （模板不是 source of truth）
 *   归档的不被复活             （归档是用户的明确意图）
 *   模板改了不升级已有 Member  （升级需要显式触发，不是启动副作用）
 *
 * 另外锁住两条安全边界：路径穿越、重复 key。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-seeder-'));
// 必须在 import config.ts 之前设好，否则 db 会落到仓库的 .data/
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { seedMemberTemplates } = await import('../member-template-seeder.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memberService = new MemberService(db);

/** 仓库里真实的那份模板目录。测试从仓库根目录跑，所以相对路径可用。 */
const REAL_TEMPLATES = path.resolve('config/member-templates');

const KNOWN_KEYS = [
  'financial-services.solution-architect',
  'financial-services.senior-engineer',
  'financial-services.security-reviewer',
];

// ------------------------------------------------------------------ fixtures

let fixtureSeq = 0;

/** 每个用例一个独立的临时模板目录，避免互相影响。 */
function newTemplateRoot(): string {
  fixtureSeq += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tmca-tpl-${fixtureSeq}-`));
  return root;
}

interface TemplateFiles {
  key: string;
  handle?: string;
  name?: string;
  extraManifest?: Record<string, unknown>;
  systemPrompt?: string;
  memory?: string;
  /** 覆盖 systemPromptFile / memoryFile，用于穿越用例。 */
  systemPromptFile?: string;
  memoryFile?: string;
}

function writeTemplate(root: string, directory: string, files: TemplateFiles): void {
  const dir = path.join(root, directory);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'member.json'),
    JSON.stringify({
      key: files.key,
      handle: files.handle ?? directory.replace(/[^a-z0-9-]/gi, '-'),
      name: files.name ?? directory,
      role: files.extraManifest?.role ?? 'Test Role',
      systemPromptFile: files.systemPromptFile ?? 'SYSTEM_PROMPT.md',
      memoryFile: files.memoryFile ?? 'MEMORY.md',
      ...files.extraManifest,
    }, null, 2),
  );

  fs.writeFileSync(path.join(dir, 'SYSTEM_PROMPT.md'), files.systemPrompt ?? 'You are a test member.');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), files.memory ?? '# Long-term Memory\n');
}

// ------------------------------------------------------------------ 真实模板

describe('真实模板目录：三个默认 Member', () => {
  it('第一次 provisioning 三个 key 全部创建，且配置正确落到 member 表', () => {
    const result = seedMemberTemplates(memberService, REAL_TEMPLATES);

    for (const key of KNOWN_KEYS) {
      assert.ok(result.created.includes(key), `没有 provision ${key}`);
    }

    const architect = memberService.findBySeedKey('financial-services.solution-architect');
    const engineer = memberService.findBySeedKey('financial-services.senior-engineer');
    const security = memberService.findBySeedKey('financial-services.security-reviewer');

    assert.ok(architect && engineer && security, '三个 Member 都应该能按 seedKey 查到');
    assert.equal(architect.status, 'active');
    assert.equal(architect.handle, 'architect');
    assert.equal(engineer.handle, 'engineer');
    assert.equal(security.handle, 'security');

    // 只有 Engineer 拿到 coding：架构师和 Security Reviewer 默认不该因为
    // 「自己是这个角色」就获得宿主机代码执行能力。
    assert.equal(engineer.toolProfile, 'coding');
    assert.equal(architect.toolProfile, 'safe');
    assert.equal(security.toolProfile, 'safe');

    // system prompt 是从磁盘读进来的，不是模板 JSON 里的某个字符串字段
    assert.ok(architect.systemPrompt.length > 200, 'architect 的 system prompt 应该来自 SYSTEM_PROMPT.md');
    assert.match(architect.systemPrompt, /解决方案架构师/);

    // 模板里 model 是 null → 用部署默认模型，而不是某个写死的模型名
    assert.equal(architect.model, null);
  });

  it('第二次执行全部跳过，一个都不重建', () => {
    const result = seedMemberTemplates(memberService, REAL_TEMPLATES);

    assert.deepEqual(result.created, []);
    for (const key of KNOWN_KEYS) {
      assert.ok(result.skipped.includes(key), `${key} 应该被跳过`);
    }
  });

  it('手工创建的 Member seedKey 为 null，且多行 NULL 可以共存', () => {
    const a = memberService.create({ name: 'Manual A', role: 'T', handle: 'manual-a' });
    const b = memberService.create({ name: 'Manual B', role: 'T', handle: 'manual-b' });

    assert.equal(a.seedKey, null);
    assert.equal(b.seedKey, null);
  });

  it('seed_key 索引是部分索引，且列可空', () => {
    // 形状断言，不装成行为断言。
    //
    // SQLite 的唯一索引本来就把 NULL 视为互不相同，所以「去掉 WHERE 子句」
    // 在行为上无法区分 —— 上面那条共存用例对两种索引都会通过。这里锁的是
    // **意图**：索引只覆盖来自模板的行，`seed_key` 不是 NOT NULL。
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_member_seed_key'`)
      .get() as unknown as { sql: string } | undefined;

    assert.ok(sql, 'seed_key 索引不存在');
    assert.match(sql.sql, /WHERE seed_key IS NOT NULL/i);

    const columns = db.prepare(`PRAGMA table_info(member)`).all() as unknown as Array<{
      name: string;
      notnull: number;
    }>;
    const seedKey = columns.find((column) => column.name === 'seed_key');
    assert.ok(seedKey, 'member.seed_key 列不存在');
    assert.equal(seedKey.notnull, 0, 'seed_key 必须可空 —— 手工创建的 Member 没有模板来源');
  });
});

// ------------------------------------------------------------------ 幂等与不覆盖

describe('模板只负责第一次', () => {
  it('用户改过 name / systemPrompt 之后，再跑 provisioning 不会覆盖', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'analyst', {
      key: 'test.analyst',
      handle: 'analyst',
      name: 'Research Analyst',
      systemPrompt: 'Template prompt v1',
    });

    const first = seedMemberTemplates(memberService, root);
    assert.deepEqual(first.created, ['test.analyst']);

    const created = memberService.findBySeedKey('test.analyst')!;

    memberService.update(created.id, {
      name: 'My Own Analyst',
      systemPrompt: 'Custom prompt',
    });

    const second = seedMemberTemplates(memberService, root);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.skipped, ['test.analyst']);

    const after = memberService.get(created.id);
    assert.equal(after.name, 'My Own Analyst');
    assert.equal(after.systemPrompt, 'Custom prompt');

    // 没有多出第二个 analyst
    const all = memberService.list().filter((m) => m.seedKey === 'test.analyst');
    assert.equal(all.length, 1);
  });

  it('改了 handle 之后不会因为「找不到 @旧handle」又建一个', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'renamed', { key: 'test.renamed', handle: 'renamed', name: 'Renamed' });

    seedMemberTemplates(memberService, root);
    const created = memberService.findBySeedKey('test.renamed')!;
    memberService.update(created.id, { handle: 'completely-different-handle' });

    const again = seedMemberTemplates(memberService, root);
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.skipped, ['test.renamed']);

    const result = memberService.findBySeedKey('test.renamed')!;
    assert.equal(result.handle, 'completely-different-handle');
    assert.equal(memberService.get(created.id).id, created.id);
  });

  it('归档之后不会被重新创建（归档是用户的明确意图）', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'retired', { key: 'test.retired', handle: 'retired', name: 'Retired' });

    seedMemberTemplates(memberService, root);
    const created = memberService.findBySeedKey('test.retired')!;

    memberService.update(created.id, { status: 'archived' });

    const again = seedMemberTemplates(memberService, root);
    assert.deepEqual(again.created, [], '归档的 Member 不该被重新建出来');
    assert.deepEqual(again.skipped, ['test.retired']);

    const after = memberService.findBySeedKey('test.retired')!;
    assert.equal(after.id, created.id);
    assert.equal(after.status, 'archived');
    // list() 只看 active，所以列表里应该没有它
    assert.ok(!memberService.list().some((m) => m.id === created.id));
  });

  it('模板文件改了不会升级已经建好的 Member', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'evolving', {
      key: 'test.evolving',
      handle: 'evolving',
      name: 'Evolving',
      systemPrompt: 'Template prompt v1',
    });

    seedMemberTemplates(memberService, root);
    const created = memberService.findBySeedKey('test.evolving')!;
    assert.equal(memberService.get(created.id).systemPrompt, 'Template prompt v1');

    // 运维改了模板
    fs.writeFileSync(
      path.join(root, 'evolving', 'SYSTEM_PROMPT.md'),
      'Template prompt v2 — totally different personality',
    );

    const again = seedMemberTemplates(memberService, root);
    assert.deepEqual(again.created, []);

    const after = memberService.get(created.id);
    assert.equal(
      after.systemPrompt,
      'Template prompt v1',
      '模板是 baseline，不是 source of truth —— 升级必须是显式操作',
    );
  });

  it('初始记忆写进 member home 的 MEMORY.md', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'mnemonic', {
      key: 'test.mnemonic',
      handle: 'mnemonic',
      name: 'Mnemonic',
      memory: '# Long-term Memory\n\n- 记住这条初始背景',
    });

    seedMemberTemplates(memberService, root);
    const created = memberService.findBySeedKey('test.mnemonic')!;

    const memory = memberService.getMemory(created.id).content;
    assert.match(memory, /记住这条初始背景/);
    assert.match(memory, /^# Long-term Memory/);
  });
});

// ------------------------------------------------------------------ 配置错误

describe('模板配置错误必须大声报出来', () => {
  it('两个模板共用一个 key 直接抛错', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'dup-a', { key: 'test.dup', handle: 'dup-a' });
    writeTemplate(root, 'dup-b', { key: 'test.dup', handle: 'dup-b' });

    assert.throws(
      () => seedMemberTemplates(memberService, root),
      /重复的 Member template key/,
      '同一个 key 会让其中一个永远建不出来，必须报错',
    );
  });

  it('systemPromptFile 指到模板目录之外直接拒绝', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'escape', {
      key: 'test.escape',
      handle: 'escape',
      systemPromptFile: '../../etc/passwd',
    });

    assert.throws(() => seedMemberTemplates(memberService, root), /越界/);
    assert.equal(memberService.findBySeedKey('test.escape'), null);
  });

  it('缺少 member.json 直接抛错', () => {
    const root = newTemplateRoot();
    fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });

    assert.throws(() => seedMemberTemplates(memberService, root), /缺少 member\.json/);
  });

  it('member.json 不是合法 JSON / 字段不合法都抛错', () => {
    const root = newTemplateRoot();

    fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'broken', 'member.json'), '{ not json');
    assert.throws(() => seedMemberTemplates(memberService, root), /不是合法 JSON/);

    fs.rmSync(path.join(root, 'broken'), { recursive: true });
    fs.mkdirSync(path.join(root, 'invalid'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'invalid', 'member.json'),
      JSON.stringify({ key: 'test.invalid', handle: 'x', name: 'X' }),
    );
    // 少了 role
    assert.throws(() => seedMemberTemplates(memberService, root), /不合法/);
  });

  it('模板目录不存在时返回空结果，不抛（这份部署不需要模板）', () => {
    const result = seedMemberTemplates(memberService, path.join(dataDir, 'nope-does-not-exist'));
    assert.deepEqual(result, { created: [], skipped: [] });
  });

  it('enabled: false 的模板既不创建也不计入 skipped', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'disabled', {
      key: 'test.disabled',
      handle: 'disabled',
      extraManifest: { enabled: false },
    });

    const result = seedMemberTemplates(memberService, root);
    assert.deepEqual(result, { created: [], skipped: [] });
    assert.equal(memberService.findBySeedKey('test.disabled'), null);
  });

  it('以点开头的目录被跳过（.git / .DS_Store 之类）', () => {
    const root = newTemplateRoot();
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hidden', 'member.json'), '{');
    fs.writeFileSync(path.join(root, '.DS_Store'), 'junk');

    const result = seedMemberTemplates(memberService, root);
    assert.deepEqual(result, { created: [], skipped: [] });
  });
});
