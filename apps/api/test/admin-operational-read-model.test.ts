import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, signIn, startHarness, TEST_PASSWORD, type Harness } from './harness.js';

/**
 * Regression for the operational-admin/RLS boundary.
 *
 * The HTTP process is always `dawaee_app`; an admin JWT does not create a new
 * database role. The old admin routes used `withTransaction()` and queried
 * FORCE-RLS clinical tables directly without setting app.user_id. PostgreSQL
 * correctly hid every row, so the admin overview and delivery diagnostics
 * returned zero/empty on a healthy populated database.
 *
 * The fix must not swing to the opposite failure mode. Operators need global
 * aggregate/failure mechanics, not raw patient records. Migration 0048 exposes
 * a bounded definer read model and this suite proves both halves: the admin sees
 * the operational facts, while the ordinary app role still cannot read the
 * underlying clinical rows outside a user-scoped transaction.
 */

let h: Harness;
let owner: pg.Pool;
let appRole: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  appRole = new pg.Pool({ connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test' });
});

afterAll(async () => {
  await appRole.end();
  await owner.end();
  await h.close();
});

async function adminToken(userId: string, phone: string): Promise<string> {
  await owner.query('UPDATE users SET is_admin=true WHERE id=$1', [userId]);
  const login = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: '10.66.1.1',
    payload: {
      identifier: phone,
      password: TEST_PASSWORD,
      deviceId: 'admin-ops-regression',
    },
  });
  expect(login.statusCode, login.body).toBe(200);
  return login.json<{ accessToken: string }>().accessToken;
}

describe('admin operational read model stays useful without bypassing clinical RLS', () => {
  it('shows global aggregate and failed-delivery facts to an admin, but not to a normal user', async () => {
    const admin = await signIn(h, '+966500098801');
    const patient = await signIn(h, '+966500098802');
    const token = await adminToken(admin.userId, admin.phone);

    const { rows: medRows } = await owner.query<{ id: string }>(
      `INSERT INTO medications
         (patient_profile_id, name, form, start_date, created_by)
       VALUES ($1,'admin regression medicine','tablet',current_date,$2)
       RETURNING id`,
      [patient.profileId, patient.userId],
    );
    expect(medRows).toHaveLength(1);

    const { rows: deliveryRows } = await owner.query<{ id: string }>(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, locale, title, body, payload,
          dedupe_key, scheduled_for, next_attempt_at, status, error_code, attempts)
       VALUES ($1,$2,'dose_reminder','push','en','generic','generic','{}'::jsonb,
               $3,now(),now(),'failed','provider_rejected',2)
       RETURNING id`,
      [patient.profileId, patient.userId, `admin-ops-${Date.now()}`],
    );
    const failedId = deliveryRows[0]!.id;

    const denied = await h.app.inject({
      method: 'GET', url: '/v1/admin/overview',
      headers: { authorization: `Bearer ${patient.token}` },
    });
    expect(denied.statusCode, 'a normal patient reached the admin read model').toBe(403);

    const overview = await h.app.inject({
      method: 'GET', url: '/v1/admin/overview',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(overview.statusCode, overview.body).toBe(200);
    const counts = overview.json<{ counts: Record<string, string | number> }>().counts;
    expect(Number(counts.users), 'the admin overview lost globally visible users to RLS').toBeGreaterThanOrEqual(2);
    expect(Number(counts.profiles), 'the admin overview lost globally visible profiles to RLS').toBeGreaterThanOrEqual(2);
    expect(Number(counts.active_medications), 'an active medication disappeared from the aggregate').toBeGreaterThanOrEqual(1);

    const failed = await h.app.inject({
      method: 'GET', url: '/v1/admin/deliveries/failed?channel=push&limit=20',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(failed.statusCode, failed.body).toBe(200);
    const body = failed.json<{ failures: Array<Record<string, unknown>>; count: number }>();
    expect(body.failures.map((row) => row.id), 'the failed delivery was hidden by recipient RLS').toContain(failedId);
    expect(Object.keys(body.failures.find((row) => row.id === failedId)!).sort()).toEqual([
      'attempts', 'channel', 'created_at', 'error_code', 'id', 'kind', 'provider', 'scheduled_for',
    ].sort());
    expect(JSON.stringify(body.failures)).not.toContain(patient.profileId);
    expect(JSON.stringify(body.failures)).not.toContain(patient.userId);

    const stats = await h.app.inject({
      method: 'GET', url: '/v1/admin/deliveries/stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stats.statusCode, stats.body).toBe(200);
    const statRows = stats.json<{ stats: Array<{ channel: string; status: string; count: number }> }>().stats;
    expect(statRows.some((row) => row.channel === 'push' && row.status === 'failed' && Number(row.count) >= 1),
      'delivery statistics lost the failed row to RLS').toBe(true);
  });

  it('keeps the raw clinical tables hidden and grants only the bounded definer shapes', async () => {
    const raw = await appRole.query<{ n: string }>('SELECT count(*) AS n FROM medications');
    expect(Number(raw.rows[0]!.n), 'dawaee_app gained global raw medication visibility').toBe(0);

    const overview = await appRole.query('SELECT * FROM app.admin_operational_overview()');
    expect(Object.keys(overview.rows[0]!).sort()).toEqual([
      'active_caregivers', 'active_medications', 'doses_24h', 'profiles', 'taken_24h', 'users',
    ].sort());

    const deliveries = await appRole.query(
      'SELECT * FROM app.admin_failed_deliveries(NULL::notification_channel, 10)',
    );
    for (const row of deliveries.rows) {
      expect(Object.keys(row).sort()).toEqual([
        'attempts', 'channel', 'created_at', 'error_code', 'id', 'kind', 'provider', 'scheduled_for',
      ].sort());
      expect(row).not.toHaveProperty('patient_profile_id');
      expect(row).not.toHaveProperty('recipient_user_id');
      expect(row).not.toHaveProperty('body');
      expect(row).not.toHaveProperty('payload');
    }

    const { rows: acl } = await owner.query<{
      proname: string; public_exec: boolean; app_exec: boolean; search_path: string;
    }>(
      `SELECT p.proname,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('dawaee_app', p.oid, 'EXECUTE') AS app_exec,
              array_to_string(p.proconfig, ',') AS search_path
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app'
          AND p.proname = ANY($1::text[])
        ORDER BY p.proname`,
      [['admin_delivery_stats', 'admin_failed_deliveries', 'admin_operational_overview']],
    );
    expect(acl).toHaveLength(3);
    expect(acl.every((row) => row.public_exec === false)).toBe(true);
    expect(acl.every((row) => row.app_exec === true)).toBe(true);
    expect(acl.every((row) => row.search_path.includes('search_path='))).toBe(true);
  });
});
