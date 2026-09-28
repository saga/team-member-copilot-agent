import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { config } from '../config.js';

export interface AuthPrincipal {
  kind: 'human';
  principalId: string; // OIDC sub
  displayName?: string;
  email?: string;
  claims: JWTPayload;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!config.oidc.jwksUrl) {
    throw new Error('OIDC_JWKS_URL 未配置');
  }
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.oidc.jwksUrl));
  }
  return jwks;
}

export async function authenticateHuman(req: Request): Promise<AuthPrincipal> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    if (config.authDevMode) {
      return {
        kind: 'human',
        principalId: config.localActorId,
        displayName: 'Local Dev User',
        claims: { sub: config.localActorId },
      };
    }
    throw new Error('缺少 Bearer token');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new Error('Bearer token 为空');

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
  });

  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('OIDC token 缺少 sub');
  }

  return {
    kind: 'human',
    principalId: payload.sub,
    displayName:
      typeof payload.name === 'string'
        ? payload.name
        : typeof payload.preferred_username === 'string'
          ? payload.preferred_username
          : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    claims: payload,
  };
}
