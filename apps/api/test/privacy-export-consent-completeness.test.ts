import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * A consent can be bound to one patient profile. The privacy screen promises
 * the complete data export for the selected profile, so that current consent
 * state must travel with the rest of that profile's records. RLS is user-wide
 * for consents, therefore the export query itself must also keep two profiles
 * owned by the same account separate.
 */
let h: Harness;
let owner: TestUser;
let siblingProfileId: string;
let targetConsentId: string;
let siblingConsentId: string;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = await signIn(h, '+966500097780');

  const sibling = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(owner),
    payload: { displayName: 'SYNTHETIC-CONSENT-SIBLING', timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(sibling.statusCode, sibling.body).toBe(200);
  siblingProfileId = sibling.json<{ profile: { id: string } }>().profile.id;

  await withUser(owner.userId, async (tx) => {
    const { rows: target } = await tx.query<{ id: string }>(
      `INSERT INTO consents
         (user_id, patient_profile_id, type, granted, version, granted_at, ip_hash)
       VALUES ($1,$2,'caregiver_data_sharing',true,'2026.09',now(),'synthetic-target-ip-hash')
       RETURNING id`,
      [owner.userId, owner.profileId],
    );
    targetConsentId = target[0]!.id;

    const { rows: siblingRows } = await tx.query<{ id: string }>(
      `INSERT INTO consents
         (user_id, patient_profile_id, type, granted, version, withdrawn_at, ip_hash)
       VALUES ($1,$2,'emergency_card_public',false,'2026.09',now(),'synthetic-sibling-ip-hash')
       RETURNING id`,
      [owner.userId, siblingProfileId],
    );
    siblingConsentId = siblingRows[0]!.id;
  });
}, 120_000);

afterAll(async () => { if (h) await h.close(); });

async function exportProfile(profileId: string) {
  const res = await h.app.inject({
    method: 'GET', url: '/v1/reports/export',
    headers: { ...authHeaders(owner), [PROFILE_ID_HEADER]: profileId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ data: { consents?: Array<Record<string, unknown>> } }>().data;
}

describe('privacy export profile consent completeness', () => {
  it('includes the selected profile current consent state', async () => {
    const data = await exportProfile(owner.profileId);
    expect(data.consents).toBeDefined();
    expect(data.consents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetConsentId,
        user_id: owner.userId,
        patient_profile_id: owner.profileId,
        type: 'caregiver_data_sharing',
        granted: true,
        version: '2026.09',
      }),
    ]));
  });

  it('does not mix another profile consent owned by the same account', async () => {
    const primary = await exportProfile(owner.profileId);
    const sibling = await exportProfile(siblingProfileId);

    expect(primary.consents?.map((row) => row.id)).toContain(targetConsentId);
    expect(primary.consents?.map((row) => row.id)).not.toContain(siblingConsentId);
    expect(sibling.consents?.map((row) => row.id)).toContain(siblingConsentId);
    expect(sibling.consents?.map((row) => row.id)).not.toContain(targetConsentId);
  });
});
