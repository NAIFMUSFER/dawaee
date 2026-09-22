import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let stranger: TestUser;
const day = new Date().toISOString().slice(0, 10);
let firstMedication = '';

beforeAll(async () => {
  resetDatabase(); h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500092751');
  stranger = await signIn(h, '+966500092752');
  for (const size of [1000, 2]) {
    const made = await h.app.inject({ method: 'POST', url: '/v1/medications', headers: authHeaders(patient), payload: {
      patientProfileId: patient.profileId, name: `History fixture ${size}`, form: 'tablet', startDate: day,
      schedule: { rule: { kind: 'fixed_times', times: ['23:59'] }, doseQuantity: 1, doseUnit: 'tablet', startDate: day },
    } });
    expect(made.statusCode, made.body).toBe(200);
    const medication = made.json().medication.id;
    if (!firstMedication) firstMedication = medication;
    const { rows: schedules } = await db.query('SELECT id FROM medication_schedules WHERE medication_id=$1', [medication]);
    await db.query(`INSERT INTO dose_occurrences
      (schedule_id, medication_id, patient_profile_id, scheduled_at, scheduled_local_date,
       scheduled_local_time, scheduled_timezone, dose_quantity, dose_unit, status, notified_at, snoozed_until)
      SELECT $1,$2,$3, instant, (instant AT TIME ZONE 'Asia/Riyadh')::date,
        (instant AT TIME ZONE 'Asia/Riyadh')::time,'Asia/Riyadh',1,'tablet',
        CASE WHEN n=0 THEN 'skipped'::dose_status ELSE 'upcoming'::dose_status END,
        CASE WHEN n=599 THEN instant ELSE NULL END,
        CASE WHEN n=601 THEN $4::date + interval '11 hours' ELSE NULL END
      FROM (SELECT n, $4::date + n * interval '1 minute' AS instant FROM generate_series(0,$5::int) n) seed`,
    [schedules[0].id, medication, patient.profileId, day, size]);
  }
  h.setServerNow(new Date(`${day}T10:00:00Z`));
}, 120_000);
afterAll(async () => { await db?.end(); await h?.close(); });

async function page(query = '', cursor?: string, user = patient) {
  return h.app.inject({ url: `/v1/doses?profileId=${patient.profileId}&from=${day}&to=${day}${query}`,
    headers: { ...authHeaders(user), ...(cursor ? { 'x-dawaee-history-cursor': cursor } : {}) } });
}

describe('history filters before limiting and exposes all bounded pages', () => {
  it('finds an old matching dose behind more than 500 newer nonmatching rows', async () => {
    const res = await page(`&medicationId=${firstMedication}&status=skipped&limit=1`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().doses).toHaveLength(1);
    expect(res.json().doses[0].status).toBe('skipped');
    expect(res.json().nextCursor).toBeNull();
  });

  it('matches the displayed derived status for each SQL filter', async () => {
    const all = (await page('&limit=2000')).json().doses as Array<{ id: string; status: string }>;
    expect(all.length).toBeGreaterThan(1000);
    for (const status of ['skipped', 'missed', 'due', 'pending_confirmation', 'snoozed', 'upcoming']) {
      const filtered = await page(`&limit=2000&status=${status}`);
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json().doses.map((d: { id: string }) => d.id))
        .toEqual(all.filter(d => d.status === status).map(d => d.id));
    }
  });

  it('pages beyond 1000 rows with no omissions or duplicate equal-time rows', async () => {
    const expected = (await page('&limit=2000')).json().doses.map((d: { id: string }) => d.id);
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const res = await page('&limit=37', cursor);
      expect(res.statusCode, res.body).toBe(200);
      ids.push(...res.json().doses.map((d: { id: string }) => d.id));
      cursor = res.json().nextCursor ?? undefined;
      expect(ids.length).toBeLessThanOrEqual(expected.length);
    } while (cursor);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects malformed or mismatched cursors and retains authorization on subsequent pages', async () => {
    expect((await page('', 'invalid')).statusCode).toBe(400);
    const cursor = (await page('&limit=1')).json().nextCursor;
    expect(cursor).toBeTruthy();
    expect((await page('&status=missed', cursor)).statusCode).toBe(400);
    const denied = await page('', cursor, stranger);
    // RLS hides the profile itself from an unrelated account.
    expect(denied.statusCode, denied.body).toBe(404);
    expect(denied.json()).not.toHaveProperty('doses');
    expect((await page('&status=not-a-status')).statusCode).toBe(400);
  });
});
