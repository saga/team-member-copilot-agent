import { Router } from 'express';
import { copilotService } from '../copilot.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const startedAt = (healthRouter as unknown as { startedAt?: number }).startedAt ?? Date.now();
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
    // idle = client 尚未建连的懒加载态，不是故障；判可用性看 /api/health/ready
    copilot: copilotService.getStatus(),
    ...(copilotService.getLastError() ? { copilotError: copilotService.getLastError() } : {}),
  });
});

healthRouter.get('/ready', (_req, res) => {
  // 基础框架无启动恢复流程：进程 listen 即就绪。copilot 未连不阻塞就绪，
  // 首个会话请求会触发建连并返回明确错误。
  res.json({ status: 'ready', timestamp: new Date().toISOString() });
});
