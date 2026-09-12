import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness } from './harness.js';

/**
 * Red-team regression for logout isolation.
 *
 * `deviceId` is supplied by the client and is routing metadata, not a security
 * principal. Two independent sessions for the same account may therefore carry
 * the same value (whether by cloning, restore, bug, or deliberate spoofing).
 * Logging out one authenticated session must end that session and any
 * server-proven refresh descendants, but must not revoke an unrelated session
 * merely because it claimed the same client-controlled device id.
 */
let h: Harness;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('logout does not trust client device-id as a session boundary', () => {
  it('keeps an unrelated same-account session live when both claim the same device id', async () => {
    const phone = '+966500096861';
    const sharedDeviceId = 'device-logout-collision-0001';
    const first = await signIn(h, phone, sharedDeviceId);
    const sibling = await signIn(h, phone, sharedDeviceId);

    expect(sibling.userId).toBe(first.userId);
    expect(sibling.sessionId).not.toBe(first.sessionId);

    // Positive control: both independent sessions are live before logout.
    expect((await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${first.accessToken}` },
    })).statusCode).toBe(200);
    expect((await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${sibling.accessToken}` },
    })).statusCode).toBe(200);

    const logout = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    expect(logout.statusCode, logout.body).toBe(200);

    // The session that explicitly logged out must be dead.
    expect((await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${first.accessToken}` },
    })).statusCode).toBe(401);

    // Security boundary: an unrelated session survives despite the colliding
    // client-controlled device id. The pre-fix 0044 revoke_session revokes it.
    expect((await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${sibling.accessToken}` },
    })).statusCode, 'logout revoked an unrelated session solely by shared client device id').toBe(200);

    const siblingRefresh = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: sibling.refreshToken },
    });
    expect(siblingRefresh.statusCode, siblingRefresh.body).toBe(200);
  });
});
