import express, { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import type {
  ConversationFileProcessor,
} from '../conversation-file-processor.js';
import type { ConversationFileService } from '../conversation-file-service.js';
import type { StoredConversationEvent } from '../domain.js';
import { config } from '../config.js';
import { sendError } from '../middleware/errorHandler.js';
import { canAdmin } from '../middleware/adminAccess.js';
import { FileTypeRejectedError } from '../file-extractor.js';

/**
 * 会话文件（聊天附件）的上传。
 *
 * 用 raw body（和装 skill 同一套）而不是 multipart：一次只传一个文件，引入
 * multipart parser 只会多一层依赖和一个临时目录。文件名走 query —— `X-` 开头
 * 的头在部分代理上会被吃掉，而文件名是这类接口最容易被中间层改坏的东西。
 *
 * Content-Type 不做白名单（附件本来就可能是任何类型），但 `express.raw` 必须
 * 拿到 `*​/*` 才会解析出 Buffer，否则 body 会是一个普通对象 —— 路由里按 400
 * 处理，而不是让 Buffer.isBuffer 静默失败。
 */
const rawFile = express.raw({ type: () => true, limit: config.maxConversationFileBytes });

const createConversationSchema = z.object({
  title: z.string().trim().max(200).optional(),
  kind: z.enum(['task', 'direct']).optional(),
  memberIds: z.array(z.string().min(1)).min(1).max(20),
  leadMemberId: z.string().optional(),
  /**
   * 这间会话围绕哪条外部工作。
   *
   * 只收引用 —— 工单内容在 Jira，本地没有存它的地方。zod 会把没声明的键
   * 静默剥掉，所以这里必须显式声明：漏一个字段的表现是「调用方传了、服务端
   * 当没看见」，而它不会报任何错（真实发生过：重构掉 jiraIssueKey 之后，
   * 前端改传 externalWorkRef，这个 schema 没跟着改，引用被丢在边界上）。
   */
  externalWorkRef: z
    .object({
      /**
       * provider 在这里枚举，而不是交给 registry 校验：schema 是**输入形状**
       * 的权威，registry 是**能力**的权威。放行一个未知 provider 会让
       * normalizeExternalWorkRef 抛普通 Error，最后表现成 500 —— 一个客户端
       * 输入错误不该是 500。代价是新增外部系统要同时改这里和 registry。
       */
      provider: z.literal('jira').optional(),
      /**
       * 允许空串：`normalizeExternalWorkRef` 把空 key 当成「没有引用」而不是
       * 错误（调用方清空输入框时不该炸）。语义判断留在 service，schema 只管形状。
       */
      key: z.string().trim().max(60),
      externalId: z.string().trim().max(120).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(20000),
  replyToMessageId: z.string().min(1).optional(),
  /**
   * 幂等键。同一个键第二次到达时不会再落一条消息，也不会再派一次唤醒，
   * 而是把第一次那条原样返回（`deduplicated: true`）。
   *
   * 长度上限是防御性的：这个值会进 UNIQUE 索引，一个超长（或每次调用都变）
   * 的值只会把索引撑大，不会带来任何好处。
   */
  clientRequestId: z.string().trim().min(1).max(200).optional(),
  /**
   * 这条消息带 / 引用的会话文件。上限与 ServiceOptions 的
   * maxConversationFilesPerMessage 保持一致 —— schema 是边界，service 是权威，
   * 这里放宽只是不让一个明显过分的请求进到业务逻辑里。
   */
  fileIds: z.array(z.string().min(1)).max(50).optional(),
});

const updateGoalSchema = z.object({
  objective: z.string().trim().min(1).max(4000),
  requirements: z
    .object({
      facts: z
        .array(
          z.object({
            key: z.string().min(1).max(200),
            value: z.string().min(1).max(4000),
            source: z.enum([
              'user',
              'jira',
              'knowledge',
              'conversation',
              'agent',
            ]),
            confirmed: z.boolean(),
          }),
        )
        .max(50)
        .optional(),
      assumptions: z.array(z.string().max(1000)).max(20).optional(),
      constraints: z.array(z.string().max(1000)).max(20).optional(),
      successCriteria: z
        .array(z.string().max(1000))
        .max(20)
        .optional(),
    })
    .optional(),
  changeKind: z
    .enum([
      'clarification',
      'scope_change',
      'success_criteria_change',
      'correction',
    ])
    .default('scope_change'),
  reason: z.string().trim().max(2000).optional(),
});

/** promote 的目标知识库：只接受 team KB，个人库不在这个入口的语义里。 */
export interface PromotionTarget {
  writeDocument(input: {
    knowledgeBaseId: string;
    title: string;
    relativePath: string;
    content: string;
    sourceUri?: string | null;
  }): { id: string; relativePath: string; title: string };
  listTeamKnowledgeBases(): Array<{ id: string; key: string; name: string }>;
}

const promoteSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  title: z.string().trim().min(1).max(300).optional(),
});

const addMemberSchema = z.object({
  memberId: z.string().min(1),
});

/**
 * 改 Member 在房间里的静音状态。
 *
 * body 必须是 `{ muted: boolean }`：空 body 什么都不改却回 200，是最难查的
 * 一类「接口没问题但没生效」。
 */
const setMemberStateSchema = z.object({
  muted: z.boolean(),
});

export function conversationsRouter(
  team: TeamService,
  files: ConversationFileService,
  processor: ConversationFileProcessor,
  knowledge: PromotionTarget,
) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ conversations: team.listConversations() });
  });

  router.post('/', (req, res) => {
    const parsed = createConversationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      // 线上建工作区 Lead 主动先开口：用户不用先想第一句话。
      res.status(201).json({ conversation: team.createConversation(parsed.data, { autoStartLead: true }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      res.json({ conversation: team.getConversation(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id/messages', (req, res) => {
    const requested = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
    try {
      res.json({ messages: team.listMessages(req.params.id, limit) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** 这个工作区的任务列表。 */
  router.get('/:id/tasks', (req, res) => {
    try {
      res.json({ tasks: team.listTasks(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * conversation 的 execution 列表，按创建时间正序。
   *
   * 客户端按 `parentExecutionId` 自己组执行树 —— 不需要服务端出一个 tree 接口，
   * 那只是在缓存一个随时会变的视图。
   */
  router.get('/:id/executions', (req, res) => {
    const requested = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 1000) : 200;
    try {
      res.json({ executions: team.listExecutions(req.params.id, limit) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/messages', async (req, res) => {
    const parsed = sendMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      // 202：消息已落库、execution 已入队，结果通过 SSE 推。
      const result = await team.sendMessage({ conversationId: req.params.id, ...parsed.data });
      res.status(202).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/members', (req, res) => {
    const parsed = addMemberSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'memberId 不能为空' });
      return;
    }
    try {
      res.json({ conversation: team.addMember(req.params.id, parsed.data.memberId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:id/members/:memberId', (req, res) => {
    try {
      res.json({ conversation: team.removeMember(req.params.id, req.params.memberId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 房间里每个 Member 的房间状态（读游标 / 唤醒状态 / 是否静音）。
   *
   * UI 用它在 header 上把成员显示成「团队成员」而不是下拉选项：
   * Alice ●idle / Bob ●working / Iris 🔇muted。
   */
  router.get('/:id/state', (req, res) => {
    try {
      res.json({ states: team.listConversationState(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 用户在 UI 上改 Goal：生成新版本，旧计划失效，Lead 重新规划。
   * Lead 自己在 turn 里改走 update_goal 工具，两条路汇到同一个
   * TeamService.updateGoal —— “谁点的”只决定 actorType，不决定语义。
   */
  router.patch('/:id/goal', async (req, res) => {
    const parsed = updateGoalSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => i.message).join('; '),
      });
      return;
    }
    try {
      const result = await team.updateGoal({
        conversationId: req.params.id,
        actorType: 'user',
        actorId: config.localUserId,
        objective: parsed.data.objective,
        requirements: parsed.data.requirements
          ? {
              facts: parsed.data.requirements.facts ?? [],
              assumptions: parsed.data.requirements.assumptions ?? [],
              constraints: parsed.data.requirements.constraints ?? [],
              successCriteria: parsed.data.requirements.successCriteria ?? [],
            }
          : undefined,
        changeKind: parsed.data.changeKind,
        reason: parsed.data.reason,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id/goal/history', (req, res) => {
    try {
      res.json({
        revisions: team.listGoalRevisions(req.params.id),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 改某个 Member 在房间里的静音状态。
   *
   * 静音的语义是「dispatcher 不唤醒它」——@ 也唤不醒。成员仍然看得见历史，
   * 只是不再被拉进讨论。
   */
  router.patch('/:id/members/:memberId/state', (req, res) => {
    const parsed = setMemberStateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      const state = team.setMemberMuted(req.params.id, req.params.memberId, parsed.data.muted);
      res.json({ state });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 这个会话里共享的文件。
   *
   * 权限边界是「会话成员」：拿到 conversation id 就能列，因为能拿到它的人本来
   * 就在这场对话里（当前是单 Team 本地部署，没有跨租户的会话 id 泄露面）。
   * 真正需要重新校验的是**按 fileId 取内容**那条路径 —— 见 /content。
   */
  router.get('/:id/files', (req, res) => {
    try {
      team.getConversation(req.params.id);
      res.json({ files: files.list(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 上传一份文件。
   *
   * 返回 202：正文已落盘、行已建好（status=processing），但提取与 FTS 索引在
   * 后台跑。让这个请求等 PDF 解析 / 长文本索引跑完，等于把上传耗时绑在文件内容
   * 上 —— 而那是用户完全无从预期的东西。就绪状态通过 file.updated 事件推。
   */
  router.post('/:id/files', rawFile, (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: '上传的内容不是原始文件：请直接发文件内容，不要包成 JSON' });
      return;
    }

    const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
    if (!filename.trim()) {
      res.status(400).json({ error: '这个请求没带文件名：请在地址后面加上 ?filename=文件名' });
      return;
    }

    try {
      const conversation = team.getConversation(req.params.id);
      const file = files.create({
        conversationId: conversation.id,
        teamId: conversation.teamId,
        uploadedBy: config.localUserId,
        originalName: filename,
        contentType: req.headers['content-type'] ?? 'application/octet-stream',
        body: req.body,
      });
      processor.enqueue(file);
      res.status(202).json({ file });
    } catch (error) {
      // 类型闸门抛的是普通 Error，不翻成 400 的话会变成 500 —— 而它其实只是
      // 「这个文件不允许上传」，是调用方能自己改的那种错误。
      if (error instanceof FileTypeRejectedError) {
        res.status(400).json({ error: error.message });
        return;
      }
      sendError(res, error);
    }
  });

  /**
   * 取出文件正文。
   *
   * 三条纪律：
   *   1. 每次都用 (conversationId, fileId) 重新定位 —— fileId 是客户端输入，
   *      不能拿它直接去读磁盘。
   *   2. 默认 inline 的只有浏览器能安全渲染的格式（图片 / PDF）；其它一律
   *      attachment。上传的 HTML / SVG 走 inline 会在同源下执行脚本。
   *   3. 无论如何都带 nosniff + CSP sandbox：即使 Content-Type 被伪造，
   *      浏览器也不会把它当可执行的东西跑起来。
   */
  router.get('/:id/files/:fileId/content', (req, res) => {
    try {
      const file = files.get(req.params.id, req.params.fileId);
      const content = files.readContent(req.params.id, req.params.fileId);

      const safelisted =
        file.contentType === 'application/pdf' ||
        (file.contentType.startsWith('image/') && file.contentType !== 'image/svg+xml');
      const inline = safelisted && req.query.download !== '1';

      res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      );
      res.send(content);
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 会话内文件搜索（人在界面上用）。
   *
   * `memberId` 传 null：人是通过会话级入口进来的，不是 conversation_member
   * 里的一行。Agent 走的是另一个入口（tool provider），那条路径必须带 memberId，
   * 让成员校验进 SQL。
   */
  router.get('/:id/files/search', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.status(400).json({ error: '没有要搜的内容：请在地址后面加上 ?q=关键词' });
      return;
    }
    try {
      team.getConversation(req.params.id);
      res.json({
        hits: files.search({
          conversationId: req.params.id,
          memberId: null,
          query,
          limit: 10,
        }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 删除一份会话文件。
   *
   * 软删除：历史消息里那条附件仍然在（它发生过），只是不能再出现在 Shared
   * Files 里、也不能再被引用。物理删掉会把过去那条消息变成一个指不到东西的
   * 引用 —— 审计链就断了。
   */
  router.delete('/:id/files/:fileId', (req, res) => {
    try {
      files.softDelete(req.params.id, req.params.fileId);
      res.json({ file: files.get(req.params.id, req.params.fileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 把聊天文件存进团队知识库（显式动作）。
   *
   * 这是「临时」变成「长期」的唯一入口，所以它是一次**发布**：需要 admin /
   * owner。不这么做的话，任何参与私聊的人都能把里面的文件推成全团队可见的资料。
   */
  router.post('/:id/files/:fileId/promote', (req, res) => {
    if (!canAdmin(req)) {
      res.status(403).json({ error: '需要 Team owner 或 admin 权限' });
      return;
    }
    const parsed = promoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }

    try {
      const target = knowledge
        .listTeamKnowledgeBases()
        .find((base) => base.id === parsed.data.knowledgeBaseId);
      if (!target) {
        res.status(400).json({ error: '只能保存到团队知识库，请重新选择' });
        return;
      }

      const document = files.promote({
        conversationId: req.params.id,
        fileId: req.params.fileId,
        knowledgeBaseId: parsed.data.knowledgeBaseId,
        knowledge,
        ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
      });
      res.status(201).json({ document });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * 所有 Member / User / delegation 的实时事件都从这一个 SSE 通道出去。
   *
   * 为什么不是让 POST /messages 自己返回 SSE：
   *   POST message → 202 + executionId
   *   Conversation SSE → message.created / message.delta /
   *                      delegation.started / delegation.finished /
   *                      execution.updated
   * 一次请求只对应一个 execution，但一个 execution 可能触发多次 delegation，
   * 只有「会话级」的通道才能把整棵执行树推给前端。
   *
   * 可靠性：事件先落 conversation_event 再广播，SSE 帧带 `id: <sequence>`。
   * 浏览器断线重连时会自动带上 Last-Event-ID，服务端据此把断线期间的事件补发，
   * 所以刷新页面 / 切网络不会丢消息。也可以用 `?since=` 手动指定水位。
   */
  router.get('/:id/events', (req, res) => {
    const conversationId = req.params.id;

    // 先校验会话存在，避免给不存在的 id 开一个永远静默的长连接
    try {
      team.getConversation(conversationId);
    } catch (error) {
      sendError(res, error);
      return;
    }

    const since = parseSince(req.headers['last-event-id'], req.query.since);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);
    // 断线后浏览器 3s 重连，比默认值激进一点，移动端体验更好
    res.write('retry: 3000\n\n');
    res.write(`event: connected\ndata: ${JSON.stringify({ conversationId, since })}\n\n`);

    const send = (event: StoredConversationEvent) => {
      // message.delta 没有 sequence（token 级事件不落库），因此不带 id 帧，
      // 浏览器不会推进 Last-Event-ID —— 它丢了也不用补，durable 的
      // message.created 会带完整内容收敛。
      const frame: string[] = [];
      if (event.sequence !== null) frame.push(`id: ${event.sequence}`);
      frame.push(`event: ${event.type}`);
      frame.push(`data: ${JSON.stringify(event.data)}`);
      res.write(`${frame.join('\n')}\n\n`);
    };

    const unsubscribe = team.replayAndSubscribe(conversationId, since, send);

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  return router;
}

/**
 * Last-Event-ID 头优先于 `?since=`。
 *
 * 自动重连时浏览器会带上 Last-Event-ID，它比 URL 里的 `?since=` 新（后者是
 * 首次连接时写死的），所以必须让 header 赢，否则每次重连都会重复回放一段。
 * 非法值一律当作从头回放（0）。Team SSE 用同一套语义。
 */
export function parseSince(header: unknown, query: unknown): number {
  const raw = header ?? query;
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
