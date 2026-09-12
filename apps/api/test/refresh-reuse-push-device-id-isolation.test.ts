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

describe('refresh-reuse push cleanup does not trust a client device-id collision', () => {
  it('retires the revoked lineage endpoint even when an unrelated live session claims the same device id', async () => {
    const phone = '+966500096860';
    const sharedDeviceId = 'device-refresh-push-collision-0001';
    const current = await signIn(h, phone, sharedDeviceId);
    const compromised = await signIn(h, phone, sharedDeviceId);
    expect(compromised.userId).toBe(current.userId);

    // TestUser exposes public auth artifacts, not database session ids. Resolve
    // each session through the authenticated session-list contract so the test
    // proves the real API boundary rather than depending on a harness-only id.
    const currentSessions = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${current.token}` },
    });
    expect(currentSessions.statusCode, currentSessions.body).toBe(200);
    const currentSessionId = currentSessions
      .json<{ sessions: Array<{ id: string; current: boolean }> }>()
      .sessions.find((session) => session.current)?.id;
    expect(currentSessionId).toBeTruthy();

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
    expect(compromisedSessionId).not.toBe(currentSessionId);

    const rotated = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: compromised.refreshToken },
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const rotatedBody = rotated.json<{ accessToken: string; refreshToken: string }>();

    const attackerEndpoint = 'ExponentPushToken[refresh-lineage-collision-endpoint]';
    const registration = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/push-token',
      headers: { authorization: `Bearer ${rotatedBody.accessToken}` },
      payload: {
        token: attackerEndpoint,
        platform: 'android',
        deviceId: sharedDeviceId,
        appVersion: '1.0.0',
      },
    });
    expect(registration.statusCode, registration.body).toBe(200);

    // Move only the consumed predecessor past the benign concurrent-refresh
    // grace window. Reuse must then revoke its server-linked live successor.
    await owner.query(
      `UPDATE auth_sessions
          SET revoked_at = now() - interval '31 seconds'
        WHERE id = $1`,
      [compromisedSessionId],
    );

    const reuse = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: compromised.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    const currentStillLive = await owner.query<{ id: string }>(
      `SELECT id FROM auth_sessions
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [currentSessionId],
    );
    expect(currentStillLive.rows).toHaveLength(1);

    const compromisedLive = await owner.query<{ id: string }>(
      `SELECT id FROM auth_sessions
        WHERE user_id = $1
          AND id <> $2
          AND device_id = $3
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [current.userId, currentSessionId, sharedDeviceId],
    );
    expect(compromisedLive.rows).toHaveLength(0);

    const push = await owner.query<{ token: string; active: boolean }>(
      'SELECT token, active FROM push_tokens WHERE user_id = $1 AND device_id = $2',
      [current.userId, sharedDeviceId],
    );
    expect(
      push.rows,
      'a provider endpoint written by the revoked replacement lineage must not stay eligible merely because an unrelated live session reused the same client-supplied device id',
    ).toEqual([{ token: attackerEndpoint, active: false }]);
  });
});
