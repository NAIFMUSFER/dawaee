import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearOtpCooldown, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

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
    const req = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '0500000003' }, remoteAddress: '10.9.9.1',
    });
    expect(req.statusCode).toBe(200);
    const bad = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/verify',
      payload: { phone: '0500000003', code: '000000', deviceId: 'device-bad' }, remoteAddress: '10.9.9.1',
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('otp_invalid');
  });

  it('consumes a code so it cannot be replayed', async () => {
    const req = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '0500000004' }, remoteAddress: '10.9.9.2',
    });
    const code = req.json().debugCode;
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
    const issued = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '0500000005' }, remoteAddress: '10.9.9.3',
    });
    expect(issued.statusCode, issued.body).toBe(200);
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
    await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '0500000006' }, remoteAddress: '10.9.9.4',
    });
    const second = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '0500000006' }, remoteAddress: '10.9.9.4',
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('rate_limited');
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

    // Re-presenting the consumed token is treated as theft.
    const reuse = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: user.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    // …and that revokes the replacement too, so the attacker gains nothing.
    const afterTheft = await h.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: rotated.refreshToken },
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
