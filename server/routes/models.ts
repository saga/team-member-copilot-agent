import { Router } from 'express';
import { modelPolicy } from '../config.js';

/**
 * 模型策略只读接口。
 *
 * 前端只知道：Lead 有 Standard / Strong 两档，Member 有 Standard / Cheap。
 * 真正执行时由服务端再次校验，前端只是展示 —— 可选列表里永远没有 Strong。
 */
export function modelsRouter() {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ policy: modelPolicy });
  });
  return router;
}
