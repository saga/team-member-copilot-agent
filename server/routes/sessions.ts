import { Router } from 'express';
import { z } from 'zod';
import { copilotService } from '../copilot.js';

export const sessionsRouter = Router();

export const CreateSessionBody = z.object({
  model: z.string().trim().min(1).optional(),
});

export const ChatBody = z.object({
  prompt: z.string().trim().min(1, 'prompt 不能为空'),
  streaming: z.boolean().optional().default(false),
  model: z.string().trim().min(1).optional(),
});

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errStatus(e: unknown): number {
  const s = (e as { status?: unknown }).status;
  return typeof s === 'number' && Number.isInteger(s) && s >= 400 && s < 600 ? s : 500;
}

/** POST /api/sessions — 创建会话 → { sessionId } */
sessionsRouter.post('/', async (req, res) => {
  const parsed = CreateSessionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  try {
    const session = await copilotService.createSession(parsed.data.model);
    res.status(201).json({ sessionId: session.sessionId });
  } catch (e) {
    res.status(errStatus(e)).json({ error: `创建会话失败：${errMsg(e)}` });
  }
});

/** GET /api/sessions — 会话 id 列表（内存） */
sessionsRouter.get('/', (_req, res) => {
  res.json({ sessions: copilotService.listSessions() });
});

/** DELETE /api/sessions/:id — 销毁会话 */
sessionsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await copilotService.destroySession(req.params.id);
    if (!ok) {
      res.status(404).json({ error: `session 不存在：${req.params.id}` });
      return;
    }
    res.json({ sessionId: req.params.id, destroyed: true });
  } catch (e) {
    res.status(errStatus(e)).json({ error: `销毁会话失败：${errMsg(e)}` });
  }
});

/**
 * POST /api/sessions/:id/chat — 一次 prompt = 一轮 agent turn。
 * streaming:false → { sessionId, content }；true → SSE（delta / done / error）。
 */
sessionsRouter.post('/:id/chat', async (req, res) => {
  const parsed = ChatBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  const { prompt, streaming, model } = parsed.data;
  const sessionId = req.params.id;

  if (!streaming) {
    try {
      const content = await copilotService.chat(sessionId, prompt, { model });
      res.json({ sessionId, content });
    } catch (e) {
      res.status(errStatus(e)).json({ error: errMsg(e) });
    }
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const content = await copilotService.chat(sessionId, prompt, {
      model,
      onDelta: (delta) => send('delta', { delta }),
    });
    send('message', { content });
    send('done', { sessionId });
    res.end();
  } catch (e) {
    send('error', { error: errMsg(e) });
    res.end();
  }
});
