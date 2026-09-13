import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;
let relationshipId = '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500099941');
  caregiver = await signIn(h, '+966500099942');

  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, role, status, permissions,
        escalation_priority, invited_by_user_id, accepted_at)
     VALUES ($1,$2,'caregiver','active',$3,10,$4,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, ['view_history', 'view_medications'], patient.userId],
  );
  relationshipId = rows[0]!.id;
});

afterAll(async () => { await owner.end(); await h.close(); });

async function history() {
  return h.app.inject({
    method: 'GET',
    url: `/v1/doses?profileId=${patient.profileId}&from=2026-09-01&to=2026-09-07`,
    headers: authHeaders(caregiver),
  });
}

describe('P20 dose-history reads require the permissions of the joined schedule', () => {
  it('refuses history + medication visibility without view_schedule instead of an empty 200', async () => {
    const res = await history();
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('view_schedule');
  });

  it('works once the joined schedule can be read', async () => {
    await owner.query(
      'UPDATE caregiver_relationships SET permissions=$2 WHERE id=$1',
      [relationshipId, ['view_history', 'view_medications', 'view_schedule']],
    );
    const res = await history();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveProperty('doses');
  });
});
