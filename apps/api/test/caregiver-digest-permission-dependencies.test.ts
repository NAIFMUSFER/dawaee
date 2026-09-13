import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestJob } from '../../worker/src/jobs/digests.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;

const DATE = '2026-06-10';
const CREATION_TIME = new Date('2026-06-10T17:00:00.000Z'); // 20:00 Riyadh
const DIGEST_TIME = new Date('2026-06-10T21:05:00.000Z'); // 00:05 Riyadh, June 11

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });

  patient = await signIn(h, '+966500097811');
  caregiver = await signIn(h, '+966500097812');
  await db.query("UPDATE patient_profiles SET timezone='Asia/Riyadh' WHERE id=$1", [patient.profileId]);

  h.setNow(CREATION_TIME);
  const medication = await h.app.inject({
    method: 'POST',
    url: '/v1/medications',
    headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      name: 'Digest permission probe',
      form: 'tablet',
      strengthValue: 10,
      strengthUnit: 'mg',
      foodInstruction: 'no_preference',
      startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: ['23:30'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: DATE,
        lateAfterMinutes: 15,
        missedAfterMinutes: 30,
      },
    },
  });
  expect(medication.statusCode, medication.body).toBe(200);

  const fixture = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM dose_occurrences
      WHERE patient_profile_id=$1
        AND scheduled_local_date=$2`,
    [patient.profileId, DATE],
  );
  expect(fixture.rows[0]!.n, 'fixture did not materialize the previous-day dose').toBeGreaterThan(0);

  const relationship = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, role, status, permissions,
        escalation_priority, invited_by_user_id, accepted_at)
     VALUES ($1,$2,'caregiver','active',ARRAY['receive_notifications']::text[],1,$3,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, patient.userId],
  );

  await db.query(
    `INSERT INTO caregiver_notification_rules
       (relationship_id, patient_profile_id, channel, mode, summary_time, enabled)
     VALUES ($1,$2,'push','daily_summary','00:05',true)`,
    [relationship.rows[0]!.id, patient.profileId],
  );

  h.setWorkerNow(DIGEST_TIME);
}, 120_000);

afterAll(async () => {
  await db.end();
  await h.close();
});

describe('caregiver digest permission dependencies', () => {
  it('does not disclose adherence to a caregiver who only has notification delivery permission', async () => {
    const client = await h.worker.pool.connect();
    let processed = 0;
    try {
      await client.query('BEGIN');
      const result = await digestJob(h.worker, client);
      processed = result.itemsProcessed;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    expect(processed,
      'receive_notifications authorizes the delivery channel, not access to adherence data').toBe(0);

    const delivery = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM notification_deliveries
        WHERE patient_profile_id=$1 AND kind='daily_summary'`,
      [patient.profileId],
    );
    expect(delivery.rows[0]!.n).toBe(0);
  });
});
