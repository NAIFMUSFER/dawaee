import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';

const signing = vi.hoisted(() => ({ publicKey: undefined as any }));
// The provider certificate fetch/import is the external boundary. JWT
// signature, issuer, audience and required-claim checks still use real jose.
vi.mock('jose', async (original) => ({
  ...await original<typeof import('jose')>(),
  importX509: async () => signing.publicKey,
}));
import { verifyFirebasePhoneIdToken, resetFirebasePhoneCertCache, FirebasePhoneProofInvalid, FirebasePhoneProofUnavailable } from '../src/auth/firebase-phone-proof.js';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  signing.publicKey = keys.publicKey; privateKey = keys.privateKey;
});
afterEach(() => { vi.unstubAllGlobals(); resetFirebasePhoneCertCache(); });

function certificates() {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ fixture: '-----BEGIN CERTIFICATE-----fixture' }), { headers: { 'cache-control': 'max-age=300' } }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function token(options: { expiry?: boolean; audience?: string; age?: number } = {}) {
  const jwt = new SignJWT({ phone_number: '+966500092202', firebase: { sign_in_provider: 'phone' }, auth_time: Math.floor(Date.now() / 1000) - (options.age ?? 0) })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setSubject('synthetic-firebase-user')
    .setIssuedAt().setIssuer('https://securetoken.google.com/tadawee').setAudience(options.audience ?? 'tadawee');
  if (options.expiry !== false) jwt.setExpirationTime('1h');
  return jwt.sign(privateKey);
}
describe('Firebase phone proof validation', () => {
  it('validates a fresh signed phone proof and reuses provider certificates', async () => {
    const fetcher = certificates();
    const proof = await token();
    expect(await verifyFirebasePhoneIdToken(proof)).toMatchObject({ phoneE164: '+966500092202', firebaseUid: 'synthetic-firebase-user' });
    await verifyFirebasePhoneIdToken(proof);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ expiry: false }, { audience: 'different-project' }, { age: 660 }])('requires complete, project-bound and recent proof: %j', async (options) => {
    certificates();
    await expect(verifyFirebasePhoneIdToken(await token(options))).rejects.toBeInstanceOf(FirebasePhoneProofInvalid);
  });
  it('reports a provider outage as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(verifyFirebasePhoneIdToken(await token())).rejects.toBeInstanceOf(FirebasePhoneProofUnavailable);
  });
  it('enforces the shorter recovery authentication window even for a refreshed valid token', async () => {
    certificates();
    const proof = await token({ age: 360 });
    await expect(verifyFirebasePhoneIdToken(proof)).resolves.toBeTruthy();
    await expect(verifyFirebasePhoneIdToken(proof, { maxAuthAgeSeconds: 300 })).rejects.toBeInstanceOf(FirebasePhoneProofInvalid);
  });
});
