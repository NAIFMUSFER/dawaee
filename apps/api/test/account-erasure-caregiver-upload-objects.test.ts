import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import { housekeepingJob } from '../../worker/src/jobs/housekeeping.js';
import { runJob } from '../../worker/src/context.js';

const OBJECT_KEY = 'synthetic-account-erasure/caregiver-owned-patient-image.jpg';

let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500096890');
  caregiver = await signIn(h, '+966500096891');

  // This is a reachable state: Dawaee permits a caregiver with medication
  // permissions to upload an image into the patient's profile, while the
  // stored object keeps the caregiver as uploader/owner attribution. Erasing
  // the PATIENT must remove those bytes too; uploader identity must not decide
  // which patient's medical object survives erasure.
  await db.query(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, status, permissions,
        invited_by_user_id, accepted_at)
     VALUES ($1,$2,'active',ARRAY['view_medications','add_medication']::text[],$3,now())`,
    [patient.profileId, caregiver.userId, patient.userId],
  );

  await db.query(
    `INSERT INTO stored_objects
       (object_key, owner_user_id, patient_profile_id, purpose,
        content_type, byte_size, uploaded_at, scan_status)
     VALUES ($1,$2,$3,'prescription_image','image/jpeg',128,now(),'clean')`,
    [OBJECT_KEY, caregiver.userId, patient.profileId],
  );

  const requested = await h.app.inject({
    method: 'POST', url: '/v1/me/deletion-request', headers: authHeaders(patient),
    payload: { confirm: true },
  });
  expect(requested.statusCode, requested.body).toBe(200);

  // Age only the durable request marker because production erasure deliberately
  // uses database time for the grace-period decision.
  await db.query(
    `UPDATE users SET deletion_requested_at = now() - interval '15 days' WHERE id = $1`,
    [patient.userId],
  );
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (db) await db.end();
  if (h) await h.close();
});

describe('account erasure owns patient-profile objects regardless of uploader', () => {
  it('enumerates and physically deletes a caregiver-uploaded object attached to the departing patient', async () => {
    const enumerated = await h.worker.pool.query<{ object_key: string }>(
      'SELECT object_key FROM app.list_due_account_object_keys($1, 14)',
      [patient.userId],
    );
    expect(enumerated.rows.map((row) => row.object_key)).toContain(OBJECT_KEY);

    const deleteObject = vi.spyOn(h.worker.providers.storage, 'deleteObject').mockResolvedValue(undefined);
    const result = await runJob(h.worker, 'caregiver-upload-erasure-regression', (client) =>
      housekeepingJob(h.worker, client));
    expect(result.ran).toBe(true);
    const failures = (result as typeof result & { failures?: Array<{ step: string; error: string }> }).failures ?? [];
    expect(failures, `housekeeping failed before erasure: ${JSON.stringify(failures)}`).toEqual([]);
    expect(deleteObject).toHaveBeenCalledWith(OBJECT_KEY);

    const erased = await db.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [patient.userId]);
    expect(erased.rows).toHaveLength(0);
  });
});
