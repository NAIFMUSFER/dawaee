import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PushMessage, PushSendResult } from '../src/providers/types.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let patient: TestUser;

const DATE = '2026-04-04';
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 3, 4, hh - 3, mm, 0));
};

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097797');

  await h.app.inject({
    method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(patient),
    payload: { token: 'ExponentPushToken[privacy-retry-device]', platform: 'ios', deviceId: 'privacy-retry-1' },
  });

  expect((await h.app.inject({
    method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(patient),
    payload: { showMedicationInNotifications: true },
  })).statusCode).toBe(200);

  expect((await h.app.inject({
    method: 'PUT', url: `/v1/escalation-policy?profileId=${patient.profileId}`, headers: authHeaders(patient),
    payload: {
      enabled: true,
      stages: [{ afterMinutes: 0, target: 'patient', channels: ['push'] }],
    },
  })).statusCode).toBe(200);

  h.setNow(at('08:00'));
  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      name: 'SYNTHETIC-PRIVATE-RETRY-DRUG',
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
        missedAfterMinutes: 180,
      },
    },
  });
  expect(med.statusCode, med.body).toBe(200);
}, 120_000);

afterAll(async () => {
  if (h) await h.close();
});

describe('notification privacy is evaluated again before a queued retry leaves the system', () => {
  it('does not send a stored medication name after the patient opts out while delivery is queued', async () => {
    const originalSend = h.push.send.bind(h.push);
    h.push.send = async (messages: PushMessage[]): Promise<PushSendResult[]> =>
      messages.map(() => ({ ok: false, errorCode: 'network_error', retryable: true }));

    h.setNow(at('20:00'));
    await h.tick();

    const queued = await h.worker.pool.query<{ id: string; status: string; body: string; next_attempt_at: Date }>(
      `SELECT id, status::text AS status, body, next_attempt_at
         FROM notification_deliveries
        WHERE patient_profile_id = $1 AND channel = 'push'
        ORDER BY created_at DESC LIMIT 1`,
      [patient.profileId],
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]!.status).toBe('queued');
    expect(queued.rows[0]!.body).toContain('SYNTHETIC-PRIVATE-RETRY-DRUG');
    // Retry time is derived from the worker's authoritative clock, not the
    // database wall clock. First backoff is exactly thirty seconds.
    expect(queued.rows[0]!.next_attempt_at.toISOString()).toBe('2026-04-04T17:00:30.000Z');
    expect(h.push.sent).toHaveLength(0);

    // Privacy becomes stricter before the retry is due. This must affect what
    // actually leaves Dawaee, not only newly-created delivery rows.
    expect((await h.app.inject({
      method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(patient),
      payload: { showMedicationInNotifications: false },
    })).statusCode).toBe(200);

    h.push.send = originalSend;
    h.setNow(at('20:01'));
    await h.tick();

    expect(h.push.sent.length, 'the queued retry was sent').toBeGreaterThan(0);
    for (const push of h.push.sent) {
      expect(push.body).not.toContain('SYNTHETIC-PRIVATE-RETRY-DRUG');
      expect(JSON.stringify(push)).not.toContain('SYNTHETIC-PRIVATE-RETRY-DRUG');
    }
  });
});
