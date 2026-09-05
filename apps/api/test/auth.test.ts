import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearOtpCooldown, resetDatabase, signIn, startHarness, type Harness } from './harness.js';
import { withTransaction } from '../src/lib/db.js';
import { issueOtp } from '../src/auth/otp-service.js';

/**
 * Issues a challenge through the service rather than the HTTP route.
 *
 * `/v1/auth/otp/request` refuses now: there is no channel left to deliver a
 * code over, and both would need a Saudi commercial registration to exist. The
 * verification machinery below it is intact and still guards real properties —
 * a wrong code is rejected, a used code cannot be replayed, guessing is locked
 * out — so those stay under test at the layer that still runs. Delivering the
 * code is what disappeared; checking it is not.
 */
const issue = (phone: string) => withTransaction((tx) => issueOtp(tx, phone, null));

let h: Harness;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('phone OTP sign-in', () => {
  it('creates an account with a self profile and preferences on first verification', async () => {
    const user = await signIn(h, '0500000001');
    expect(user.token).toBeTruthy();
    expect(user.profileId).toBeTruthy();

    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${user.token}` } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.phoneE164).toBe('+966500000001');
    expect(body.preferences.locale).toBe('ar');
    expect(body.preferences.lowStockThresholdDays).toBe(7);
  });

  it('normalises the Saudi local format to E.164', async () => {
    const a = await signIn(h, '0500000002');
    // Same person, same number, written the other way — the resend cooldown is
    // per phone and correctly blocks a real retry, so the test steps past it.
    await clearOtpCooldown('+966500000002');
    const b = await signIn(h, '+966500000002', 'device-second');
    expect(b.userId).toBe(a.userId);
  });

  it('rejects an incorrect code', async () => {
    await issue('+966500000003');
    const bad = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/verify',
      payload: { phone: '0500000003', code: '000000', deviceId: 'device-bad' }, remoteAddress: '10.9.9.1',
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('otp_invalid');
  });

  it('consumes a code so it cannot be replayed', async () => {
    const { code } = await issue('+966500000004');
    const first = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/verify',
      payload: { phone: '0500000004', code, deviceId: 'device-replay' }, remoteAddress: '10.9.9.2',
    });
    expect(first.statusCode).toBe(200);

    const replay = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/verify',
      payload: { phone: '0500000004', code, deviceId: 'device-replay' }, remoteAddress: '10.9.9.2',
    });
    expect(replay.statusCode).toBe(401);
  });

  it('locks out after too many wrong guesses', async () => {
    await issue('+966500000005');
    let last = 0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await h.app.inject({
        method: 'POST', url: '/v1/auth/otp/verify',
        payload: { phone: '0500000005', code: '111111', deviceId: 'device-brute' }, remoteAddress: '10.9.9.3',
      });
      last = res.statusCode;
      seen.push(res.statusCode);
    }
    // Five wrong guesses are merely wrong; the sixth trips the lockout and
    // burns the challenge, so a new code has to be requested.
    expect(seen.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(last).toBe(429);
  });

  it('enforces a resend cooldown', async () => {
    await issue('+966500000006');
    await expect(issue('+966500000006')).rejects.toThrow();
  });

  /**
   * The route itself is gone, and must say so rather than appearing to work.
   * A 200 with no message arriving is the failure that makes someone think
   * their phone is broken.
   */
  it('refuses to issue a code, because none can be delivered', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request',
      payload: { phone: '0500000007' }, remoteAddress: '10.9.9.5',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('provider_unavailable');
  });
});

describe('sessions', () => {
  it('rotates the refresh token and invalidates the old one', async () => {
    const user = await signIn(h, '0500000010');
    const first = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: user.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json();
    expect(rotated.refreshToken).not.toBe(user.refreshToken);

    // Re-presenting the consumed token IMMEDIATELY is a race, not theft: a
    // client can legitimately have two requests in flight carrying the same
    // token. Within the 30-second window the server says "superseded", mints
    // nothing, and revokes nothing (P9-1).
    const raced = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: user.refreshToken },
    });
    expect(raced.statusCode).toBe(409);
    expect(raced.json().error.code).toBe('refresh_superseded');

    // The replacement is untouched by that.
    const stillGood = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: rotated.refreshToken },
    });
    expect(stillGood.statusCode).toBe(200);
    const rotatedTwice = stillGood.json();

    // Age the lineage past the race window: the same replay is now theft, and
    // it revokes the device including the live tip.
    // The owner connection: the worker role deliberately has no access to
    // auth_sessions at all since the P8-1 least-privilege work.
    const ownerPool = new pg.Pool({
      connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 1,
    });
    await ownerPool.query(
      `UPDATE auth_sessions SET revoked_at = now() - interval '31 seconds'
        WHERE user_id = $1 AND replaced_by IS NOT NULL`,
      [user.userId],
    );
    await ownerPool.end();
    const reuse = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: user.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    const afterTheft = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: rotatedTwice.refreshToken },
    });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('stops accepting an access token once its session is revoked', async () => {
    const user = await signIn(h, '0500000011');
    const before = await h.app.inject({
      method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${user.token}` },
    });
    expect(before.statusCode).toBe(200);

    await h.app.inject({
      method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${user.token}` },
    });

    // The JWT is still cryptographically valid; the session check is what
    // makes "sign out" actually mean something.
    const after = await h.app.inject({
      method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${user.token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a tampered or unsigned token', async () => {
    const user = await signIn(h, '0500000012');
    const tampered = `${user.token.slice(0, -4)}AAAA`;
    for (const token of [tampered, 'not-a-jwt', '']) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/profiles', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it('requires authentication on every protected route', async () => {
    for (const url of ['/v1/profiles', '/v1/me', '/v1/today?profileId=x', '/v1/medications?profileId=x']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
