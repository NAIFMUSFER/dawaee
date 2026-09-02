import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@dawaee/shared';
import { verifyAccessToken } from '../auth/tokens.js';
import { assertSessionLive, } from '../auth/session-service.js';
import { hashIp, withTransaction } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; sessionId: string; isAdmin: boolean };
    ipHash: string | null;
  }
}

/**
 * Authentication.
 *
 * Verifying the JWT signature is not enough on its own: a session revoked from
 * another device must stop working immediately, so the session row is checked
 * too. That costs one indexed lookup per request and is the difference between
 * "signed out everywhere" meaning something and not.
 */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw AppError.unauthenticated();

  const claims = await verifyAccessToken(header.slice(7).trim());
  await withTransaction(async (tx) => {
    await assertSessionLive(tx, claims.sid);
  });

  req.auth = { userId: claims.sub, sessionId: claims.sid, isAdmin: claims.role === 'admin' };
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!req.auth?.isAdmin) throw AppError.forbidden('Administrator access required');
}

export function currentUser(req: FastifyRequest): { userId: string; sessionId: string; isAdmin: boolean } {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}

export function attachRequestContext(req: FastifyRequest): void {
  req.ipHash = hashIp(req.ip);
}
