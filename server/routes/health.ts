import { Router } from 'express';
import { copilotService } from '../app.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    // idle = client 尚未建连的懒加载态，不是故障
    copilot: copilotService.getStatus(),
    ...(copilotService.getLastError() ? { copilotError: copilotService.getLastError() } : {}),
  });
});

healthRouter.get('/ready', (_req, res) => {
  // 进程 listen 即就绪。copilot 未建连不阻塞就绪，首个 turn 会触发建连。
  res.json({ status: 'ready', timestamp: new Date().toISOString() });
});
