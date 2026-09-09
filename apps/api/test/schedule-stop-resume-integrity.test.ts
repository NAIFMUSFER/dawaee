import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reminderJob } from '../../worker/src/jobs/reminders.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

// Synthetic API + real PostgreSQL lifecycle. No device, OCR, or live push calls.
// Keep occurrences ahead of the database clock too: DELETE currently uses now().
const NOW = new Date();
const DATE = new Date(NOW.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
let h: Harness;
let observer: pg.Pool;
let patient: TestUser;
let outsider: TestUser;
let serial = 0;
type Dose = { id: string; status: string; snoozedUntil: string | null; scheduledAt: string; scheduleId: string };

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  h.setNow(NOW);
  observer = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500098731');
  outsider = await signIn(h, '+966500098732');
});
afterAll(async () => { await observer?.end(); await h?.close(); });

async function medication() {
  h.setNow(NOW);
  const created = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, name: `Schedule lifecycle sentinel ${++serial}`,
      form: 'tablet', startDate: DATE,
      // Multiple synthetic medications in one isolated account are deliberate.
      acknowledgeDuplicate: true,
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] }, doseQuantity: 1, doseUnit: 'tablet',
        timezone: 'UTC', startDate: DATE, endDate: DATE,
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const body = created.json<{ medication: { id: string }; scheduleId: string; dosesCreated: number }>();
  expect(body.dosesCreated).toBe(1);
  return { medicationId: body.medication.id, scheduleId: body.scheduleId };
}

async function secondSchedule(medicationId: string) {
  const created = await h.app.inject({
    method: 'POST', url: `/v1/medications/${medicationId}/schedules`, headers: authHeaders(patient),
    payload: {
      rule: { kind: 'fixed_times', times: ['09:00'] }, doseQuantity: 1, doseUnit: 'tablet',
      timezone: 'UTC', startDate: DATE, endDate: DATE,
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json<{ dosesCreated: number }>().dosesCreated).toBe(1);
  return created.json<{ schedule: { id: string } }>().schedule.id;
}

async function doses(medicationId: string): Promise<Dose[]> {
  const res = await h.app.inject({
    method: 'GET', headers: authHeaders(patient),
    url: `/v1/doses?profileId=${patient.profileId}&medicationId=${medicationId}&from=${DATE}&to=${DATE}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ doses: Dose[] }>().doses;
}

async function detail(doseId: string): Promise<Dose> {
  const res = await h.app.inject({ method: 'GET', url: `/v1/doses/${doseId}`, headers: authHeaders(patient) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ dose: Dose }>().dose;
}

async function status(medicationId: string, value: 'active' | 'paused') {
  const res = await h.app.inject({
    method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(patient),
    payload: { status: value },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ futureDosesCancelled: number; futureDosesRevived: number }>();
}

async function stop(scheduleId: string) {
  const res = await h.app.inject({
    method: 'DELETE', url: `/v1/schedules/${scheduleId}`, headers: authHeaders(patient),
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json<{ deactivated: boolean }>().deactivated).toBe(true);
  return res;
}

async function runReminderTick() {
  const tx = await h.worker.pool.connect();
  try {
    await tx.query('BEGIN');
    await reminderJob(h.worker, tx);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}

async function deliveriesFor(doseId: string): Promise<number> {
  const res = await observer.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification_deliveries
      WHERE dose_occurrence_id = $1::uuid OR COALESCE(payload->'doseIds', '[]'::jsonb) ? $1::text`, [doseId],
  );
  return Number(res.rows[0]!.n);
}

describe('schedule deletion remains authoritative across medication resume', () => {
  it('positive control: active-schedule doses revive exactly once after pause', async () => {
    const med = await medication();
    const before = await doses(med.medicationId);
    expect(before).toHaveLength(1);
    expect((await status(med.medicationId, 'paused')).futureDosesCancelled).toBe(1);
    expect((await detail(before[0]!.id)).status).toBe('cancelled');
    expect((await status(med.medicationId, 'active')).futureDosesRevived).toBe(1);
    expect((await doses(med.medicationId))[0]).toMatchObject({ id: before[0]!.id, status: 'upcoming' });
    expect((await status(med.medicationId, 'active')).futureDosesRevived).toBe(0);
    expect(await doses(med.medicationId)).toHaveLength(1);
  });

  it('does not revive a deleted schedule while restoring another active schedule of the same medication', async () => {
    const med = await medication();
    const activeSchedule = await secondSchedule(med.medicationId);
    const stopped = (await doses(med.medicationId)).find(d => d.scheduleId === med.scheduleId)!;
    await stop(med.scheduleId);
    expect((await detail(stopped.id)).status).toBe('cancelled');
    await status(med.medicationId, 'paused');
    const resumed = await status(med.medicationId, 'active');
    const after = await doses(med.medicationId);
    expect((await detail(stopped.id)).status).toBe('cancelled');
    expect(after.some(d => d.id === stopped.id)).toBe(false);
    expect(after.find(d => d.scheduleId === activeSchedule)?.status).toBe('upcoming');
    expect(resumed.futureDosesRevived).toBe(1);
    const row = await observer.query<{ active: boolean }>('SELECT active FROM medication_schedules WHERE id=$1', [med.scheduleId]);
    expect(row.rows[0]!.active).toBe(false);
  });

  it('does not enqueue a stopped-schedule reminder after pause/resume, while an active schedule still enqueues', async () => {
    const med = await medication();
    const activeSchedule = await secondSchedule(med.medicationId);
    const before = await doses(med.medicationId);
    const stopped = before.find(d => d.scheduleId === med.scheduleId)!;
    const active = before.find(d => d.scheduleId === activeSchedule)!;
    await stop(med.scheduleId);
    await status(med.medicationId, 'paused');
    await status(med.medicationId, 'active');
    // Probe the deleted dose at its own first patient-reminder stage. Testing
    // only an hour later can pass because the selected caregiver stage has no
    // recipient, not because the deleted schedule was respected.
    h.setWorkerNow(new Date(`${DATE}T08:00:00.000Z`));
    await runReminderTick();
    const stoppedAtDue = await deliveriesFor(stopped.id);
    h.setWorkerNow(new Date(`${DATE}T09:00:00.000Z`));
    await runReminderTick();
    expect(await deliveriesFor(active.id)).toBeGreaterThan(0);
    expect(stoppedAtDue).toBe(0);
    expect(await deliveriesFor(stopped.id)).toBe(0);
  });

  it('DELETE clears snooze metadata while retaining the original dose, event history and stock', async () => {
    const med = await medication();
    const dose = (await doses(med.medicationId))[0]!;
    h.setServerNow(new Date(new Date(dose.scheduledAt).getTime() - 5 * 60_000));
    const snooze = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/snooze`, headers: authHeaders(patient),
      payload: { minutes: 15, clientEventId: `schedule-delete-snooze-${serial}` },
    });
    expect(snooze.statusCode, snooze.body).toBe(200);
    expect((await doses(med.medicationId))[0]!.snoozedUntil).not.toBeNull();
    const beforeEvents = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM dose_events WHERE dose_occurrence_id=$1', [dose.id]);
    expect(Number(beforeEvents.rows[0]!.n)).toBeGreaterThan(0);
    await stop(med.scheduleId);
    const after = await detail(dose.id);
    expect(after).toMatchObject({ id: dose.id, status: 'cancelled', snoozedUntil: null });
    const afterEvents = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM dose_events WHERE dose_occurrence_id=$1', [dose.id]);
    expect(afterEvents.rows[0]!.n).toBe(beforeEvents.rows[0]!.n);
    const stock = await observer.query<{ remaining: string }>('SELECT remaining_quantity::text AS remaining FROM medication_stock WHERE medication_id=$1', [med.medicationId]);
    expect(Number(stock.rows[0]!.remaining)).toBe(30);
  });

  it('retains an already-taken dose and its stock ledger through schedule deletion and medication resume', async () => {
    const med = await medication();
    const dose = (await doses(med.medicationId))[0]!;
    h.setServerNow(new Date(new Date(dose.scheduledAt).getTime() - 5 * 60_000));
    const taken = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/taken`, headers: authHeaders(patient),
      payload: { method: 'app', clientEventId: `schedule-delete-taken-${serial}` },
    });
    expect(taken.statusCode, taken.body).toBe(200);
    await stop(med.scheduleId);
    await status(med.medicationId, 'paused');
    expect((await status(med.medicationId, 'active')).futureDosesRevived).toBe(0);
    expect((await doses(med.medicationId))[0]).toMatchObject({ id: dose.id, status: 'taken' });
    const stock = await observer.query<{ remaining: string; debits: string }>(
      `SELECT st.remaining_quantity::text AS remaining,
              (SELECT count(*)::text FROM stock_transactions tx WHERE tx.medication_id=st.medication_id AND tx.delta<0) AS debits
         FROM medication_stock st WHERE st.medication_id=$1`, [med.medicationId],
    );
    expect(Number(stock.rows[0]!.remaining)).toBe(29);
    expect(Number(stock.rows[0]!.debits)).toBe(1);
  });

  it('denies a different account schedule deletion without changing its activity or dose', async () => {
    const med = await medication();
    const res = await h.app.inject({
      method: 'DELETE', url: `/v1/schedules/${med.scheduleId}`, headers: authHeaders(outsider),
    });
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(patient.profileId);
    expect((await doses(med.medicationId))[0]!.status).toBe('upcoming');
    const row = await observer.query<{ active: boolean }>('SELECT active FROM medication_schedules WHERE id=$1', [med.scheduleId]);
    expect(row.rows[0]!.active).toBe(true);
  });
});
