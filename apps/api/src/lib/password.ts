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
/**
 * Cost parameters, against a named source.
 *
 * OWASP Password Storage Cheat Sheet (retrieved 2026-09-05,
 * cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
 * lists five scrypt configurations of roughly equivalent work:
 *
 *   N=2^17 r=8 p=1 · N=2^16 r=8 p=2 · N=2^15 r=8 p=3 · N=2^14 r=8 p=5 · N=2^13 r=8 p=10
 *
 * This was previously N=2^15, r=8, p=1 — which is BELOW every one of those,
 * not "at the 2^15 floor": the 2^15 entry pairs that N with p=3, so a third of
 * the intended work was being done. Corrected to the listed p.
 *
 * N=2^15 with p=3 rather than the headline N=2^17 with p=1, and the reason is
 * the deployment rather than the cryptography. Each scrypt call at N=2^17, r=8
 * needs ~128 MiB resident; on the API's memory allowance four concurrent logins
 * would exhaust it, and an out-of-memory kill during a login storm is a worse
 * outcome than the (equivalent, per OWASP) work factor chosen here. p=3 keeps
 * the working set at ~32 MiB and pays in CPU instead: measured 94ms → 232ms per
 * hash on this hardware, which is acceptable for a login and is the cost of
 * being at guidance rather than below it.
 *
 * Old hashes keep their own parameters — they are stored in the hash string —
 * and `needsRehash` below upgrades each account transparently on its next
 * successful sign-in. Nobody is locked out and no migration runs.
 */
const N = 32_768; // 2^15 — ~32 MB per hash at r=8
const R = 8;
const P = 3;
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

/**
 * NFKC, and why compatibility normalization is deliberate here.
 *
 * NFKC collapses characters that are compatibility-equivalent: the ﬁ ligature
 * to "fi", full-width Latin to ASCII, superscript digits to ordinary ones, a
 * non-breaking space to a space, and — the one that matters for this app —
 * Arabic presentation forms to their base letters. Measured, not assumed:
 * Arabic-Indic digits (٢٠٢٦) do NOT collapse to ASCII digits, so an Arabic
 * numeral password stays distinct from its Latin spelling.
 *
 * The trade is real and accepted. Compatibility folding shrinks the effective
 * password space slightly, because two visually different inputs can hash the
 * same. Against that: this app's users type Arabic on iOS, Android and desktop
 * keyboards that emit different codepoints for the same visible letter, and
 * paste from messaging apps that rewrite text into presentation forms. Under
 * plain NFC a password set on one keyboard would silently fail to verify on
 * another, with no diagnosable reason — a lockout the user cannot fix and
 * support cannot explain. For an Arabic-first product that failure is far more
 * likely than an attacker profiting from ligature folding.
 *
 * Applied identically in `hashPassword` and `verifyPassword`, which is the
 * property that actually matters: any normalization is safe as long as both
 * sides do the same one, and changing it later would invalidate every stored
 * hash, so it is fixed deliberately rather than incidentally.
 */
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
  // `p` is compared too. It was omitted, so raising the parallelism factor
  // alone would have upgraded nobody — every existing hash would have kept its
  // weaker cost forever while the constant above claimed otherwise.
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}
