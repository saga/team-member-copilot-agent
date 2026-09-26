import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Member 记忆隔离：Global + Team 两层。
 *
 *   Global（memory/MEMORY.md）—— 人工维护的长期习惯，跨 Team 稳定，
 *     Agent 写不到（remember_member 没有 global 入口）。
 *   Team（teams/<teamId>/MEMORY.md）—— 当前 Team 的上下文，
 *     Agent 与人都可写，换 Team 看不到。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-memory-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { StubCopilot, createTestStack } = await import('./support.js');

const stub = new StubCopilot();
const memberService = new MemberService(db);
const { team } = createTestStack(db, memberService, stub.asCopilot);

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Member memory 隔离', () => {
  it('全局记忆在任何 Team 都可见（它是跨 Team 的）', () => {
    const member = team.createMember({ name: 'Global Gal', role: 'Analyst' });
    team.replaceMemberMemory(member.id, '# Long-term Memory\n\n习惯把事实和推论分开写。');

    assert.match(memberService.readMemory(member.id), /事实和推论/);
    assert.match(team.getMemberMemory(member.id).content, /事实和推论/);
  });

  it('Team A 的上下文在 Team B 看不到', () => {
    const member = team.createMember({ name: 'Team Tom', role: 'Engineer' });
    memberService.replaceTeamMemory(
      member.id,
      'team-a',
      '# Team Context\n\n这个 Team 的站会是每天早上十点。',
    );
    memberService.replaceTeamMemory(
      member.id,
      'team-b',
      '# Team Context\n\n这个 Team 每周五做发布回顾。',
    );

    assert.match(memberService.readTeamMemory(member.id, 'team-a'), /早上十点/);
    assert.ok(!memberService.readTeamMemory(member.id, 'team-a').includes('发布回顾'));
    assert.match(memberService.readTeamMemory(member.id, 'team-b'), /发布回顾/);
    assert.ok(!memberService.readTeamMemory(member.id, 'team-b').includes('早上十点'));
  });

  it('remember_member 只写当前 Team，从不碰全局记忆', async () => {
    const member = team.createMember({ name: 'Agent Amy', role: 'Reviewer' });
    const conversation = team.createConversation({ kind: 'direct', memberIds: [member.id] });
    const teamId = team.getConversation(conversation.id).teamId;

    const result = await team.rememberMember({
      memberId: member.id,
      teamId,
      content: '这个 Team 的 review 输出要求先给 P0/P1 风险。',
    });
    assert.match(result, /Team/);
    assert.match(memberService.readTeamMemory(member.id, teamId), /P0\/P1/);
    assert.ok(
      !memberService.readMemory(member.id).includes('P0/P1'),
      'Agent 的写入进了全局记忆就是泄漏',
    );
  });

  it('人仍然可以直接改全局记忆（人工维护的长期习惯）', () => {
    const member = team.createMember({ name: 'Human Hal', role: 'Analyst' });
    const saved = team.replaceMemberMemory(
      member.id,
      '# Long-term Memory\n\n用户偏好先看风险再看收益。',
    );
    assert.match(saved.content, /先看风险再看收益/);
    const reloaded = team.getMemberMemory(member.id);
    assert.equal(reloaded.version, saved.version);
  });

  it('全局记忆与 Team 上下文版本相互独立', () => {
    const member = team.createMember({ name: 'Version Vera', role: 'Analyst' });
    const conversation = team.createConversation({ kind: 'direct', memberIds: [member.id] });
    const teamId = team.getConversation(conversation.id).teamId;

    const globalBefore = team.getMemberMemory(member.id).version;
    team.replaceMemberTeamContext(member.id, '# Team Context\n\n只改 Team。', teamId);
    assert.equal(
      team.getMemberMemory(member.id).version,
      globalBefore,
      '改 Team 上下文不能漂移全局记忆的版本',
    );
  });
});
