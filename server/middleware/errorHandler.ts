import type { NextFunction, Request, Response } from 'express';

/**
 * service 层用 `Object.assign(new Error(msg), { status })` 表达「这是业务错误」，
 * 这里统一把它翻译成 HTTP 响应，避免每个 route 重复 12 行 try/catch。
 */
export function errorStatus(error: unknown): number {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : 500;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sendError(res: Response, error: unknown): void {
  res.status(errorStatus(error)).json({ error: errorMessage(error) });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // eslint-disable-next-line no-console
  console.error(
    '[server] unhandled error:',
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  if (res.headersSent) return;
  // 走到这里的都是 route 没接住的意外错误，对外不泄漏内部信息
  res.status(500).json({ error: 'Internal Server Error' });
}
