import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto.js';
import { resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness } from './harness.js';

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

async function waitUntilPasswordSecurityTransactionIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rows } = await owner.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND (
              query LIKE 'UPDATE auth_sessions SET revoked_at = now()%'
              OR query LIKE 'SELECT app.set_password%'
            )
       ) AS waiting`,
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('password-change security transaction never reached the forced refresh lock');
}

describe('password change versus an in-flight refresh on another device', () => {
  it('does not let a refresh descendant survive the password-change security response', async () => {
    const phone = '+966500096854';
    const ownerSession = await signIn(h, phone, 'device-password-race-owner');
    const stolenSession = await signIn(h, phone, 'device-password-race-stolen');
    expect(stolenSession.userId).toBe(ownerSession.userId);

    const refreshTx = await owner.connect();
    try {
      await refreshTx.query('BEGIN');
      const rotated = await refreshTx.query<{ outcome: string; session_id: string | null }>(
        'SELECT outcome, session_id FROM app.rotate_session($1,$2,$3,$4)',
        [sha256(stolenSession.refreshToken), sha256('forced-password-race-descendant'), null, 30],
      );
      expect(rotated.rows[0]?.outcome).toBe('rotated');
      expect(rotated.rows[0]?.session_id).toBeTruthy();

      let passwordFinished = false;
      const passwordChange = h.app.inject({
        method: 'POST',
        url: '/v1/auth/password',
        headers: { authorization: `Bearer ${ownerSession.token}` },
        payload: {
          currentPassword: TEST_PASSWORD,
          newPassword: 'race-safe-password-change-2026',
        },
      }).then((response) => {
        passwordFinished = true;
        return response;
      });

      await waitUntilPasswordSecurityTransactionIsBlocked();
      expect(passwordFinished, 'password change completed while the target refresh still held its security lock').toBe(false);

      // The red probe originally forced password change to take the session
      // revocation UPDATE snapshot while the refresh predecessor row was
      // locked. The fixed implementation may block earlier on the shared
      // per-user serialization lock instead. In either case, committing the
      // in-flight refresh here exercises the same required invariant: after
      // password change returns 200, no descendant on the other device may
      // remain live.
      await refreshTx.query('COMMIT');
      const change = await passwordChange;
      expect(change.statusCode, change.body).toBe(200);
    } catch (error) {
      await refreshTx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      refreshTx.release();
    }

    const { rows: live } = await owner.query<{ id: string }>(
      `SELECT id
         FROM auth_sessions
        WHERE user_id = $1
          AND device_id = 'device-password-race-stolen'
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [ownerSession.userId],
    );
    expect(
      live,
      'a refresh descendant survived even though password change promised to eject every other device session',
    ).toHaveLength(0);
  }, 20_000);
});
