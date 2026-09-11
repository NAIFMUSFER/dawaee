import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
const IMAGE_KEY = 'synthetic-ocr-caregiver-race/image.png';

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
  patient = await signIn(h, '+966500096862');
  caregiver = await signIn(h, '+966500096863');

  const rel = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, status, permissions,
        invited_by_user_id, accepted_at)
     VALUES ($1,$2,'active',ARRAY['add_medication','view_medications']::text[],$3,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, patient.userId],
  );
  relationshipId = rel.rows[0]!.id;

  const consent = await h.app.inject({
    method: 'PUT',
    url: '/v1/me/consents',
    headers: authHeaders(caregiver),
    payload: { type: 'ocr_image_processing', granted: true, version: '1' },
  });
  expect(consent.statusCode, consent.body).toBe(200);

  await db.query(
    `INSERT INTO stored_objects
       (object_key, owner_user_id, patient_profile_id, purpose,
        content_type, byte_size, uploaded_at, scan_status)
     VALUES ($1,$2,$3,'medication_image','image/png',$4,now(),'clean')`,
    [IMAGE_KEY, caregiver.userId, patient.profileId, IMAGE.length],
  );
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (db) await db.end();
  if (h) await h.close();
});

describe('OCR disclosure honors caregiver access revoked while image bytes are being fetched', () => {
  it('does not call the external OCR provider after the care relationship is revoked', async () => {
    const storageStarted = deferred<void>();
    const releaseStorage = deferred<Buffer>();

    vi.spyOn(h.worker.providers.storage, 'getObject').mockImplementation(async () => {
      storageStarted.resolve();
      return releaseStorage.promise;
    });
    const ocr = vi.spyOn(h.worker.providers.ocr, 'readMedicationLabel').mockResolvedValue({
      provider: 'synthetic-caregiver-race', rawText: '', fields: {}, language: 'unknown',
    });

    const inFlight = h.app.inject({
      method: 'POST',
      url: '/v1/ocr/analyze',
      headers: authHeaders(caregiver),
      remoteAddress: '198.51.100.94',
      payload: {
        imageKey: IMAGE_KEY,
        patientProfileId: patient.profileId,
        kind: 'medication_label',
      },
    });

    // Reaching storage proves the initial add_medication authorization and
    // consent checks both passed. Revoke access while that provider I/O is in flight.
    await storageStarted.promise;
    await db.query(
      `UPDATE caregiver_relationships
          SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2
        WHERE id = $1`,
      [relationshipId, patient.userId],
    );

    releaseStorage.resolve(IMAGE);
    const response = await inFlight;

    expect(response.statusCode, response.body).toBe(403);
    expect(ocr).not.toHaveBeenCalled();
  });
});
