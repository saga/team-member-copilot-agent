import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip, hasUnzip, SYMLINK_MODE } from './zip-fixture.js';

/**
 * Skill 内容投放的三个 scope：global / team / member。
 *
 * skill 是**目录**，所以这里考的是「压缩包被写到了哪棵树」，而不是「数据库里
 * 多了哪一行」：
 *
 *   .data/global/skills/             公司级
 *   .data/team/skills/<teamId>/      Team 级
 *   .data/members/<memberId>/skills/ Member 级
 *
 * 三个 scope 共用同一套安装管线（解压前条目校验 / 解压后体积与 symlink 体检 /
 * 暂存目录 rename），所以这里只需要证明「同一个操作落在三棵不同的树上」，
 * 以及 member 级仍然互相隔离 —— 安装管线本身的性质在 skill-service 的
 * 单测里锁。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-skills-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { SkillService } = await import('../skill-service.js');
const { TeamStructureService } = await import('../team-structure-service.js');

const members = new MemberService(db);
const skills = new SkillService(db);
const structure = new TeamStructureService(db);

const alice = members.create({ name: 'Alice', role: 'Analyst' });
const bob = members.create({ name: 'Bob', role: 'Reviewer' });
const team = structure.ensureDefaultTeam();

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const skillZip = (name: string): Buffer =>
  buildZip([
    {
      path: `${name}/SKILL.md`,
      content: `---\ndescription: demo skill for ${name}\n---\n\n# ${name}\n`,
    },
    { path: `${name}/references/notes.md`, content: 'notes\n' },
  ]);

describe('Scoped skills', () => {
  it('global skill：装到公司级目录，所有 Agent 都能继承', { skip: !hasUnzip() }, () => {
    const skill = skills.install({ kind: 'global' }, skillZip('global-demo'), 'global-demo.zip');

    assert.equal(skill.name, 'global-demo');
    assert.equal(skill.description, 'demo skill for global-demo');
    // SKILL.md + references/notes.md
    assert.equal(skill.fileCount, 2);

    assert.ok(
      skills.list({ kind: 'global' }).some((item) => item.name === 'global-demo'),
      '装完必须出现在 global 列表里',
    );
  });

  it('team skill：装到 Team 级目录', { skip: !hasUnzip() }, () => {
    skills.install({ kind: 'team', teamId: team.id }, skillZip('team-demo'), 'team-demo.zip');

    const items = skills.list({ kind: 'team', teamId: team.id });
    assert.ok(items.some((item) => item.name === 'team-demo'));
  });

  it('member skill：属于单个 Member，互相看不见', { skip: !hasUnzip() }, () => {
    skills.install({ kind: 'member', memberId: alice.id }, skillZip('alice-demo'), 'alice-demo.zip');

    const aliceSkills = skills.list({ kind: 'member', memberId: alice.id });
    const bobSkills = skills.list({ kind: 'member', memberId: bob.id });

    assert.ok(aliceSkills.some((item) => item.name === 'alice-demo'));
    assert.equal(
      bobSkills.some((item) => item.name === 'alice-demo'),
      false,
      'Member 级 skill 不能跨人可见',
    );
  });

  it('三个 scope 各自独立：删掉一个不影响另外两个', { skip: !hasUnzip() }, () => {
    // 同名的 skill 可以在三层里各存一份 —— 它们是三棵不同的树，不是「同一份
    // 内容挂在三个 scope 上」。这条同时证明删除只作用于指定 scope。
    const shared = skillZip('shared-name');
    skills.install({ kind: 'global' }, shared, 'shared-name.zip');
    skills.install({ kind: 'team', teamId: team.id }, shared, 'shared-name.zip');
    skills.install({ kind: 'member', memberId: alice.id }, shared, 'shared-name.zip');

    skills.remove({ kind: 'team', teamId: team.id }, 'shared-name');

    assert.equal(
      skills.list({ kind: 'team', teamId: team.id }).some((item) => item.name === 'shared-name'),
      false,
    );
    assert.ok(skills.list({ kind: 'global' }).some((item) => item.name === 'shared-name'));
    assert.ok(
      skills.list({ kind: 'member', memberId: alice.id }).some((item) => item.name === 'shared-name'),
    );
  });

  it('给不存在的 Team / Member 装 skill → 404，而不是建一棵没人读得到的空树', { skip: !hasUnzip() }, () => {
    assert.throws(
      () => skills.install({ kind: 'team', teamId: 'no-such-team' }, skillZip('ghost'), 'ghost.zip'),
      /Team 不存在/,
    );
    assert.throws(
      () => skills.install({ kind: 'member', memberId: 'no-such-member' }, skillZip('ghost'), 'ghost.zip'),
      /Member 不存在/,
    );
  });
});

/**
 * 安装是一条「把远端来的压缩包写进本地目录」的路径。
 *
 * 它有三道闸，缺一不可，而且每一道都必须**自己**成立：
 *
 *   1. 解压前看条目列表   绝对路径 / `..` 穿越 / 反斜杠 / 盘符
 *   2. 解压后遍历产物     文件数与总字节数上限，且拒绝 symbolic link
 *   3. 先解到暂存目录     校验通过才 rename 进目标；中途失败不留半个 skill
 *
 * 只看「压缩包 ≤ 25MB」是不够的：压缩比可以极高（zip bomb），而 symlink 能让
 * skill 在加载时把 workspace 之外的文件当成自己的内容读进来。这三条都是
 * **安全**性质，不是体验优化 —— 所以它们必须有专属断言，不能靠「反正装得上」。
 */
describe('Skill 安装的安全闸', () => {
  const globalRoot = () => skills.rootFor({ kind: 'global' });

  it('zip 里没有 SKILL.md → 400，且不落盘', { skip: !hasUnzip() }, () => {
    const archive = buildZip([{ path: 'whatever/readme.txt', content: 'not a skill\n' }]);

    assert.throws(() => skills.install({ kind: 'global' }, archive, 'not-a-skill.zip'), /SKILL\.md/);
    assert.equal(
      fs.existsSync(path.join(globalRoot(), 'not-a-skill')),
      false,
      '校验失败不能留下目录',
    );
  });

  it('路径穿越条目被拒绝，且不会写到 skills/ 外面', { skip: !hasUnzip() }, () => {
    const escapeTarget = path.join(dataDir, 'escaped.txt');
    const archive = buildZip([
      { path: 'evil/SKILL.md', content: '# evil\n' },
      { path: '../../escaped.txt', content: 'pwned\n' },
    ]);

    assert.throws(() => skills.install({ kind: 'global' }, archive, 'evil.zip'), /穿越|绝对路径/);
    assert.equal(fs.existsSync(escapeTarget), false, '穿越条目必须一个字节都没写出去');
  });

  it('symlink 条目被拒绝，且不落盘', { skip: !hasUnzip() }, () => {
    // 一个指向 /etc 的链接会让 skill 在加载时把宿主机文件读成自己的内容。
    // `lstatSync` 是关键：用 `statSync` 会跟随链接，于是链接永远看起来是
    // 一个普通文件，这道检查形同不存在。
    const archive = buildZip([
      { path: 'linked/SKILL.md', content: '# linked\n' },
      { path: 'linked/outside', content: '/etc/passwd', mode: SYMLINK_MODE },
    ]);

    assert.throws(() => skills.install({ kind: 'global' }, archive, 'linked.zip'), /symbolic link/);
    assert.equal(fs.existsSync(path.join(globalRoot(), 'linked')), false, '拒绝之后不能留下半个 skill');
  });

  it('解压后文件数超过上限 → 拒绝（zip bomb 的体积侧）', { skip: !hasUnzip() }, () => {
    // 上限是 2000；造 2001 个条目。压缩包本身很小，这正是要拦的东西。
    const entries = [{ path: 'bomb/SKILL.md', content: '# bomb\n' }];
    for (let index = 0; index < 2001; index += 1) {
      entries.push({ path: `bomb/f${index}.md`, content: 'x' });
    }

    assert.throws(() => skills.install({ kind: 'global' }, buildZip(entries), 'bomb.zip'), /文件数超过/);
    assert.equal(fs.existsSync(path.join(globalRoot(), 'bomb')), false);
  });

  it('安装用的暂存目录不留在 skills/ 下（它也会被 skillDirectories 扫到）', { skip: !hasUnzip() }, () => {
    skills.install({ kind: 'global' }, skillZip('clean-install'), 'clean-install.zip');

    const leftovers = fs.readdirSync(globalRoot()).filter((name) => name.startsWith('.'));
    assert.deepEqual(leftovers, []);
  });

  it('重复安装同名 skill → 409，不静默覆盖已装的那一份', { skip: !hasUnzip() }, () => {
    skills.install({ kind: 'global' }, skillZip('dup-skill'), 'dup-skill.zip');
    assert.throws(() => skills.install({ kind: 'global' }, skillZip('dup-skill'), 'dup-skill.zip'), {
      status: 409,
    });
  });
});
