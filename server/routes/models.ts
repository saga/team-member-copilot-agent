import { Router } from 'express';
import { modelPolicy } from '../config.js';

/**
 * 模型策略只读接口：前端的 Member 编辑器用它渲染可选的 Task 模型。
 *
 * Lead 模型只在这里展示，不在任何可选列表里出现 —— 用户不能选它，
 * 担任 Lead 时服务端自动用它。
 */
export function modelsRouter() {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ policy: modelPolicy });
  });
  return router;
}
