import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let db: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 2 });
});

afterAll(async () => {
  await db.end();
  await h.close();
});

describe('push binding during expired-session retention cleanup', () => {
  it('fails closed when the bound session is deleted and another session shares the device label', async () => {
    const deviceId = 'device-retention-collision-0001';
    const first = await signIn(h, '+966500096864', deviceId);
    const second = await signIn(h, '+966500096864', deviceId);

    const sessionResponse = await h.app.inject({ method: 'GET', url: '/v1/auth/sessions', headers: authHeaders(second) });
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(200);
    const boundSessionId = sessionResponse.json<{ sessions: Array<{ id: string; current: boolean }> }>()
      .sessions.find((session) => session.current)?.id;
    expect(boundSessionId).toBeTruthy();

    const firstSessionResponse = await h.app.inject({ method: 'GET', url: '/v1/auth/sessions', headers: authHeaders(first) });
    expect(firstSessionResponse.statusCode, firstSessionResponse.body).toBe(200);
    const siblingSessionId = firstSessionResponse.json<{ sessions: Array<{ id: string; current: boolean }> }>()
      .sessions.find((session) => session.current)?.id;
    expect(siblingSessionId).toBeTruthy();
    expect(siblingSessionId).not.toBe(boundSessionId);

    const providerToken = 'ExponentPushToken[retention-binding-regression]';
    const registration = await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(second),
      payload: { token: providerToken, platform: 'android', deviceId, appVersion: '1.0.0' },
    });
    expect(registration.statusCode, registration.body).toBe(200);

    const initial = await db.query<{ active: boolean; session_id: string | null }>(
      'SELECT active, session_id FROM push_tokens WHERE user_id = $1 AND token = $2', [second.userId, providerToken],
    );
    expect(initial.rows).toEqual([{ active: true, session_id: boundSessionId }]);

    await db.query("UPDATE auth_sessions SET expires_at = now() - interval '31 days' WHERE id = $1", [boundSessionId]);
    await db.query('SELECT app.cleanup_expired_sessions(30)');

    const afterCleanup = await db.query<{ active: boolean; session_id: string | null }>(
      'SELECT active, session_id FROM push_tokens WHERE user_id = $1 AND token = $2', [second.userId, providerToken],
    );
    expect(afterCleanup.rows).toEqual([{ active: false, session_id: null }]);

    const routed = await db.query<{ token: string }>('SELECT token FROM app.list_live_push_tokens($1,$2)', [second.userId, 20]);
    expect(routed.rows).toEqual([]);
  });
});
