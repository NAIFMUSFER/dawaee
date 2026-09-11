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
  it('deactivates an active push token even when the client cannot issue a separate deregistration request', async () => {
    const deviceId = 'device-server-logout-push-0001';
    const user = await signIn(h, '+966500096851', deviceId);

    await owner.query(
      `INSERT INTO push_tokens (user_id, token, platform, device_id, active, last_seen_at)
       VALUES ($1,$2,'android',$3,true,now())`,
      [user.userId, 'ExponentPushToken[server-logout-regression]', deviceId],
    );

    const before = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [user.userId, deviceId],
    );
    expect(before.rows[0]?.active).toBe(true);

    const logout = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(logout.statusCode, logout.body).toBe(200);

    const after = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [user.userId, deviceId],
    );
    expect(
      after.rows[0]?.active,
      'logout revoked the session but left its device eligible for worker push delivery',
    ).toBe(false);
  });
});
