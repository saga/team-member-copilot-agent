import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip, hasUnzip } from './zip-fixture.js';

/**
 * Member skill 的安装 / 列表 / 删除。
 *
 * 这一块是「把外部来的压缩包写进用户 home」，所以重点不在 happy path，
 * 而在三件事：
 *   1. 非 skill 的 zip 不能被装进去（会直接被 Copilot 当成 skill 加载）
 *   2. 路径穿越条目不能写到 skills/ 外面
 *   3. 中途失败不留半个 skill（skillDirectories 会把半个也当真的加载）
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-skills-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');

const members = new MemberService(db);
const alice = members.create({ name: 'Alice', role: 'Analyst' });
const bob = members.create({ name: 'Bob', role: 'Reviewer' });

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const skillZip = (name: string): Buffer =>
  buildZip([
    {
      path: `${name}/SKILL.md`,
      content: `---\nname: ${name}\ndescription: demo skill for ${name}\n---\n\n# ${name}\n`,
    },
    { path: `${name}/references/notes.md`, content: 'notes\n' },
  ]);

describe('Member skills', () => {
  it('安装 zip：解到 skills/<name>，描述取自 SKILL.md 的 frontmatter', { skip: !hasUnzip() }, () => {
    const skill = members.installSkill(alice.id, skillZip('demo-skill'), 'demo-skill.zip');

    assert.equal(skill.name, 'demo-skill');
    assert.equal(skill.description, 'demo skill for demo-skill');
    // SKILL.md + references/notes.md
    assert.equal(skill.fileCount, 2);

    const dir = path.join(members.skillsPath(alice.id), 'demo-skill');
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, 'references', 'notes.md')));

    // 解压的暂存目录不能留在 skills/ 下 —— 它也会被 skillDirectories 扫到
    const leftovers = fs
      .readdirSync(members.skillsPath(alice.id))
      .filter((name) => name.startsWith('.'));
    assert.deepEqual(leftovers, []);
  });

  it('zip 里没有 SKILL.md → 400，且不落盘', { skip: !hasUnzip() }, () => {
    const archive = buildZip([{ path: 'whatever/readme.txt', content: 'not a skill\n' }]);

    assert.throws(() => members.installSkill(alice.id, archive, 'not-a-skill.zip'), /SKILL\.md/);
    assert.ok(
      !fs.existsSync(path.join(members.skillsPath(alice.id), 'not-a-skill')),
      '校验失败不能留下目录',
    );
  });

  it('路径穿越条目被拒绝，且不会写到 skills/ 外面', { skip: !hasUnzip() }, () => {
    const escapeTarget = path.join(members.homePath(alice.id), 'escaped.txt');
    const archive = buildZip([
      { path: 'evil/SKILL.md', content: '# evil\n' },
      { path: '../../escaped.txt', content: 'pwned\n' },
    ]);

    assert.throws(() => members.installSkill(alice.id, archive, 'evil.zip'), /穿越|绝对路径/);
    assert.ok(!fs.existsSync(escapeTarget), '穿越条目必须一个字节都没写出去');
  });

  it('skill 属于单个 Member，互相看不见', { skip: !hasUnzip() }, () => {
    members.installSkill(bob.id, skillZip('bob-only'), 'bob-only.zip');

    const aliceSkills = members.listSkills(alice.id).map((skill) => skill.name);
    const bobSkills = members.listSkills(bob.id).map((skill) => skill.name);

    assert.ok(bobSkills.includes('bob-only'));
    assert.ok(!aliceSkills.includes('bob-only'));

    members.removeSkill(bob.id, 'bob-only');
    assert.deepEqual(members.listSkills(bob.id), []);
    assert.throws(() => members.removeSkill(bob.id, 'bob-only'), /不存在/);
  });

  it('非法 skill 名（路径分隔符 / 相对路径）被拒绝', { skip: !hasUnzip() }, () => {
    assert.throws(() => members.removeSkill(alice.id, '../../etc'), /非法的 skill 名/);
    assert.throws(() => members.removeSkill(alice.id, 'a/b'), /非法的 skill 名/);
  });
});
