import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, resetDatabase, signIn, startHarness,
  type Harness, type TestUser,
} from './harness.js';

let h: Harness;
let owner: TestUser;
let stranger: TestUser;
let inviteSequence = 0;

async function inviteRelationship(): Promise<string> {
  inviteSequence += 1;
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/caregivers/invite',
    headers: authHeaders(owner),
    payload: {
      patientProfileId: owner.profileId,
      invitedName: `Fixed path ${inviteSequence}`,
      invitedPhone: `+96651123${String(4500 + inviteSequence).padStart(4, '0')}`,
      role: 'other',
      permissions: ['view_adherence'],
      escalationPriority: 5,
      channel: 'link',
      expiresInHours: 72,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ relationshipId: string }>().relationshipId;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = await signIn(h, '+966511234401');
  stranger = await signIn(h, '+966511234402');
});

afterAll(async () => {
  await h.close();
});

describe('fixed-path caregiver mutations', () => {
  it('updates permissions without putting relationshipId in the route', async () => {
    const relationshipId = await inviteRelationship();
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/v1/caregivers/permissions',
      headers: authHeaders(owner),
      payload: {
        relationshipId,
        permissions: ['view_adherence', 'view_medications'],
        escalationPriority: 4,
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ caregiver: { permissions: string[]; escalation_priority: number } }>().caregiver)
      .toMatchObject({ escalation_priority: 4 });
  });

  it('updates notification rules through a fixed public path', async () => {
    const relationshipId = await inviteRelationship();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/v1/caregivers/notification-rules',
      headers: authHeaders(owner),
      payload: {
        relationshipId,
        channel: 'push',
        mode: 'missed_only',
        consecutiveMissedThreshold: 2,
        summaryTime: null,
        quietHoursStart: null,
        quietHoursEnd: null,
        enabled: true,
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ rule: { channel: string; enabled: boolean } }>().rule)
      .toMatchObject({ channel: 'push', enabled: true });
  });

  it('does not let an unrelated account mutate a relationship by body id', async () => {
    const relationshipId = await inviteRelationship();
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/v1/caregivers/permissions',
      headers: authHeaders(stranger),
      payload: { relationshipId, permissions: ['view_adherence', 'manage_caregivers'] },
    });

    expect(res.statusCode, res.body).toBe(404);
  });

  it('revokes through a fixed path and preserves owner authorization', async () => {
    const relationshipId = await inviteRelationship();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/caregivers/revoke',
      headers: authHeaders(owner),
      payload: { relationshipId },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ revoked: boolean; selfRemoval: boolean }>()).toEqual({
      revoked: true,
      selfRemoval: false,
    });
  });

  it('rejects malformed relationship identifiers at the request edge', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/caregivers/revoke',
      headers: authHeaders(owner),
      payload: { relationshipId: 'not-a-uuid' },
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });
});
