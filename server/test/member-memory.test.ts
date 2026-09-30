import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Member 长期记忆：**只有一份**。
 *
 * `.data/members/<id>/memory/MEMORY.md`，跨 Conversation、跨 Team 稳定。
 * 人和 Agent 写的是同一个文件：人在 UI 里整体覆盖，Agent 在 turn 里调
 * remember_member 追加 —— 所以保存必须带版本校验，否则中间那次写入会无声消失。
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

describe('Member 长期记忆', () => {
  it('人在 UI 里保存的内容，prompt 读取与编辑器读取是同一份', () => {
    const member = team.createMember({ name: 'Human Hal', role: 'Analyst' });
    const saved = team.replaceMemberMemory(
      member.id,
      '# Long-term Memory\n\n用户偏好先看风险再看收益。',
    );

    assert.match(saved.content, /先看风险再看收益/);
    assert.match(memberService.readMemory(member.id), /先看风险再看收益/);
    assert.equal(team.getMemberMemory(member.id).version, saved.version);
  });

  it('remember_member 写进同一份记忆，不另开一份', async () => {
    const member = team.createMember({ name: 'Agent Amy', role: 'Reviewer' });
    const result = await team.rememberMember({
      memberId: member.id,
      content: 'review 输出要求先给 P0/P1 风险。',
    });

    assert.match(result, /长期记忆/);
    assert.match(memberService.readMemory(member.id), /P0\/P1/);
    assert.match(team.getMemberMemory(member.id).content, /P0\/P1/);
  });

  it('版本不匹配时拒绝写入（409），不覆盖中间那次写入', () => {
    const member = team.createMember({ name: 'Version Vera', role: 'Analyst' });
    const first = team.replaceMemberMemory(member.id, '# Long-term Memory\n\n第一条。');
    // Agent 在两次保存之间记下了一句。
    memberService.appendMemory(member.id, 'Agent 中间记下的一句。');

    assert.throws(
      () => team.replaceMemberMemory(member.id, '# Long-term Memory\n\n第二条。', first.version),
      (error: unknown) => (error as { status?: number }).status === 409,
    );
    assert.match(
      memberService.readMemory(member.id),
      /Agent 中间记下的一句/,
      '409 之后不能有副作用：那次写入必须还在',
    );
  });

  it('只有一个记忆文件：不存在按 Team 分片的第二份', () => {
    const member = team.createMember({ name: 'Single Sam', role: 'Engineer' });

    assert.equal(fs.existsSync(path.join(dataDir, 'members', member.id, 'memory', 'MEMORY.md')), true);
    assert.equal(
      fs.existsSync(path.join(dataDir, 'members', member.id, 'teams')),
      false,
      '记忆不按 Team 分片 —— 多一份就多一个「这个事实该记在哪」的问题',
    );
  });
});
