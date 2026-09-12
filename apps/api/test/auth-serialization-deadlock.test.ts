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

async function waitUntilRefreshIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rows } = await owner.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE 'SELECT outcome FROM app.rotate_session%'
       ) AS waiting`,
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('refresh never reached the forced session-row lock');
}

describe('account auth serialization does not enter the table/FK lock graph', () => {
  it('lets logout audit its action while a refresh waits on the revoked session, with no deadlock victim', async () => {
    const deviceId = 'device-auth-deadlock-regression';
    const session = await signIn(h, '+966500096855', deviceId);
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM auth_sessions
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [session.userId, deviceId],
    );
    expect(rows).toHaveLength(1);
    const sessionId = rows[0]!.id;

    const logoutTx = await owner.connect();
    const refreshTx = await owner.connect();
    try {
      await logoutTx.query('BEGIN');
      await refreshTx.query('BEGIN');
      // Make a regression deterministic if a future change recreates the lock
      // cycle. These test connections are the database owner; production code
      // does not alter deadlock_timeout.
      await logoutTx.query("SET LOCAL deadlock_timeout = '100ms'");
      await refreshTx.query("SET LOCAL deadlock_timeout = '100ms'");

      // Logout owns the session-row lock first and keeps it until commit.
      await logoutTx.query('SELECT app.revoke_session($1)', [sessionId]);

      // Refresh now reaches its account serialization point and then waits on
      // that same session row. The first 0054 implementation used users FOR
      // UPDATE before this wait, which made the audit FK below wait back on the
      // refresh transaction: auth_sessions -> users versus users ->
      // auth_sessions, a real 40P01 deadlock observed in CI.
      const refreshResult = refreshTx.query<{ outcome: string }>(
        'SELECT outcome FROM app.rotate_session($1,$2,$3,$4)',
        [sha256(session.refreshToken), sha256('deadlock-regression-descendant'), null, 30],
      ).then(
        (result) => ({ outcome: result.rows[0]?.outcome ?? null, errorCode: null as string | null }),
        (error: { code?: string }) => ({ outcome: null, errorCode: error.code ?? 'unknown' }),
      );

      await waitUntilRefreshIsBlocked();

      const auditResult = await logoutTx.query(
        `INSERT INTO audit_logs
          (actor_user_id, actor_role, action, entity_type, entity_id)
         VALUES ($1, 'patient', 'auth.logout', 'session', $2)`,
        [session.userId, sessionId],
      ).then(
        () => ({ errorCode: null as string | null }),
        (error: { code?: string }) => ({ errorCode: error.code ?? 'unknown' }),
      );

      expect(auditResult.errorCode, 'logout audit became a deadlock victim').toBeNull();
      await logoutTx.query('COMMIT');

      const refresh = await refreshResult;
      expect(refresh.errorCode, 'refresh became a deadlock victim').toBeNull();
      expect(refresh.outcome, 'a refresh descendant survived a completed logout').not.toBe('rotated');
      await refreshTx.query('COMMIT');
    } catch (error) {
      await logoutTx.query('ROLLBACK').catch(() => undefined);
      await refreshTx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      logoutTx.release();
      refreshTx.release();
    }

    const { rows: live } = await owner.query<{ id: string }>(
      `SELECT id FROM auth_sessions
        WHERE user_id = $1 AND device_id = $2
          AND revoked_at IS NULL AND expires_at > now()`,
      [session.userId, deviceId],
    );
    expect(live, 'logout/refresh interleaving left a usable session').toHaveLength(0);
  }, 20_000);
});
