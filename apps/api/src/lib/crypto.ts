import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Token and code handling.
 *
 * Nothing here stores a secret in a form that is useful if the database leaks:
 * OTP codes, refresh tokens, invitation tokens and QR tokens are all kept as
 * SHA-256 hashes and compared in constant time.
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
