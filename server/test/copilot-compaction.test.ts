import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CopilotService } from '../copilot.js';
import type { Member } from '../domain.js';

/**
 * Copilot Session 上下文压缩 + 共享上下文窗口的边界测试。
 *
 * ── 这一组要守的两条线 ────────────────────────────────────────────────
 *
 *  1. **压缩交给 SDK，但我们得把开关透传对。**
 *     Infinite Session 的阈值有 SDK 默认值（0.80 / 0.95），所以「忘传」不会
 *     报错 —— 引擎照跑，只是用默认值。而 `memory` 忘关会静默开一套我们不想用
 *     的记忆。默认值把「漏接线」伪装成「一切正常」，只能靠显式断言拦住。
 *
 *  2. **共享窗口是有界的，且省略必须说出来。**
 *     Member 这一轮的输入不止房间 transcript：它自己的 Copilot Session 带着
 *     自己的历史（SDK 自动 compact），Goal / Task / Approval 是结构化事实，
 *     Member / Team Memory 管跨会话长期记忆。所以窗口可以小；但**被截掉的
 *     部分必须在 prompt 里说明**，否则模型会把残缺的 transcript 当成房间的
 *     全部，给出「没有人提过 X」这种截断本身制造出来的结论。
 *
 * 不碰真实 Copilot runtime：临时 DATA_DIR + stub 引擎。压缩行为本身由 SDK
 * 负责，这里测的是「我们交给 SDK 的东西对不对」。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-compaction-'));
// 必须在 import config.ts 之前设好，否则 db 会落到仓库的 .data/
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { MemberService } = await import('../member-service.js');
const { muteAllMembers, createTestStack } = await import('./support.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 仓库根目录：跑子进程时要用（`npm test` 的 cwd 就是它，但别依赖这个）。 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const memberService = new MemberService(db);
/** 只回一句话：这一组不测引擎行为，测的是配置与上下文装配。 */
const stub = {
  async runMemberTurn(): Promise<string> {
    return 'stub reply';
  },
};
const { team } = createTestStack(db, memberService, stub as unknown as CopilotService);

function makeMember(name: string, handle: string): Member {
  return memberService.create({ name, handle, role: 'Analyst', style: 'concise' });
}

async function waitForConversationIdle(conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = db
      .prepare(
        `
        SELECT COUNT(*) AS n
        FROM execution
        WHERE conversation_id = ?
          AND status IN ('queued', 'running', 'waiting_for_member')
        `,
      )
      .get(conversationId) as unknown as { n: number };
    if (row.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`conversation ${conversationId} 没有进入 idle`);
}

// ═══════════════════════════════════════════ 1. 配置面

describe('compaction / 上下文窗口的配置默认值', () => {
  it('阈值默认就是 SDK 官方默认值，且都在 (0,1) 区间内', () => {
    // 这两条是「照抄 SDK 默认」而不是「自己另定一套」的判据。改默认值本身不是
    // 错误，但必须是**有意的** —— 所以这里把它钉住，让改动显式可见。
    assert.equal(config.copilotCompactionBackgroundThreshold, 0.8);
    assert.equal(config.copilotCompactionBufferExhaustionThreshold, 0.95);

    // background 必须严格小于 buffer：否则后台压缩还没机会跑就先撞上阻塞线，
    // 每一轮都在「同步等压缩」而不是「后台压缩」。
    assert.ok(
      config.copilotCompactionBackgroundThreshold <
        config.copilotCompactionBufferExhaustionThreshold,
      'background 阈值必须小于 buffer 阈值',
    );

    // 两个都必须是合法的比例。越界（<=0 或 >=1）在这里就说明 ratioEnv 回退失效了。
    for (const value of [
      config.copilotCompactionBackgroundThreshold,
      config.copilotCompactionBufferExhaustionThreshold,
    ]) {
      assert.ok(value > 0 && value < 1, `compaction 阈值必须在 (0,1) 内，实际 ${value}`);
    }
  });

  it('共享上下文窗口的默认值已收紧（60 条 / 32000 字符）', () => {
    assert.equal(config.maxContextMessages, 60);
    assert.equal(config.maxContextChars, 32_000);
  });

  it('development 不设 copilotBaseDirectory：SDK 用 ~/.copilot', () => {
    // 测试进程 NODE_ENV 未设置 = development。此时必须为 undefined，
    // CopilotClient 才不会收到 baseDirectory，SDK 自己用 ~/.copilot。
    // production 的绝对路径约束由部署环境保证，不在这里断言。
    assert.equal(config.isProduction, false);
    assert.equal(config.copilotBaseDirectory, undefined);
    assert.equal(config.githubToken, undefined);
  });
});

/**
 * 越界的配置必须回退，而不是原样生效。
 *
 * 为什么值得起一个子进程：`ratioEnv` 是 import 时求值的模块私有函数，同一个
 * 进程里没法用不同的 env 再求一次。而这条回退路径有一个**静默且严重**的失败
 * 模式 —— 阈值 >1 时压缩永远不触发（永远不会达到 100% 上下文利用率），表现为
 * 「跑一段时间后上下文溢出」，而不是启动报错。
 */
describe('越界的 compaction 配置回退到默认值', () => {
  it('非法比例 / 非法整数都回退，合法值原样生效', () => {
    const probe = `
      const { config } = await import('./server/config.ts');
      console.log(JSON.stringify({
        background: config.copilotCompactionBackgroundThreshold,
        buffer: config.copilotCompactionBufferExhaustionThreshold,
        messages: config.maxContextMessages,
        chars: config.maxContextChars,
      }));
    `;

    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', probe],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          COPILOT_WARMUP: 'false',
          // 合法比例：原样生效
          COPILOT_COMPACTION_BACKGROUND_THRESHOLD: '0.5',
          // 越界比例（>=1）：回退到 0.95
          COPILOT_COMPACTION_BUFFER_THRESHOLD: '1.5',
          // 非数字：回退到 60
          MAX_CONTEXT_MESSAGES: 'abc',
          // 合法整数：原样生效
          MAX_CONTEXT_CHARS: '12345',
        },
        encoding: 'utf8',
      },
    );

    const parsed = JSON.parse(stdout.trim()) as {
      background: number;
      buffer: number;
      messages: number;
      chars: number;
    };

    assert.equal(parsed.background, 0.5, '合法比例必须原样生效');
    assert.equal(parsed.buffer, 0.95, '比例 >= 1 必须回退，否则压缩永远不触发');
    assert.equal(parsed.messages, 60, '非数字必须回退到默认条数');
    assert.equal(parsed.chars, 12_345, '合法整数必须原样生效');
  });
});

// ═══════════════════════════════════════════ 2. 共享窗口的硬上限

describe('ContextAssembler 的硬上限与截断说明', () => {
  it('200 条消息时只注入最近的一窗，并把省略说清楚', async () => {
    const alice = makeMember('Cap Alice', 'cap-alice');
    const bob = makeMember('Cap Bob', 'cap-bob');

    // 全员静音：攒下来的都是**用户**消息，不会被「自己的回复」过滤掉，
    // 于是这一窗的条数完全由 MAX_CONTEXT_MESSAGES 决定。
    const room = team.createConversation({
      kind: 'task',
      title: 'Compaction window',
      memberIds: [alice.id, bob.id],
    });
    await muteAllMembers(team, room.id);

    const total = 200;
    for (let index = 1; index <= total; index += 1) {
      await team.sendMessage({
        actorId: 'test-user',
        conversationId: room.id,
        content: `消息 ${index}`,
      });
    }
    await waitForConversationIdle(room.id);

    const { ContextAssembler } = await import('../context-assembler.js');
    const assembler = new ContextAssembler(db);

    const runtime = {
      id: 'runtime-cap',
      conversationId: room.id,
      memberId: alice.id,
      copilotSessionId: 'sess-cap',
      workspacePath: '/tmp/cap',
      status: 'idle' as const,
      activeExecutionId: null,
      lastContextMessageSequence: 0,
      lastUsedAt: null,
    };

    const context = assembler.assemble({
      runtime,
      conversation: team.getConversation(room.id),
      member: team.getMember(alice.id),
      turnMode: 'lead',
      // 最后一条是触发消息，单独拎成 Current message，不进 transcript。
      triggerMessageSequence: total,
      wakeReason: 'lead_message',
      currentPrompt: 'hello',
    });

    // ── 硬上限 ────────────────────────────────────────────────────────
    // 窗口大小必须正好等于配置上限：既不能超（超了就是没生效），也不能少
    // （少了说明边界算错了）。
    assert.equal(context.sharedMessages.length, config.maxContextMessages);

    // 保留的是**最新**的一窗：唤醒这个 Member 的是刚刚发生的事。
    const kept = context.sharedMessages.map((message) => message.content);
    assert.equal(kept[kept.length - 1], `消息 ${total - 1}`, '最新一条必须在窗口里');
    assert.ok(!kept.includes('消息 1'), '最老的一条不该进窗口');

    // 省略的条数 = 相关消息总数 - 窗口大小。触发消息不算在相关消息里。
    const relevant = total - 1;
    assert.equal(context.elidedMessageCount, relevant - config.maxContextMessages);
    assert.equal(context.elidedFromSequence, 1, '被略过的是最老的那一段');

    // checkpoint 仍然推到「读到的最后一条」，否则同一批消息每轮重放。
    assert.equal(context.consumedThroughSequence, total);

    // ── 截断说明 ──────────────────────────────────────────────────────
    // 四件事缺一不可，缺哪件都会让模型得出错误结论：
    assert.match(context.prompt, /139 earlier messages .* were omitted/);
    assert.match(context.prompt, /shared-room context is bounded/);
    assert.match(
      context.prompt,
      /Goal, Task status, and approvals are tracked as structured facts/,
      '必须告诉模型结构化事实不受截断影响 —— 否则它会怀疑 Goal / Task 也不完整',
    );
    assert.match(
      context.prompt,
      /Do not treat omitted history as evidence that something was never discussed/,
      '省略 ≠ 没发生过：不说这句，模型会把残缺的 transcript 当成房间的全部',
    );
  });

  it('没有消息被省略时不出现截断说明（不能无中生有）', async () => {
    const carol = makeMember('Cap Carol', 'cap-carol');

    const room = team.createConversation({
      kind: 'task',
      title: 'No elision',
      memberIds: [carol.id],
    });
    await muteAllMembers(team, room.id);

    await team.sendMessage({ actorId: 'test-user', conversationId: room.id, content: '只有这一条' });
    await waitForConversationIdle(room.id);

    const { ContextAssembler } = await import('../context-assembler.js');
    const assembler = new ContextAssembler(db);

    const context = assembler.assemble({
      runtime: {
        id: 'runtime-no-elide',
        conversationId: room.id,
        memberId: carol.id,
        copilotSessionId: 'sess-no-elide',
        workspacePath: '/tmp/no-elide',
        status: 'idle' as const,
        activeExecutionId: null,
        lastContextMessageSequence: 0,
        lastUsedAt: null,
      },
      conversation: team.getConversation(room.id),
      member: team.getMember(carol.id),
      turnMode: 'lead',
      // 唯一一条消息就是触发消息 → transcript 为空
      triggerMessageSequence: 1,
      wakeReason: 'lead_message',
      currentPrompt: 'hello',
    });

    assert.equal(context.elidedMessageCount, 0);
    assert.doesNotMatch(
      context.prompt,
      /were omitted/,
      '没有被省略时说「有消息被省略」是凭空制造不确定性',
    );
  });
});
