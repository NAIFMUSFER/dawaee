import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;
let relationshipId: string;

const MEDICATION = 'SYNTHETIC-CAREGIVER-PRIVATE-MED';
const DATE = '2026-04-06';
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 3, 6, hh - 3, mm, 0));
};

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500097797');
  caregiver = await signIn(h, '+966500097798');

  // The patient explicitly opts in to seeing medication names on THEIR own
  // lock screen. That preference must not silently grant medication visibility
  // to a caregiver whose relationship lacks view_medications.
  const preference = await h.app.inject({
    method: 'PATCH',
    url: '/v1/me/preferences',
    headers: authHeaders(patient),
    payload: { showMedicationInNotifications: true },
  });
  expect(preference.statusCode, preference.body).toBe(200);

  const push = await h.app.inject({
    method: 'POST',
    url: '/v1/devices/push-token',
    headers: authHeaders(caregiver),
    payload: {
      token: 'ExponentPushToken[caregiver-permission-boundary]',
      platform: 'ios',
      deviceId: 'caregiver-permission-boundary',
    },
  });
  expect(push.statusCode, push.body).toBe(200);

  // This is the shipped observer permission shape: it can receive adherence
  // notifications but is deliberately NOT allowed to view medication identity.
  const rel = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, invited_phone_e164, invited_name,
        role, status, permissions, escalation_priority, invited_by_user_id, accepted_at)
     VALUES ($1,$2,$3,'Observer','caregiver','active',
             ARRAY['view_schedule','view_adherence','receive_notifications']::text[],
             1,$4,now())
     RETURNING id`,
    [patient.profileId, caregiver.userId, '+966500097798', patient.userId],
  );
  relationshipId = rel.rows[0]!.id;

  await db.query(
    `INSERT INTO caregiver_notification_rules
       (relationship_id, patient_profile_id, channel, mode, enabled)
     VALUES ($1,$2,'push','every_dose',true)`,
    [relationshipId, patient.profileId],
  );

  const policy = await h.app.inject({
    method: 'PUT',
    url: `/v1/escalation-policy?profileId=${patient.profileId}`,
    headers: authHeaders(patient),
    payload: {
      enabled: true,
      stages: [{ afterMinutes: 0, target: 'primary_caregiver', channels: ['push'] }],
    },
  });
  expect(policy.statusCode, policy.body).toBe(200);

  h.setNow(at('08:00'));
  const medication = await h.app.inject({
    method: 'POST',
    url: '/v1/medications',
    headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      name: MEDICATION,
      form: 'tablet',
      strengthValue: 10,
      strengthUnit: 'mg',
      foodInstruction: 'no_preference',
      startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: ['20:00'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: DATE,
        lateAfterMinutes: 15,
        missedAfterMinutes: 60,
      },
    },
  });
  expect(medication.statusCode, medication.body).toBe(200);
}, 120_000);

afterAll(async () => {
  if (db) await db.end();
  if (h) await h.close();
});

describe('caregiver notification text cannot outrank caregiver medication permission', () => {
  it('withholds medication identity from an observer even when the patient opted in to names', async () => {
    h.setNow(at('20:00'));
    await h.tick();

    const stored = await h.worker.pool.query<{ body: string; payload: unknown }>(
      `SELECT body, payload
         FROM notification_deliveries
        WHERE relationship_id = $1 AND kind = 'escalation'
        ORDER BY created_at DESC LIMIT 1`,
      [relationshipId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.body).not.toContain(MEDICATION);
    expect(JSON.stringify(stored.rows[0]!.payload)).not.toContain(MEDICATION);

    // Dispatcher runs before reminder enqueue in a tick, so a second tick
    // exercises the actual push-provider path for the queued caregiver alert.
    h.setNow(at('20:01'));
    await h.tick();
    const pushes = h.push.sent.filter((item) => item.to === 'ExponentPushToken[caregiver-permission-boundary]');
    expect(pushes.length, 'the caregiver escalation was actually dispatched').toBeGreaterThan(0);
    for (const item of pushes) {
      expect(item.body).not.toContain(MEDICATION);
      expect(JSON.stringify(item)).not.toContain(MEDICATION);
    }
  });
});
