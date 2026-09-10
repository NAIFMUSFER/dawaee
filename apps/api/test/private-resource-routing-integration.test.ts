import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, PANADOL, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import { MEDICATION_ID_HEADER } from '../src/middleware/private-resource-routing.js';
import { PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let aliceMedicationId = '';
let bobMedicationId = '';

async function addMedication(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: { patientProfileId: user.profileId, ...PANADOL, startDate: '2026-09-01' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ medication: { id: string } }>().medication.id;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  alice = await signIn(h, '+966500091101');
  bob = await signIn(h, '+966500091102');
  aliceMedicationId = await addMedication(alice);
  bobMedicationId = await addMedication(bob);
}, 120_000);

afterAll(async () => { await h.close(); });

describe('fixed public resource routing reaches the established authorization handlers', () => {
  it('reads the owner medication through a public path containing no medication id', async () => {
    const publicPath = '/v1/medication';
    expect(publicPath).not.toContain(aliceMedicationId);
    const res = await h.app.inject({
      method: 'GET', url: publicPath,
      headers: { ...authHeaders(alice), [MEDICATION_ID_HEADER]: aliceMedicationId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ medication: { id: string } }>().medication.id).toBe(aliceMedicationId);
  });

  it('reuses the same protection for stock without exposing the id in the path', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/medication/stock',
      headers: { ...authHeaders(alice), [MEDICATION_ID_HEADER]: aliceMedicationId },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('does not let a fixed path become a BOLA bypass', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/medication',
      headers: { ...authHeaders(alice), [MEDICATION_ID_HEADER]: bobMedicationId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(PANADOL.name);
  });

  it('still requires authentication after the internal rewrite', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/medication', headers: { [MEDICATION_ID_HEADER]: aliceMedicationId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('reads the owner profile through the fixed profile path', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/profile',
      headers: { ...authHeaders(alice), [PROFILE_ID_HEADER]: alice.profileId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ profile: { id: string } }>().profile.id).toBe(alice.profileId);
  });

  it('preserves profile cross-account isolation after rewriting', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/profile',
      headers: { ...authHeaders(alice), [PROFILE_ID_HEADER]: bob.profileId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(bob.phone);
  });
});
