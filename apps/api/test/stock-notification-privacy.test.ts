import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let patient: TestUser;
const MEDICATION = 'SYNTHETIC-PRIVATE-STOCK-DRUG';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097798');

  // Keep the account on the product default: medication names are private in
  // notifications unless the patient explicitly opts in.
  const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(patient) });
  expect(me.statusCode).toBe(200);
  expect(me.json().preferences.showMedicationInNotifications).toBe(false);

  expect((await h.app.inject({
    method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(patient),
    payload: { token: 'ExponentPushToken[stock-privacy-device]', platform: 'ios', deviceId: 'stock-privacy-1' },
  })).statusCode).toBe(200);

  h.setNow(new Date('2026-04-05T05:00:00.000Z')); // 08:00 Riyadh
  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      name: MEDICATION,
      form: 'tablet',
      strengthValue: 10,
      strengthUnit: 'mg',
      foodInstruction: 'no_preference',
      startDate: '2026-04-05',
      schedule: {
        rule: { kind: 'fixed_times', times: ['20:00'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: '2026-04-05',
        lateAfterMinutes: 15,
        missedAfterMinutes: 180,
      },
      stock: {
        trackingEnabled: true,
        initialQuantity: 1,
        unit: 'tablet',
        lowStockThresholdDays: 7,
      },
    },
  });
  expect(med.statusCode, med.body).toBe(200);
}, 120_000);

afterAll(async () => {
  if (h) await h.close();
});

describe('stock alerts obey the same lock-screen medication privacy control as dose reminders', () => {
  it('does not store or send a medication name while the patient remains opted out', async () => {
    // Dispatcher runs before stock-alerts in a tick. First tick enqueues; second
    // tick sends, keeping this an actual worker/outbox path instead of a string
    // helper assertion.
    await h.tick();

    const stored = await h.worker.pool.query<{ body: string; payload: unknown; status: string }>(
      `SELECT body, payload, status::text AS status
         FROM notification_deliveries
        WHERE patient_profile_id = $1 AND kind = 'low_stock'
        ORDER BY created_at DESC LIMIT 1`,
      [patient.profileId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.body).not.toContain(MEDICATION);
    expect(JSON.stringify(stored.rows[0]!.payload)).not.toContain(MEDICATION);

    h.setNow(new Date('2026-04-05T05:01:00.000Z'));
    await h.tick();

    const stockPushes = h.push.sent.filter((push) => push.data.kind === 'low_stock');
    expect(stockPushes.length, 'the low-stock alert was actually dispatched').toBeGreaterThan(0);
    for (const push of stockPushes) {
      expect(push.body).not.toContain(MEDICATION);
      expect(JSON.stringify(push)).not.toContain(MEDICATION);
    }
  });
});
