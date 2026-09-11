import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

const IMAGE_KEY = 'synthetic-read-url-revocation/prescription.jpg';
let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;
let relationshipId = '';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500096864');
  caregiver = await signIn(h, '+966500096865');

  const rel = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, status, permissions,
        invited_by_user_id, accepted_at)
     VALUES ($1,$2,'active',ARRAY['view_medications']::text[],$3,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, patient.userId],
  );
  relationshipId = rel.rows[0]!.id;

  await db.query(
    `INSERT INTO stored_objects
       (object_key, owner_user_id, patient_profile_id, purpose,
        content_type, byte_size, uploaded_at, scan_status)
     VALUES ($1,$2,$3,'prescription_image','image/jpeg',128,now(),'clean')`,
    [IMAGE_KEY, patient.userId, patient.profileId],
  );
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (db) await db.end();
  if (h) await h.close();
});

describe('signed medication-image URL honors access revoked while capability is being issued', () => {
  it('does not return a signed URL after the caregiver relationship is revoked', async () => {
    const signingStarted = deferred<void>();
    const releaseSigning = deferred<string>();

    vi.spyOn(h.worker.providers.storage, 'createReadUrl').mockImplementation(async () => {
      signingStarted.resolve();
      return releaseSigning.promise;
    });

    const inFlight = h.app.inject({
      method: 'GET',
      url: '/v1/uploads/url',
      headers: {
        ...authHeaders(caregiver),
        'x-dawaee-object-key': IMAGE_KEY,
      },
    });

    // Reaching the signing provider proves object visibility and the initial
    // view_medications authorization both passed. Revoke the care relationship
    // before the capability is returned to the caller.
    await signingStarted.promise;
    await db.query(
      `UPDATE caregiver_relationships
          SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2
        WHERE id = $1`,
      [relationshipId, patient.userId],
    );

    releaseSigning.resolve('https://storage.invalid/private-capability');
    const response = await inFlight;

    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).not.toContain('private-capability');
  });
});
