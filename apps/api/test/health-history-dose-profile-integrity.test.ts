import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, PANADOL, resetDatabase, signIn, startHarness,
  type Harness, type TestUser,
} from './harness.js';

let h: Harness;
let owner: pg.Pool;
let alice: TestUser;
let bob: TestUser;
let aliceDoseId: string;
let bobDoseId: string;

async function seedDose(user: TestUser): Promise<string> {
  const created = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      ...PANADOL,
      name: `Dose reference guard ${Math.random().toString(36).slice(2)}`,
      startDate: '2026-09-01',
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);

  const doses = await h.app.inject({
    method: 'GET',
    url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2026-09-30`,
    headers: authHeaders(user),
  });
  expect(doses.statusCode, doses.body).toBe(200);
  const doseId = doses.json<{ doses: Array<{ id: string }> }>().doses[0]?.id;
  expect(doseId).toBeTruthy();
  return doseId!;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  alice = await signIn(h, '+966500096871');
  bob = await signIn(h, '+966500096872');
  aliceDoseId = await seedDose(alice);
  bobDoseId = await seedDose(bob);
});

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('health-history dose references stay inside one patient profile', () => {
  it('rejects a symptom note linked to another patient dose at the database boundary', async () => {
    await expect(owner.query(
      `INSERT INTO symptom_notes
         (patient_profile_id, dose_occurrence_id, text, created_by)
       VALUES ($1, $2, 'cross-profile note', $3)`,
      [alice.profileId, bobDoseId, alice.userId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'symptom_note_dose_profile_match' });
  });

  it('rejects a health measurement linked to another patient dose at the database boundary', async () => {
    await expect(owner.query(
      `INSERT INTO health_measurements
         (patient_profile_id, dose_occurrence_id, type, value_primary, unit, created_by)
       VALUES ($1, $2, 'weight', 70, 'kg', $3)`,
      [alice.profileId, bobDoseId, alice.userId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'measurement_dose_profile_match' });
  });

  it('still accepts same-profile dose references and null references', async () => {
    const note = await owner.query<{ id: string }>(
      `INSERT INTO symptom_notes
         (patient_profile_id, dose_occurrence_id, text, created_by)
       VALUES ($1, $2, 'same-profile note', $3) RETURNING id`,
      [alice.profileId, aliceDoseId, alice.userId],
    );
    expect(note.rowCount).toBe(1);

    const measurement = await owner.query<{ id: string }>(
      `INSERT INTO health_measurements
         (patient_profile_id, dose_occurrence_id, type, value_primary, unit, created_by)
       VALUES ($1, NULL, 'weight', 70, 'kg', $2) RETURNING id`,
      [alice.profileId, alice.userId],
    );
    expect(measurement.rowCount).toBe(1);
  });
});
