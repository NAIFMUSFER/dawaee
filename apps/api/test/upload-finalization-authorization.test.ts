import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

// Only storage/OCR provider I/O is mocked. Authentication, the actual routes,
// upload lease transitions and ordinary application-role RLS execute for real.
const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
let h: Harness;
let uploader: TestUser;
let caregiver: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  vi.spyOn(h.worker.providers.storage, 'getObject').mockResolvedValue(IMAGE);
  vi.spyOn(h.worker.providers.storage, 'deleteObject').mockResolvedValue(undefined);
  vi.spyOn(h.worker.providers.ocr, 'readMedicationLabel').mockResolvedValue({
    provider: 'synthetic-finalization-test', rawText: '', fields: {}, language: 'unknown',
  });
  vi.spyOn(h.worker.providers.ocr, 'readPrescription').mockResolvedValue({
    provider: 'synthetic-finalization-test', rawText: '', lines: [], language: 'unknown',
  });
  uploader = await signIn(h, '+966500097881');
  caregiver = await signIn(h, '+966500097882');
  stranger = await signIn(h, '+966500097883');
  await withUser(uploader.userId, async (tx) => {
    await tx.query(
      `INSERT INTO caregiver_relationships
         (patient_profile_id, caregiver_user_id, invited_name, role, status,
          permissions, escalation_priority, invited_by_user_id, accepted_at)
       VALUES ($1,$2,'SYNTHETIC-UPLOAD-HELPER','caregiver','active',
               ARRAY['view_medications','add_medication'],1,$3,now())`,
      [uploader.profileId, caregiver.userId, uploader.userId],
    );
  });
}, 120_000);

beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => {
  vi.restoreAllMocks();
  if (h) await h.close();
});

async function lease(purpose = 'medication_image'): Promise<string> {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/uploads/request', headers: authHeaders(uploader),
    payload: { patientProfileId: uploader.profileId, purpose, contentType: 'image/png', byteSize: IMAGE.length },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ objectKey: string }>().objectKey;
}

function finalize(objectKey: string, user?: TestUser) {
  return h.app.inject({
    method: 'POST', url: '/v1/uploads/finalize',
    headers: user ? authHeaders(user) : {}, payload: { objectKey },
  });
}

async function leaseState(objectKey: string, user = uploader) {
  return withUser(user.userId, async (tx) => {
    const { rows } = await tx.query<{ owner_user_id: string; uploaded_at: Date | null; scan_status: string }>(
      'SELECT owner_user_id, uploaded_at, scan_status FROM stored_objects WHERE object_key = $1', [objectKey],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  });
}

function noProviderUse() {
  expect(h.worker.providers.storage.getObject).not.toHaveBeenCalled();
  expect(h.worker.providers.storage.deleteObject).not.toHaveBeenCalled();
  expect(h.worker.providers.ocr.readMedicationLabel).not.toHaveBeenCalled();
  expect(h.worker.providers.ocr.readPrescription).not.toHaveBeenCalled();
}

describe('upload finalization authorization and staged-object boundary', () => {
  it('requires authentication even for a real, well-formed upload lease', async () => {
    const key = await lease();
    const before = await leaseState(key);
    const res = await finalize(key);
    expect(res.statusCode, res.body).toBe(401);
    expect(await leaseState(key)).toEqual(before);
    noProviderUse();
  });

  it('cannot finalize an unrelated account upload or distinguish it from an absent key', async () => {
    const key = await lease();
    const before = await leaseState(key);
    const foreign = await finalize(key, stranger);
    const absent = await finalize('synthetic-missing-upload', stranger);
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(absent.statusCode, absent.body).toBe(404);
    expect(foreign.json().error.code).toBe(absent.json().error.code);
    expect(foreign.json().error.message).toBe(absent.json().error.message);
    expect(await leaseState(key)).toEqual(before);
    noProviderUse();
  });

  it('does not let a related caregiver finalize a lease visible through profile RLS', async () => {
    const key = await lease();
    // Positive visibility control: RLS permits this row, so only the explicit
    // uploader check (not an invisible fixture) can make the endpoint refuse it.
    const visible = await leaseState(key, caregiver);
    expect(visible.owner_user_id).toBe(uploader.userId);
    expect(visible.uploaded_at).toBeNull();
    const res = await finalize(key, caregiver);
    expect(res.statusCode, res.body).toBe(404);
    expect(await leaseState(key)).toEqual(visible);
    noProviderUse();
  });

  it('lets the uploader finalize and replay without a second provider read', async () => {
    const key = await lease();
    expect((await leaseState(key)).uploaded_at).toBeNull();
    const first = await finalize(key, uploader);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, objectKey: key });
    const completed = await leaseState(key);
    expect(completed.uploaded_at).not.toBeNull();
    expect(completed.scan_status).toBe('clean');
    const replay = await finalize(key, uploader);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await leaseState(key)).toEqual(completed);
    expect(h.worker.providers.storage.getObject).toHaveBeenCalledTimes(1);
    expect(h.worker.providers.storage.getObject).toHaveBeenCalledWith(key);
    expect(h.worker.providers.storage.deleteObject).not.toHaveBeenCalled();
  });

  it.each(['medication_label', 'prescription'] as const)(
    'does not process an unfinalized %s even with valid matching consent', async (kind) => {
      const key = await lease(kind === 'prescription' ? 'prescription_image' : 'medication_image');
      const consent = await h.app.inject({
        method: 'PUT', url: '/v1/me/consents', headers: authHeaders(uploader),
        payload: { type: 'ocr_image_processing', granted: true, patientProfileId: uploader.profileId },
      });
      expect(consent.statusCode, consent.body).toBe(200);
      const res = await h.app.inject({
        method: 'POST', url: '/v1/ocr/analyze', headers: authHeaders(uploader),
        payload: { imageKey: key, patientProfileId: uploader.profileId, kind },
      });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe('not_found');
      expect((await leaseState(key)).uploaded_at).toBeNull();
      noProviderUse();
    },
  );
});
