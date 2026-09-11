import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../../worker/src/context.js';
import { materializeJob } from '../../worker/src/jobs/materialize.js';
import { MATERIALIZE_HORIZON_DAYS } from '../src/services/materializer.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let scheduleId: string;
let initialCount = 0;
const DAY = 86_400_000;
const BASE = new Date('2026-06-10T05:00:00.000Z');
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

  const user = await signIn(h, '+966500097794');
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/medications',
    headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: 'SYNTHETIC-WORKER-HOTFIX',
      form: 'tablet',
      strengthValue: 10,
      strengthUnit: 'mg',
      foodInstruction: 'no_preference',
      startDate: '2026-06-10',
      schedule: {
        rule: { kind: 'fixed_times', times: ['09:00'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: '2026-06-10',
        lateAfterMinutes: 15,
        missedAfterMinutes: 60,
      },
      stock: { trackingEnabled: true, initialQuantity: 60, unit: 'tablet' },
    },
  });
  expect(res.statusCode, res.body).toBe(200);

  const medicationId = res.json<{ medication: { id: string } }>().medication.id;
  const schedule = await owner.query<{ id: string; materialized_through: Date }>(
    'SELECT id, materialized_through FROM medication_schedules WHERE medication_id = $1',
    [medicationId],
  );
  expect(schedule.rows).toHaveLength(1);
  scheduleId = schedule.rows[0]!.id;
  expect(schedule.rows[0]!.materialized_through.toISOString()).toBe(
    new Date(BASE.getTime() + MATERIALIZE_HORIZON_DAYS * DAY).toISOString(),
  );

  const count = await owner.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM dose_occurrences WHERE schedule_id = $1',
    [scheduleId],
  );
  initialCount = count.rows[0]!.count;
  expect(initialCount).toBeGreaterThan(0);

  h.setWorkerNow(new Date(BASE.getTime() + 4 * DAY));
}, 120_000);

afterAll(async () => {
  if (owner) await owner.end();
  if (h) await h.close();
});

describe('worker materialization production hotfix', () => {
  it('uses the real least-privilege worker role', async () => {
    const { rows } = await h.worker.pool.query(
      'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([{ role: 'dawaee_worker', rolsuper: false, rolbypassrls: false }]);
  });

  it('reproduces SQLSTATE 42501 when occurrence INSERT is removed', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE medication_schedules SET materialized_through = NULL WHERE id = $1', [scheduleId]);
      await client.query('REVOKE INSERT ON public.dose_occurrences FROM dawaee_worker');
      await client.query(`REVOKE INSERT (${INSERT_COLUMNS.join(', ')}) ON public.dose_occurrences FROM dawaee_worker`);
      await client.query('SET LOCAL ROLE dawaee_worker');
      await expect(materializeJob(h.worker, client)).rejects.toMatchObject({
        code: '42501',
        message: 'permission denied for table dose_occurrences',
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('grants only the columns required by rolling-horizon materialization', async () => {
    const columns = await h.worker.pool.query<{ column_name: string; allowed: boolean }>(
      `SELECT column_name,
              has_column_privilege(current_user, 'public.dose_occurrences', column_name, 'INSERT') AS allowed
         FROM unnest($1::text[]) AS column_name`,
      [INSERT_COLUMNS],
    );
    expect(columns.rows).toHaveLength(INSERT_COLUMNS.length);
    for (const row of columns.rows) expect(row.allowed, row.column_name).toBe(true);

    const boundary = await h.worker.pool.query(
      `SELECT
         has_table_privilege(current_user, 'public.dose_occurrences', 'INSERT') AS broad_insert,
         has_column_privilege(current_user, 'public.dose_occurrences', 'confirmed_at', 'INSERT') AS insert_confirmation,
         has_table_privilege(current_user, 'public.medication_schedules', 'UPDATE') AS broad_schedule_update,
         has_column_privilege(current_user, 'public.medication_schedules', 'materialized_through', 'UPDATE') AS horizon_update,
         has_column_privilege(current_user, 'public.medication_schedules', 'rule', 'UPDATE') AS rule_update`,
    );
    expect(boundary.rows).toEqual([{
      broad_insert: false,
      insert_confirmation: false,
      broad_schedule_update: false,
      horizon_update: true,
      rule_update: false,
    }]);
  });

  it('extends the dose horizon successfully and idempotently', async () => {
    const first = await runJob(h.worker, 'materialize', (client) => materializeJob(h.worker, client));
    expect(first.ran).toBe(true);
    expect(first.itemsProcessed).toBeGreaterThan(0);

    const count = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM dose_occurrences WHERE schedule_id = $1',
      [scheduleId],
    );
    expect(count.rows[0]!.count).toBe(initialCount + first.itemsProcessed);

    const schedule = await owner.query<{ materialized_through: Date }>(
      'SELECT materialized_through FROM medication_schedules WHERE id = $1',
      [scheduleId],
    );
    expect(schedule.rows[0]!.materialized_through.toISOString()).toBe(
      new Date(BASE.getTime() + 4 * DAY + MATERIALIZE_HORIZON_DAYS * DAY).toISOString(),
    );

    const replay = await runJob(h.worker, 'materialize', (client) => materializeJob(h.worker, client));
    expect(replay.ran).toBe(true);
    expect(replay.itemsProcessed).toBe(0);

    const failures = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM job_runs WHERE job_name = 'materialize' AND NOT succeeded",
    );
    expect(failures.rows[0]!.count).toBe(0);
  });
});
