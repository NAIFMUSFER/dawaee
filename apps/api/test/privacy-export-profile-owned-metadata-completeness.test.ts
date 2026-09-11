import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Red-team regression for profile-scoped records that are readable by the
 * profile owner but were not represented by the privacy screen's "all data for
 * this profile" export.
 *
 * Keep the fixtures synthetic and assert each domain independently so CI proves
 * each omission rather than stopping at the first missing collection.
 */
let h: Harness;
let patient: TestUser;
let caregiverRuleId: string;
let travelPromptId: string;
let storedObjectId: string;

const psqlScalar = (sql: string) => execFileSync('psql', ['-d', 'dawaee_test', '-tAc', sql], {
  env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
}).toString().trim().split(/\r?\n/, 1)[0] ?? '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097775');

  const relationshipId = psqlScalar(`
    INSERT INTO caregiver_relationships
      (patient_profile_id, invited_phone_e164, invited_name, role, status,
       invitation_token_hash, invitation_expires_at, invitation_channel,
       invited_by_user_id)
    VALUES
      ('${patient.profileId}', '+966500097776', 'SYNTHETIC-EXPORT-CAREGIVER',
       'caregiver', 'pending', 'synthetic-export-token-${patient.profileId}',
       now() + interval '1 day', 'link', '${patient.userId}')
    RETURNING id
  `);

  caregiverRuleId = psqlScalar(`
    INSERT INTO caregiver_notification_rules
      (relationship_id, patient_profile_id, channel, mode,
       consecutive_missed_threshold, quiet_hours_start, quiet_hours_end, enabled)
    VALUES
      ('${relationshipId}', '${patient.profileId}', 'sms', 'consecutive_missed',
       3, '22:00', '06:00', true)
    RETURNING id
  `);

  travelPromptId = psqlScalar(`
    INSERT INTO travel_prompts
      (patient_profile_id, detected_timezone, previous_timezone,
       offset_shift_hours, decision, decided_at)
    VALUES
      ('${patient.profileId}', 'Europe/London', 'Asia/Riyadh',
       -3, 'keep_home_time', '2026-09-10T09:00:00Z')
    RETURNING id
  `);

  storedObjectId = psqlScalar(`
    INSERT INTO stored_objects
      (object_key, owner_user_id, patient_profile_id, purpose, content_type,
       byte_size, sha256, scan_status, uploaded_at)
    VALUES
      ('medication_image/synthetic-export-object', '${patient.userId}', '${patient.profileId}',
       'medication_image', 'image/jpeg', 1234,
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'clean', '2026-09-10T09:30:00Z')
    RETURNING id
  `);
});

afterAll(async () => { await h.close(); });

const exportData = async () => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/v1/reports/export?profileId=${patient.profileId}`,
    headers: authHeaders(patient),
    remoteAddress: '198.51.100.81',
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ data: Record<string, Array<Record<string, unknown>> | undefined> }>().data;
};

describe('privacy export remaining profile-owned metadata completeness', () => {
  it('includes caregiver notification rules owned by the profile', async () => {
    const data = await exportData();
    expect(data.caregiverNotificationRules).toBeDefined();
    expect(data.caregiverNotificationRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: caregiverRuleId,
        patient_profile_id: patient.profileId,
        channel: 'sms',
        mode: 'consecutive_missed',
        consecutive_missed_threshold: 3,
        enabled: true,
      }),
    ]));
  });

  it('includes the profile travel-decision history', async () => {
    const data = await exportData();
    expect(data.travelPrompts).toBeDefined();
    expect(data.travelPrompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: travelPromptId,
        patient_profile_id: patient.profileId,
        detected_timezone: 'Europe/London',
        previous_timezone: 'Asia/Riyadh',
        decision: 'keep_home_time',
      }),
    ]));
  });

  it('includes profile-owned upload metadata', async () => {
    const data = await exportData();
    expect(data.storedObjects).toBeDefined();
    expect(data.storedObjects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: storedObjectId,
        patient_profile_id: patient.profileId,
        purpose: 'medication_image',
        content_type: 'image/jpeg',
        byte_size: 1234,
        scan_status: 'clean',
      }),
    ]));
  });
});
