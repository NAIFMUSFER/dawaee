import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import { housekeepingJob } from '../../worker/src/jobs/housekeeping.js';
import { runJob } from '../../worker/src/context.js';

const PATIENT_OBJECT_KEY = 'synthetic-account-erasure/caregiver-owned-patient-image.jpg';
const SURVIVING_OBJECT_KEY = 'synthetic-account-erasure/departing-uploader-surviving-patient-image.jpg';

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

  // Both directions are reachable delegated-upload states. Object ownership for
  // erasure follows the patient profile, while owner_user_id remains uploader
  // attribution only.
  await db.query(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, status, permissions,
        invited_by_user_id, accepted_at)
     VALUES
       ($1,$2,'active',ARRAY['view_medications','add_medication']::text[],$3,now()),
       ($4,$3,'active',ARRAY['view_medications','add_medication']::text[],$2,now())`,
    [patient.profileId, caregiver.userId, patient.userId, caregiver.profileId],
  );

  // The first object belongs to the departing patient's medical record even
  // though the caregiver uploaded it. The second was uploaded by the departing
  // user into somebody else's surviving profile and must NOT be physically
  // deleted when the uploader leaves.
  await db.query(
    `INSERT INTO stored_objects
       (object_key, owner_user_id, patient_profile_id, purpose,
        content_type, byte_size, uploaded_at, scan_status)
     VALUES
       ($1,$2,$3,'prescription_image','image/jpeg',128,now(),'clean'),
       ($4,$5,$6,'prescription_image','image/jpeg',128,now(),'clean')`,
    [
      PATIENT_OBJECT_KEY, caregiver.userId, patient.profileId,
      SURVIVING_OBJECT_KEY, patient.userId, caregiver.profileId,
    ],
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

describe('account erasure follows patient-profile ownership, not uploader attribution', () => {
  it('deletes every object in the departing patient profile without deleting another patient record', async () => {
    const enumerated = await h.worker.pool.query<{ object_key: string }>(
      'SELECT object_key FROM app.list_due_account_object_keys($1, 14)',
      [patient.userId],
    );
    const keys = enumerated.rows.map((row) => row.object_key);
    expect(keys).toContain(PATIENT_OBJECT_KEY);
    expect(keys).not.toContain(SURVIVING_OBJECT_KEY);

    const deleteObject = vi.spyOn(h.worker.providers.storage, 'deleteObject').mockResolvedValue(undefined);
    const result = await runJob(h.worker, 'caregiver-upload-erasure-regression', (client) =>
      housekeepingJob(h.worker, client));
    expect(result.ran).toBe(true);
    const failures = (result as typeof result & { failures?: Array<{ step: string; error: string }> }).failures ?? [];
    expect(failures, `housekeeping failed before erasure: ${JSON.stringify(failures)}`).toEqual([]);
    expect(deleteObject).toHaveBeenCalledWith(PATIENT_OBJECT_KEY);
    expect(deleteObject).not.toHaveBeenCalledWith(SURVIVING_OBJECT_KEY);

    const erased = await db.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [patient.userId]);
    expect(erased.rows).toHaveLength(0);

    const surviving = await db.query<{ patient_profile_id: string; owner_user_id: string | null }>(
      'SELECT patient_profile_id, owner_user_id FROM stored_objects WHERE object_key = $1',
      [SURVIVING_OBJECT_KEY],
    );
    expect(surviving.rows).toEqual([{ patient_profile_id: caregiver.profileId, owner_user_id: null }]);
  });
});
