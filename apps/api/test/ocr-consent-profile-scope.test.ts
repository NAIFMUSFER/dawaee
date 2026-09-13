import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Consent belongs to a user AND a scope. A grant for another owned profile
 * cannot authorize disclosing this profile's image to an OCR provider.
 * Only the external storage/OCR boundary is mocked; the routes, consent writes,
 * authentication, ownership checks and database/RLS execute for real.
 */
type OcrKind = 'medication_label' | 'prescription';
type Fixture = { user: TestUser; secondProfileId: string };
const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
let h: Harness;
let nextFixture = 0;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  vi.spyOn(h.worker.providers.storage, 'getObject').mockResolvedValue(IMAGE);
  vi.spyOn(h.worker.providers.ocr, 'readMedicationLabel').mockResolvedValue({
    provider: 'synthetic-consent-test', rawText: '', fields: {}, language: 'unknown',
  });
  vi.spyOn(h.worker.providers.ocr, 'readPrescription').mockResolvedValue({
    provider: 'synthetic-consent-test', rawText: '', lines: [], language: 'unknown',
  });
}, 120_000);

beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => {
  vi.restoreAllMocks();
  if (h) await h.close();
});

async function fixture(): Promise<Fixture> {
  nextFixture += 1;
  const user = await signIn(h, `+966500098${String(nextFixture).padStart(3, '0')}`);
  const res = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(user),
    payload: { displayName: 'SYNTHETIC-CONSENT-SIBLING', timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { user, secondProfileId: res.json<{ profile: { id: string } }>().profile.id };
}

async function consent(user: TestUser, granted: boolean, patientProfileId?: string) {
  const res = await h.app.inject({
    method: 'PUT', url: '/v1/me/consents', headers: authHeaders(user),
    payload: { type: 'ocr_image_processing', granted, version: '1',
      ...(patientProfileId ? { patientProfileId } : {}) },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function analyze(user: TestUser, profileId: string, kind: OcrKind) {
  const imageKey = `synthetic-consent-scope/${profileId}/${kind}`;
  // This suite isolates consent semantics. Its synthetic object represents an
  // upload whose lease has already been finalized by the dedicated upload flow.
  await withUser(user.userId, async (tx) => {
    await tx.query(
      `INSERT INTO stored_objects
         (object_key, owner_user_id, patient_profile_id, purpose, content_type, byte_size, uploaded_at, scan_status)
       VALUES ($1,$2,$3,$4,'image/png',$5,now(),'clean') ON CONFLICT (object_key) DO NOTHING`,
      [imageKey, user.userId, profileId,
        kind === 'medication_label' ? 'medication_image' : 'prescription_image', IMAGE.length],
    );
  });
  return h.app.inject({
    method: 'POST', url: '/v1/ocr/analyze', headers: authHeaders(user),
    remoteAddress: '198.51.100.92',
    payload: { imageKey, patientProfileId: profileId, kind },
  });
}

async function deniedWithoutDisclosure(user: TestUser, profileId: string, kind: OcrKind) {
  const res = await analyze(user, profileId, kind);
  expect.soft(res.statusCode, res.body).toBe(428);
  expect.soft(res.json<{ error?: { code: string } }>().error?.code).toBe('consent_required');
  expect.soft(h.worker.providers.storage.getObject).not.toHaveBeenCalled();
  expect.soft(h.worker.providers.ocr.readMedicationLabel).not.toHaveBeenCalled();
  expect.soft(h.worker.providers.ocr.readPrescription).not.toHaveBeenCalled();
}

describe('OCR consent respects the requested patient profile', () => {
  it.each<OcrKind>(['medication_label', 'prescription'])(
    'does not use profile B consent for profile A %s processing', async (kind) => {
      const { user, secondProfileId } = await fixture();
      await consent(user, true, secondProfileId);
      await deniedWithoutDisclosure(user, user.profileId, kind);
    },
  );

  it.each<OcrKind>(['medication_label', 'prescription'])(
    'accepts an explicit grant for the matching profile for %s', async (kind) => {
      const { user } = await fixture();
      await consent(user, true, user.profileId);
      const res = await analyze(user, user.profileId, kind);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ kind, requiresUserConfirmation: true });
      expect(h.worker.providers.storage.getObject).toHaveBeenCalledTimes(1);
      const expected = kind === 'medication_label'
        ? h.worker.providers.ocr.readMedicationLabel : h.worker.providers.ocr.readPrescription;
      const unexpected = kind === 'medication_label'
        ? h.worker.providers.ocr.readPrescription : h.worker.providers.ocr.readMedicationLabel;
      expect(expected).toHaveBeenCalledTimes(1);
      expect(expected).toHaveBeenCalledWith(IMAGE, 'image/png');
      expect(unexpected).not.toHaveBeenCalled();
    },
  );

  it('retains the existing account-wide grant when no profile-specific decision exists', async () => {
    const { user, secondProfileId } = await fixture();
    await consent(user, true);
    const first = await analyze(user, user.profileId, 'medication_label');
    const second = await analyze(user, secondProfileId, 'prescription');
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(h.worker.providers.ocr.readMedicationLabel).toHaveBeenCalledTimes(1);
    expect(h.worker.providers.ocr.readPrescription).toHaveBeenCalledTimes(1);
  });

  it('requires consent when none is recorded', async () => {
    const { user } = await fixture();
    await deniedWithoutDisclosure(user, user.profileId, 'medication_label');
  });

  it('does not let another profile grant override this profile withdrawal', async () => {
    const { user, secondProfileId } = await fixture();
    await consent(user, true, secondProfileId);
    await consent(user, false, user.profileId);
    await deniedWithoutDisclosure(user, user.profileId, 'prescription');
  });

  it('does not let an account-wide grant override an explicit profile withdrawal', async () => {
    const { user } = await fixture();
    await consent(user, true);
    await consent(user, false, user.profileId);
    await deniedWithoutDisclosure(user, user.profileId, 'medication_label');
  });

  it('does not let another profile withdrawal block a matching profile grant', async () => {
    const { user, secondProfileId } = await fixture();
    await consent(user, false, secondProfileId);
    await consent(user, true, user.profileId);
    const res = await analyze(user, user.profileId, 'medication_label');
    expect(res.statusCode, res.body).toBe(200);
    expect(h.worker.providers.ocr.readMedicationLabel).toHaveBeenCalledTimes(1);
  });
});
