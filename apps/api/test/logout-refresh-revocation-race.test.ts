import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness, type TestUser } from './harness.js';

/**
 * Regression for the server-side logout/refresh race.
 *
 * The auth pre-handler can validate session S1, then a concurrent refresh can
 * rotate S1 -> S2 before the logout handler reaches app.revoke_session(S1).
 * Historically revoke_session updated only S1. Because S1 was already revoked,
 * the logout returned 200 while S2 remained usable.
 *
 * This test drives that exact post-authentication ordering deterministically:
 * authenticate/login, rotate, then execute the logout tail against S1. The
 * logout tail must revoke the live descendant on the SAME user/device while
 * leaving another device untouched.
 */
let h: Harness;
let owner: pg.Pool;
let user: TestUser;

const conn = () => new pg.Pool({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 4,
});

async function login(phone: string, deviceId: string) {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/auth/login', remoteAddress: '10.33.1.1',
    payload: { identifier: phone, password: TEST_PASSWORD, deviceId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ accessToken: string; refreshToken: string }>();
}

const refresh = (refreshToken: string) => h.app.inject({
  method: 'POST', url: '/v1/auth/refresh', remoteAddress: '10.33.1.2',
  payload: { refreshToken },
});

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = conn();
  user = await signIn(h, '+966500004401');
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('logout tail versus an already-committed refresh', () => {
  it('kills the refresh descendant on that device and no other device', async () => {
    const deviceA = 'device-logout-race-a';
    const deviceB = 'device-logout-race-b';
    const a1 = await login(user.phone, deviceA);
    const b1 = await login(user.phone, deviceB);

    const { rows: before } = await owner.query<{ id: string }>(
      `SELECT id FROM auth_sessions
        WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [user.userId, deviceA],
    );
    expect(before).toHaveLength(1);
    const oldSessionId = before[0]!.id;

    // Concurrent refresh wins before the already-authenticated logout tail.
    const rotated = await refresh(a1.refreshToken);
    expect(rotated.statusCode, rotated.body).toBe(200);
    const a2 = rotated.json<{ accessToken: string; refreshToken: string }>();

    // Positive controls: descendant A2 and independent device B are both live.
    expect((await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a2.accessToken}` },
    })).statusCode).toBe(200);
    expect((await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${b1.accessToken}` },
    })).statusCode).toBe(200);

    // This is the database tail the logout route runs after authentication.
    await owner.query('SELECT app.revoke_session($1)', [oldSessionId]);

    const { rows: liveA } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_sessions
        WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL AND expires_at > now()`,
      [user.userId, deviceA],
    );
    expect(liveA[0]!.n, 'logout left a refresh descendant alive').toBe(0);

    expect((await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a2.accessToken}` },
    })).statusCode, 'descendant access token survived logout').toBe(401);
    expect((await refresh(a2.refreshToken)).statusCode,
      'descendant refresh token survived logout').not.toBe(200);

    // Established revocation scope is user + device, not the whole account.
    expect((await h.app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${b1.accessToken}` },
    })).statusCode, 'logout on device A revoked device B').toBe(200);
    expect((await refresh(b1.refreshToken)).statusCode,
      'logout on device A revoked device B refresh').toBe(200);
  });
});
