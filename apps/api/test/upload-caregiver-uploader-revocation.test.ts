import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

const IMAGE_KEY = 'synthetic-caregiver-uploader-revocation/prescription.jpg';
let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;
let relationshipId = '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500096866');
  caregiver = await signIn(h, '+966500096867');

  const rel = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, status, permissions,
        invited_by_user_id, accepted_at)
     VALUES ($1,$2,'active',ARRAY['view_medications','add_medication']::text[],$3,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, patient.userId],
  );
  relationshipId = rel.rows[0]!.id;

  await db.query(
    `INSERT INTO stored_objects
       (object_key, owner_user_id, patient_profile_id, purpose,
        content_type, byte_size, uploaded_at, scan_status)
     VALUES ($1,$2,$3,'prescription_image','image/jpeg',128,now(),'clean')`,
    [IMAGE_KEY, caregiver.userId, patient.profileId],
  );

  await db.query(
    `UPDATE caregiver_relationships
        SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2
      WHERE id = $1`,
    [relationshipId, patient.userId],
  );
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (db) await db.end();
  if (h) await h.close();
});

describe('delegated medication-image uploads follow current care permissions', () => {
  it('does not issue a signed read URL after caregiver access is revoked', async () => {
    vi.spyOn(h.worker.providers.storage, 'createReadUrl')
      .mockResolvedValue('https://storage.invalid/signed-url-placeholder');

    const response = await h.app.inject({
      method: 'GET',
      url: '/v1/uploads/url',
      headers: {
        ...authHeaders(caregiver),
        'x-dawaee-object-key': IMAGE_KEY,
      },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.body).not.toContain('signed-url-placeholder');
    expect(h.worker.providers.storage.createReadUrl).not.toHaveBeenCalled();
  });
});
