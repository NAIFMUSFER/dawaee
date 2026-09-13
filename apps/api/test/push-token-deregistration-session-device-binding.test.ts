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

describe('push-token deregistration is bound to the authenticated session device', () => {
  it('does not let one live session silence another live device', async () => {
    const phone = '+966500096857';
    const deviceA = 'device-push-delete-binding-a-0001';
    const deviceB = 'device-push-delete-binding-b-0001';
    const sessionA = await signIn(h, phone, deviceA);
    const sessionB = await signIn(h, phone, deviceB);
    expect(sessionB.userId).toBe(sessionA.userId);

    const tokenB = 'ExponentPushToken[push-delete-binding-legitimate-b]';
    const registerB = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(sessionB),
      payload: { token: tokenB, platform: 'android', deviceId: deviceB, appVersion: '1.0.0' },
    });
    expect(registerB.statusCode, registerB.body).toBe(200);

    // A same-account session may discover sibling device ids from the session
    // list. Deregistration is an installation-local logout/privacy action, so
    // possession of the account alone must not let session A silence session B.
    const attemptedDelete = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/push-token/${deviceB}`,
      headers: authHeaders(sessionA),
    });
    expect(
      attemptedDelete.statusCode,
      'a push endpoint may only be deregistered by the session backed by that device',
    ).toBe(403);

    const afterCrossDeviceAttempt = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [sessionA.userId, deviceB],
    );
    expect(afterCrossDeviceAttempt.rows).toEqual([{ active: true }]);

    const ownDelete = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/push-token/${deviceB}`,
      headers: authHeaders(sessionB),
    });
    expect(ownDelete.statusCode, ownDelete.body).toBe(200);

    const afterOwnDelete = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [sessionA.userId, deviceB],
    );
    expect(afterOwnDelete.rows).toEqual([{ active: false }]);
  });
});
