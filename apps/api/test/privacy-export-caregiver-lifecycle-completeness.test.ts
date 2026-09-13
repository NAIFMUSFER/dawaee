import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

type CaregiverRow = Record<string, unknown>;
type ExportPayload = { profileId: string; data: { caregivers: CaregiverRow[] } };

let h: Harness;
let owner: TestUser;
let siblingProfileId: string;
let primaryRelationshipId: string;
let siblingRelationshipId: string;
let invitationCapability: string;

async function createOwnedProfile(displayName: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(owner),
    payload: { displayName, timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ profile: { id: string } }>().profile.id;
}

async function invite(profileId: string, label: string, phone: string, channel: 'link' | 'qr') {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(owner),
    payload: {
      patientProfileId: profileId,
      invitedName: label,
      invitedPhone: phone,
      role: 'caregiver',
      permissions: ['view_reports'],
      escalationPriority: 7,
      channel,
      expiresInHours: 48,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{ relationshipId: string; invitationLink: string }>();
  const token = body.invitationLink.split('/').at(-1);
  expect(token).toBeTruthy();
  return { relationshipId: body.relationshipId, token: token! };
}

async function exportedCaregivers(profileId: string): Promise<{ payload: ExportPayload; rows: CaregiverRow[] }> {
  const res = await h.app.inject({
    method: 'GET', url: '/v1/reports/export',
    headers: { ...authHeaders(owner), [PROFILE_ID_HEADER]: profileId },
  });
  expect(res.statusCode, res.body).toBe(200);
  const payload = res.json<ExportPayload>();
  expect(payload.profileId).toBe(profileId);
  expect(Array.isArray(payload.data.caregivers)).toBe(true);
  return { payload, rows: payload.data.caregivers };
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = await signIn(h, '+966500096811');
  siblingProfileId = await createOwnedProfile('SYNTHETIC-EXPORT-CAREGIVER-SIBLING');

  const primary = await invite(
    owner.profileId,
    'SYNTHETIC-PENDING-CAREGIVER',
    '+966500096812',
    'qr',
  );
  primaryRelationshipId = primary.relationshipId;
  invitationCapability = primary.token;

  const sibling = await invite(
    siblingProfileId,
    'SYNTHETIC-SIBLING-CAREGIVER',
    '+966500096813',
    'link',
  );
  siblingRelationshipId = sibling.relationshipId;
}, 120_000);

afterAll(async () => { if (h) await h.close(); });

describe('privacy export caregiver lifecycle completeness', () => {
  it('exports the patient-visible invitation lifecycle without bearer capability material', async () => {
    const { payload, rows } = await exportedCaregivers(owner.profileId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row).toEqual(expect.objectContaining({
      id: primaryRelationshipId,
      invited_phone_e164: '+966500096812',
      invited_name: 'SYNTHETIC-PENDING-CAREGIVER',
      role: 'caregiver',
      status: 'pending',
      permissions: ['view_reports'],
      escalation_priority: 7,
      invitation_channel: 'qr',
      invitation_expires_at: expect.any(String),
      accepted_at: null,
      declined_at: null,
      revoked_at: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    }));

    expect(row).not.toHaveProperty('invitation_token_hash');
    expect(JSON.stringify(payload)).not.toContain(invitationCapability);
  });

  it('does not mix pending invitations between two profiles owned by the same account', async () => {
    const first = await exportedCaregivers(owner.profileId);
    const second = await exportedCaregivers(siblingProfileId);

    expect(first.rows.map((row) => row.id)).toEqual([primaryRelationshipId]);
    expect(second.rows.map((row) => row.id)).toEqual([siblingRelationshipId]);
    expect(second.rows[0]).toEqual(expect.objectContaining({
      invited_phone_e164: '+966500096813',
      invited_name: 'SYNTHETIC-SIBLING-CAREGIVER',
      invitation_channel: 'link',
      invitation_expires_at: expect.any(String),
    }));
    expect(second.rows[0]).not.toHaveProperty('invitation_token_hash');
  });
});
