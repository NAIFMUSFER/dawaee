import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/auth/firebase-phone-proof.js', async (original) => ({
  ...await original<typeof import('../src/auth/firebase-phone-proof.js')>(),
  verifyFirebasePhoneIdToken: provider.verify,
}));
import { FirebasePhoneProofInvalid, FirebasePhoneProofUnavailable } from '../src/auth/firebase-phone-proof.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let patient: TestUser;
let caregiver: TestUser;
let token: string;
const syntheticProof = 'synthetic-provider-boundary-proof-'.repeat(4);
const proofFor = (phone: string, age = 0) => ({ phoneE164: phone, firebaseUid: 'fixture-firebase-user', authenticatedAt: Math.floor(Date.now() / 1000) - age });

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500092201');
  caregiver = await signIn(h, '+966500092202', 'phone-proof-device', { verifiedPhone: false });
  const invite = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(patient),
    payload: { patientProfileId: patient.profileId, invitedName: 'Caregiver', invitedPhone: caregiver.phone,
      role: 'caregiver', permissions: ['view_schedule'], escalationPriority: 1 },
  });
  expect(invite.statusCode, invite.body).toBe(200);
  token = invite.json<{ invitationLink: string }>().invitationLink.split('/invite/')[1]!;
});
afterAll(async () => { await h?.close(); });

const status = () => h.app.inject({ method: 'GET', url: '/v1/auth/phone-verification', headers: authHeaders(caregiver) });
const verify = () => h.app.inject({ method: 'POST', url: '/v1/auth/phone-verification', headers: authHeaders(caregiver), payload: { idToken: syntheticProof } });

describe('caregiver phone verification lifecycle', () => {
  it('keeps password registration unverified and requests proof without consuming the invitation', async () => {
    expect((await status()).json()).toEqual({ phone: caregiver.phone, verified: false });
    const result = await h.app.inject({ method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(caregiver), payload: { token } });
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe('phone_verification_required');
  });

  it('requires the proof to match the registered phone', async () => {
    provider.verify.mockResolvedValueOnce(proofFor(patient.phone));
    expect((await verify()).statusCode).toBe(403);
    expect((await status()).json().verified).toBe(false);
  });

  it('requires recent authentication at the persistence boundary', async () => {
    provider.verify.mockResolvedValueOnce(proofFor(caregiver.phone, 660));
    expect((await verify()).statusCode).toBe(403);
    expect((await status()).json().verified).toBe(false);
  });

  it('keeps expired proof retryable without ending the Dawaee session', async () => {
    provider.verify.mockRejectedValueOnce(new FirebasePhoneProofInvalid());
    expect((await verify()).statusCode).toBe(403);
    expect((await status()).statusCode).toBe(200);
  });

  it('reports an unavailable verification provider', async () => {
    provider.verify.mockRejectedValueOnce(new FirebasePhoneProofUnavailable());
    expect((await verify()).statusCode).toBe(503);
  });

  it('persists verified ownership and accepts the same pending invitation', async () => {
    provider.verify.mockResolvedValueOnce(proofFor(caregiver.phone));
    const result = await verify();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ verified: true });
    expect((await status()).json().verified).toBe(true);
    const accepted = await h.app.inject({ method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(caregiver), payload: { token } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const profiles = await h.app.inject({ method: 'GET', url: '/v1/profiles', headers: authHeaders(caregiver) });
    expect(profiles.json().profiles.map((p: { id: string }) => p.id)).toContain(patient.profileId);
  });
});
