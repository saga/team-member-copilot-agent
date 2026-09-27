import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { ConversationFile, Member } from '../domain.js';

/**
 * 会话文件（聊天附件）的**行为**测试。
 *
 * 这一层要证明的不是「表建好了、字段存进去了」，而是四件**只有跨模块才看得见**
 * 的事 —— 每一件都对应一个真实会出错的写法：
 *
 *   1. 上传落盘 + 后台提取      —— 上传不该等提取；提取完必须变成可搜
 *   2. 消息附件 / 引用的区分     —— 同一个文件第二次挂在消息上不是第二份附件
 *   3. 会话边界（ACL）           —— 别的会话的 fileId 既不能引用、也不能读出内容
 *   4. 软删除保留历史            —— 删掉之后过去那条消息仍指向一份存在的文件
 *
 * 第 3 条是这套东西的全部意义：上传**不会**自动进知识库，权限边界就是「这场
 * 对话的参与者」。如果 fileId 能跨会话用，这个边界当场就不存在了，而接口会
 * 一路 200 —— 静默越权正是这类功能最难查的失败形态。
 *
 * 所以关键路径走**真实 express + 真实 fetch**（schema / raw body / 响应头都参与），
 * 而关系语义（attachment vs reference）查库断言，因为那是 UI 看不见的一列。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmca-convfiles-'));
process.env.DATA_DIR = dataDir;
process.env.COPILOT_WARMUP = 'false';

const { db } = await import('../db.js');
const { config } = await import('../config.js');
const { MemberService } = await import('../member-service.js');
const { conversationsRouter } = await import('../routes/conversations.js');
const { ConversationFileService } = await import(
  '../conversation-file-service.js'
);
const { ConversationFileProcessor } = await import('../conversation-file-processor.js');
const { StubCopilot, createTestStack, muteAllMembers } = await import('./support.js');

const memberService = new MemberService(db);
const stub = new StubCopilot();
const stack = createTestStack(db, memberService, stub.asCopilot);

let alice: Member;
let bob: Member;
/** 一个不属于任何会话的人 —— 用来证明 ACL 不是「拿到 id 就能读」。 */
let carol: Member;
/** alice + bob 的群聊，绝大多数用例在这里发生。 */
let room: string;
/** alice 单聊，用来放「别的会话的文件」。 */
let sideRoom: string;

let server: Server;
let base: string;

before(async () => {
  alice = stack.team.createMember({ name: 'FileAlice', role: 'Engineer' });
  bob = stack.team.createMember({ name: 'FileBob', role: 'Reviewer' });
  carol = stack.team.createMember({ name: 'FileCarol', role: 'Outsider' });

  room = stack.team.createConversation({
    title: 'Files room',
    kind: 'task',
    memberIds: [alice.id, bob.id],
  }).id;
  sideRoom = stack.team.createConversation({ title: 'Side room', memberIds: [alice.id] }).id;

  // 全部静音：这些用例考的是文件，不是调度。不静音的话群聊里每发一条消息都会
  // 唤醒成员、追加 member 回复，让「这一条消息挂了哪些文件」变得不确定。
  muteAllMembers(stack.team, room);
  muteAllMembers(stack.team, sideRoom);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api/conversations',
    conversationsRouter(stack.team, stack.conversationFiles, stack.processor, stack.knowledge),
  );
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 工具

let nameCounter = 0;

/** 每次调用都给一个新名字：同会话内同名同内容会被去重成同一份，用例要互相隔离。 */
function newFileName(prefix: string, extension = 'md'): string {
  nameCounter += 1;
  return `${prefix}-${nameCounter}.${extension}`;
}

function uploadUrl(conversationId: string, filename?: string): string {
  const suffix = filename === undefined ? '' : `?filename=${encodeURIComponent(filename)}`;
  return `${base}/api/conversations/${conversationId}/files${suffix}`;
}

function upload(
  conversationId: string,
  filename: string | undefined,
  body: string | Buffer,
  contentType = 'text/markdown',
) {
  return fetch(uploadUrl(conversationId, filename), {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

async function uploadOk(
  conversationId: string,
  filename: string,
  body: string,
  contentType = 'text/markdown',
): Promise<ConversationFile> {
  const response = await upload(conversationId, filename, body, contentType);
  assert.equal(response.status, 202, `上传 ${filename} 期望 202，实际 ${response.status}`);
  const payload = (await response.json()) as { file: ConversationFile };
  return payload.file;
}

/**
 * 等提取跑完。
 *
 * 上传是 202 + 后台队列，`enqueue()` 不 await（响应先回去）。这里轮询而不是
 * `await processor.enqueue()`：后者会把用例绑在「enqueue 同步等待队列排空」这个
 * 实现细节上，而上传接口的契约恰恰是**不**等它。
 */
async function waitForStatus(
  service: { get(conversationId: string, fileId: string): ConversationFile },
  conversationId: string,
  fileId: string,
): Promise<ConversationFile> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const file = service.get(conversationId, fileId);
    if (file.status !== 'processing') return file;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`文件 ${fileId} 一直停在 processing，提取没有跑完`);
}

function waitForReady(conversationId: string, fileId: string): Promise<ConversationFile> {
  return waitForStatus(stack.conversationFiles, conversationId, fileId);
}

/** 落一份「已就绪」的文件，给不关心提取过程的用例用。 */
async function readyFile(
  conversationId: string,
  prefix: string,
  content: string,
  extension = 'md',
): Promise<ConversationFile> {
  const file = await uploadOk(conversationId, newFileName(prefix, extension), content);
  const settled = await waitForReady(conversationId, file.id);
  assert.equal(settled.status, 'ready');
  return settled;
}

function postMessage(conversationId: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 消息 ↔ 文件的那一列关系。UI 看不见它，但它就是审计链本身。 */
function relationBetween(messageId: string, fileId: string): string | null {
  const row = db
    .prepare(
      'SELECT relation_type FROM conversation_message_file WHERE message_id = ? AND file_id = ?',
    )
    .get(messageId, fileId) as unknown as { relation_type: string } | undefined;
  return row?.relation_type ?? null;
}

// ---------------------------------------------------------------- 上传

describe('会话文件：上传与提取', () => {
  it('上传先返回 processing，提取完成后变成 ready 且内容可搜', async () => {
    const content = `# Note\nshipping-conversation-files-${nameCounter}`;
    const file = await uploadOk(room, newFileName('upload'), content);

    // 202 的契约就是这个：行已建好，正文已落盘，但提取还没跑。
    assert.equal(file.status, 'processing');
    assert.equal(file.sizeBytes, Buffer.byteLength(content));
    assert.equal(file.contentType, 'text/markdown');
    assert.equal(file.uploadedBy, config.localUserId);

    const ready = await waitForReady(room, file.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.extractionError, null);

    const hits = stack.conversationFiles.search({
      conversationId: room,
      memberId: alice.id,
      query: 'shipping-conversation-files',
      limit: 10,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].fileId, file.id);
  });

  it('正文按 <conversationId>/files/<fileId>/ 落盘，且可以原样取回', async () => {
    const content = '# 原文\n一行中文，一行中文。';
    const file = await readyFile(room, 'roundtrip', content);

    assert.match(file.storagePath, new RegExp(`^${room}/files/${file.id}/original\\.md$`));
    assert.ok(fs.existsSync(path.join(config.conversationFileRoot, file.storagePath)));

    const response = await fetch(`${base}/api/conversations/${room}/files/${file.id}/content`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
  });

  it('同名同内容重复上传收敛成同一份，不会在 Shared Files 里出现两份', async () => {
    const content = 'dedupe-target-content';
    const first = await uploadOk(room, 'dedupe.md', content);
    const second = await uploadOk(room, 'dedupe.md', content);

    assert.equal(second.id, first.id);
    const named = stack.conversationFiles.list(room).filter((item) => item.originalName === 'dedupe.md');
    assert.equal(named.length, 1);
  });

  it('文件名里的目录成分会被剥掉（路径穿越不会落到磁盘上）', async () => {
    const file = await uploadOk(room, '../../etc/passwd.md', 'traversal content');
    assert.equal(file.originalName, 'passwd.md');
    assert.ok(!file.storagePath.includes('..'));
  });

  /**
   * 这条守的是**上传接口的时序契约**，不是某一处状态字段。
   *
   * 报错的方式很隐蔽：`enqueue()` 直接 `void drain()` 时，提取是同步 IO，于是
   * `markReady`（进而 `file.updated`）在路由 `res.json()` 之前就跑完了。调用方
   * 先收到「已就绪」的事件、后收到 202 里 `status: 'processing'` 的快照 —— 那份
   * 快照比事件旧却到得更晚，Shared Files 里这份文件就永远停在「处理中…」，
   * 直到刷新页面。接口全程 202，日志干净，是最难查的一类「接口没问题但不对」。
   */
  it('上传后提取不在请求线程里同步跑完：202 的快照必须先于 file.updated 写出', async () => {
    const events: Array<{ type: string; status: string }> = [];
    const service = new ConversationFileService(db, {
      root: config.conversationFileRoot,
      maxBytesPerFile: config.maxConversationFileBytes,
      maxFilesPerConversation: config.maxConversationFilesPerConversation,
      maxFilesPerMessage: config.maxConversationFilesPerMessage,
      onEvent: (_conversationId, type, file) => events.push({ type, status: file.status }),
    });
    const processor = new ConversationFileProcessor(service, config.maxExtractedTextChars);

    const file = service.create({
      conversationId: room,
      teamId: stack.team.getConversation(room).teamId,
      uploadedBy: config.localUserId,
      originalName: newFileName('ordering'),
      contentType: 'text/markdown',
      body: Buffer.from('ordering probe'),
    });
    assert.equal(file.status, 'processing');
    assert.deepEqual(events.map((event) => event.type), ['file.created']);

    processor.enqueue(file);
    assert.deepEqual(
      events.map((event) => event.type),
      ['file.created'],
      'enqueue 返回时提取必须还没发生，否则 file.updated 会先于 202 的响应写出去',
    );

    await waitForStatus(service, room, file.id);
    assert.deepEqual(events.map((event) => event.type), ['file.created', 'file.updated']);
    assert.equal(events[1].status, 'ready');
  });

  it('可执行文件 / 无扩展名 / 缺文件名 / 空文件一律拒绝，且是调用方能改的错误', async () => {
    const blocked = await upload(room, 'installer.sh', 'echo hi');
    assert.equal(blocked.status, 400);
    assert.match(((await blocked.json()) as { error: string }).error, /不允许上传/);

    const noExtension = await upload(room, 'README', 'no extension');
    assert.equal(noExtension.status, 400);
    assert.match(((await noExtension.json()) as { error: string }).error, /扩展名/);

    const noName = await upload(room, undefined, 'binary body');
    assert.equal(noName.status, 400);
    assert.match(((await noName.json()) as { error: string }).error, /没带文件名/);
  });
});

describe('会话文件：上限闸门', () => {
  /** 用一份刻意调小的策略建一个服务，验证闸门本身，而不是去堆 50MB 的 buffer。 */
  function tinyService(overrides: { maxBytesPerFile?: number; maxFilesPerConversation?: number }) {
    return new ConversationFileService(db, {
      root: config.conversationFileRoot,
      maxBytesPerFile: overrides.maxBytesPerFile ?? 1024,
      maxFilesPerConversation: overrides.maxFilesPerConversation ?? 500,
      maxFilesPerMessage: 10,
    });
  }

  const baseInput = {
    conversationId: '',
    teamId: '',
    uploadedBy: 'tester',
    originalName: 'x.txt',
    contentType: 'text/plain',
  };

  it('空文件与超限文件被拒', () => {
    const service = tinyService({ maxBytesPerFile: 4 });
    const context = { conversationId: room, teamId: stack.team.getConversation(room).teamId };

    assert.throws(() => service.create({ ...baseInput, ...context, body: Buffer.alloc(0) }), /空的/);
    assert.throws(
      () => service.create({ ...baseInput, ...context, body: Buffer.from('12345') }),
      /上限/,
    );
  });

  it('会话内文件数达到上限后不再接受新文件', () => {
    const service = tinyService({ maxFilesPerConversation: 1 });
    // 单独开一间房：用共享的会话会让这个用例依赖别的用例有没有先放过文件。
    const quotaRoom = stack.team.createConversation({ title: 'Quota room', memberIds: [alice.id] }).id;
    const context = { conversationId: quotaRoom, teamId: stack.team.getConversation(quotaRoom).teamId };

    service.create({ ...baseInput, ...context, originalName: 'first.txt', body: Buffer.from('1') });
    assert.throws(
      () =>
        service.create({
          ...baseInput,
          ...context,
          originalName: 'second.txt',
          body: Buffer.from('2'),
        }),
      /上限/,
    );
  });

  it('一条消息最多带 10 个文件（校验在落库之前）', async () => {
    const tooMany = Array.from({ length: 11 }, (_, index) => `missing-file-${index}`);
    const response = await postMessage(room, { content: '一次带太多', fileIds: tooMany });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /最多带 10 个文件/);
  });
});

// ------------------------------------------------------ 消息附件 / 引用

describe('会话文件：消息附件与引用', () => {
  it('挂到消息上的文件随消息一起返回（否则前端要刷新才看得到卡片）', async () => {
    const file = await readyFile(room, 'attach', 'attachment body');

    const response = await postMessage(room, {
      content: '这条带一个附件',
      fileIds: [file.id],
    });
    assert.equal(response.status, 202);

    const payload = (await response.json()) as {
      message: { id: string; files: ConversationFile[] };
    };
    assert.deepEqual(
      payload.message.files.map((item) => item.id),
      [file.id],
      'message.created 里必须已经带附件，不然收到的人先看到一条没有附件的消息',
    );
    assert.equal(relationBetween(payload.message.id, file.id), 'attachment');

    const listed = stack.team.listMessages(room).find((item) => item.id === payload.message.id);
    assert.ok(listed);
    assert.deepEqual(
      listed.files.map((item) => item.id),
      [file.id],
    );
  });

  it('同一个文件第二次挂到消息上是 reference，不是第二份 attachment', async () => {
    const file = await readyFile(room, 'reuse', 'reuse body');

    const first = await postMessage(room, { content: '第一次带上', fileIds: [file.id] });
    const firstPayload = (await first.json()) as { message: { id: string } };
    assert.equal(relationBetween(firstPayload.message.id, file.id), 'attachment');

    const second = await postMessage(room, { content: '再引用一次', fileIds: [file.id] });
    const secondPayload = (await second.json()) as { message: { id: string } };
    assert.equal(
      relationBetween(secondPayload.message.id, file.id),
      'reference',
      '「这份文件是在这条消息里上传的」必须只在真的那条消息上成立',
    );

    // 引用不会复制文件：会话里仍然只有一份。
    assert.equal(stack.conversationFiles.list(room).filter((item) => item.id === file.id).length, 1);
  });
});

// -------------------------------------------------------------- 会话边界

describe('会话文件：会话边界', () => {
  it('引用别的会话的文件 → 403，且消息不会落库', async () => {
    const foreign = await readyFile(sideRoom, 'foreign', 'belongs to another room');
    const before = stack.team.listMessages(room).length;

    const response = await postMessage(room, { content: '偷偷引用', fileIds: [foreign.id] });
    assert.equal(response.status, 403);
    assert.match(((await response.json()) as { error: string }).error, /别的会话/);
    assert.equal(
      stack.team.listMessages(room).length,
      before,
      '校验必须在落库之前，否则房间会留下一条指不到文件的空消息',
    );
  });

  it('用别的会话的 fileId 取正文 → 404（不能靠猜 id 读到内容）', async () => {
    const foreign = await readyFile(sideRoom, 'private', 'private content');

    const content = await fetch(
      `${base}/api/conversations/${room}/files/${foreign.id}/content`,
    );
    assert.equal(content.status, 404);

    const removed = await fetch(`${base}/api/conversations/${room}/files/${foreign.id}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 404);

    // 它本身还在自己的会话里，没被这次失败的操作动过。
    assert.equal(stack.conversationFiles.get(sideRoom, foreign.id).status, 'ready');
  });

  it('Agent 路径的搜索把成员身份写进 SQL：非成员搜不到任何东西', async () => {
    const marker = 'acl-marker-quantum';
    await readyFile(room, 'acl', `this document mentions ${marker} in the body`);

    const asMember = stack.conversationFiles.search({
      conversationId: room,
      memberId: alice.id,
      query: marker,
      limit: 10,
    });
    assert.equal(asMember.length, 1);

    const asOutsider = stack.conversationFiles.search({
      conversationId: room,
      memberId: carol.id,
      query: marker,
      limit: 10,
    });
    assert.deepEqual(
      asOutsider,
      [],
      'ACL 必须是查询的一部分：让调用方先校验一遍，模型换一个 conversationId 就绕过去了',
    );

    // 人的入口（memberId = null）走会话级权限，不过 conversation_member 这一层。
    const asHuman = stack.conversationFiles.search({
      conversationId: room,
      memberId: null,
      query: marker,
      limit: 10,
    });
    assert.equal(asHuman.length, 1);

    assert.throws(
      () => stack.conversationFiles.assertMemberOfConversation(room, carol.id),
      /不是这个会话的成员/,
    );
  });
});

// ------------------------------------------------------------------ 搜索

describe('会话文件：搜索', () => {
  it('搜不到已删除的文件；删掉 FTS 行才算真删干净', async () => {
    const marker = 'deleted-marker-zeta';
    const file = await readyFile(room, 'gone', `content with ${marker} inside`);

    const before = await fetch(`${base}/api/conversations/${room}/files/search?q=${marker}`);
    assert.equal(before.status, 200);
    assert.equal(((await before.json()) as { hits: unknown[] }).hits.length, 1);

    await fetch(`${base}/api/conversations/${room}/files/${file.id}`, { method: 'DELETE' });

    const after = await fetch(`${base}/api/conversations/${room}/files/search?q=${marker}`);
    assert.equal(((await after.json()) as { hits: unknown[] }).hits.length, 0);
  });

  it('模型能打出的畸形查询串不会让 fts5 抛语法错', async () => {
    await readyFile(room, 'fts', 'alpha beta gamma');
    const response = await fetch(
      `${base}/api/conversations/${room}/files/search?q=${encodeURIComponent('alpha" NEAR( beta')}`,
    );
    assert.equal(response.status, 200, '带引号/括号的查询必须被转义，而不是变成 500');
  });
});

// -------------------------------------------------------- 删除与历史保留

describe('会话文件：删除', () => {
  it('软删除：Shared Files 里消失、不能再引用，但历史消息仍然指向它', async () => {
    const file = await readyFile(room, 'history', 'history body');

    const sent = await postMessage(room, { content: '带附件的历史消息', fileIds: [file.id] });
    const sentPayload = (await sent.json()) as { message: { id: string } };

    const removed = await fetch(`${base}/api/conversations/${room}/files/${file.id}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { file: ConversationFile }).file.status, 'deleted');

    const listedInShared = await fetch(`${base}/api/conversations/${room}/files`);
    const files = ((await listedInShared.json()) as { files: ConversationFile[] }).files;
    assert.ok(!files.some((item) => item.id === file.id), '删除后不该再出现在 Shared Files 里');

    // 这一条是审计链：那条消息是**发生过的事实**，物理删掉文件会让它指向空气。
    const listed = stack.team.listMessages(room).find((item) => item.id === sentPayload.message.id);
    assert.ok(listed);
    assert.deepEqual(
      listed.files.map((item) => item.id),
      [file.id],
      '删掉文件不能让历史消息上的附件卡片消失',
    );
    assert.equal(listed.files[0].status, 'deleted');

    const content = await fetch(`${base}/api/conversations/${room}/files/${file.id}/content`);
    assert.equal(content.status, 404);

    const reuse = await postMessage(room, { content: '引用已删除的文件', fileIds: [file.id] });
    assert.equal(reuse.status, 400);
    assert.match(((await reuse.json()) as { error: string }).error, /已经被删除/);
  });

  it('消息没了，关系行跟着走：不留指向不存在消息的孤儿行', async () => {
    const file = await readyFile(room, 'cascade', 'cascade body');
    const sent = await postMessage(room, { content: '级联用', fileIds: [file.id] });
    const payload = (await sent.json()) as { message: { id: string } };
    assert.equal(relationBetween(payload.message.id, file.id), 'attachment');

    db.prepare('DELETE FROM conversation_message WHERE id = ?').run(payload.message.id);

    const leftover = db
      .prepare('SELECT COUNT(*) AS count FROM conversation_message_file WHERE message_id = ?')
      .get(payload.message.id) as unknown as { count: number };
    assert.equal(leftover.count, 0, '关系行必须随消息级联删除，否则库里的关系会慢慢变成垃圾');

    // 删的是消息，不是文件 —— 文件仍然在 Shared Files 里。
    assert.equal(stack.conversationFiles.get(room, file.id).status, 'ready');
  });
});

// ---------------------------------------------------------------- promote

describe('会话文件：promote 到团队知识库', () => {
  it('显式把一份文本文件写进团队知识库', async () => {
    const kb = stack.knowledge.createTeamKnowledgeBase({ key: 'handbook', name: 'Handbook' });
    const file = await readyFile(room, 'promote', '# 发布说明\n这次上线了会话文件。');

    const response = await fetch(
      `${base}/api/conversations/${room}/files/${file.id}/promote`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledgeBaseId: kb.id }),
      },
    );
    assert.equal(response.status, 201);
    const { document } = (await response.json()) as {
      document: { id: string; relativePath: string; title: string };
    };

    // 标题保留原文件名（检索结果上看到的就是它），路径只留 fileId + .md。
    assert.equal(document.title, file.originalName);
    assert.equal(document.relativePath, `promoted/${file.id}.md`);
    assert.equal(stack.knowledge.countDocuments(kb.id), 1);

    // 验证正文真的落到了知识库目录，而不是只留了一条索引行。
    const onDisk = fs.readFileSync(
      path.join(config.teamKnowledgeRoot, kb.key, document.relativePath),
      'utf8',
    );
    assert.equal(onDisk, '# 发布说明\n这次上线了会话文件。');
  });

  it('文本超过知识库单份上限时提前拒绝，并说清文件本身没丢', async () => {
    const kb = stack.knowledge.createTeamKnowledgeBase({ key: 'oversize', name: 'Oversize' });
    // 1MB 上限：把文本顶过去即可，不需要真的造一个超限文件。
    const huge = 'x'.repeat(1_100_000);
    const service = new ConversationFileService(db, {
      root: config.conversationFileRoot,
      maxBytesPerFile: config.maxConversationFileBytes,
      maxFilesPerConversation: config.maxConversationFilesPerConversation,
      maxFilesPerMessage: config.maxConversationFilesPerMessage,
    });
    const file = service.create({
      conversationId: room,
      teamId: stack.team.getConversation(room).teamId,
      uploadedBy: config.localUserId,
      originalName: newFileName('huge'),
      contentType: 'text/markdown',
      body: Buffer.from(huge),
    });
    service.markReady(file.id, huge);

    assert.throws(
      () =>
        service.promote({
          conversationId: room,
          fileId: file.id,
          knowledgeBaseId: kb.id,
          knowledge: stack.knowledge,
        }),
      /存不进知识库.*仍然留在这个会话里/,
    );
    // 拒绝的是「存进知识库」这一件事，会话文件本身照常可用。
    assert.equal(service.get(room, file.id).status, 'ready');
    assert.equal(stack.knowledge.countDocuments(kb.id), 0);
  });

  it('不可提取文本的文件不能 promote（知识库是文本库，进去只会是一份空壳）', async () => {
    const kb = stack.knowledge.createTeamKnowledgeBase({ key: 'manual', name: 'Manual' });
    const pdf = await uploadOk(room, newFileName('paper', 'pdf'), 'not really a pdf', 'application/pdf');
    await waitForReady(room, pdf.id);

    const response = await fetch(`${base}/api/conversations/${room}/files/${pdf.id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ knowledgeBaseId: kb.id }),
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /没有可索引的文本内容/);
  });

  it('只能 promote 到团队库，且文件必须已经处理好', async () => {
    const file = await readyFile(room, 'target', 'target body');

    const personalOnly = await fetch(
      `${base}/api/conversations/${room}/files/${file.id}/promote`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledgeBaseId: 'not-a-team-kb' }),
      },
    );
    assert.equal(personalOnly.status, 400);
    assert.match(((await personalOnly.json()) as { error: string }).error, /团队知识库/);

    // 还没提取完的文件：直接调服务，绕开上传 → 就绪之间的竞态。
    const kb = stack.knowledge.createTeamKnowledgeBase({ key: 'pending', name: 'Pending' });
    const fresh = stack.conversationFiles.create({
      conversationId: room,
      teamId: stack.team.getConversation(room).teamId,
      uploadedBy: config.localUserId,
      originalName: 'still-processing.md',
      contentType: 'text/markdown',
      body: Buffer.from('still processing'),
    });
    assert.equal(fresh.status, 'processing');
    assert.throws(
      () =>
        stack.conversationFiles.promote({
          conversationId: room,
          fileId: fresh.id,
          knowledgeBaseId: kb.id,
          knowledge: stack.knowledge,
        }),
      /还没有处理完/,
    );
  });
});

// ------------------------------------------------------ 响应头与预览安全

describe('会话文件：正文响应的安全头', () => {
  it('图片 / PDF 走 inline，HTML 一律 attachment，且都带 nosniff + CSP', async () => {
    const pdf = await uploadOk(room, newFileName('doc', 'pdf'), 'fake pdf bytes', 'application/pdf');
    await waitForReady(room, pdf.id);
    const pdfResponse = await fetch(`${base}/api/conversations/${room}/files/${pdf.id}/content`);
    assert.equal(pdfResponse.headers.get('content-disposition')?.startsWith('inline'), true);
    assert.equal(pdfResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(pdfResponse.headers.get('content-security-policy') ?? '', /sandbox/);

    // HTML 是同源可执行内容：即使上传者自己看，也不该被当成页面渲染出来。
    const html = await uploadOk(
      room,
      newFileName('page', 'html'),
      '<script>alert(1)</script>',
      'text/html',
    );
    await waitForReady(room, html.id);
    const htmlResponse = await fetch(`${base}/api/conversations/${room}/files/${html.id}/content`);
    assert.equal(htmlResponse.headers.get('content-disposition')?.startsWith('attachment'), true);

    const svg = await uploadOk(room, newFileName('icon', 'svg'), '<svg/>', 'image/svg+xml');
    await waitForReady(room, svg.id);
    const svgResponse = await fetch(`${base}/api/conversations/${room}/files/${svg.id}/content`);
    assert.equal(
      svgResponse.headers.get('content-disposition')?.startsWith('attachment'),
      true,
      'SVG 能带脚本，不能和 PNG 走同一条 inline 分支',
    );
  });
});

