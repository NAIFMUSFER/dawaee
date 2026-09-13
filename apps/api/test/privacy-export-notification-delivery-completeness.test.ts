import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Red-team regression for the privacy export contract.
 *
 * Notification delivery rows are directly patient-profile scoped and preserve
 * what the service attempted or actually sent, to whom, through which channel,
 * and when. A "full data export" that silently omits this history is incomplete.
 */
let h: Harness;
let patient: TestUser;
let deliveryId: string;

const psqlScalar = (sql: string) => execFileSync('psql', ['-d', 'dawaee_test', '-tAc', sql], {
  env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
}).toString().trim().split(/\r?\n/, 1)[0] ?? '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097774');

  deliveryId = psqlScalar(`
    INSERT INTO notification_deliveries
      (patient_profile_id, recipient_user_id, kind, channel, status,
       locale, title, body, payload, dedupe_key, scheduled_for,
       next_attempt_at, sent_at, delivered_at)
    VALUES
      ('${patient.profileId}', '${patient.userId}', 'system', 'in_app', 'delivered',
       'ar', 'SYNTHETIC-NOTIFICATION-TITLE', 'SYNTHETIC-NOTIFICATION-BODY',
       '{"audit":"SYNTHETIC-NOTIFICATION-PAYLOAD"}'::jsonb,
       'privacy-export-notification-${patient.profileId}',
       '2026-09-10T08:00:00Z', '2026-09-10T08:00:00Z',
       '2026-09-10T08:00:01Z', '2026-09-10T08:00:02Z')
    RETURNING id
  `);
});

afterAll(async () => { await h.close(); });

describe('privacy export notification-delivery completeness', () => {
  it('includes profile-scoped notification delivery history in the full data export', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/reports/export?profileId=${patient.profileId}`,
      headers: authHeaders(patient),
      remoteAddress: '198.51.100.80',
    });

    expect(res.statusCode, res.body).toBe(200);
    const payload = res.json<{ data: { notificationDeliveries?: Array<Record<string, unknown>> } }>();
    expect(payload.data.notificationDeliveries).toBeDefined();
    expect(payload.data.notificationDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deliveryId,
        patient_profile_id: patient.profileId,
        recipient_user_id: patient.userId,
        kind: 'system',
        channel: 'in_app',
        status: 'delivered',
        title: 'SYNTHETIC-NOTIFICATION-TITLE',
        body: 'SYNTHETIC-NOTIFICATION-BODY',
        payload: { audit: 'SYNTHETIC-NOTIFICATION-PAYLOAD' },
      }),
    ]));
  });
});
