import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../../worker/src/context.js';
import { materializeJob } from '../../worker/src/jobs/materialize.js';
import { MATERIALIZE_HORIZON_DAYS } from '../src/services/materializer.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;
const DAY = 86_400_000;
const BASE = new Date('2026-06-10T05:00:00.000Z');
const fixtures: Array<{ profileId: string; medicationId: string; scheduleId: string }> = [];
const INSERT_COLUMNS = [
  'schedule_id', 'medication_id', 'patient_profile_id', 'scheduled_at',
  'scheduled_local_date', 'scheduled_local_time', 'scheduled_timezone',
  'dose_quantity', 'dose_unit', 'status',
] as const;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  h.setNow(BASE);
  for (const phone of ['+966500097792', '+966500097793']) {
    const user = await signIn(h, phone);
    const res = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId, name: 'SYNTHETIC-WORKER-HORIZON', form: 'tablet',
        strengthValue: 10, strengthUnit: 'mg', foodInstruction: 'no_preference',
        startDate: '2026-06-10',
        schedule: {
          rule: { kind: 'fixed_times', times: ['09:00'] },
          doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-06-10',
          lateAfterMinutes: 15, missedAfterMinutes: 60,
        },
        stock: { trackingEnabled: true, initialQuantity: 60, unit: 'tablet' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const medicationId = res.json<{ medication: { id: string } }>().medication.id;
    const { rows } = await owner.query<{ id: string; materialized_through: Date }>(
      'SELECT id, materialized_through FROM medication_schedules WHERE medication_id = $1', [medicationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.materialized_through.toISOString()).toBe(new Date(BASE.getTime() + MATERIALIZE_HORIZON_DAYS * DAY).toISOString());
    fixtures.push({ profileId: user.profileId, medicationId, scheduleId: rows[0]!.id });
  }
  h.setWorkerNow(new Date(BASE.getTime() + 4 * DAY));
}, 120_000);

afterAll(async () => {
  if (owner) await owner.end();
  if (h) await h.close();
});

async function snapshot() {
  const { rows } = await owner.query<{
    id: string; schedule_id: string; medication_id: string; patient_profile_id: string; scheduled_at: Date;
  }>(
    `SELECT id, schedule_id, medication_id, patient_profile_id, scheduled_at
       FROM dose_occurrences WHERE schedule_id = ANY($1::uuid[])
      ORDER BY schedule_id, scheduled_at`, [fixtures.map((f) => f.scheduleId)],
  );
  return rows;
}

const topUp = () => runJob(h.worker, 'materialize', (client) => materializeJob(h.worker, client));

/** Recreates one historical missing grant ONLY inside the disposable test DB.
 * Nothing is committed, including successful inserts before a later failure.
 * The positive scenario below connects through the actual worker pool instead
 * of using this administrator connection or SET ROLE as its success proof. */
async function assertMissingPrivilege(table: 'dose_occurrences' | 'medication_schedules') {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE medication_schedules SET materialized_through = NULL WHERE id = ANY($1::uuid[])', [fixtures.map((f) => f.scheduleId)]);
    if (table === 'dose_occurrences') {
      await client.query('REVOKE INSERT ON public.dose_occurrences FROM dawaee_worker');
      await client.query(`REVOKE INSERT (${INSERT_COLUMNS.join(', ')}) ON public.dose_occurrences FROM dawaee_worker`);
    } else {
      // Permit inserts so this control independently reaches the horizon write.
      await client.query(`GRANT INSERT (${INSERT_COLUMNS.join(', ')}) ON public.dose_occurrences TO dawaee_worker`);
      await client.query('REVOKE UPDATE ON public.medication_schedules FROM dawaee_worker');
      await client.query('REVOKE UPDATE (materialized_through) ON public.medication_schedules FROM dawaee_worker');
    }
    await client.query('SET LOCAL ROLE dawaee_worker');
    await expect(materializeJob(h.worker, client)).rejects.toMatchObject({
      code: '42501', message: `permission denied for table ${table}`,
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('worker materialization uses the minimum runtime privileges', () => {
  it('runs the positive scenario as the real non-superuser worker login', async () => {
    const { rows } = await h.worker.pool.query(
      'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([{ role: 'dawaee_worker', rolsuper: false, rolbypassrls: false }]);
  });

  it('negative control: missing occurrence INSERT reproduces the production permission error', async () => {
    await assertMissingPrivilege('dose_occurrences');
  });

  it('negative control: missing horizon UPDATE independently aborts the same job', async () => {
    await assertMissingPrivilege('medication_schedules');
  });

  it('tops up both profiles, then survives same-clock replay and concurrent top-up without duplicates', async () => {
    const before = await snapshot();
    for (const f of fixtures) expect(before.some((row) => row.schedule_id === f.scheduleId)).toBe(true);

    const first = await topUp();
    const firstRun = await owner.query<{ succeeded: boolean; error_message: string | null }>(
      "SELECT succeeded, error_message FROM job_runs WHERE job_name = 'materialize' ORDER BY started_at DESC LIMIT 1",
    );
    expect(firstRun.rows[0], JSON.stringify(firstRun.rows)).toMatchObject({ succeeded: true, error_message: null });
    expect(first.ran).toBe(true);
    expect(first.itemsProcessed).toBeGreaterThan(0);
    const after = await snapshot();
    expect(after.length - before.length).toBe(first.itemsProcessed);
    for (const f of fixtures) {
      expect(after.filter((row) => row.schedule_id === f.scheduleId).length)
        .toBeGreaterThan(before.filter((row) => row.schedule_id === f.scheduleId).length);
    }

    const replay = await topUp();
    expect(replay.itemsProcessed).toBe(0);
    expect(await snapshot()).toEqual(after);

    const concurrentNow = new Date(BASE.getTime() + 8 * DAY);
    h.setWorkerNow(concurrentNow);
    const concurrent = await Promise.all([topUp(), topUp()]);
    expect(concurrent.some((result) => result.ran)).toBe(true);
    const last = await snapshot();
    const inserted = concurrent.reduce((sum, result) => sum + result.itemsProcessed, 0);
    expect(inserted).toBeGreaterThan(0);
    expect(last.length - after.length).toBe(inserted);
    expect(new Set(last.map((row) => `${row.schedule_id}:${row.scheduled_at.toISOString()}`)).size).toBe(last.length);
    for (const row of last) {
      const fixture = fixtures.find((f) => f.scheduleId === row.schedule_id)!;
      expect(row.patient_profile_id).toBe(fixture.profileId);
      expect(row.medication_id).toBe(fixture.medicationId);
    }
    const horizons = await owner.query<{ materialized_through: Date }>(
      'SELECT materialized_through FROM medication_schedules WHERE id = ANY($1::uuid[])', [fixtures.map((f) => f.scheduleId)],
    );
    expect(horizons.rows).toHaveLength(fixtures.length);
    for (const row of horizons.rows) {
      expect(row.materialized_through.toISOString()).toBe(new Date(concurrentNow.getTime() + MATERIALIZE_HORIZON_DAYS * DAY).toISOString());
    }
    const failed = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM job_runs WHERE job_name = 'materialize' AND NOT succeeded",
    );
    expect(failed.rows[0]!.count).toBe(0);
  });

  it('grants only the materializer insert columns and the horizon update column', async () => {
    const columns = await h.worker.pool.query<{ column_name: string; allowed: boolean }>(
      `SELECT column_name, has_column_privilege(current_user, 'public.dose_occurrences', column_name, 'INSERT') AS allowed
         FROM unnest($1::text[]) AS column_name`, [INSERT_COLUMNS],
    );
    expect(columns.rows).toHaveLength(INSERT_COLUMNS.length);
    for (const row of columns.rows) expect(row.allowed, row.column_name).toBe(true);
    const boundary = await h.worker.pool.query(
      `SELECT
         has_table_privilege(current_user, 'public.dose_occurrences', 'INSERT') AS broad_insert,
         has_column_privilege(current_user, 'public.dose_occurrences', 'confirmed_at', 'INSERT') AS insert_confirmation,
         has_table_privilege(current_user, 'public.medication_schedules', 'UPDATE') AS broad_schedule_update,
         has_column_privilege(current_user, 'public.medication_schedules', 'materialized_through', 'UPDATE') AS horizon_update,
         has_column_privilege(current_user, 'public.medication_schedules', 'rule', 'UPDATE') AS rule_update,
         has_column_privilege(current_user, 'public.medication_schedules', 'dose_quantity', 'UPDATE') AS quantity_update`,
    );
    expect(boundary.rows).toEqual([{
      broad_insert: false, insert_confirmation: false, broad_schedule_update: false,
      horizon_update: true, rule_update: false, quantity_update: false,
    }]);
  });

  it('still refuses clinical schedule edits through the worker connection', async () => {
    await expect(h.worker.pool.query(
      'UPDATE medication_schedules SET dose_quantity = dose_quantity WHERE id = $1', [fixtures[0]!.scheduleId],
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('does not expand worker access to unrelated private records', async () => {
    const { rows } = await h.worker.pool.query<{ table_name: string; allowed: boolean }>(
      `SELECT table_name, has_table_privilege(current_user, table_name, 'SELECT') AS allowed
         FROM unnest($1::text[]) AS table_name`,
      [['public.emergency_cards', 'public.prescriptions', 'public.consents', 'public.symptom_notes',
        'public.health_measurements', 'public.auth_sessions', 'public.audit_logs']],
    );
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.allowed, row.table_name).toBe(false);
  });
});
