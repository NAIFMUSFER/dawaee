import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * The disclosure policy, driven through the real worker rather than asserted
 * against the text builder alone.
 *
 * The builder tests prove the strings are right. This proves the flag actually
 * reaches the push the server sends — which is the half that was broken by
 * construction before, because the phone and the worker each rendered their own
 * body and only the phone would ever have been changed.
 */

let h: Harness;
let patient: TestUser;
let doseId: string;

const DATE = '2026-04-02';
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  // Riyadh is UTC+3.
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
  patient = await signIn(h, '+966500000900');

  await h.app.inject({
    method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(patient),
    payload: { token: 'ExponentPushToken[privacy-device]', platform: 'ios', deviceId: 'privacy-1' },
  });

  await h.app.inject({
    method: 'PUT', url: `/v1/escalation-policy?profileId=${patient.profileId}`, headers: authHeaders(patient),
    // Two patient stages, so a later tick sends a SECOND reminder for the same
    // dose. That is what lets the opt-in case below observe a fresh push
    // without undoing state the earlier assertions depend on.
    payload: {
      enabled: true,
      stages: [
        { afterMinutes: 0, target: 'patient', channels: ['push'] },
        { afterMinutes: 60, target: 'patient', channels: ['push'] },
        { afterMinutes: 120, target: 'patient', channels: ['push'] },
      ],
    },
  });

  // Place both clocks on the scenario day before the medication is created,
  // so the dose is materialized into a window the queries below can see.
  h.setNow(at('08:00'));

  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, name: 'Clozapine', form: 'tablet',
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
      expect(push.body, 'no drug name in the body').not.toContain('Clozapine');
      expect(push.body).not.toContain('1 tablet');
      expect(JSON.stringify(push), 'nor anywhere else in the payload').not.toContain('Clozapine');
    }
  });

  /**
   * The body is still actionable. A notification an elderly patient cannot act
   * on is not a privacy win — it is a missed dose with better optics.
   */
  it('still tells the patient a dose is due, and when', async () => {
    const body = h.push.sent[0]!.body;
    expect(body).toContain('20:00');
    expect(body.length).toBeGreaterThan(20);
  });

  it('names it once the patient opts in, on the same path', async () => {
    expect((await setDisclosure(true)).statusCode).toBe(200);

    const before = h.push.sent.length;
    // Stage 2 of the ladder, an hour later, for the same unconfirmed dose.
    h.setNow(at('21:30'));
    await h.tick();

    const fresh = h.push.sent.slice(before);
    expect(fresh.length, 'a further reminder went out').toBeGreaterThan(0);
    expect(fresh.some((p) => p.body.includes('Clozapine')), 'now named').toBe(true);
  });

  it('goes back to generic when the patient opts out again', async () => {
    expect((await setDisclosure(false)).statusCode).toBe(200);
    const before = h.push.sent.length;
    h.setNow(at('22:30'));
    await h.tick();

    for (const push of h.push.sent.slice(before)) {
      expect(push.body).not.toContain('Clozapine');
    }
  });
});

describe('the stored delivery row follows the same policy', () => {
  /**
   * notification_deliveries rows are read back by the dispatcher and by anyone
   * with database access. Leaving the medication in the stored payload while
   * the visible text withheld it would keep the PHI in the system and make the
   * setting cosmetic.
   */
  it('writes no medication name into the payload in generic mode', async () => {
    const { rows } = await h.worker.pool.query<{ payload: unknown; body: string }>(
      `SELECT payload, body FROM notification_deliveries
        WHERE dose_occurrence_id = $1 ORDER BY created_at`,
      [doseId],
    );
    expect(rows.length).toBeGreaterThan(0);

    const generic = rows.filter((r) => !r.body.includes('Clozapine'));
    expect(generic.length, 'at least one generic delivery was recorded').toBeGreaterThan(0);
    for (const row of generic) {
      expect(JSON.stringify(row.payload)).not.toContain('Clozapine');
    }
  });
});
