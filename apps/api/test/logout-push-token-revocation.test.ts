import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness } from './harness.js';

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

describe('logout retires the remote notification endpoint for that session device', () => {
  it('deactivates only the logging-out installation even when client-side deregistration is unavailable', async () => {
    const phone = '+966500096851';
    const deviceId = 'device-server-logout-push-0001';
    const otherDeviceId = 'device-server-logout-push-0002';
    const user = await signIn(h, phone, deviceId);
    const otherSession = await signIn(h, phone, otherDeviceId);
    expect(otherSession.userId).toBe(user.userId);

    await owner.query(
      `INSERT INTO push_tokens (user_id, token, platform, device_id, active, last_seen_at)
       VALUES
         ($1,$2,'android',$3,true,now()),
         ($1,$4,'android',$5,true,now())`,
      [
        user.userId,
        'ExponentPushToken[server-logout-regression-current]', deviceId,
        'ExponentPushToken[server-logout-regression-other]', otherDeviceId,
      ],
    );

    const before = await owner.query<{ device_id: string; active: boolean }>(
      'SELECT device_id, active FROM push_tokens WHERE user_id = $1 ORDER BY device_id',
      [user.userId],
    );
    expect(before.rows).toEqual([
      { device_id: deviceId, active: true },
      { device_id: otherDeviceId, active: true },
    ]);

    const logout = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(logout.statusCode, logout.body).toBe(200);

    const after = await owner.query<{ device_id: string; active: boolean }>(
      'SELECT device_id, active FROM push_tokens WHERE user_id = $1 ORDER BY device_id',
      [user.userId],
    );
    expect(
      after.rows,
      'logout must retire this session device without silencing the same user on another live device',
    ).toEqual([
      { device_id: deviceId, active: false },
      { device_id: otherDeviceId, active: true },
    ]);
  });
});
