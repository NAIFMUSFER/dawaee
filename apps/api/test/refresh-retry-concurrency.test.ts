import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rotateSessionAttempt } from '../src/auth/session-service.js';
import { resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;
beforeAll(async () => {
  resetDatabase(); h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 3 });
});
afterAll(async () => { await owner?.end(); await h?.close(); });
async function blocked(pid: number) {
  for (let i = 0; i < 160; i++) {
    const result = await owner.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid]);
    if (result.rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('retry did not reach the held account security lock');
}

describe('refresh retry on real PostgreSQL connections', () => {
  it('serializes concurrent copies of the same attempt and creates exactly one successor', async () => {
    const user = await signIn(h, '+966500096891', 'retry-concurrency-device');
    const proof = randomBytes(32).toString('hex');
    const held = await owner.connect();
    let pending: Array<ReturnType<typeof h.app.inject>> = [];
    try {
      await held.query('BEGIN'); await held.query('SET LOCAL ROLE dawaee_app');
      const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const initial = await rotateSessionAttempt(held, user.refreshToken, null, proof);
      expect(initial.outcome).toBe('rotated');
      pending = Array.from({ length: 6 }, () => h.app.inject({ method: 'POST', url: '/v1/auth/refresh',
        payload: { refreshToken: user.refreshToken, retryNonce: proof } }));
      // Start the lazy inject thenables before observing the real lock wait.
      const replies = Promise.all(pending);
      await blocked(pid);
      await held.query('COMMIT');
      for (const response of await replies) {
        expect(response.statusCode).toBe(200);
        if (initial.outcome === 'rotated') expect(response.json().refreshToken).toBe(initial.refreshToken);
      }
      expect((await owner.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [user.userId])).rows[0].n).toBe(2);
    } finally { await held.query('ROLLBACK'); held.release(); await Promise.allSettled(pending); }
  });

  it('cannot recover a successor revoked by a security action while the retry waits', async () => {
    const user = await signIn(h, '+966500096892', 'retry-revocation-device');
    const proof = randomBytes(32).toString('hex');
    const initial = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken, retryNonce: proof } });
    expect(initial.statusCode).toBe(200);
    const held = await owner.connect();
    let pending: Promise<{ statusCode: number }> | undefined;
    try {
      await held.query('BEGIN');
      await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,20260912))', [user.userId]);
      const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = Promise.resolve(h.app.inject({ method: 'POST', url: '/v1/auth/refresh',
        payload: { refreshToken: user.refreshToken, retryNonce: proof } }));
      await blocked(pid);
      await held.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.userId]);
      await held.query('COMMIT');
      expect((await pending).statusCode).toBe(409); // Existing grace; never a recovered 200.
      expect((await owner.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [user.userId])).rows[0].n).toBe(0);
    } finally { await held.query('ROLLBACK'); held.release(); await pending; }
  });
});
