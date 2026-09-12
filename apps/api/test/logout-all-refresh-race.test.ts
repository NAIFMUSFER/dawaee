import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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

async function waitUntilLogoutAllIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rows } = await owner.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND (
              query LIKE 'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1%'
              OR query LIKE 'SELECT app.lock_current_auth_account()%'
            )
       ) AS waiting`,
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('logout-all never reached the forced refresh overlap');
}

describe('logout-all versus an in-flight refresh', () => {
  it('does not let a refresh descendant survive the successful logout-all response', async () => {
    const phone = '+966500096856';
    const ownerSession = await signIn(h, phone, 'device-logout-all-owner');
    const stolenSession = await signIn(h, phone, 'device-logout-all-stolen');
    expect(stolenSession.userId).toBe(ownerSession.userId);

    const refreshTx = await owner.connect();
    try {
      await refreshTx.query('BEGIN');
      const rotated = await refreshTx.query<{ outcome: string; session_id: string | null }>(
        'SELECT outcome, session_id FROM app.rotate_session($1,$2,$3,$4)',
        [sha256(stolenSession.refreshToken), sha256('forced-logout-all-race-descendant'), null, 30],
      );
      expect(rotated.rows[0]?.outcome).toBe('rotated');
      expect(rotated.rows[0]?.session_id).toBeTruthy();

      let logoutFinished = false;
      const logoutAll = h.app.inject({
        method: 'POST',
        url: '/v1/auth/logout-all',
        headers: { authorization: `Bearer ${ownerSession.token}` },
      }).then((response) => {
        logoutFinished = true;
        return response;
      });

      await waitUntilLogoutAllIsBlocked();
      expect(logoutFinished, 'logout-all completed while the target refresh transaction was still open').toBe(false);

      // Commit the refresh only after logout-all has reached the competing
      // security boundary. A vulnerable direct UPDATE resumes from its older
      // statement snapshot and misses the descendant. The fixed path waits on
      // the shared advisory lock first, then starts the UPDATE from a fresh
      // READ COMMITTED snapshot that includes the descendant.
      await refreshTx.query('COMMIT');
      const response = await logoutAll;
      expect(response.statusCode, response.body).toBe(200);
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
          AND device_id = 'device-logout-all-stolen'
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [ownerSession.userId],
    );
    expect(
      live,
      'a refresh descendant survived even though logout-all reported success',
    ).toHaveLength(0);
  }, 20_000);
});
