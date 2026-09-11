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
  it('excludes a still-active push token once that device has no live session', async () => {
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

    // Time-based expiry does not execute the revocation trigger added in 0051.
    // This reproduces the gap directly: the routing token remains active even
    // though app.session_is_live() would now reject that device's session.
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

    const eligible = await worker.query<{ token: string }>(
      'SELECT token FROM app.list_live_push_tokens($1, 5)',
      [expired.userId],
    );
    expect(eligible.rows).toEqual([{ token: 'ExponentPushToken[live-session-may-send]' }]);
  });

  it('keeps dispatcher push selection behind the live-session function', () => {
    const dispatcher = fs.readFileSync(
      new URL('../../worker/src/jobs/dispatcher.ts', import.meta.url),
      'utf8',
    );

    expect(dispatcher).toContain('SELECT token FROM app.list_live_push_tokens($1, 5)');
    expect(dispatcher).not.toContain(
      'SELECT token FROM push_tokens WHERE user_id = $1 AND active ORDER BY last_seen_at DESC LIMIT 5',
    );
  });
});
