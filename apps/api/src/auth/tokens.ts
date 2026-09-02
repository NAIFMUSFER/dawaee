import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { loadConfig } from '../config.js';

/**
 * Access tokens are short-lived JWTs; refresh tokens are opaque random strings
 * stored only as hashes and rotated on every use, so a stolen refresh token is
 * detectable (the old one stops working) and useless once rotated.
 */

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  sid: string;
  role: 'user' | 'admin';
}

let secretKey: Uint8Array | null = null;
function key(): Uint8Array {
  if (!secretKey) secretKey = new TextEncoder().encode(loadConfig().JWT_SECRET);
  return secretKey;
}

export async function signAccessToken(userId: string, sessionId: string, isAdmin = false): Promise<string> {
  const cfg = loadConfig();
  return new SignJWT({ sid: sessionId, role: isAdmin ? 'admin' : 'user' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(cfg.JWT_ISSUER)
    .setAudience('dawaee-client')
    .setIssuedAt()
    .setExpirationTime(`${cfg.ACCESS_TOKEN_TTL_MINUTES}m`)
    .sign(key());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const cfg = loadConfig();
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: cfg.JWT_ISSUER,
      audience: 'dawaee-client',
      algorithms: ['HS256'],
      clockTolerance: 15,
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw AppError.unauthenticated('Malformed token');
    }
    return payload as AccessTokenClaims;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') {
      throw new AppError(ERROR_CODES.TOKEN_EXPIRED, 401, 'Access token expired');
    }
    throw AppError.unauthenticated('Invalid access token');
  }
}

export function accessTokenTtlSeconds(): number {
  return loadConfig().ACCESS_TOKEN_TTL_MINUTES * 60;
}
