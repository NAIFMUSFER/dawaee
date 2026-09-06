import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@dawaee/shared';
import { verifyAccessToken } from '../auth/tokens.js';
import { assertSessionLive, } from '../auth/session-service.js';
import { hashIp, withTransaction } from '../lib/db.js';
import { loadConfig } from '../config.js';

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

/**
 * Warns, once, when the derived client address is obviously not a client.
 *
 * TRUST_PROXY_HOPS says how many proxies sit in front of this app, and it
 * cannot be verified from inside the repository — it is a fact about the
 * deployment. Both ways of getting it wrong are silent, and both are bad:
 *
 *   TOO FEW — a value the client wrote becomes `req.ip`, and every
 *   address-keyed limit is one header away from meaningless.
 *
 *   TOO MANY — the app walks past the real client and lands on the proxy's own
 *   address, so every user on earth shares one rate-limit bucket and one
 *   `ipHash` in the audit trail. Nothing errors; the limits simply start
 *   refusing everyone at once.
 *
 * The second case leaves a fingerprint: infrastructure addresses are private or
 * loopback, and a genuine internet client's is not. Saying so in the log is how
 * an operator finds out, and it needs no diagnostic endpoint left running in
 * production to do it. Once per process — this is a configuration fact, not a
 * per-request event, and a line per request would be its own denial of service.
 */
let warnedAboutProxyDepth = false;

function looksLikeInfrastructure(ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
  if (v4 === '::1' || v4.startsWith('fc') || v4.startsWith('fd')) return true; // loopback / unique-local v6
  const parts = v4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function attachRequestContext(req: FastifyRequest): void {
  if (!warnedAboutProxyDepth && looksLikeInfrastructure(req.ip)) {
    warnedAboutProxyDepth = true;
    req.log.warn(
      { trustProxyHops: loadConfig().TRUST_PROXY_HOPS, forwardedEntries: req.ips?.length ?? 0 },
      'client address resolves to a private range — TRUST_PROXY_HOPS is probably larger than the '
      + 'number of proxies actually in front of this service, which collapses every client into one '
      + 'rate-limit bucket. The address itself is not logged.',
    );
  }
  req.ipHash = hashIp(req.ip);
}
