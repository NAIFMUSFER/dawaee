import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appleAuthAvailable, AppleProofInvalid, AppleProviderUnavailable, exchangeAppleCode, revokeAppleAuthorization, verifyAppleTokenClaims } from '../src/auth/apple-token.js';
import { loadConfig, resetConfigCache } from '../src/config.js';

afterEach(() => { vi.unstubAllGlobals(); resetConfigCache(); });
const rawNonce = 'a1'.repeat(32);
const audience = 'app.dawaee.mobile';
async function fixture() {
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'apple-fixture', alg: 'RS256' }] });
  const sign = (overrides: Record<string, unknown> = {}, key = pair.privateKey) => new SignJWT({
    sub: 'apple-stable-subject', email: 'fixture@privaterelay.appleid.com', email_verified: 'true',
    nonce: createHash('sha256').update(rawNonce).digest('hex'),
    iss: 'https://appleid.apple.com', aud: audience, iat: Math.floor(Date.now()/1000),
    exp: Math.floor(Date.now()/1000) + 300, ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'apple-fixture' }).sign(key);
  return { pair, keys, sign };
}

describe('Apple identity and OAuth boundary', () => {
  it('validates signature, issuer, app audience, expiry, nonce and verified private-relay email', async () => {
    const { keys, sign } = await fixture();
    const check = async (overrides: Record<string, unknown> = {}) => verifyAppleTokenClaims(await sign(overrides), audience, rawNonce, keys);
    await expect(check()).resolves.toMatchObject({ subject: 'apple-stable-subject', email: 'fixture@privaterelay.appleid.com' });
    for (const overrides of [{ aud: 'another.app' }, { iss: 'https://attacker.example.test' },
      { exp: 1 }, { nonce: 'b1'.repeat(32) }, { email_verified: false }, { sub: '' },
      { iat: Math.floor(Date.now()/1000)-700 }]) await expect(check(overrides)).rejects.toThrow();
    const attacker = await generateKeyPair('RS256');
    await expect(verifyAppleTokenClaims(await sign({}, attacker.privateKey), audience, rawNonce, keys)).rejects.toThrow();
    await expect(verifyAppleTokenClaims(await sign(), audience, 'not-random', keys)).rejects.toThrow();
    await expect(check({ email: undefined, email_verified: undefined })).resolves.toMatchObject({ email: null });
  });

  it('redeems a one-use code at Apple with an ES256 client secret and refuses replay/provider failures', async () => {
    const { keys, sign } = await fixture();
    const client = await generateKeyPair('ES256', { extractable: true });
    resetConfigCache();
    loadConfig({ ...process.env, APPLE_AUTH_CLIENT_ID: audience, APPLE_AUTH_TEAM_ID: 'TEAMTEST01',
      APPLE_AUTH_KEY_ID: 'KEYTEST001', APPLE_AUTH_PRIVATE_KEY: await exportPKCS8(client.privateKey) });
    expect(appleAuthAvailable()).toBe(true);
    const idToken = await sign();
    let consumed = false;
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe('https://appleid.apple.com/auth/token');
      expect(options.redirect).toBe('error');
      const fields = options.body as URLSearchParams;
      const secret = await jwtVerify(fields.get('client_secret')!, client.publicKey, {
        issuer: 'TEAMTEST01', audience: 'https://appleid.apple.com', algorithms: ['ES256'],
      });
      expect(secret.payload.sub).toBe(audience);
      expect(fields.get('client_id')).toBe(audience);
      expect(fields.get('code')).toBe('synthetic-single-use-code');
      if (consumed) return new Response('{"error":"invalid_grant"}', { status: 400 });
      consumed = true;
      return Response.json({ id_token: idToken, refresh_token: 'synthetic-refresh-token' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeAppleCode('synthetic-single-use-code', rawNonce, keys)).resolves.toMatchObject({ subject: 'apple-stable-subject' });
    await expect(exchangeAppleCode('synthetic-single-use-code', rawNonce, keys)).rejects.toBeInstanceOf(AppleProofInvalid);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider data must not leak', { status: 503 })));
    await expect(exchangeAppleCode('another-single-use-code', rawNonce, keys)).rejects.toBeInstanceOf(AppleProviderUnavailable);
  });

  it('does not advertise Apple auth with incomplete or malformed signing configuration', () => {
    resetConfigCache();
    loadConfig(process.env);
    expect(appleAuthAvailable()).toBe(false);
    resetConfigCache();
    expect(() => loadConfig({ ...process.env, APPLE_AUTH_CLIENT_ID: audience })).toThrow(/four APPLE_AUTH/);
    resetConfigCache();
    expect(() => loadConfig({ ...process.env, APPLE_AUTH_CLIENT_ID: audience,
      APPLE_AUTH_TEAM_ID: 'TEAMTEST01', APPLE_AUTH_KEY_ID: 'KEYTEST001', APPLE_AUTH_PRIVATE_KEY: 'not-a-key' })).toThrow(/ES256/);
  });

  it('revokes only the subject matching the current account and fails closed if revocation is unavailable', async () => {
    const { keys, sign } = await fixture();
    const client = await generateKeyPair('ES256', { extractable: true });
    resetConfigCache();
    loadConfig({ ...process.env, APPLE_AUTH_CLIENT_ID: audience, APPLE_AUTH_TEAM_ID: 'TEAMTEST01',
      APPLE_AUTH_KEY_ID: 'KEYTEST001', APPLE_AUTH_PRIVATE_KEY: await exportPKCS8(client.privateKey) });
    const token = await sign();
    let revokes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/token')) return Response.json({ id_token: token, refresh_token: 'synthetic-revoke-token' });
      expect(url).toBe('https://appleid.apple.com/auth/revoke');
      expect((options.body as URLSearchParams).get('token')).toBe('synthetic-revoke-token');
      revokes++;
      return new Response('', { status: 200 });
    }));
    const proof = { authorizationCode: 'synthetic-fresh-delete-code', rawNonce };
    await expect(revokeAppleAuthorization(proof, 'someone-else', keys)).rejects.toBeInstanceOf(AppleProofInvalid);
    expect(revokes).toBe(0);
    await expect(revokeAppleAuthorization(proof, 'apple-stable-subject', keys)).resolves.toBeUndefined();
    expect(revokes).toBe(1);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/token')
      ? Response.json({ id_token: token, refresh_token: 'synthetic-revoke-token' })
      : new Response('provider unavailable', { status: 503 })));
    await expect(revokeAppleAuthorization(proof, 'apple-stable-subject', keys)).rejects.toBeInstanceOf(AppleProviderUnavailable);
  });
});
