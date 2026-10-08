import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { loadConfig } from '../config.js';

const issuer = 'https://appleid.apple.com';
const keys = createRemoteJWKSet(new URL(`${issuer}/auth/keys`), { timeoutDuration: 5_000 });
export class AppleProofInvalid extends Error {}
export class AppleProviderUnavailable extends Error {}

export function appleAuthAvailable(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.APPLE_AUTH_CLIENT_ID && cfg.APPLE_AUTH_TEAM_ID && cfg.APPLE_AUTH_KEY_ID && cfg.APPLE_AUTH_PRIVATE_KEY);
}

export async function verifyAppleTokenClaims(token: string, audience: string, rawNonce: string, verificationKeys: JWTVerifyGetKey) {
  if (!audience || !/^[0-9a-f]{64}$/.test(rawNonce)) throw new AppleProofInvalid();
  const { payload } = await jwtVerify(token, verificationKeys, {
    issuer, audience, algorithms: ['RS256'], maxTokenAge: '10m', requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
  });
  const expected = createHash('sha256').update(rawNonce).digest('hex');
  if (!payload.sub || payload.sub.length > 255 || typeof payload.nonce !== 'string'
    || !/^[0-9a-f]{64}$/.test(payload.nonce)
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(payload.nonce))) throw new AppleProofInvalid();
  let email: string | null = null;
  if (payload.email !== undefined) {
    if ((payload.email_verified !== true && payload.email_verified !== 'true')
      || typeof payload.email !== 'string' || payload.email.length > 320
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw new AppleProofInvalid();
    email = payload.email.toLowerCase();
  }
  return { subject: payload.sub, email };
}

async function clientSecret(): Promise<string> {
  const cfg = loadConfig();
  if (!appleAuthAvailable()) throw new AppleProviderUnavailable();
  try {
    const key = await importPKCS8(cfg.APPLE_AUTH_PRIVATE_KEY!.replace(/\\n/g, '\n'), 'ES256');
    return await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: cfg.APPLE_AUTH_KEY_ID! })
      .setIssuer(cfg.APPLE_AUTH_TEAM_ID!).setSubject(cfg.APPLE_AUTH_CLIENT_ID!)
      .setAudience(issuer).setIssuedAt().setExpirationTime('5m').sign(key);
  } catch { throw new AppleProviderUnavailable(); }
}

/** Fixed provider origin; neither provider response bodies nor credentials escape errors. */
async function applePost(path: 'token' | 'revoke', fields: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch(`${issuer}/auth/${path}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(5_000) });
  } catch { throw new AppleProviderUnavailable(); }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) throw new AppleProviderUnavailable();
    throw new AppleProofInvalid();
  }
  return response;
}

/** Redeeming the one-use authorization code also prevents replay of a valid identity JWT. */
export async function exchangeAppleCode(authorizationCode: string, rawNonce: string, verificationKeys: JWTVerifyGetKey = keys) {
  const cfg = loadConfig();
  const response = await applePost('token', { client_id: cfg.APPLE_AUTH_CLIENT_ID!,
    client_secret: await clientSecret(), grant_type: 'authorization_code', code: authorizationCode });
  let data: { id_token?: unknown; refresh_token?: unknown };
  try {
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppleProviderUnavailable();
    data = raw as typeof data;
  } catch { throw new AppleProviderUnavailable(); }
  if (typeof data.id_token !== 'string' || data.id_token.length > 16_384
    || typeof data.refresh_token !== 'string' || data.refresh_token.length > 16_384) throw new AppleProviderUnavailable();
  let identity;
  try { identity = await verifyAppleTokenClaims(data.id_token, cfg.APPLE_AUTH_CLIENT_ID!, rawNonce, verificationKeys); }
  catch { throw new AppleProofInvalid(); }
  return { ...identity, refreshToken: data.refresh_token };
}

/** A fresh native Apple proof is required to revoke the correct account on deletion. */
export async function revokeAppleAuthorization(proof: { authorizationCode: string; rawNonce: string }, expectedSubject: string,
  verificationKeys: JWTVerifyGetKey = keys) {
  const identity = await exchangeAppleCode(proof.authorizationCode, proof.rawNonce, verificationKeys);
  if (identity.subject !== expectedSubject) throw new AppleProofInvalid();
  await applePost('revoke', { client_id: loadConfig().APPLE_AUTH_CLIENT_ID!,
    client_secret: await clientSecret(), token: identity.refreshToken, token_type_hint: 'refresh_token' });
}
