import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import type { ConversationMemberState, StoredConversationEvent } from '../domain.js';
import { sendError } from '../middleware/errorHandler.js';

const createConversationSchema = z.object({
  title: z.string().trim().max(200).optional(),
  kind: z.enum(['direct', 'group', 'work']).optional(),
  memberIds: z.array(z.string().min(1)).min(1).max(20),
  defaultMemberId: z.string().optional(),
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
  targetMemberId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
  /**
   * 幂等键。同一个键第二次到达时不会再落一条消息，也不会再派一次唤醒，
   * 而是把第一次那条原样返回（`deduplicated: true`）。
   *
   * 长度上限是防御性的：这个值会进 UNIQUE 索引，一个超长（或每次调用都变）
   * 的值只会把索引撑大，不会带来任何好处。
   */
  clientRequestId: z.string().trim().min(1).max(200).optional(),
});

const addMemberSchema = z.object({
  memberId: z.string().min(1),
});

/**
 * 改 Member 在房间里的状态。
 *
 * 两个字段都可选，但**至少要有一个**：空 body 什么都不改却回 200，是最难查的
 * 一类「接口没问题但没生效」。
 */
const setMemberStateSchema = z
  .object({
    muted: z.boolean().optional(),
    isLead: z.boolean().optional(),
  })
  .refine((value) => value.muted !== undefined || value.isLead !== undefined, {
    message: '至少要提供 muted 或 isLead 之一',
  });

export function conversationsRouter(team: TeamService) {
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
      res.status(201).json({ conversation: team.createConversation(parsed.data) });
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
   * 改某个 Member 在房间里的状态：`muted`（静音）与 `isLead`（房间负责人）。
   *
   * 静音的语义是「dispatcher 不唤醒它」——@ 也唤不醒。成员仍然看得见历史，
   * 只是不再被拉进讨论。
   *
   * 负责人的语义是「用户对着房间说话、而整个房间都没接话时，由它兜底回答」。
   * 它不参与日常排序 —— 让她回答每一条，房间就变回「一个 Agent 加几个装饰」。
   * 一个房间至多一个负责人，由 DB 上的偏索引强制（换人会自动顶掉旧的）。
   */
  router.patch('/:id/members/:memberId/state', (req, res) => {
    const parsed = setMemberStateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      const { muted, isLead } = parsed.data;
      // 两个 setter 各自返回**改完之后**的完整状态，所以最后一个的结果就是
      // 响应该给的那份 —— 不需要再查一次全房间的状态。
      let state: ConversationMemberState | undefined;
      if (muted !== undefined) {
        state = team.setMemberMuted(req.params.id, req.params.memberId, muted);
      }
      if (isLead !== undefined) {
        state = team.setMemberLead(req.params.id, req.params.memberId, isLead);
      }
      res.json({ state });
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
