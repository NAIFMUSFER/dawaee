import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
const IMAGE_KEY = 'synthetic-ocr-revocation-race/image.png';

let h: Harness;
let user: TestUser;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500096861');

  await withUser(user.userId, async (tx) => {
    await tx.query(
      `INSERT INTO stored_objects
         (object_key, owner_user_id, patient_profile_id, purpose, content_type, byte_size, uploaded_at, scan_status)
       VALUES ($1,$2,$3,'medication_image','image/png',$4,now(),'clean')`,
      [IMAGE_KEY, user.userId, user.profileId, IMAGE.length],
    );
  });

  const granted = await h.app.inject({
    method: 'PUT',
    url: '/v1/me/consents',
    headers: authHeaders(user),
    payload: {
      type: 'ocr_image_processing',
      granted: true,
      version: '1',
      patientProfileId: user.profileId,
    },
  });
  expect(granted.statusCode, granted.body).toBe(200);
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (h) await h.close();
});

describe('OCR disclosure honors consent revoked while the image is being fetched', () => {
  it('does not call the external OCR provider after consent is withdrawn before disclosure', async () => {
    const storageStarted = deferred<void>();
    const releaseStorage = deferred<Buffer>();

    vi.spyOn(h.worker.providers.storage, 'getObject').mockImplementation(async () => {
      storageStarted.resolve();
      return releaseStorage.promise;
    });
    const ocr = vi.spyOn(h.worker.providers.ocr, 'readMedicationLabel').mockResolvedValue({
      provider: 'synthetic-revocation-race', rawText: '', fields: {}, language: 'unknown',
    });

    const inFlight = h.app.inject({
      method: 'POST',
      url: '/v1/ocr/analyze',
      headers: authHeaders(user),
      remoteAddress: '198.51.100.93',
      payload: {
        imageKey: IMAGE_KEY,
        patientProfileId: user.profileId,
        kind: 'medication_label',
      },
    });

    await storageStarted.promise;

    const revoked = await h.app.inject({
      method: 'PUT',
      url: '/v1/me/consents',
      headers: authHeaders(user),
      payload: {
        type: 'ocr_image_processing',
        granted: false,
        version: '1',
        patientProfileId: user.profileId,
      },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    releaseStorage.resolve(IMAGE);
    const response = await inFlight;

    expect(response.statusCode, response.body).toBe(428);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('consent_required');
    expect(ocr).not.toHaveBeenCalled();
  });
});
