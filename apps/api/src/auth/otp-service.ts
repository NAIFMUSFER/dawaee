import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { loadConfig } from '../config.js';
import { generateOtp, sha256 } from '../lib/crypto.js';

/**
 * Phone OTP.
 *
 * The plaintext code exists only in this process, long enough to be handed to
 * the SMS provider. Everything else — storage, rate limiting, attempt counting
 * and single-use consumption — happens inside `app.issue_otp` / `app.verify_otp`,
 * which are SECURITY DEFINER: the request-serving database role has no access
 * to `auth_otp_challenges` at all, and the counters are atomic across every
 * API instance rather than racy per-process checks.
 */

export const OTP_REQUEST_WINDOW_MINUTES = 15;
export const OTP_MAX_REQUESTS_PER_WINDOW = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 45;

export interface IssuedOtp {
  challengeId: string;
  code: string;
  expiresAt: Date;
}

export async function issueOtp(tx: PoolClient, phone: string, ipHash: string | null): Promise<IssuedOtp> {
  const cfg = loadConfig();
  const code = generateOtp(cfg.OTP_LENGTH);

  const { rows } = await tx.query<{
    challenge_id: string | null; expires_at: Date | null; outcome: string; retry_after_seconds: number;
  }>(
    'SELECT * FROM app.issue_otp($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      phone, sha256(code), cfg.OTP_TTL_MINUTES, cfg.OTP_MAX_ATTEMPTS, ipHash,
      OTP_REQUEST_WINDOW_MINUTES, OTP_MAX_REQUESTS_PER_WINDOW, OTP_RESEND_COOLDOWN_SECONDS,
    ],
  );
  const result = rows[0];

  if (!result || result.outcome === 'rate_limited') {
    throw new AppError(ERROR_CODES.RATE_LIMITED, 429, 'Too many verification codes requested. Try again later.', {
      meta: { retryAfterSeconds: result?.retry_after_seconds ?? OTP_REQUEST_WINDOW_MINUTES * 60 },
    });
  }
  if (result.outcome === 'cooldown') {
    throw new AppError(
      ERROR_CODES.RATE_LIMITED, 429,
      `Please wait ${result.retry_after_seconds} seconds before requesting another code.`,
      { meta: { retryAfterSeconds: result.retry_after_seconds } },
    );
  }

  return { challengeId: result.challenge_id!, code, expiresAt: new Date(result.expires_at!) };
}

export type OtpOutcome = 'verified' | 'expired' | 'too_many_attempts' | 'no_challenge' | 'invalid';

export interface OtpCheckResult {
  outcome: OtpOutcome;
  attemptsRemaining: number;
}

/**
 * Checks a code and RETURNS the outcome instead of throwing.
 *
 * This distinction is load-bearing. A failed attempt increments a counter, and
 * a wrong guess that rolled that increment back would hand an attacker
 * unlimited tries. The caller must therefore commit this transaction before
 * turning a bad outcome into an error — see `assertOtpVerified`.
 */
export async function checkOtp(tx: PoolClient, phone: string, code: string): Promise<OtpCheckResult> {
  const { rows } = await tx.query<{ outcome: string; attempts_remaining: number }>(
    'SELECT * FROM app.verify_otp($1,$2)',
    [phone, sha256(code)],
  );
  return {
    outcome: (rows[0]?.outcome ?? 'no_challenge') as OtpOutcome,
    attemptsRemaining: rows[0]?.attempts_remaining ?? 0,
  };
}

/** Turns a committed outcome into the right API error. Never inside a transaction. */
export function assertOtpVerified(result: OtpCheckResult): void {
  const { outcome } = result;

  switch (outcome) {
    case 'verified':
      return;
    case 'expired':
      throw new AppError(ERROR_CODES.OTP_EXPIRED, 401, 'Verification code expired');
    case 'too_many_attempts':
      throw new AppError(ERROR_CODES.OTP_TOO_MANY_ATTEMPTS, 429, 'Too many incorrect attempts. Request a new code.');
    case 'no_challenge':
      // Same code and message as a wrong guess: whether a challenge exists for
      // a number must not be observable.
      throw new AppError(ERROR_CODES.OTP_INVALID, 401, 'Incorrect verification code');
    default:
      throw new AppError(ERROR_CODES.OTP_INVALID, 401, 'Incorrect verification code', {
        meta: { attemptsRemaining: result.attemptsRemaining },
      });
  }
}
