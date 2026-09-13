import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

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

describe('account deletion request keeps remote notifications silenced', () => {
  it('does not let a surviving authenticated session reactivate push after deletion was requested', async () => {
    const deviceId = 'device-deletion-push-boundary-0001';
    const user = await signIn(h, '+966500096855', deviceId);
    const token = 'ExponentPushToken[deletion-push-boundary-0001]';

    const registered = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(user),
      payload: { token, platform: 'ios', deviceId, appVersion: '1.0.0' },
    });
    expect(registered.statusCode, registered.body).toBe(200);

    const requested = await h.app.inject({
      method: 'POST',
      url: '/v1/me/deletion-request',
      headers: authHeaders(user),
      payload: { confirm: true },
    });
    expect(requested.statusCode, requested.body).toBe(200);

    const silenced = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [user.userId, deviceId],
    );
    expect(silenced.rows[0]?.active).toBe(false);

    // The mobile shell syncs its Expo token whenever an authenticated install
    // starts. A deletion request intentionally leaves the session alive during
    // the grace period, so a process restart can reach this endpoint again.
    // That restart must not undo the deletion route's explicit notification
    // silence by turning the same installation back on.
    const attemptedReactivation = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(user),
      payload: { token, platform: 'ios', deviceId, appVersion: '1.0.1' },
    });
    expect(
      attemptedReactivation.statusCode,
      'a deletion-pending account must not be allowed to reactivate remote push',
    ).not.toBe(200);

    const after = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [user.userId, deviceId],
    );
    expect(after.rows[0]?.active).toBe(false);
  });
});
