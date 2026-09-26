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
const { createCapabilityStack } = await import('./support.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memberService = new MemberService(db);

/**
 * 模板 provisioning 会写能力绑定，而绑定要对着**注册表**校验。
 *
 * 这里用与 TeamService 用例同一份装配（support.ts）—— 如果反过来手写一份只含
 * 模板用到的 Provider 的注册表，那么「模板写了一个部署里不存在的 Provider ID」
 * 就会在这份测试里通过，只在生产启动时才炸。
 */
const stack = createCapabilityStack(db, memberService, () => {
  throw new Error('这条用例不该执行 team 工具');
});

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
  /** 覆盖默认能力组成；不传就用一份「协议层最小集」。 */
  capabilities?: Record<string, unknown>;
}

/**
 * 默认能力组成：与 `defaultMemberCapabilities()` 同形。
 *
 * 模板里的 `capabilities` 现在是**必填**——「这个 Member 能用什么」不该有一个
 * 隐式默认（隐式默认会让漏配的模板安静地拿到一些能力）。所以 fixture 也得显式
 * 写出来，而不是靠 seeder 兜底。
 */
const FIXTURE_CAPABILITIES = {
  skills: [{ providerId: 'team.filesystem-skills' }, { providerId: 'member.filesystem-skills' }],
  knowledge: [{ providerId: 'local.filesystem-knowledge', selector: '$personal' }],
  tools: [{ providerId: 'team.core-tools' }, { providerId: 'knowledge.tools' }],
};

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
      capabilities: files.capabilities ?? FIXTURE_CAPABILITIES,
      ...files.extraManifest,
    }, null, 2),
  );

  fs.writeFileSync(path.join(dir, 'SYSTEM_PROMPT.md'), files.systemPrompt ?? 'You are a test member.');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), files.memory ?? '# Long-term Memory\n');
}

// ------------------------------------------------------------------ 真实模板

describe('真实模板目录：三个默认 Member', () => {
  it('第一次 provisioning 三个 key 全部创建，且配置正确落到 member 表', () => {
    const result = seedMemberTemplates(memberService, REAL_TEMPLATES, stack.capabilities, stack.resolver);

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

    // 只有 Engineer 绑定了宿主工具：架构师和 Security Reviewer 不该因为
    // 「自己是这个角色」就获得宿主机代码执行能力。
    //
    // 注意这只代表它们**想要**：能不能真的用还要部署层放行
    // （HOST_CODING_TOOLS），两件事刻意分开。
    assert.deepEqual(
      stack.capabilities.get(engineer.id).tools,
      [
        { providerId: 'knowledge.tools' },
        { providerId: 'runtime.host-coding-tools' },
        { providerId: 'team.core-tools' },
      ],
      'Engineer 应该多绑定一条宿主工具',
    );
    for (const member of [architect, security]) {
      assert.ok(
        !stack.capabilities
          .get(member.id)
          .tools.some((binding) => binding.providerId === 'runtime.host-coding-tools'),
        `${member.handle} 不该绑定宿主工具`,
      );
    }

    // system prompt 是从磁盘读进来的，不是模板 JSON 里的某个字符串字段
    assert.ok(architect.systemPrompt.length > 200, 'architect 的 system prompt 应该来自 SYSTEM_PROMPT.md');
    assert.match(architect.systemPrompt, /解决方案架构师/);

    // 模板里 model 是 null → 用部署默认模型，而不是某个写死的模型名
    assert.equal(architect.model, null);
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

    const first = seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
    assert.deepEqual(first.created, ['test.analyst']);

    const created = memberService.findBySeedKey('test.analyst')!;

    memberService.update(created.id, {
      name: 'My Own Analyst',
      systemPrompt: 'Custom prompt',
    });

    const second = seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.skipped, ['test.analyst']);

    const after = memberService.get(created.id);
    assert.equal(after.name, 'My Own Analyst');
    assert.equal(after.systemPrompt, 'Custom prompt');

    // 没有多出第二个 analyst
    const all = memberService.list().filter((m) => m.seedKey === 'test.analyst');
    assert.equal(all.length, 1);
  });

  it('归档之后不会被重新创建（归档是用户的明确意图）', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'retired', { key: 'test.retired', handle: 'retired', name: 'Retired' });

    seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
    const created = memberService.findBySeedKey('test.retired')!;

    memberService.update(created.id, { status: 'archived' });

    const again = seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
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

    seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
    const created = memberService.findBySeedKey('test.evolving')!;
    assert.equal(memberService.get(created.id).systemPrompt, 'Template prompt v1');

    // 运维改了模板
    fs.writeFileSync(
      path.join(root, 'evolving', 'SYSTEM_PROMPT.md'),
      'Template prompt v2 — totally different personality',
    );

    const again = seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
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

    seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
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
      () => seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver),
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

    assert.throws(() => seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver), /越界/);
    assert.equal(memberService.findBySeedKey('test.escape'), null);
  });

  it('member.json 不是合法 JSON / 字段不合法都抛错', () => {
    const root = newTemplateRoot();

    fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'broken', 'member.json'), '{ not json');
    assert.throws(() => seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver), /不是合法 JSON/);

    fs.rmSync(path.join(root, 'broken'), { recursive: true });
    fs.mkdirSync(path.join(root, 'invalid'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'invalid', 'member.json'),
      JSON.stringify({ key: 'test.invalid', handle: 'x', name: 'X' }),
    );
    // 少了 role
    assert.throws(() => seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver), /不合法/);
  });

  it('模板目录不存在时返回空结果，不抛（这份部署不需要模板）', () => {
    const result = seedMemberTemplates(
      memberService,
      path.join(dataDir, 'nope-does-not-exist'),
      stack.capabilities,
      stack.resolver,
    );
    assert.deepEqual(result, { created: [], skipped: [] });
  });

  it('模板引用了未注册的 Provider ID → 直接抛，且不留下半成品 Member', () => {
    // 拼错的 Provider ID 如果被静默接受，表现为「这个 Member 少了检索能力」，
    // 而不是一个启动错误 —— 它会照常回答，只是答案不再有依据。
    // 所以校验必须发生在建 Member **之前**：否则会留下一个没有能力的 Member，
    // 而且第二次启动会被幂等判据跳过，永远修不好。
    const root = newTemplateRoot();
    writeTemplate(root, 'typo', {
      key: 'test.typo',
      handle: 'typo',
      capabilities: {
        skills: [{ providerId: 'team.filesystem-skill' }], // 少一个 s
        knowledge: [],
        tools: [],
      },
    });

    assert.throws(
      () =>
        seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver),
      /未注册 Skill Provider：team\.filesystem-skill/,
    );
    assert.equal(memberService.findBySeedKey('test.typo'), null);
  });

  it('enabled: false 的模板既不创建也不计入 skipped', () => {
    const root = newTemplateRoot();
    writeTemplate(root, 'disabled', {
      key: 'test.disabled',
      handle: 'disabled',
      extraManifest: { enabled: false },
    });

    const result = seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
    assert.deepEqual(result, { created: [], skipped: [] });
    assert.equal(memberService.findBySeedKey('test.disabled'), null);
  });

  it('以点开头的目录被跳过（.git / .DS_Store 之类）', () => {
    const root = newTemplateRoot();
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hidden', 'member.json'), '{');
    fs.writeFileSync(path.join(root, '.DS_Store'), 'junk');

    const result = seedMemberTemplates(memberService, root, stack.capabilities, stack.resolver);
    assert.deepEqual(result, { created: [], skipped: [] });
  });
});
