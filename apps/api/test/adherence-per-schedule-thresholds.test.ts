import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let db: pg.Pool;
let patient: TestUser;

const DATE = '2026-06-10';
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 5, 10, hh - 3, mm, 0)); // Riyadh = UTC+3
};

async function createMedication(name: string, missedAfterMinutes: number) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/medications',
    headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      name,
      form: 'tablet',
      strengthValue: 10,
      strengthUnit: 'mg',
      foodInstruction: 'no_preference',
      startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: ['09:00'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: DATE,
        lateAfterMinutes: 15,
        missedAfterMinutes,
      },
    },
  });
  expect(res.statusCode, `${name}: ${res.body}`).toBe(200);
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500099932');

  h.setNow(at('08:00'));
  await createMedication('Short window', 30);
  await createMedication('Long window', 240);

  // Creation currently materializes the initial window; assert the fixture so
  // this test cannot accidentally pass/fail because it has no occurrences.
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM dose_occurrences
      WHERE patient_profile_id=$1 AND scheduled_local_date=$2`,
    [patient.profileId, DATE],
  );
  expect(Number(rows[0]!.n), 'fixture did not materialize both doses').toBe(2);

  // At 10:00 the 09:00 dose with a 30-minute missed threshold is missed, while
  // the otherwise identical dose with a 240-minute threshold is still pending.
  h.setNow(at('10:00'));
}, 120_000);

afterAll(async () => {
  await db.end();
  await h.close();
});

function expectOneMissedOnePending(body: { summary: { missed: number; pending: number; scheduled: number } }) {
  expect(body.summary.scheduled).toBe(2);
  expect(body.summary.missed,
    'one schedule threshold was incorrectly applied to both medications').toBe(1);
  expect(body.summary.pending,
    'the long-window dose was not left pending under its own schedule threshold').toBe(1);
}

describe('adherence uses each occurrence schedule thresholds', () => {
  it('family report does not classify every dose using the first row thresholds', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/reports/adherence?profileId=${patient.profileId}&from=${DATE}&to=${DATE}`,
      headers: authHeaders(patient),
    });
    expect(res.statusCode, res.body).toBe(200);
    expectOneMissedOnePending(res.json());
  });

  it('adherence analytics does not classify every dose using an arbitrary row thresholds', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/adherence?profileId=${patient.profileId}&from=${DATE}&to=${DATE}`,
      headers: authHeaders(patient),
    });
    expect(res.statusCode, res.body).toBe(200);
    expectOneMissedOnePending(res.json());
  });
});
