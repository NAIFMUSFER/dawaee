import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// `promisify` picks the 3-argument overload, losing the options parameter that
// carries the cost factors — which are the whole point here.
const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt from Node's own crypto: memory-hard, so a stolen database cannot be
 * attacked with cheap parallel hardware the way a fast hash can. No third
 * party dependency, which for the one function guarding every patient's
 * account is a feature rather than a compromise.
 *
 * The cost parameters are stored inside each hash. That is what makes them
 * raisable later: an old hash keeps verifying with the parameters it was
 * written with, and is transparently upgraded the next time its owner signs in.
 */
const N = 32_768; // CPU/memory cost — ~32 MB per hash at r=8
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

// scrypt needs to be told it may use more than the 32 MB default.
const MAX_MEMORY = 128 * N * R * 2;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * The handful of passwords that appear at the top of every breach corpus. This
 * is not a substitute for a real breached-password check — it is the cheap part
 * of one, and it costs nothing to refuse the guesses an attacker tries first.
 */
const REFUSED = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678', '123456789',
  'qwertyuiop', 'qwerty123', 'iloveyou', 'admin123', 'welcome123', 'letmein123',
  'dawaee', 'dawaee123', 'passw0rd', '11111111', '00000000', 'abc12345',
]);

export interface PasswordProblem {
  reason: 'too_short' | 'too_long' | 'too_common' | 'same_as_identifier';
}

/**
 * Length first, then the obvious guesses. Deliberately no composition rules —
 * demanding a symbol and a digit pushes people towards `Password1!`, which is
 * both harder to remember and no harder to guess.
 */
export function checkPasswordStrength(password: string, identifier?: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return { reason: 'too_short' };
  if (password.length > MAX_PASSWORD_LENGTH) return { reason: 'too_long' };

  const normalized = password.trim().toLowerCase();
  if (REFUSED.has(normalized)) return { reason: 'too_common' };
  if (identifier && normalized === identifier.trim().toLowerCase()) {
    return { reason: 'same_as_identifier' };
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
    N, r: R, p: P, maxmem: MAX_MEMORY,
  });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Never throws on a malformed or absent hash — it returns false, so that an
 * account with no password set takes exactly the same path as a wrong one.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: n, r, p, maxmem: Math.max(MAX_MEMORY, 128 * n * r * 2),
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Burns roughly the same time as a real verification.
 *
 * Called when no account matches the identifier. Without it, "no such user"
 * returns in microseconds while a wrong password takes ~100ms, and that gap
 * alone tells an attacker which phone numbers and addresses have accounts —
 * which, for a medication app, is a health-adjacent disclosure on its own.
 */
export async function burnVerificationTime(): Promise<void> {
  await scrypt('decoy', DECOY_SALT, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEMORY });
}

const DECOY_SALT = randomBytes(SALT_BYTES);

/** True when a stored hash was written with weaker parameters than we now use. */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}
