import { createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config.js';

/**
 * Token and code handling.
 *
 * Refresh tokens, invitation tokens and QR tokens are kept as SHA-256 hashes
 * and compared in constant time. Those are 256-bit random values, so the hash
 * is the whole defence: there is nothing to guess.
 *
 * A ONE-TIME CODE is a different problem, and `otpVerifier` below exists
 * because it was being treated as the same one. See its comment.
 */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so length alone is not a timing oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * What gets stored for a one-time code.
 *
 * A six-digit code has a million possibilities, and `sha256(code)` was the
 * stored verifier. That is not a hash in any protective sense — measured
 * against a real row from this table, single-threaded JavaScript recovered the
 * plaintext code from its SHA-256 in 460 milliseconds by trying every value.
 * Anyone who could read `auth_otp_challenges` — a stolen backup, a compromised
 * database account, a support engineer with a psql prompt — held every live
 * sign-in code. "Not stored in plaintext" was true and meant nothing.
 *
 * Two changes fix it:
 *
 * KEYED. An HMAC under a server-held key cannot be computed from the row
 * alone, so reading the table is no longer enough — an attacker needs the
 * application's secret as well. The low entropy of the code stops mattering,
 * because the search is no longer offline.
 *
 * BOUND TO THE PHONE. The phone number goes into the MAC input, so the same
 * six digits issued to two people produce different verifiers. Without it, a
 * reader of the table could group challenges by identical hash and learn that
 * two accounts happened to share a code — and, once one plaintext was known by
 * any means, know the other for free.
 *
 * The key is derived from JWT_SECRET rather than added as new configuration:
 * one fewer secret to provision, rotate and lose. HKDF with a distinct label
 * keeps it independent of the signing key, so this value cannot be used to mint
 * tokens and a token key cannot be used to forge verifiers. Rotating JWT_SECRET
 * invalidates codes issued in the previous few minutes, which is the entire
 * lifetime of one.
 */
let otpKeyCache: { secret: string; key: Buffer } | null = null;

export function otpVerifier(phone: string, code: string): string {
  const { JWT_SECRET } = loadConfig();
  if (otpKeyCache?.secret !== JWT_SECRET) {
    otpKeyCache = {
      secret: JWT_SECRET,
      key: Buffer.from(hkdfSync('sha256', Buffer.from(JWT_SECRET, 'utf8'), Buffer.alloc(0), 'dawaee:otp-verifier:v1', 32)),
    };
  }
  // The colon is not decorative. Without a separator the phone and the code
  // run together, and two different (phone, code) pairs can produce the same
  // MAC input. Neither field can contain a colon: the phone is E.164 and the
  // code is digits.
  return createHmac('sha256', otpKeyCache.key).update(`${phone}:${code}`).digest('hex');
}

/** Numeric OTP drawn from a CSPRNG, never Math.random. */
export function generateOtp(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

/**
 * Normalizes a phone number to E.164, defaulting bare Saudi numbers to +966.
 * `0512345678`, `512345678`, `00966512345678` and `+966512345678` all converge.
 */
export function normalizePhone(raw: string, defaultCountry = '966'): string | null {
  let digits = raw.replace(/[\s()\-.]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('+')) {
    return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  }
  digits = digits.replace(/\D/g, '');
  if (digits.startsWith(defaultCountry)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${defaultCountry}${digits.slice(1)}`;
  if (digits.length >= 8) return `+${defaultCountry}${digits}`;
  return null;
}

/** Masks a phone for display and for anything that might reach a log. */
export function maskPhone(e164: string): string {
  if (e164.length <= 5) return '***';
  return `${e164.slice(0, 4)}${'*'.repeat(Math.max(0, e164.length - 7))}${e164.slice(-3)}`;
}
