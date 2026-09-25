import { Router } from 'express';
import { z } from 'zod';
import type { TeamService } from '../team-service.js';
import { sendError } from '../middleware/errorHandler.js';

const createConversationSchema = z.object({
  title: z.string().trim().max(200).optional(),
  kind: z.enum(['direct', 'group', 'work']).optional(),
  memberIds: z.array(z.string().min(1)).min(1).max(20),
  defaultMemberId: z.string().optional(),
});

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(20000),
  targetMemberId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
});

const addMemberSchema = z.object({
  memberId: z.string().min(1),
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
   * 所有 Member / User / delegation 的实时事件都从这一个 SSE 通道出去。
   *
   * 为什么不是让 POST /messages 自己返回 SSE：
   *   POST message → 202 + executionId
   *   Conversation SSE → message.created / message.delta /
   *                      delegation.started / delegation.finished /
   *                      execution.updated
   * 一次请求只对应一个 execution，但一个 execution 可能触发多次 delegation，
   * 只有「会话级」的通道才能把整棵执行树推给前端。
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

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('connected', { conversationId });

    const unsubscribe = team.subscribe(conversationId, (event) => {
      send(event.type, event.data);
    });

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
