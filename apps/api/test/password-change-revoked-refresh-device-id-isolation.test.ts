import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness } from './harness.js';

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

describe('revoked refresh reuse is isolated from unrelated sessions sharing a client device id', () => {
  it('cannot revoke the password-changing session after an ejected sibling spoofed the same device id', async () => {
    const phone = '+966500096859';
    const sharedDeviceId = 'device-refresh-reuse-collision-0001';
    const current = await signIn(h, phone, sharedDeviceId);
    const ejected = await signIn(h, phone, sharedDeviceId);
    expect(ejected.userId).toBe(current.userId);

    // TestUser intentionally exposes only public auth artifacts. Resolve the
    // current session id through the same authenticated session-list API a real
    // client can use instead of reaching for a nonexistent harness-only field.
    const sessionList = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${current.token}` },
    });
    expect(sessionList.statusCode, sessionList.body).toBe(200);
    const currentSessionId = sessionList
      .json<{ sessions: Array<{ id: string; current: boolean }> }>()
      .sessions.find((session) => session.current)?.id;
    expect(currentSessionId).toBeTruthy();

    const change = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { authorization: `Bearer ${current.token}` },
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'device-id-isolated-password-2026',
      },
    });
    expect(change.statusCode, change.body).toBe(200);

    const beforeReplay = await owner.query<{ id: string }>(
      `SELECT id
         FROM auth_sessions
        WHERE id = $1
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [currentSessionId],
    );
    expect(beforeReplay.rows).toHaveLength(1);

    // The ejected refresh token is already invalid. Re-presenting it must not
    // use the client-supplied device_id as authority to revoke a different live
    // session that merely claims the same installation identifier.
    const replay = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: ejected.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    const afterReplay = await owner.query<{ id: string }>(
      `SELECT id
         FROM auth_sessions
        WHERE id = $1
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [currentSessionId],
    );
    expect(
      afterReplay.rows,
      'a refresh token that password change already revoked must not remain a persistent logout capability against another session with the same client-supplied device id',
    ).toHaveLength(1);
  });
});
