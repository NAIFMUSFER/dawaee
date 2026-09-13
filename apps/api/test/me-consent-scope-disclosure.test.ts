import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * /v1/me is the source used by the privacy screen for consent state. The
 * database permits an account-wide default and a patient-profile override for
 * the same consent type. Once those rows coexist, omitting patientProfileId
 * makes opposite decisions indistinguishable to the client and can make a
 * privacy switch display or withdraw the wrong effective decision.
 */
let h: Harness;
let user: TestUser;
let siblingProfileId = '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500098880');

  const sibling = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(user),
    payload: { displayName: 'SYNTHETIC-CONSENT-SCOPE', timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(sibling.statusCode, sibling.body).toBe(200);
  siblingProfileId = sibling.json<{ profile: { id: string } }>().profile.id;

  const globalGrant = await h.app.inject({
    method: 'PUT', url: '/v1/me/consents', headers: authHeaders(user),
    payload: { type: 'ocr_image_processing', granted: true, version: 'global-1' },
  });
  expect(globalGrant.statusCode, globalGrant.body).toBe(200);

  const ownWithdrawal = await h.app.inject({
    method: 'PUT', url: '/v1/me/consents', headers: authHeaders(user),
    payload: {
      type: 'ocr_image_processing', granted: false, version: 'profile-1',
      patientProfileId: user.profileId,
    },
  });
  expect(ownWithdrawal.statusCode, ownWithdrawal.body).toBe(200);

  const siblingGrant = await h.app.inject({
    method: 'PUT', url: '/v1/me/consents', headers: authHeaders(user),
    payload: {
      type: 'ocr_image_processing', granted: true, version: 'sibling-1',
      patientProfileId: siblingProfileId,
    },
  });
  expect(siblingGrant.statusCode, siblingGrant.body).toBe(200);
}, 120_000);

afterAll(async () => { if (h) await h.close(); });

async function loadMe() {
  const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(user) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    consents: Array<{
      type: string;
      granted: boolean;
      version: string;
      patientProfileId: string | null;
    }>;
  }>();
}

describe('/v1/me preserves consent scope', () => {
  it('distinguishes the account-wide default from this profile explicit withdrawal', async () => {
    const me = await loadMe();
    const rows = me.consents.filter((row) => row.type === 'ocr_image_processing');

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ granted: true, version: 'global-1', patientProfileId: null }),
      expect.objectContaining({
        granted: false, version: 'profile-1', patientProfileId: user.profileId,
      }),
    ]));
  });

  it('keeps two owned patient-profile decisions distinguishable from each other', async () => {
    const me = await loadMe();
    const rows = me.consents.filter((row) => row.type === 'ocr_image_processing');

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        granted: false, version: 'profile-1', patientProfileId: user.profileId,
      }),
      expect.objectContaining({
        granted: true, version: 'sibling-1', patientProfileId: siblingProfileId,
      }),
    ]));
  });
});
