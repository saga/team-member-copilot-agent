import type { NextFunction, Request, Response } from 'express';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // eslint-disable-next-line no-console
  console.error('[server] unhandled error:', err instanceof Error ? err.stack ?? err.message : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal Server Error' });
}
