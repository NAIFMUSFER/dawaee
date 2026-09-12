import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let patient: TestUser;
let doseId: string;
const MEDICATION = 'SYNTHETIC-PRIVACY-MED';

const DATE = '2026-04-02';
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 3, 2, hh - 3, mm, 0));
};

const setDisclosure = (on: boolean) =>
  h.app.inject({
    method: 'PATCH', url: '/v1/me/preferences', headers: authHeaders(patient),
    payload: { showMedicationInNotifications: on },
  });

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500000900', 'privacy-1');

  await h.app.inject({
    method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(patient),
    payload: { token: 'ExponentPushToken[privacy-device]', platform: 'ios', deviceId: 'privacy-1' },
  });

  await h.app.inject({
    method: 'PUT', url: `/v1/escalation-policy?profileId=${patient.profileId}`, headers: authHeaders(patient),
    payload: {
      enabled: true,
      stages: [
        { afterMinutes: 0, target: 'patient', channels: ['push'] },
        { afterMinutes: 60, target: 'patient', channels: ['push'] },
        { afterMinutes: 120, target: 'patient', channels: ['push'] },
      ],
    },
  });

  h.setNow(at('08:00'));

  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, name: MEDICATION, form: 'tablet',
      strengthValue: 100, strengthUnit: 'mg', foodInstruction: 'after_food', startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: ['20:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: DATE,
        lateAfterMinutes: 15, missedAfterMinutes: 180,
      },
    },
  });
  expect(med.statusCode).toBe(200);

  const doses = await h.app.inject({
    method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=${DATE}&to=${DATE}`,
    headers: authHeaders(patient),
  });
  doseId = doses.json().doses[0].id;
  expect(doseId).toBeTruthy();
});

afterAll(async () => { await h.close(); });

describe('the push the server actually sends respects the patient’s choice', () => {
  it('names no medication by default', async () => {
    h.setNow(at('20:00'));
    await h.tick();

    const sent = h.push.sent;
    expect(sent.length, 'the reminder was sent at all').toBeGreaterThan(0);
    for (const push of sent) {
      expect(push.body, 'no medication name in the body').not.toContain(MEDICATION);
      expect(push.body).not.toContain('1 tablet');
      expect(JSON.stringify(push), 'nor anywhere else in the payload').not.toContain(MEDICATION);
    }
  });

  it('still tells the patient a dose is due, and when', async () => {
    const body = h.push.sent[0]!.body;
    expect(body).toContain('20:00');
    expect(body.length).toBeGreaterThan(20);
  });

  it('names it once the patient opts in, on the same path', async () => {
    expect((await setDisclosure(true)).statusCode).toBe(200);

    const before = h.push.sent.length;
    h.setNow(at('21:30'));
    await h.tick();

    const fresh = h.push.sent.slice(before);
    expect(fresh.length, 'a further reminder went out').toBeGreaterThan(0);
    expect(fresh.some((p) => p.body.includes(MEDICATION)), 'now named').toBe(true);
  });

  it('goes back to generic when the patient opts out again', async () => {
    expect((await setDisclosure(false)).statusCode).toBe(200);
    const before = h.push.sent.length;
    h.setNow(at('22:30'));
    await h.tick();

    for (const push of h.push.sent.slice(before)) {
      expect(push.body).not.toContain(MEDICATION);
    }
  });
});

describe('the stored delivery row follows the same policy', () => {
  it('writes no medication name into the payload in generic mode', async () => {
    const { rows } = await h.worker.pool.query<{ payload: unknown; body: string }>(
      `SELECT payload, body FROM notification_deliveries
        WHERE dose_occurrence_id = $1 ORDER BY created_at`,
      [doseId],
    );
    expect(rows.length).toBeGreaterThan(0);

    const generic = rows.filter((r) => !r.body.includes(MEDICATION));
    expect(generic.length, 'at least one generic delivery was recorded').toBeGreaterThan(0);
    for (const row of generic) {
      expect(JSON.stringify(row.payload)).not.toContain(MEDICATION);
    }
  });
});
