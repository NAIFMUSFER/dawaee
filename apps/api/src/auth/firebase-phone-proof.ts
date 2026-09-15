import { decodeProtectedHeader, importX509, jwtVerify } from 'jose';
import { normalizePhone } from '../lib/crypto.js';

const FIREBASE_PROJECT_ID = 'tadawee';
const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const DEFAULT_MAX_AUTH_AGE_SECONDS = 10 * 60;

interface CertCache { expiresAt: number; certs: Record<string, string> }
let certCache: CertCache | null = null;

export class FirebasePhoneProofInvalid extends Error {
  constructor() { super('Firebase phone proof is invalid'); this.name = 'FirebasePhoneProofInvalid'; }
}
export class FirebasePhoneProofUnavailable extends Error {
  constructor() {
    super('Firebase phone verification is temporarily unavailable');
    this.name = 'FirebasePhoneProofUnavailable';
  }
}
export interface FirebasePhoneProof {
  phoneE164: string;
  firebaseUid: string;
  authenticatedAt: number;
}

function cacheSeconds(header: string | null): number {
  const match = header?.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) return 300;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return 300;
  return Math.min(86_400, Math.max(60, parsed));
}

async function loadCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certCache && certCache.expiresAt > now) return certCache.certs;
  let response: Response;
  try {
    response = await fetch(FIREBASE_CERTS_URL, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new FirebasePhoneProofUnavailable();
  }
  if (!response.ok) throw new FirebasePhoneProofUnavailable();
  let certs: unknown;
  try { certs = await response.json(); } catch { throw new FirebasePhoneProofUnavailable(); }
  if (!certs || typeof certs !== 'object' || Array.isArray(certs)) {
    throw new FirebasePhoneProofUnavailable();
  }
  const valid: Record<string, string> = {};
  for (const [kid, cert] of Object.entries(certs)) {
    if (typeof cert === 'string' && cert.includes('BEGIN CERTIFICATE')) valid[kid] = cert;
  }
  if (Object.keys(valid).length === 0) throw new FirebasePhoneProofUnavailable();
  certCache = {
    certs: valid,
    expiresAt: now + cacheSeconds(response.headers.get('cache-control')) * 1_000,
  };
  return valid;
}

export async function verifyFirebasePhoneIdToken(
  token: string,
  options?: { maxAuthAgeSeconds?: number },
): Promise<FirebasePhoneProof> {
  if (!token || token.length > 16_384) throw new FirebasePhoneProofInvalid();
  let kid: string;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw new FirebasePhoneProofInvalid();
    }
    kid = header.kid;
  } catch (error) {
    if (error instanceof FirebasePhoneProofInvalid) throw error;
    throw new FirebasePhoneProofInvalid();
  }

  // Respect Google's cache lifetime. Do not refetch on an attacker-controlled
  // unknown kid: otherwise arbitrary JWT headers become a network-amplification
  // primitive against the public certificate endpoint.
  const cert = (await loadCerts())[kid];
  if (!cert) throw new FirebasePhoneProofInvalid();

  try {
    const key = await importX509(cert, 'RS256');
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      audience: FIREBASE_PROJECT_ID,
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) {
      throw new FirebasePhoneProofInvalid();
    }
    if (typeof payload.phone_number !== 'string') throw new FirebasePhoneProofInvalid();
    const phoneE164 = normalizePhone(payload.phone_number);
    if (!phoneE164) throw new FirebasePhoneProofInvalid();
    const firebase = payload.firebase;
    if (!firebase || typeof firebase !== 'object' || Array.isArray(firebase)) {
      throw new FirebasePhoneProofInvalid();
    }
    if ((firebase as Record<string, unknown>).sign_in_provider !== 'phone') {
      throw new FirebasePhoneProofInvalid();
    }
    const authTime = payload.auth_time;
    if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
      throw new FirebasePhoneProofInvalid();
    }
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const maxAge = options?.maxAuthAgeSeconds ?? DEFAULT_MAX_AUTH_AGE_SECONDS;
    if (authTime > nowSeconds + 5 || nowSeconds - authTime > maxAge) {
      throw new FirebasePhoneProofInvalid();
    }
    return { phoneE164, firebaseUid: payload.sub, authenticatedAt: authTime };
  } catch (error) {
    if (error instanceof FirebasePhoneProofInvalid) throw error;
    throw new FirebasePhoneProofInvalid();
  }
}

export function resetFirebasePhoneCertCache(): void { certCache = null; }
