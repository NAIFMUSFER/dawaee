import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { loadConfig } from '../config.js';
import { randomToken, sha256 } from '../lib/crypto.js';

/**
 * Sessions.
 *
 * Every statement here goes through a SECURITY DEFINER function (migration
 * 0011) because the auth plane runs before `app.user_id` exists and therefore
 * cannot satisfy the RLS policies that protect `auth_sessions` for everything
 * else. Refresh tokens are opaque, stored only as hashes, and rotated on use.
 */

export interface SessionTokens {
  sessionId: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export async function createSession(
  tx: PoolClient,
  userId: string,
  device: { deviceId: string; deviceName?: string | null; userAgent?: string | null; ipHash?: string | null },
): Promise<SessionTokens> {
  const cfg = loadConfig();
  const refreshToken = randomToken(48);
  const { rows } = await tx.query<{ session_id: string; expires_at: Date }>(
    'SELECT * FROM app.create_session($1,$2,$3,$4,$5,$6,$7)',
    [
      userId, sha256(refreshToken), device.deviceId, device.deviceName ?? null,
      device.userAgent ?? null, device.ipHash ?? null, cfg.REFRESH_TOKEN_TTL_DAYS,
    ],
  );
  const row = rows[0]!;
  return { sessionId: row.session_id, refreshToken, refreshExpiresAt: new Date(row.expires_at) };
}

export type RotateOutcome =
  | { outcome: 'rotated'; userId: string; isAdmin: boolean; sessionId: string; refreshToken: string; refreshExpiresAt: Date }
  | { outcome: 'reuse_detected' | 'expired' | 'invalid' | 'superseded' };

/**
 * Performs the rotation and RETURNS the outcome rather than throwing.
 *
 * On reuse detection the function revokes every session on that device — a
 * durable, security-critical write. Throwing here would roll that revocation
 * back and leave the stolen session alive, so the caller commits first and
 * raises the error afterwards (see `assertRotated`).
 */
export async function rotateSessionAttempt(
  tx: PoolClient,
  presentedToken: string,
  ipHash: string | null,
): Promise<RotateOutcome> {
  const cfg = loadConfig();
  const newToken = randomToken(48);
  const { rows } = await tx.query<{
    outcome: string; user_id: string | null; is_admin: boolean | null;
    session_id: string | null; expires_at: Date | null;
  }>(
    'SELECT * FROM app.rotate_session($1,$2,$3,$4)',
    [sha256(presentedToken), sha256(newToken), ipHash, cfg.REFRESH_TOKEN_TTL_DAYS],
  );
  const result = rows[0];

  if (result?.outcome === 'rotated') {
    return {
      outcome: 'rotated',
      userId: result.user_id!,
      isAdmin: result.is_admin ?? false,
      sessionId: result.session_id!,
      refreshToken: newToken,
      refreshExpiresAt: new Date(result.expires_at!),
    };
  }
  return { outcome: (result?.outcome ?? 'invalid') as 'reuse_detected' | 'expired' | 'invalid' | 'superseded' };
}

export function assertRotated(
  result: RotateOutcome,
): Extract<RotateOutcome, { outcome: 'rotated' }> {
  switch (result.outcome) {
    case 'rotated':
      return result;
    case 'superseded':
      /**
       * Two of this client's own requests raced and this one lost. Nothing was
       * revoked and nothing is minted — the caller already has a valid session
       * from its winning request and must use that. Deliberately a 409 rather
       * than a 401: a 401 is what tells a client to discard its session, which
       * is precisely the wrong reaction here.
       */
      throw new AppError(
        ERROR_CODES.REFRESH_SUPERSEDED, 409,
        'This refresh was superseded by another request from the same client.',
      );
    case 'reuse_detected':
      // The old token surfaced again after rotation. The device's sessions
      // have already been revoked and committed; the legitimate owner has to
      // sign in again, which is the correct outcome of a suspected theft.
      throw new AppError(ERROR_CODES.UNAUTHENTICATED, 401, 'Session revoked. Please sign in again.');
    case 'expired':
      throw new AppError(ERROR_CODES.TOKEN_EXPIRED, 401, 'Session expired. Please sign in again.');
    default:
      throw AppError.unauthenticated('Invalid refresh token');
  }
}

export async function revokeSession(tx: PoolClient, sessionId: string): Promise<void> {
  await tx.query('SELECT app.revoke_session($1)', [sessionId]);
}

export async function assertSessionLive(tx: PoolClient, sessionId: string): Promise<void> {
  const { rows } = await tx.query<{ live: boolean }>('SELECT app.session_is_live($1) AS live', [sessionId]);
  if (!rows[0]?.live) throw AppError.unauthenticated('Session is no longer valid');
}
