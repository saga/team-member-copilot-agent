import type { NextFunction, Request, Response } from 'express';
import { authenticateHuman, type AuthPrincipal } from '../auth/identity.js';

declare global {
  namespace Express {
    interface Request {
      principal?: AuthPrincipal;
    }
  }
}

export function requireHumanAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    void authenticateHuman(req)
      .then((principal) => {
        req.principal = principal;
        next();
      })
      .catch((error) => {
        res.status(401).json({
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
}

export function currentPrincipal(req: Request): AuthPrincipal {
  if (!req.principal) {
    throw new Error('当前请求未认证');
  }
  return req.principal;
}
