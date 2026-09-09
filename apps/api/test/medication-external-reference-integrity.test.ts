import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  alice = await signIn(h, '+966500099911');
  bob = await signIn(h, '+966500099912');
});

afterAll(async () => { await owner.end(); await h.close(); });

async function createMedication(user: TestUser, extra: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: `Reference Guard ${Math.random().toString(36).slice(2)}`,
      form: 'tablet', startDate: '2026-09-01',
      ...extra,
    },
  });
}

async function uploadKey(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/uploads/request', headers: authHeaders(user),
    payload: {
      purpose: 'medication_image', contentType: 'image/png', byteSize: 128,
      patientProfileId: user.profileId,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ objectKey: string }>().objectKey;
}

describe('P20 medication external references stay inside one patient profile', () => {
  it('refuses a prescription id belonging to another patient', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO prescriptions (patient_profile_id, reference, created_by)
       VALUES ($1, 'foreign-rx', $2) RETURNING id`,
      [bob.profileId, bob.userId],
    );

    const res = await createMedication(alice, { prescriptionId: rows[0]!.id });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).not.toContain(bob.profileId);
  });

  it('refuses an image key belonging to another patient', async () => {
    const bobImage = await uploadKey(bob);
    const res = await createMedication(alice, { imageKey: bobImage });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).not.toContain(bobImage);
  });

  it('still accepts a medication image owned by the same profile', async () => {
    const ownImage = await uploadKey(alice);
    const res = await createMedication(alice, { imageKey: ownImage });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ medication: { imageKey: string } }>().medication.imageKey).toBe(ownImage);
  });

  it('the guard is structural: direct cross-profile SQL is rejected too', async () => {
    const { rows: rx } = await owner.query<{ id: string }>(
      `INSERT INTO prescriptions (patient_profile_id, reference, created_by)
       VALUES ($1, 'direct-foreign-rx', $2) RETURNING id`,
      [bob.profileId, bob.userId],
    );

    await expect(owner.query(
      `INSERT INTO medications
         (patient_profile_id, name, form, start_date, prescription_id, created_by)
       VALUES ($1, 'Direct Cross Profile', 'tablet', '2026-09-01', $2, $3)`,
      [alice.profileId, rx[0]!.id, alice.userId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'medication_prescription_profile_match' });
  });
});
