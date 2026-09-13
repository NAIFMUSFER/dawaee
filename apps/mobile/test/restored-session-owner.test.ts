import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ readSession: vi.fn() }));
vi.mock('../src/api/token-store.js', () => ({ readSession: io.readSession }));

const OWNER = '11111111-2222-4333-8444-555555555555';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function token(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  return `${b64url(header)}.${b64url(payload)}.signature`;
}

let owner: typeof import('../src/api/restored-session-owner.js');

beforeEach(async () => {
  vi.resetModules();
  io.readSession.mockReset();
  owner = await import('../src/api/restored-session-owner.js');
});

describe('stored session identity is a cache namespace, never authorization', () => {
  it('recovers the UUID subject from the exact Dawaee access-token envelope', async () => {
    io.readSession.mockResolvedValue({
      accessToken: token({ sub: OWNER, sid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', role: 'user', aud: 'dawaee-client', exp: 1 }),
      refreshToken: 'opaque-refresh',
    });

    // exp=1 is deliberate: access-token expiry must not erase the identity of
    // a still-persisted refresh session while the phone is offline.
    await expect(owner.getRestoredSessionUserId()).resolves.toBe(OWNER);
  });

  it('accepts the JWT array form of the Dawaee audience', () => {
    expect(owner.userIdFromStoredAccessToken(token({ sub: OWNER, aud: ['other', 'dawaee-client'] }))).toBe(OWNER);
  });

  it('fails closed for a token from a different audience or algorithm', () => {
    expect(owner.userIdFromStoredAccessToken(token({ sub: OWNER, aud: 'other-client' }))).toBeNull();
    expect(owner.userIdFromStoredAccessToken(token(
      { sub: OWNER, aud: 'dawaee-client' },
      { alg: 'none', typ: 'JWT' },
    ))).toBeNull();
  });

  it('fails closed for a malformed/non-UUID subject', () => {
    expect(owner.userIdFromStoredAccessToken(token({ sub: 'ACCOUNT-A', aud: 'dawaee-client' }))).toBeNull();
    expect(owner.userIdFromStoredAccessToken('not.a.jwt')).toBeNull();
    expect(owner.userIdFromStoredAccessToken('broken')).toBeNull();
  });

  it('returns no owner when secure storage is empty or unreadable', async () => {
    io.readSession.mockResolvedValueOnce(null);
    await expect(owner.getRestoredSessionUserId()).resolves.toBeNull();

    io.readSession.mockRejectedValueOnce(new Error('keychain unavailable'));
    await expect(owner.getRestoredSessionUserId()).resolves.toBeNull();
  });
});
