import { readSession } from './token-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode the small ASCII JSON segments Dawaee puts in its JWTs without adding
 * another mobile dependency. The server-issued access-token payload contains
 * only identifiers, role/audience/issuer strings and numeric timestamps.
 */
function decodeBase64UrlAscii(input: string): string | null {
  if (!input || input.length % 4 === 1) return null;
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  let value = 0;
  let bits = 0;
  let out = '';

  for (const char of normalized) {
    const sextet = BASE64.indexOf(char);
    if (sextet < 0) return null;
    value = (value << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
      value &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }

  // Canonical unpadded base64url has only zero padding bits left over.
  if (bits > 0 && value !== 0) return null;
  return out;
}

function parseSegment(segment: string): Record<string, unknown> | null {
  const decoded = decodeBase64UrlAscii(segment);
  if (decoded === null) return null;
  try {
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Recover only the account namespace from a stored Dawaee access token.
 *
 * This is deliberately NOT token verification or authorization. The mobile app
 * does not have the signing secret and every server request still goes through
 * normal JWT verification. The claim is used only to select the per-user local
 * encrypted-cache/key namespace while the server is unreachable. Requiring the
 * exact Dawaee JWT envelope prevents an arbitrary string in secure storage from
 * becoming a cache selector; malformed or unfamiliar credentials fail closed.
 * Expiry is intentionally ignored here: an expired short-lived access token can
 * still identify the owner of a valid stored refresh session during an offline
 * restart, which is exactly the recovery case this helper serves.
 */
export function userIdFromStoredAccessToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;

  const header = parseSegment(parts[0]);
  const payload = parseSegment(parts[1]);
  if (!header || !payload) return null;
  if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  const audience = payload.aud;
  const isDawaeeAudience = audience === 'dawaee-client'
    || (Array.isArray(audience) && audience.includes('dawaee-client'));
  if (!isDawaeeAudience) return null;

  return typeof payload.sub === 'string' && UUID.test(payload.sub) ? payload.sub : null;
}

/**
 * Read the same Keychain/Keystore-backed session that loadStoredSession just
 * restored and recover its local cache owner. A read/parse failure returns null
 * so offline storage remains inaccessible rather than guessing an identity.
 */
export async function getRestoredSessionUserId(): Promise<string | null> {
  const stored = await readSession().catch(() => null);
  return stored ? userIdFromStoredAccessToken(stored.accessToken) : null;
}
