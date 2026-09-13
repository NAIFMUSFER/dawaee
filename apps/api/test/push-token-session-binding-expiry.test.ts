import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let db: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
});

afterAll(async () => {
  await db.end();
  await h.close();
});

describe('push token session binding', () => {
  it('does not route to a token after its exact bound session expires, even if a new same-device session exists', async () => {
    const phone = '+966500009301';
    const deviceId = 'push-expiry-device';
    const user = await signIn(h, phone, deviceId);
    const pushToken = 'ExponentPushToken[expiry-binding]';

    const registered = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(user),
      payload: { token: pushToken, platform: 'ios', deviceId },
    });
    expect(registered.statusCode, registered.body).toBe(200);

    const bound = await db.query<{ session_id: string | null }>(
      'SELECT session_id FROM push_tokens WHERE user_id = $1 AND token = $2',
      [user.userId, pushToken],
    );
    expect(bound.rows[0]?.session_id).toBeTruthy();
    const originalSessionId = bound.rows[0]!.session_id!;

    const beforeExpiry = await db.query<{ token: string }>(
      'SELECT token FROM app.list_live_push_tokens($1, 5)',
      [user.userId],
    );
    expect(beforeExpiry.rows.map((row) => row.token)).toContain(pushToken);

    const receiptAwareBeforeExpiry = await db.query<{ push_token_id: string; token: string }>(
      'SELECT push_token_id, token FROM app.list_live_push_endpoints($1, 5)',
      [user.userId],
    );
    expect(receiptAwareBeforeExpiry.rows.map((row) => row.token)).toContain(pushToken);

    await db.query(
      `UPDATE auth_sessions
          SET expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [originalSessionId],
    );

    const afterExpiry = await db.query<{ token: string }>(
      'SELECT token FROM app.list_live_push_tokens($1, 5)',
      [user.userId],
    );
    expect(afterExpiry.rows).toEqual([]);

    const receiptAwareAfterExpiry = await db.query<{ push_token_id: string; token: string }>(
      'SELECT push_token_id, token FROM app.list_live_push_endpoints($1, 5)',
      [user.userId],
    );
    expect(receiptAwareAfterExpiry.rows).toEqual([]);

    // Logging in again on the same device creates a fresh live session. The
    // old token must remain unroutable until that new session explicitly
    // re-registers it; matching only user_id + device_id would fail here.
    const relogged = await signIn(h, phone, deviceId);
    const stillBoundToOldSession = await db.query<{ session_id: string | null }>(
      'SELECT session_id FROM push_tokens WHERE user_id = $1 AND token = $2',
      [user.userId, pushToken],
    );
    expect(stillBoundToOldSession.rows[0]?.session_id).toBe(originalSessionId);

    const afterSameDeviceRelogin = await db.query<{ token: string }>(
      'SELECT token FROM app.list_live_push_endpoints($1, 5)',
      [user.userId],
    );
    expect(afterSameDeviceRelogin.rows).toEqual([]);

    const rebound = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(relogged),
      payload: { token: pushToken, platform: 'ios', deviceId },
    });
    expect(rebound.statusCode, rebound.body).toBe(200);

    const afterRebind = await db.query<{ token: string }>(
      'SELECT token FROM app.list_live_push_endpoints($1, 5)',
      [user.userId],
    );
    expect(afterRebind.rows.map((row) => row.token)).toContain(pushToken);
  });
});
