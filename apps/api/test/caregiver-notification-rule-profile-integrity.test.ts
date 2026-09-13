import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, resetDatabase, signIn, startHarness,
  type Harness, type TestUser,
} from './harness.js';

let h: Harness;
let owner: pg.Pool;
let user: TestUser;
let secondProfileId = '';
let relationshipId = '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  user = await signIn(h, '+966500096901');

  const second = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(user),
    payload: { displayName: 'Second patient', timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(second.statusCode, second.body).toBe(200);
  secondProfileId = second.json<{ profile: { id: string } }>().profile.id;

  const invite = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      invitedName: 'Profile boundary helper',
      invitedPhone: '+966500096902',
      role: 'caregiver',
      permissions: ['view_adherence', 'view_schedule', 'receive_notifications'],
      escalationPriority: 1,
    },
  });
  expect(invite.statusCode, invite.body).toBe(200);
  relationshipId = invite.json<{ relationshipId: string }>().relationshipId;
}, 120_000);

afterAll(async () => {
  await owner.end();
  await h.close();
});

describe('caregiver notification rules stay on their relationship patient profile', () => {
  it('rejects a direct cross-profile rule insert at the database boundary', async () => {
    await expect(owner.query(
      `INSERT INTO caregiver_notification_rules
         (relationship_id, patient_profile_id, channel, mode, enabled)
       VALUES ($1, $2, 'sms', 'missed_only', false)`,
      [relationshipId, secondProfileId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'caregiver_rule_profile_match' });
  });

  it('rejects moving an existing relationship rule onto another owned profile', async () => {
    await expect(owner.query(
      `UPDATE caregiver_notification_rules
          SET patient_profile_id = $2
        WHERE relationship_id = $1 AND channel = 'push'`,
      [relationshipId, secondProfileId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'caregiver_rule_profile_match' });
  });

  it('still accepts a same-profile rule', async () => {
    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO caregiver_notification_rules
         (relationship_id, patient_profile_id, channel, mode, enabled)
       VALUES ($1, $2, 'sms', 'missed_only', false)
       RETURNING id::text`,
      [relationshipId, user.profileId],
    );
    expect(inserted.rowCount).toBe(1);
  });
});
