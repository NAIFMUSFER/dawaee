import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, resetDatabase, signIn, startHarness,
  type Harness, type TestUser,
} from './harness.js';

/**
 * Red-team regression for the PATCH /v1/me/preferences persistence contract.
 *
 * Two cases matter here:
 *  1. the endpoint must apply the submitted patch even when no preference row
 *     exists yet (legacy/recovery data is allowed to reach this state), and
 *  2. explicit null is meaningful for the nullable quiet-hour fields and must
 *     clear a previously saved value rather than being treated as "omitted".
 *
 * This suite uses the real Fastify route and PostgreSQL database. The one
 * superuser DELETE only constructs the otherwise-valid absent-row precondition;
 * every behavior under assertion is exercised through the authenticated API.
 */
let h: Harness;
let user: TestUser;

function deletePreferenceRow(userId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('unexpected synthetic user id');
  execFileSync('psql', ['-d', 'dawaee_test', '-c',
    `DELETE FROM user_preferences WHERE user_id = '${userId}'`], {
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    stdio: 'pipe',
  });
}

async function getPreferences() {
  const res = await h.app.inject({
    method: 'GET', url: '/v1/me', headers: authHeaders(user),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ preferences: {
    locale: string;
    highContrast: boolean;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
  } }>().preferences;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500091101');
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('PATCH /v1/me/preferences persistence semantics', () => {
  it('applies the submitted values when the preference row does not exist', async () => {
    deletePreferenceRow(user.userId);

    const patched = await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(user),
      payload: { locale: 'en', highContrast: true },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const preferences = await getPreferences();
    expect(preferences.locale).toBe('en');
    expect(preferences.highContrast).toBe(true);
  });

  it('clears saved quiet hours when the client sends explicit null', async () => {
    const set = await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(user),
      payload: { quietHoursStart: '22:00', quietHoursEnd: '06:00' },
    });
    expect(set.statusCode, set.body).toBe(200);

    const beforeClear = await getPreferences();
    expect(beforeClear.quietHoursStart).not.toBeNull();
    expect(beforeClear.quietHoursEnd).not.toBeNull();

    const cleared = await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(user),
      payload: { quietHoursStart: null, quietHoursEnd: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);

    const afterClear = await getPreferences();
    expect(afterClear.quietHoursStart).toBeNull();
    expect(afterClear.quietHoursEnd).toBeNull();
    // An unrelated value from the first scenario must survive this narrow patch.
    expect(afterClear.highContrast).toBe(true);
  });
});
