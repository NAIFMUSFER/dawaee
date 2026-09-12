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

describe('remote push eligibility follows the exact authenticated session', () => {
  it('does not keep an expired session endpoint eligible through an unrelated live session with the same client device id', async () => {
    const phone = '+966500096862';
    const sharedDeviceId = 'device-expiry-endpoint-collision-0001';
    const current = await signIn(h, phone, sharedDeviceId);
    const compromised = await signIn(h, phone, sharedDeviceId);
    expect(compromised.userId).toBe(current.userId);

    const compromisedSessions = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${compromised.token}` },
    });
    expect(compromisedSessions.statusCode, compromisedSessions.body).toBe(200);
    const compromisedSessionId = compromisedSessions
      .json<{ sessions: Array<{ id: string; current: boolean }> }>()
      .sessions.find((session) => session.current)?.id;
    expect(compromisedSessionId).toBeTruthy();

    const attackerEndpoint = 'ExponentPushToken[expired-session-collision-endpoint]';
    const registration = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: `Bearer ${compromised.token}` },
      payload: {
        token: attackerEndpoint,
        platform: 'android',
        deviceId: sharedDeviceId,
        appVersion: '1.0.0',
      },
    });
    expect(registration.statusCode, registration.body).toBe(200);

    // Natural expiry does not execute the session-revocation trigger. The
    // endpoint must therefore be authorized by the exact session that bound it,
    // not by any other live session that happens to reuse the same client label.
    await owner.query(
      `UPDATE auth_sessions
          SET expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [compromisedSessionId],
    );

    const currentStillAuthenticated = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${current.token}` },
    });
    expect(currentStillAuthenticated.statusCode, currentStillAuthenticated.body).toBe(200);

    const routed = await h.worker.pool.query<{ token: string }>(
      'SELECT token FROM app.list_live_push_tokens($1,$2)',
      [current.userId, 20],
    );
    expect(
      routed.rows,
      'an endpoint bound by the expired session remained remotely routable because an unrelated live session reused its client-supplied device id',
    ).toEqual([]);
  });
});
