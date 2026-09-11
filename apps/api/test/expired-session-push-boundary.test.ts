import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let worker: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test',
    max: 2,
  });
  worker = new pg.Pool({
    connectionString: 'postgres://dawaee_worker:devpass@127.0.0.1:5433/dawaee_test',
    max: 2,
  });
});

afterAll(async () => {
  await worker.end();
  await owner.end();
  await h.close();
});

describe('remote push eligibility follows current device authentication', () => {
  it('returns only active routing tokens backed by a live same-device session', async () => {
    const phone = '+966500096854';
    const expiredDevice = 'device-expired-push-0001';
    const liveDevice = 'device-live-push-0001';
    const expired = await signIn(h, phone, expiredDevice);
    const live = await signIn(h, phone, liveDevice);
    expect(live.userId).toBe(expired.userId);

    await owner.query(
      `INSERT INTO push_tokens (user_id, token, platform, device_id, active, last_seen_at)
       VALUES
         ($1,$2,'android',$3,true,now()),
         ($1,$4,'android',$5,true,now())`,
      [
        expired.userId,
        'ExponentPushToken[expired-session-must-not-send]', expiredDevice,
        'ExponentPushToken[live-session-may-send]', liveDevice,
      ],
    );

    // Time-based expiry does not execute the explicit-revocation trigger from
    // 0051. Reproduce that exact edge: storage still says both tokens are active.
    await owner.query(
      `UPDATE auth_sessions
          SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
      [expired.userId, expiredDevice],
    );

    const raw = await owner.query<{ device_id: string; active: boolean }>(
      'SELECT device_id, active FROM push_tokens WHERE user_id = $1 ORDER BY device_id',
      [expired.userId],
    );
    expect(raw.rows).toEqual([
      { device_id: expiredDevice, active: true },
      { device_id: liveDevice, active: true },
    ]);

    // The real non-bypass worker receives only provider routing strings and no
    // auth-session data. This is the exact DB contract used by dispatcher.ts.
    const eligible = await worker.query<{ token: string }>(
      'SELECT token FROM app.list_live_push_tokens($1, 5)',
      [expired.userId],
    );
    expect(eligible.rows).toEqual([{ token: 'ExponentPushToken[live-session-may-send]' }]);
  });

  it('keeps auth_sessions unavailable and exposes the bounded function only to the worker', async () => {
    await expect(worker.query('SELECT id FROM auth_sessions LIMIT 1')).rejects.toMatchObject({ code: '42501' });

    const { rows } = await owner.query<{
      worker_exec: boolean;
      app_exec: boolean;
      worker_session_select: boolean;
    }>(
      `SELECT
         has_function_privilege('dawaee_worker', 'app.list_live_push_tokens(uuid,int)', 'EXECUTE') AS worker_exec,
         has_function_privilege('dawaee_app', 'app.list_live_push_tokens(uuid,int)', 'EXECUTE') AS app_exec,
         has_table_privilege('dawaee_worker', 'public.auth_sessions', 'SELECT') AS worker_session_select`,
    );
    expect(rows).toEqual([{
      worker_exec: true,
      app_exec: false,
      worker_session_select: false,
    }]);
  });

  it('pins the dispatcher to the live-session function instead of active=true alone', () => {
    const src = fs.readFileSync(new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/SELECT token FROM app\.list_live_push_tokens\(\$1, 5\)/);
    expect(src).not.toMatch(/SELECT\s+token\s+FROM\s+push_tokens\s+WHERE\s+user_id/i);
  });
});
