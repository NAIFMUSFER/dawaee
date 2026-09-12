import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

/**
 * Red-team regression for a shared-phone/offline sign-out boundary.
 *
 * The mobile client deliberately completes local sign-out even when the network
 * is unavailable. In that case its best-effort DELETE /v1/devices/push-token
 * never reaches the server, so the old account can still own this installation's
 * Expo push token. When the phone later signs into another account, Expo returns
 * the same installation token. Registration must move that routing endpoint to
 * the currently authenticated account rather than fail on the active-token
 * uniqueness constraint or leave reminders addressed to the old account.
 *
 * The token is routing metadata, not an authentication credential: the caller
 * still has to be authenticated before this endpoint runs.
 */
let h: Harness;
let owner: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 4,
  });
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('push token ownership follows the account currently using one installation', () => {
  it('reassigns an active token after the previous account signed out offline', async () => {
    const deviceId = 'audit-shared-installation-0001';
    const a = await signIn(h, '+966500006101', deviceId);
    const b = await signIn(h, '+966500006102', deviceId);
    const token = 'ExponentPushToken[audit-account-switch-token-0001]';

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(a),
      payload: { token, platform: 'ios', deviceId, appVersion: '1.0.0' },
    });
    expect(first.statusCode, first.body).toBe(200);

    const before = await owner.query<{ user_id: string; active: boolean }>(
      'SELECT user_id, active FROM push_tokens WHERE token=$1 ORDER BY created_at',
      [token],
    );
    expect(before.rows).toEqual([{ user_id: a.userId, active: true }]);

    // No remote de-registration here: this is exactly what an offline sign-out
    // looks like to the server. Local credentials/cache were cleared on-device,
    // then the same installation signed in as B once connectivity returned.
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(b),
      payload: { token, platform: 'ios', deviceId, appVersion: '1.0.0' },
    });
    expect(second.statusCode, second.body).toBe(200);

    const after = await owner.query<{ user_id: string; active: boolean }>(
      'SELECT user_id, active FROM push_tokens WHERE token=$1 ORDER BY created_at',
      [token],
    );
    expect(after.rows.filter((row) => row.active)).toEqual([{ user_id: b.userId, active: true }]);
    expect(after.rows.some((row) => row.user_id === a.userId && row.active)).toBe(false);
  });

  it('does not let knowledge of a token alone transfer another installation', async () => {
    const ownerDeviceId = 'audit-installation-owner-0002';
    const differentDeviceId = 'audit-different-installation-0002';
    const a = await signIn(h, '+966500006103', ownerDeviceId);
    const b = await signIn(h, '+966500006104', differentDeviceId);
    const token = 'ExponentPushToken[audit-account-switch-token-0002]';

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(a),
      payload: {
        token,
        platform: 'ios',
        deviceId: ownerDeviceId,
        appVersion: '1.0.0',
      },
    });
    expect(first.statusCode, first.body).toBe(200);

    // Same provider token but a different installation id is not an account
    // switch. It must not gain the trigger's cross-user transfer privilege.
    const attemptedSteal = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: authHeaders(b),
      payload: {
        token,
        platform: 'ios',
        deviceId: differentDeviceId,
        appVersion: '1.0.0',
      },
    });
    expect(attemptedSteal.statusCode).not.toBe(200);

    const rows = await owner.query<{ user_id: string; device_id: string; active: boolean }>(
      'SELECT user_id, device_id, active FROM push_tokens WHERE token=$1 ORDER BY created_at',
      [token],
    );
    expect(rows.rows.filter((row) => row.active)).toEqual([{
      user_id: a.userId,
      device_id: ownerDeviceId,
      active: true,
    }]);
  });

  it('keeps the cross-user transfer helper unreachable as a runtime function', async () => {
    const { rows } = await owner.query<{
      app_can_execute: boolean;
      worker_can_execute: boolean;
      public_can_execute: boolean;
    }>(`
      SELECT
        has_function_privilege('dawaee_app', 'app.transfer_push_token_on_account_switch()', 'EXECUTE') AS app_can_execute,
        has_function_privilege('dawaee_worker', 'app.transfer_push_token_on_account_switch()', 'EXECUTE') AS worker_can_execute,
        has_function_privilege('public', 'app.transfer_push_token_on_account_switch()', 'EXECUTE') AS public_can_execute
    `);

    expect(rows[0]).toEqual({
      app_can_execute: false,
      worker_can_execute: false,
      public_can_execute: false,
    });
  });
});
