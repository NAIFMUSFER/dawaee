import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, PANADOL, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

interface Profile {
  id: string;
  isSelf: boolean;
  role: 'owner' | 'caregiver';
  permissions: string[] | null;
}

let h: Harness;
let patient: TestUser;
let caregiver: TestUser;
let dependentId: string;
let medicationId: string;

async function profilesFor(user: TestUser): Promise<Profile[]> {
  const res = await h.app.inject({ method: 'GET', url: '/v1/profiles', headers: authHeaders(user) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ profiles: Profile[] }>().profiles;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  // The patient's older self row comes first in the existing SQL sort. This
  // reproduces the bootstrap selection failure without rewriting any test row.
  patient = await signIn(h, '+966500092760');
  caregiver = await signIn(h, '+966500092761');
  const dependent = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(caregiver),
    payload: { displayName: 'Synthetic dependent', timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(dependent.statusCode, dependent.body).toBe(200);
  dependentId = dependent.json<{ profile: { id: string } }>().profile.id;
  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: { patientProfileId: patient.profileId, ...PANADOL, startDate: '2026-09-09', acknowledgeDuplicate: true },
  });
  expect(med.statusCode, med.body).toBe(200);
  medicationId = med.json<{ medication: { id: string } }>().medication.id;
  const invite = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(patient),
    payload: { patientProfileId: patient.profileId, invitedName: 'Read-only helper', invitedPhone: caregiver.phone,
      role: 'caregiver', permissions: ['view_medications'], escalationPriority: 1 },
  });
  expect(invite.statusCode, invite.body).toBe(200);
  const invitationLink = invite.json<{ invitationLink: string }>().invitationLink;
  const token = new URL(invitationLink).hash.slice(1);
  expect(token, 'invite response did not contain a fragment token').toBeTruthy();
  const accepted = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(caregiver), payload: { token },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
}, 120_000);

afterAll(async () => { await h?.close(); });

describe('self identity is relative to the authenticated profile-list caller', () => {
  it('the patient still receives their own self profile', async () => {
    expect((await profilesFor(patient)).find(p => p.id === patient.profileId)).toMatchObject({ isSelf: true, role: 'owner', permissions: null });
  });
  it('a view-only caregiver never receives another patient as their self', async () => {
    expect((await profilesFor(caregiver)).find(p => p.id === patient.profileId)).toMatchObject({
      isSelf: false, role: 'caregiver', permissions: ['view_medications'],
    });
  });
  it('the client self selector chooses the caller even when the older patient row sorts first', async () => {
    const profiles = await profilesFor(caregiver);
    expect(profiles.filter(p => p.isSelf).map(p => p.id)).toEqual([caregiver.profileId]);
    expect(profiles.find(p => p.isSelf)?.id).toBe(caregiver.profileId);
  });
  it('an owned dependent remains owner-accessible but is not the caller self', async () => {
    expect((await profilesFor(caregiver)).find(p => p.id === dependentId)).toMatchObject({ isSelf: false, role: 'owner', permissions: null });
  });
  it('positive control: the caregiver can still read the explicitly granted medication', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/v1/medications?profileId=${patient.profileId}`, headers: authHeaders(caregiver) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ medications: Array<{ id: string }> }>().medications.map(m => m.id)).toContain(medicationId);
  });
  it('negative control: misleading self metadata never bypassed server write permission', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(caregiver),
      payload: { patientProfileId: patient.profileId, ...PANADOL, name: 'UNAUTHORIZED-SYNTHETIC', startDate: '2026-09-09', acknowledgeDuplicate: true },
    });
    expect(res.statusCode, res.body).toBe(403);
    const list = await h.app.inject({ method: 'GET', url: `/v1/medications?profileId=${patient.profileId}`, headers: authHeaders(patient) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain('UNAUTHORIZED-SYNTHETIC');
  });
});
