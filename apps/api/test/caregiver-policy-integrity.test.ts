import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
let secondProfileId = '';
let primaryMedicationId = '';
let secondMedicationId = '';

const date = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function createMedication(profileId: string, name: string) {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: { patientProfileId: profileId, name, form: 'tablet', startDate: date(), acknowledgeDuplicate: true },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ medication: { id: string } }>().medication.id;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500091400');

  const second = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(user),
    payload: { displayName: 'Second patient', timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(second.statusCode, second.body).toBe(200);
  secondProfileId = second.json<{ profile: { id: string } }>().profile.id;

  primaryMedicationId = await createMedication(user.profileId, 'Primary profile medicine');
  secondMedicationId = await createMedication(secondProfileId, 'Second profile medicine');
}, 120_000);

afterAll(async () => { await h.close(); });

describe('P20 caregiver delivery contract matches live providers', () => {
  it('a new caregiver gets only the live push rule, not an enabled phantom WhatsApp rule', async () => {
    const invite = await h.app.inject({
      method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId,
        invitedName: 'Helper', invitedPhone: '+966500091401', role: 'caregiver',
        permissions: ['view_adherence'], escalationPriority: 1,
      },
    });
    expect(invite.statusCode, invite.body).toBe(200);

    const circle = await h.app.inject({
      method: 'GET', url: `/v1/care-circle?profileId=${user.profileId}`, headers: authHeaders(user),
    });
    expect(circle.statusCode, circle.body).toBe(200);
    const helper = circle.json<{ caregivers: Array<{ name: string; notificationRules: Array<{ channel: string; enabled: boolean }> }> }>()
      .caregivers.find((c) => c.name === 'Helper');
    expect(helper).toBeTruthy();
    expect(helper!.notificationRules).toEqual([
      expect.objectContaining({ channel: 'push', enabled: true }),
    ]);
  });
});

describe('P20 medication-specific escalation policy integrity', () => {
  const stages = [
    { afterMinutes: 0, target: 'patient', channels: ['push'] },
    { afterMinutes: 30, target: 'primary_caregiver', channels: ['push'] },
  ];

  it('refuses binding a medication from another owned profile to this profile policy', async () => {
    const res = await h.app.inject({
      method: 'PUT', url: `/v1/escalation-policy?profileId=${user.profileId}`, headers: authHeaders(user),
      payload: { enabled: true, medicationId: secondMedicationId, stages },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/does not belong/i);
  });

  it('upserts a medication-specific policy instead of conflicting on the second save', async () => {
    const first = await h.app.inject({
      method: 'PUT', url: `/v1/escalation-policy?profileId=${user.profileId}`, headers: authHeaders(user),
      payload: { enabled: true, medicationId: primaryMedicationId, stages },
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstId = first.json<{ policy: { id: string } }>().policy.id;

    const second = await h.app.inject({
      method: 'PUT', url: `/v1/escalation-policy?profileId=${user.profileId}`, headers: authHeaders(user),
      payload: { enabled: false, medicationId: primaryMedicationId, stages: [] },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<{ policy: { id: string; enabled: boolean } }>().policy.id).toBe(firstId);
    expect(second.json<{ policy: { enabled: boolean } }>().policy.enabled).toBe(false);
  });

  it('validates medicationId query syntax instead of handing malformed UUIDs to PostgreSQL', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/escalation-policy?profileId=${user.profileId}&medicationId=not-a-uuid`,
      headers: authHeaders(user),
    });
    expect(res.statusCode, res.body).toBe(400);
  });
});
