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

describe('push-token deregistration follows the exact registering session', () => {
  it('does not let an unrelated same-account session with a colliding device id retire the endpoint', async () => {
    const phone = '+966500096863';
    const sharedDeviceId = 'device-push-delete-collision-0001';
    const sibling = await signIn(h, phone, sharedDeviceId);
    const ownerSession = await signIn(h, phone, sharedDeviceId);
    expect(ownerSession.userId).toBe(sibling.userId);

    const token = 'ExponentPushToken[push-delete-same-device-owner]';
    const register = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(ownerSession),
      payload: {
        token,
        platform: 'android',
        deviceId: sharedDeviceId,
        appVersion: '1.0.0',
      },
    });
    expect(register.statusCode, register.body).toBe(200);

    // Both sessions present the same client-controlled device label. The older
    // implementation authorized the DELETE by user_id + device_id and therefore
    // let the unrelated sibling silence the endpoint registered by ownerSession.
    const crossSessionDelete = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/push-token/${sharedDeviceId}`,
      headers: authHeaders(sibling),
    });
    expect(crossSessionDelete.statusCode, crossSessionDelete.body).toBe(200);

    const afterSibling = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND token = $2',
      [ownerSession.userId, token],
    );
    expect(
      afterSibling.rows,
      'a colliding client device id must not let an unrelated session deactivate the registered provider endpoint',
    ).toEqual([{ active: true }]);

    const ownDelete = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/push-token/${sharedDeviceId}`,
      headers: authHeaders(ownerSession),
    });
    expect(ownDelete.statusCode, ownDelete.body).toBe(200);

    const afterOwner = await owner.query<{ active: boolean }>(
      'SELECT active FROM push_tokens WHERE user_id = $1 AND token = $2',
      [ownerSession.userId, token],
    );
    expect(afterOwner.rows).toEqual([{ active: false }]);
  });
});
