import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
let secondProfileId = '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500091300');

  const profile = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(user),
    payload: { displayName: 'Second patient', timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(profile.statusCode, profile.body).toBe(200);
  secondProfileId = profile.json<{ profile: { id: string } }>().profile.id;

  const consent = await h.app.inject({
    method: 'PUT', url: '/v1/me/consents', headers: authHeaders(user),
    payload: { type: 'ocr_image_processing', granted: true, version: '1' },
  });
  expect(consent.statusCode, consent.body).toBe(200);
}, 120_000);

afterAll(async () => { await h.close(); });

async function requestObject(purpose: 'medication_image' | 'prescription_image' | 'avatar', profileId?: string) {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/uploads/request', headers: authHeaders(user),
    payload: {
      purpose, contentType: 'image/png', byteSize: 128,
      ...(profileId ? { patientProfileId: profileId } : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const objectKey = res.json<{ objectKey: string }>().objectKey;
  // This suite is about provenance binding, not the upload lease. Model an
  // object that already completed the separately-tested finalization step.
  await withUser(user.userId, async (tx) => {
    await tx.query(
      `UPDATE stored_objects SET uploaded_at = now(), scan_status = 'clean'
        WHERE object_key = $1 AND owner_user_id = $2`,
      [objectKey, user.userId],
    );
  });
  return objectKey;
}

describe('P20 OCR provenance binds image, patient profile, and purpose', () => {
  it('does not let one account relabel profile A image as profile B during OCR', async () => {
    const objectKey = await requestObject('medication_image', user.profileId);
    const res = await h.app.inject({
      method: 'POST', url: '/v1/ocr/analyze', headers: authHeaders(user),
      payload: { imageKey: objectKey, patientProfileId: secondProfileId, kind: 'medication_label' },
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('does not accept an unbound upload as a patient medication image', async () => {
    const objectKey = await requestObject('medication_image');
    const res = await h.app.inject({
      method: 'POST', url: '/v1/ocr/analyze', headers: authHeaders(user),
      payload: { imageKey: objectKey, patientProfileId: user.profileId, kind: 'medication_label' },
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('does not run medication-label OCR over an object uploaded as a prescription', async () => {
    const objectKey = await requestObject('prescription_image', user.profileId);
    const res = await h.app.inject({
      method: 'POST', url: '/v1/ocr/analyze', headers: authHeaders(user),
      payload: { imageKey: objectKey, patientProfileId: user.profileId, kind: 'medication_label' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('upload_rejected');
  });

  it('does not run prescription OCR over a medication-label image', async () => {
    const objectKey = await requestObject('medication_image', user.profileId);
    const res = await h.app.inject({
      method: 'POST', url: '/v1/ocr/analyze', headers: authHeaders(user),
      payload: { imageKey: objectKey, patientProfileId: user.profileId, kind: 'prescription' },
    });
    expect(res.statusCode, res.body).toBe(400);
  });
});
