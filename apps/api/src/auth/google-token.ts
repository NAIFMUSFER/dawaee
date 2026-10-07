import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { loadConfig } from '../config.js';
const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 10_000 });
export function googleAudiences(): string[] {
  return loadConfig().GOOGLE_AUTH_CLIENT_IDS.split(',').map(v => v.trim()).filter(Boolean);
}
export function googleIdentity(payload: JWTPayload) {
  if (!payload.sub || payload.sub.length > 255 || payload.email_verified !== true
    || typeof payload.email !== 'string' || payload.email.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw new Error('Invalid Google identity');
  // Only Google-hosted email can be used as a current mailbox ownership proof.
  if (!payload.email.toLowerCase().endsWith('@gmail.com') && (typeof payload.hd !== 'string' || !payload.hd))
    throw new Error('Google is not authoritative for this mailbox');
  return { subject: payload.sub, email: payload.email.toLowerCase(),
    displayName: typeof payload.name === 'string' ? payload.name.trim().slice(0,120) || 'TADAWEE' : 'TADAWEE' };
}
export async function verifyGoogleTokenClaims(idToken: string, audience: string[], verificationKeys: JWTVerifyGetKey) {
  if (!audience.length) throw new Error('Google sign-in unavailable');
  const { payload } = await jwtVerify(idToken, verificationKeys, { issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified'] });
  return googleIdentity(payload);
}

export async function verifyGoogleToken(idToken: string) {
  return verifyGoogleTokenClaims(idToken, googleAudiences(), keys);
}
