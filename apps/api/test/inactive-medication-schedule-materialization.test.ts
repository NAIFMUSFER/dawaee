import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

const NOW = new Date();
const DATE = new Date(NOW.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
let h: Harness;
let patient: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  h.setNow(NOW);
  patient = await signIn(h, '+966500098741');
});

afterAll(async () => { await h?.close(); });

async function createMedication() {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, name: `Inactive schedule audit sentinel ${Date.now()}-${Math.random()}`,
      form: 'tablet', startDate: DATE, acknowledgeDuplicate: true,
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] }, doseQuantity: 1, doseUnit: 'tablet',
        timezone: 'UTC', startDate: DATE, endDate: DATE,
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ medication: { id: string }; scheduleId: string }>();
}

async function pause(medicationId: string) {
  const res = await h.app.inject({
    method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(patient),
    payload: { status: 'paused' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

describe('inactive medication schedule materialization', () => {
  it('does not create actionable doses when a schedule is added while paused', async () => {
    const med = await createMedication();
    await pause(med.medication.id);
    const created = await h.app.inject({
      method: 'POST', url: `/v1/medications/${med.medication.id}/schedules`, headers: authHeaders(patient),
      payload: {
        rule: { kind: 'fixed_times', times: ['09:00'] }, doseQuantity: 1, doseUnit: 'tablet',
        timezone: 'UTC', startDate: DATE, endDate: DATE,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json<{ dosesCreated: number }>().dosesCreated).toBe(0);
  });

  it('does not create actionable doses when a schedule is edited while paused', async () => {
    const med = await createMedication();
    await pause(med.medication.id);
    const patched = await h.app.inject({
      method: 'PATCH', url: `/v1/schedules/${med.scheduleId}`, headers: authHeaders(patient),
      payload: { rule: { kind: 'fixed_times', times: ['10:00'] }, confirmHighRiskChange: true },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<{ dosesCreated: number }>().dosesCreated).toBe(0);
  });

  it('serializes a pause racing with schedule rematerialization so no actionable dose survives', async () => {
    const med = await createMedication();
    const blocker = await h.worker.pool.connect();
    try {
      await blocker.query('BEGIN');
      // Queue both real API transactions behind the same medication lifecycle
      // lock. After release either one may win; the invariant must hold in both
      // orderings. This makes the race reproducible rather than timing-luck.
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))',
        [med.medication.id],
      );

      const pausePromise = pause(med.medication.id);
      const editPromise = h.app.inject({
        method: 'PATCH', url: `/v1/schedules/${med.scheduleId}`, headers: authHeaders(patient),
        payload: { rule: { kind: 'fixed_times', times: ['11:00'] }, confirmHighRiskChange: true },
      });

      // Give both handlers time to reach the lifecycle lock while it is held.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query('COMMIT');

      const [, edited] = await Promise.all([pausePromise, editPromise]);
      expect(edited.statusCode, edited.body).toBe(200);

      const { rows } = await h.worker.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM dose_occurrences
          WHERE medication_id = $1
            AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [med.medication.id],
      );
      expect(Number(rows[0]?.count ?? -1)).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  }, 30_000);
});
