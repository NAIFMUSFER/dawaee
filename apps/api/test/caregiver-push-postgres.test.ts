import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchJob } from '../../worker/src/jobs/dispatcher.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

// Unlike the envelope unit suite, every query here runs against PostgreSQL.
// Only the outbound push provider records messages instead of sending them.
let h: Harness;
let db: pg.Pool;
let patient: TestUser;
let caregiver: TestUser;
let relationshipId: string;
let doseId: string;
let medicationId: string;
const DATE = '2026-04-07';
const NOW = new Date(`${DATE}T17:02:00.000Z`);
const PATIENT = 'SYNTHETIC-PRIVATE-PATIENT';
const MEDICATION = 'SYNTHETIC-PRIVATE-MEDICATION';
const DEVICE = 'caregiver-postgres-device';
const TOKEN = 'ExponentPushToken[caregiver-postgres-device]';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 4 });
  patient = await signIn(h, '+966500097831');
  caregiver = await signIn(h, '+966500097832', DEVICE);
  const preference = await h.app.inject({
    method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(patient),
    payload: { showMedicationInNotifications: true },
  });
  expect(preference.statusCode, preference.body).toBe(200);
  const device = await h.app.inject({
    method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(caregiver),
    payload: { token: TOKEN, platform: 'android', deviceId: DEVICE },
  });
  expect(device.statusCode, device.body).toBe(200);

  h.setNow(new Date(`${DATE}T05:00:00.000Z`));
  const medication = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, name: MEDICATION, form: 'tablet',
      strengthValue: 10, strengthUnit: 'mg', foodInstruction: 'no_preference', startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: ['20:00'] }, doseQuantity: 1, doseUnit: 'tablet',
        startDate: DATE, lateAfterMinutes: 15, missedAfterMinutes: 120,
      },
    },
  });
  expect(medication.statusCode, medication.body).toBe(200);
  const { rows } = await db.query<{ id: string; medication_id: string }>(
    `SELECT d.id, d.medication_id FROM dose_occurrences d
       JOIN medications m ON m.id = d.medication_id
      WHERE d.patient_profile_id = $1 AND m.name = $2 AND d.scheduled_local_date = $3`,
    [patient.profileId, MEDICATION, DATE],
  );
  expect(rows).toHaveLength(1);
  doseId = rows[0]!.id;
  medicationId = rows[0]!.medication_id;
}, 120_000);

beforeEach(async () => {
  h.setNow(NOW);
  h.push.reset();
  await db.query('DELETE FROM notification_deliveries WHERE patient_profile_id = $1', [patient.profileId]);
  await db.query(
    'DELETE FROM caregiver_relationships WHERE patient_profile_id = $1 AND caregiver_user_id = $2',
    [patient.profileId, caregiver.userId],
  );
  const relationship = await db.query<{ id: string }>(
    `INSERT INTO caregiver_relationships
       (patient_profile_id, caregiver_user_id, invited_phone_e164, invited_name, role,
        status, permissions, escalation_priority, invited_by_user_id, accepted_at)
     VALUES ($1,$2,$3,'Synthetic helper','caregiver','active',
             ARRAY['view_schedule','view_adherence','view_medications','receive_notifications']::text[],
             1,$4,now()) RETURNING id`,
    [patient.profileId, caregiver.userId, caregiver.phone, patient.userId],
  );
  relationshipId = relationship.rows[0]!.id;
  // This delivery was queued while the caregiver opted into this channel.
  await db.query(`INSERT INTO caregiver_notification_rules(relationship_id,patient_profile_id,channel,mode,enabled)
    VALUES($1,$2,'push','missed_only',true)`, [relationshipId, patient.profileId]);
  await db.query(
    `UPDATE dose_occurrences SET status = 'pending_confirmation', snoozed_until = NULL,
            snooze_count = 0, confirmed_at = NULL, confirmed_by_user_id = NULL,
            confirmation_method = NULL, confirmation_device_id = NULL, client_event_id = NULL,
            escalation_completed_at = NULL
      WHERE id = $1`,
    [doseId],
  );
});

afterAll(async () => {
  if (db) await db.end();
  if (h) await h.close();
});

async function enqueue(locale: 'ar' | 'en' = 'ar'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification_deliveries
       (patient_profile_id, recipient_user_id, relationship_id, dose_occurrence_id, medication_id,
        kind, channel, locale, title, body, payload, dedupe_key, scheduled_for, next_attempt_at, status)
     VALUES ($1,$2,$3,$4,$5,'escalation','push',$6,$7,$8,$9::jsonb,$10,$11,$11,'queued') RETURNING id`,
    [
      patient.profileId, caregiver.userId, relationshipId, doseId, medicationId, locale,
      `Follow up ${PATIENT}`, `${PATIENT}: ${MEDICATION} at 20:00`,
      JSON.stringify({ patientName: PATIENT, medicationName: MEDICATION, doseId,
        scheduledLocalTime: '20:00', actions: [] }),
      `caregiver-postgres-${randomUUID()}`, new Date(NOW.getTime() - 60_000),
    ],
  );
  return rows[0]!.id;
}

async function dispatch(afterDeviceLookup?: () => Promise<void>) {
  const client = await h.worker.pool.connect();
  let intercepted = false;
  try {
    // Delegate all queries to the real least-privileged worker connection. The
    // hook commits an API/fixture change after claim, before provider invocation.
    const query = async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (!intercepted && afterDeviceLookup && sql.includes('app.list_live_push_endpoints')) {
        intercepted = true;
        expect(result.rows.length, 'a real live-session endpoint is required').toBeGreaterThan(0);
        await afterDeviceLookup();
      }
      return result;
    };
    const result = await dispatchJob(h.worker, { query } as unknown as pg.PoolClient);
    if (afterDeviceLookup) expect(intercepted, 'interleaving hook was not reached').toBe(true);
    return result;
  } finally {
    client.release();
  }
}

async function status(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status::text AS status FROM notification_deliveries WHERE id = $1', [id],
  );
  return rows[0]!.status;
}

async function act(action: 'taken' | 'snooze') {
  const response = await h.app.inject({
    method: 'POST', url: '/v1/dose/action', headers: authHeaders(patient),
    payload: action === 'taken'
      ? { doseId, action, clientEventId: randomUUID(), method: 'app', takenAt: NOW.toISOString() }
      : { doseId, action, clientEventId: randomUUID(), minutes: 15 },
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe('caregiver push on real PostgreSQL and least-privileged worker', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`keeps ${locale} provider content generic while retaining the protected outbox record`, async () => {
      const id = await enqueue(locale);
      expect(await dispatch()).toEqual({ itemsProcessed: 1 });
      expect(h.push.sent).toHaveLength(1);
      const message = h.push.sent[0]!;
      expect(message.token).toBe(TOKEN);
      expect(message.title).toBe(locale === 'ar' ? 'دوائي — تنبيه متابعة' : 'Dawaee — Follow-up alert');
      expect(message.data).toEqual({ deliveryId: id, kind: 'escalation' });
      expect(message.categoryId).toBeUndefined();
      for (const sensitive of [PATIENT, MEDICATION, doseId, medicationId, patient.profileId, '20:00']) {
        expect(JSON.stringify(message)).not.toContain(sensitive);
      }
      const stored = await db.query<{ body: string }>('SELECT body FROM notification_deliveries WHERE id = $1', [id]);
      expect(stored.rows[0]!.body).toContain(PATIENT);
      expect(await status(id)).toBe('sent');
      expect(await dispatch()).toEqual({ itemsProcessed: 0 });
      expect(h.push.sent, 'a completed delivery must not be dispatched twice').toHaveLength(1);
    });
  }

  for (const terminal of ['taken', 'taken_late', 'skipped', 'cancelled']) {
    it(`does not send a claimed escalation when its dose becomes ${terminal}`, async () => {
      const id = await enqueue();
      expect(await dispatch(async () => {
        await db.query(
          `UPDATE dose_occurrences SET status = $2::dose_status,
                  confirmed_at = CASE WHEN $2 IN ('taken','taken_late') THEN $3::timestamptz ELSE NULL END,
                  confirmation_method = CASE WHEN $2 IN ('taken','taken_late') THEN 'app'::confirmation_method ELSE NULL END
            WHERE id = $1`,
          [doseId, terminal, NOW],
        );
      })).toEqual({ itemsProcessed: 0 });
      expect(h.push.sent).toHaveLength(0);
      expect(await status(id)).toBe('skipped');
    });
  }

  it('observes a real patient confirmation committed after device lookup', async () => {
    const id = await enqueue();
    expect(await dispatch(() => act('taken'))).toEqual({ itemsProcessed: 0 });
    expect(h.push.sent).toHaveLength(0);
    expect(await status(id)).toBe('skipped');
  });

  it('respects a new snooze committed after device lookup', async () => {
    const id = await enqueue();
    expect(await dispatch(() => act('snooze'))).toEqual({ itemsProcessed: 0 });
    expect(h.push.sent, 'a newly postponed dose must not generate an immediate caregiver alarm').toHaveLength(0);
    expect(await status(id)).toBe('skipped');
  });

  it('still dispatches an unconfirmed escalation after its snooze has expired', async () => {
    await db.query(
      `UPDATE dose_occurrences SET status = 'snoozed', snoozed_until = $2 WHERE id = $1`,
      [doseId, new Date(NOW.getTime() - 60_000)],
    );
    const id = await enqueue();
    expect(await dispatch()).toEqual({ itemsProcessed: 1 });
    expect(h.push.sent).toHaveLength(1);
    expect(await status(id)).toBe('sent');
  });

  for (const offsetMs of [1, 0]) {
    it(`checks the snooze boundary at worker time plus ${offsetMs}ms`, async () => {
      const id = await enqueue();
      const eligible = offsetMs === 0;
      expect(await dispatch(async () => {
        await db.query(
          `UPDATE dose_occurrences SET status = 'snoozed', snoozed_until = $2 WHERE id = $1`,
          [doseId, new Date(NOW.getTime() + offsetMs)],
        );
      })).toEqual({ itemsProcessed: eligible ? 1 : 0 });
      expect(h.push.sent).toHaveLength(eligible ? 1 : 0);
      expect(await status(id)).toBe(eligible ? 'sent' : 'skipped');
    });
  }

  it('does not trust a payload dose identifier when the authoritative dose link is missing', async () => {
    const id = await enqueue();
    await db.query('UPDATE notification_deliveries SET dose_occurrence_id = NULL WHERE id = $1', [id]);
    expect(await dispatch()).toEqual({ itemsProcessed: 0 });
    expect(h.push.sent).toHaveLength(0);
    expect(await status(id)).toBe('skipped');
  });

  it('does not send from a lease invalidated after device lookup', async () => {
    const id = await enqueue();
    expect(await dispatch(async () => {
      await db.query(
        `UPDATE notification_deliveries SET status = 'skipped', lease_token = NULL, lease_until = NULL WHERE id = $1`,
        [id],
      );
    })).toEqual({ itemsProcessed: 0 });
    expect(h.push.sent).toHaveLength(0);
    expect(await status(id)).toBe('skipped');
  });

  it('honors a real caregiver revocation committed after device lookup', async () => {
    const id = await enqueue();
    expect(await dispatch(async () => {
      const revoked = await h.app.inject({
        method: 'DELETE', url: `/v1/caregivers/${relationshipId}`, headers: authHeaders(patient),
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
    })).toEqual({ itemsProcessed: 0 });
    expect(h.push.sent).toHaveLength(0);
    expect(await status(id)).toBe('skipped');
  });
});
