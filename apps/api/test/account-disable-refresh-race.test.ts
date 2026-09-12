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

async function waitUntilDisableIsBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rows } = await owner.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE 'UPDATE users SET disabled_at = now() WHERE id = $1%'
       ) AS waiting`,
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('account disable never reached the forced refresh overlap');
}

describe('account disable versus an in-flight refresh', () => {
  it('permanently revokes a refresh descendant so re-enable cannot resurrect it', async () => {
    const phone = '+966500096857';
    const session = await signIn(h, phone, 'device-disable-race');
    const descendantRaw = 'forced-disable-race-descendant';

    const refreshTx = await owner.connect();
    try {
      await refreshTx.query('BEGIN');
      const rotated = await refreshTx.query<{ outcome: string; session_id: string | null }>(
        'SELECT outcome, session_id FROM app.rotate_session($1,$2,$3,$4)',
        [sha256(session.refreshToken), sha256(descendantRaw), null, 30],
      );
      expect(rotated.rows[0]?.outcome).toBe('rotated');
      expect(rotated.rows[0]?.session_id).toBeTruthy();

      let disableFinished = false;
      const disable = owner.query(
        'UPDATE users SET disabled_at = now() WHERE id = $1',
        [session.userId],
      ).then((result) => {
        disableFinished = true;
        return result;
      });

      await waitUntilDisableIsBlocked();
      expect(disableFinished, 'disable completed while the target refresh transaction was still open').toBe(false);

      // The descendant becomes committed only after the disable statement and
      // its revocation trigger are already in flight. The permanent-disable
      // contract requires the trigger to catch it anyway.
      await refreshTx.query('COMMIT');
      await disable;
    } catch (error) {
      await refreshTx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      refreshTx.release();
    }

    const { rows: liveWhileDisabled } = await owner.query<{ id: string }>(
      `SELECT id FROM auth_sessions
        WHERE user_id = $1 AND device_id = 'device-disable-race'
          AND revoked_at IS NULL AND expires_at > now()`,
      [session.userId],
    );
    expect(
      liveWhileDisabled,
      'disable left an unrevoked credential that could resurrect after re-enable',
    ).toHaveLength(0);

    // Negative/behavioral control: re-enable is explicitly allowed to permit
    // new authentication, but must never revive credentials that existed at
    // the moment of disablement.
    await owner.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [session.userId]);
    const replay = await owner.query<{ outcome: string }>(
      'SELECT outcome FROM app.rotate_session($1,$2,$3,$4)',
      [sha256(descendantRaw), sha256('post-enable-probe'), null, 30],
    );
    expect(replay.rows[0]?.outcome).not.toBe('rotated');
  }, 20_000);
});
