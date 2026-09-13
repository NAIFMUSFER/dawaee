import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 2,
  });
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('server-side session revocation also retires remote push on ejected devices', () => {
  it('password change deactivates push for the ejected device but keeps the current device active', async () => {
    const phone = '+966500096852';
    const currentDevice = 'device-password-owner-0001';
    const ejectedDevice = 'device-password-ejected-0001';
    const current = await signIn(h, phone, currentDevice);
    const ejected = await signIn(h, phone, ejectedDevice);
    expect(ejected.userId).toBe(current.userId);

    await owner.query(
      `INSERT INTO push_tokens (user_id, token, platform, device_id, active, last_seen_at)
       VALUES
         ($1,$2,'android',$3,true,now()),
         ($1,$4,'android',$5,true,now())`,
      [
        current.userId,
        'ExponentPushToken[password-current-device]', currentDevice,
        'ExponentPushToken[password-ejected-device]', ejectedDevice,
      ],
    );

    const change = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { authorization: `Bearer ${current.token}` },
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'a-brand-new-password-2026',
      },
    });
    expect(change.statusCode, change.body).toBe(200);

    const sessions = await owner.query<{ device_id: string; live: number }>(
      `SELECT device_id,
              count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS live
         FROM auth_sessions
        WHERE user_id = $1
        GROUP BY device_id
        ORDER BY device_id`,
      [current.userId],
    );
    expect(sessions.rows.find((row) => row.device_id === currentDevice)?.live).toBeGreaterThan(0);
    expect(sessions.rows.find((row) => row.device_id === ejectedDevice)?.live).toBe(0);

    const pushes = await owner.query<{ device_id: string; active: boolean }>(
      'SELECT device_id, active FROM push_tokens WHERE user_id = $1 ORDER BY device_id',
      [current.userId],
    );
    expect(
      pushes.rows,
      'a password-change security response must not keep notifying the device whose sessions it ejected',
    ).toEqual([
      { device_id: ejectedDevice, active: false },
      { device_id: currentDevice, active: true },
    ]);
  });

  it('password change retires a push endpoint claimed by an ejected session using the current device id', async () => {
    const phone = '+966500096858';
    const sharedDeviceId = 'device-password-collision-0001';
    const current = await signIn(h, phone, sharedDeviceId);
    const ejected = await signIn(h, phone, sharedDeviceId);
    expect(ejected.userId).toBe(current.userId);

    // device_id is client supplied at sign-in. A compromised credential can
    // therefore create a sibling session that claims the legitimate device id,
    // then bind its own provider endpoint to that row. The password-change
    // response must retire that endpoint even though the genuine current
    // session with the same device id survives.
    const attackerToken = 'ExponentPushToken[password-device-id-collision]';
    const registration = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: `Bearer ${ejected.token}` },
      payload: {
        token: attackerToken,
        platform: 'android',
        deviceId: sharedDeviceId,
        appVersion: '1.0.0',
      },
    });
    expect(registration.statusCode, registration.body).toBe(200);

    const change = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { authorization: `Bearer ${current.token}` },
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'another-brand-new-password-2026',
      },
    });
    expect(change.statusCode, change.body).toBe(200);

    const survivingSessions = await owner.query<{ id: string }>(
      `SELECT id
         FROM auth_sessions
        WHERE user_id = $1 AND device_id = $2
          AND revoked_at IS NULL AND expires_at > now()`,
      [current.userId, sharedDeviceId],
    );
    expect(survivingSessions.rows).toHaveLength(1);

    const push = await owner.query<{ token: string; active: boolean }>(
      'SELECT token, active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [current.userId, sharedDeviceId],
    );
    expect(push.rows).toEqual([{ token: attackerToken, active: false }]);
  });

  it('normal refresh rotation keeps push active because a live successor exists on the same device', async () => {
    const deviceId = 'device-refresh-push-0001';
    const user = await signIn(h, '+966500096853', deviceId);

    await owner.query(
      `INSERT INTO push_tokens (user_id, token, platform, device_id, active, last_seen_at)
       VALUES ($1,$2,'android',$3,true,now())`,
      [user.userId, 'ExponentPushToken[refresh-must-stay-active]', deviceId],
    );

    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);

    const { rows } = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [user.userId, deviceId],
    );
    expect(rows[0]?.active, 'refresh rotation incorrectly silenced a still-authenticated device').toBe(true);
  });
});
