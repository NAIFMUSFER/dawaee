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

describe('push-token registration is bound to the authenticated session device', () => {
  it('does not let one live session overwrite another live device routing endpoint', async () => {
    const phone = '+966500096856';
    const deviceA = 'device-push-binding-a-0001';
    const deviceB = 'device-push-binding-b-0001';
    const sessionA = await signIn(h, phone, deviceA);
    const sessionB = await signIn(h, phone, deviceB);
    expect(sessionB.userId).toBe(sessionA.userId);

    const originalToken = 'ExponentPushToken[push-binding-legitimate-b]';
    const legitimate = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(sessionB),
      payload: { token: originalToken, platform: 'android', deviceId: deviceB, appVersion: '1.0.0' },
    });
    expect(legitimate.statusCode, legitimate.body).toBe(200);

    // The session list exposes the user's own device ids by design. Knowing a
    // sibling device id must not let session A persist its provider endpoint
    // under device B, otherwise revoking A can leave that routing endpoint
    // eligible because B still has a live session.
    const attemptedOverwrite = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(sessionA),
      payload: {
        token: 'ExponentPushToken[push-binding-spoofed-from-a]',
        platform: 'android',
        deviceId: deviceB,
        appVersion: '1.0.1',
      },
    });
    expect(
      attemptedOverwrite.statusCode,
      'a push endpoint may only be registered for the device backing the authenticated session',
    ).toBe(403);

    const { rows } = await owner.query<{ token: string; active: boolean }>(
      'SELECT token, active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [sessionA.userId, deviceB],
    );
    expect(rows).toEqual([{ token: originalToken, active: true }]);
  });
});
