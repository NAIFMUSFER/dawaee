import { reviewAndAcceptInvitation } from './reviewed-invitation-fixture.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, resetDatabase, signIn, startHarness,
  type Harness, type TestUser,
} from './harness.js';

let h: Harness;
let patient: TestUser;
let intended: TestUser;
let attacker: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500091101');
  intended = await signIn(h, '+966500091102');
  attacker = await signIn(h, '+966500091103');
});

afterAll(async () => {
  await h.close();
});

describe('caregiver invitation phone binding', () => {
  it('refuses a valid bearer token from the wrong signed-in phone without burning it', async () => {
    const invite = await h.app.inject({
      method: 'POST',
      url: '/v1/caregivers/invite',
      headers: authHeaders(patient),
      payload: {
        patientProfileId: patient.profileId,
        invitedName: 'Intended caregiver',
        invitedPhone: intended.phone,
        role: 'caregiver',
        permissions: ['view_schedule'],
        escalationPriority: 1,
      },
    });
    expect(invite.statusCode, invite.body).toBe(200);

    const link = invite.json<{ invitationLink: string }>().invitationLink;
    const token = link.split('/invite/')[1]!;
    expect(token).toBeTruthy();

    // The invitation is addressed to `intended.phone`. Possession of a copied
    // or forwarded bearer link must not let another authenticated account bind
    // itself as the caregiver.
    const stolen = await reviewAndAcceptInvitation(options => h.app.inject(options), {
      method: 'POST',
      url: '/v1/caregivers/invitations/preview',
      headers: authHeaders(attacker),
      payload: { token },
    });
    expect(stolen.statusCode, stolen.body).toBe(404);
    expect(stolen.json<{ error: { code: string } }>().error.code).toBe('invitation_invalid');

    // A wrong-account attempt must not consume the capability. The account
    // whose verified application identity carries the invited phone can still
    // redeem the exact same token once.
    const accepted = await reviewAndAcceptInvitation(options => h.app.inject(options), {
      method: 'POST',
      url: '/v1/caregivers/invitations/preview',
      headers: authHeaders(intended),
      payload: { token },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<{ accepted: boolean }>().accepted).toBe(true);

    const replay = await reviewAndAcceptInvitation(options => h.app.inject(options), {
      method: 'POST',
      url: '/v1/caregivers/invitations/preview',
      headers: authHeaders(intended),
      payload: { token },
    });
    expect(replay.statusCode, replay.body).toBe(404);
  });
});
