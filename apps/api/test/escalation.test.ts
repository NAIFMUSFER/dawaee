import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * The smart escalation scenario from the product brief, end to end, through
 * the real API and the real worker.
 *
 *   20:00  patient notified
 *   20:10  second reminder
 *   20:30  the primary caregiver is notified
 *   20:35  patient confirms
 *   21:00  NO further escalation
 */

let h: Harness;
let patient: TestUser;
let son: TestUser;
let daughter: TestUser;
let doseId: string;

const PATIENT_DEVICE = 'ExponentPushToken[patient-device]';
const SON_DEVICE = 'ExponentPushToken[son-device]';
const DAUGHTER_DEVICE = 'ExponentPushToken[daughter-device]';

/** What has been sent to one person's device, which is how "who" is asserted. */
const sentTo = (token: string) => h.push.sent.filter((m) => m.token === token);
/** Anything that reached the family at all, whichever caregiver it went to. */
const sentToFamily = () => sentTo(SON_DEVICE).length + sentTo(DAUGHTER_DEVICE).length;

/**
 * The scenario needs a date inside the materialization window, which starts at
 * today. Pinning a literal date makes the suite pass on the day it is written
 * and fail every day after, so the date is derived from the real clock:
 * tomorrow in Riyadh, which is always materialized and always in the future.
 */
const RIYADH = 'Asia/Riyadh';
const riyadhParts = (d: Date) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: RIYADH, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, mo, da] = f.format(d).split('-').map(Number) as [number, number, number];
  return { y, mo, da };
};
const SCENARIO = riyadhParts(new Date(Date.now() + 24 * 60 * 60 * 1000));
const iso = (p: { y: number; mo: number; da: number }) =>
  `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.da).padStart(2, '0')}`;
const NEXT = riyadhParts(new Date(Date.now() + 48 * 60 * 60 * 1000));
const SCENARIO_DATE = iso(SCENARIO);
const NEXT_DATE = iso(NEXT);
// The schedule starts ON the scenario day. Starting it earlier would leave
// real doses due before 19:59, and the first tick would escalate those instead
// of the one the scenario is about.
const START_DATE = SCENARIO_DATE;

/** Riyadh is UTC+3 year round, so 20:00 local on the scenario date is 17:00Z. */
const at = (riyadhHHMM: string) => {
  const [hh, mm] = riyadhHHMM.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(SCENARIO.y, SCENARIO.mo - 1, SCENARIO.da, hh - 3, mm, 0));
};

async function acceptInvite(inviter: TestUser, invitee: TestUser, permissions: string[], priority: number) {
  const invite = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(inviter),
    payload: {
      patientProfileId: inviter.profileId, invitedName: invitee.phone, invitedPhone: invitee.phone,
      role: 'son', permissions, escalationPriority: priority,
    },
  });
  const token = invite.json().invitationLink.split('/invite/')[1]!;
  const accepted = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(invitee), payload: { token },
  });
  expect(accepted.statusCode).toBe(200);
  return invite.json().relationshipId as string;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '0533000001');
  son = await signIn(h, '0533000002');
  daughter = await signIn(h, '0533000003');

  const sonRel = await acceptInvite(patient, son, ['view_adherence', 'receive_notifications'], 1);
  const daughterRel = await acceptInvite(patient, daughter, ['view_adherence', 'receive_notifications'], 5);

  for (const rel of [sonRel, daughterRel]) {
    await h.app.inject({
      method: 'PUT', url: `/v1/caregivers/${rel}/notification-rules`, headers: authHeaders(patient),
      payload: { channel: 'push', mode: 'missed_only', enabled: true },
    });
  }

  // Every participant registers a device, because push is the only channel
  // there is: a caregiver with no registered device cannot be reached at all,
  // and the tokens are what tell the assertions below WHO was contacted.
  for (const [who, token] of [
    [patient, PATIENT_DEVICE], [son, SON_DEVICE], [daughter, DAUGHTER_DEVICE],
  ] as const) {
    await h.app.inject({
      method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(who),
      payload: { token, platform: 'ios', deviceId: `${token}-1` },
    });
  }

  await h.app.inject({
    method: 'PUT', url: `/v1/escalation-policy?profileId=${patient.profileId}`, headers: authHeaders(patient),
    payload: {
      enabled: true,
      stages: [
        { afterMinutes: 0, target: 'patient', channels: ['push'] },
        { afterMinutes: 10, target: 'patient', channels: ['push'] },
        { afterMinutes: 30, target: 'primary_caregiver', channels: ['push'] },
        { afterMinutes: 60, target: 'secondary_caregivers', channels: ['push'] },
      ],
    },
  });

  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, name: 'Panadol', form: 'tablet',
      strengthValue: 500, strengthUnit: 'mg', foodInstruction: 'after_food', startDate: START_DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: ['20:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: START_DATE,
        lateAfterMinutes: 15, missedAfterMinutes: 180,
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    },
  });
  expect(med.statusCode).toBe(200);

  const doses = await h.app.inject({
    method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=${SCENARIO_DATE}&to=${SCENARIO_DATE}`,
    headers: authHeaders(patient),
  });
  doseId = doses.json().doses[0].id;
  expect(doseId).toBeTruthy();
});

afterAll(async () => {
  await h.close();
});

describe('brief §17 / §66 — escalation walks outward and stops on confirmation', () => {
  it('19:59 — nothing has been sent', async () => {
    h.setNow(at('19:59'));
    await h.tick();
    expect(h.push.sent).toHaveLength(0);
  });

  it('20:00 — stage 1 notifies the patient, and nobody else', async () => {
    h.setNow(at('20:00'));
    await h.tick();
    expect(sentTo(PATIENT_DEVICE)).toHaveLength(1);
    expect(h.push.sent[0]!.priority).toBe('high');
    // The medication is NOT named: disclosure is off unless the patient opts
    // in, and this fixture has not. The body still has to be actionable, so it
    // carries the time. See the opt-in case below for the other half.
    expect(h.push.sent[0]!.body).not.toContain('Panadol');
    expect(h.push.sent[0]!.body).toContain('20:00');
    // The family is not told anything yet. This is the whole point of the
    // ladder: a patient who is simply slow must not summon their children.
    expect(sentTo(SON_DEVICE)).toHaveLength(0);
    expect(sentTo(DAUGHTER_DEVICE)).toHaveLength(0);
  });

  it('20:05 — no duplicate for the same stage', async () => {
    h.setNow(at('20:05'));
    await h.tick();
    expect(h.push.sent).toHaveLength(1);
  });

  it('20:10 — stage 2 sends a second patient reminder, still no family', async () => {
    h.setNow(at('20:10'));
    await h.tick();
    expect(sentTo(PATIENT_DEVICE)).toHaveLength(2);
    expect(sentTo(SON_DEVICE)).toHaveLength(0);
    expect(sentTo(DAUGHTER_DEVICE)).toHaveLength(0);
  });

  it('20:30 — stage 3 reaches the PRIMARY caregiver, and only them', async () => {
    h.setNow(at('20:30'));
    await h.tick();
    // The son is priority 1. The daughter is priority 5 and hears nothing yet.
    expect(sentTo(SON_DEVICE)).toHaveLength(1);
    expect(sentTo(DAUGHTER_DEVICE)).toHaveLength(0);
  });

  it('20:35 — the patient confirms, and escalation completes', async () => {
    const res = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(patient),
      payload: { clientEventId: 'evt-escalation-1', method: 'push_action', takenAt: at('20:35').toISOString() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('taken_late');
    expect(res.json().stock.remainingQuantity).toBe(29);
  });

  it('21:00 — the secondary caregiver is NOT contacted', async () => {
    h.setNow(at('21:00'));
    await h.tick();
    // Still exactly the one message to the son from 20:30, and nothing at all
    // to the daughter: confirmation stops the ladder where it stood.
    expect(sentTo(SON_DEVICE)).toHaveLength(1);
    expect(sentTo(DAUGHTER_DEVICE)).toHaveLength(0);
  });

  it('22:00 — and stays quiet afterwards', async () => {
    h.setNow(at('22:00'));
    await h.tick();
    expect(sentTo(SON_DEVICE)).toHaveLength(1);
    expect(sentTo(DAUGHTER_DEVICE)).toHaveLength(0);
    expect(sentTo(PATIENT_DEVICE)).toHaveLength(2);
  });

  it('records the escalation in the dose event trail', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/doses/${doseId}`, headers: authHeaders(patient),
    });
    const types = res.json().events.map((e: { type: string }) => e.type);
    expect(types).toContain('notified');
    expect(types).toContain('escalated');
    expect(types).toContain('taken');
  });
});

describe('caregiver visibility of the outcome', () => {
  it('lets the son see adherence but not the medication list', async () => {
    const adherence = await h.app.inject({
      method: 'GET', url: `/v1/adherence?profileId=${patient.profileId}&from=${SCENARIO_DATE}&to=${SCENARIO_DATE}`,
      headers: authHeaders(son),
    });
    expect(adherence.statusCode).toBe(200);
    expect(adherence.json().summary.taken).toBe(1);
    expect(adherence.json().disclaimerKey).toBe('adherence.disclaimer');

    const meds = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${patient.profileId}`, headers: authHeaders(son),
    });
    // 403 for a connected caregiver (they already know the profile exists),
    // 404 for anyone else — either way the medication list stays hidden.
    expect([403, 404]).toContain(meds.statusCode);
    expect(meds.body).not.toContain('Panadol');
  });
});

describe('escalation is suppressed correctly', () => {
  it('does not escalate a snoozed dose, and resumes afterwards', async () => {
    // A fresh dose on the following day.
    const doses = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=${NEXT_DATE}&to=${NEXT_DATE}`,
      headers: authHeaders(patient),
    });
    const tomorrow = doses.json().doses[0];
    expect(tomorrow).toBeTruthy();

    const patientBefore = sentTo(PATIENT_DEVICE).length;
    const familyBefore = sentToFamily();

    const snoozeAt = new Date(Date.UTC(NEXT.y, NEXT.mo - 1, NEXT.da, 17, 0, 0));
    h.setNow(snoozeAt);
    await h.tick();
    expect(sentTo(PATIENT_DEVICE).length).toBe(patientBefore + 1);

    const snooze = await h.app.inject({
      method: 'POST', url: `/v1/doses/${tomorrow.id}/snooze`, headers: authHeaders(patient),
      payload: { minutes: 60, clientEventId: 'evt-snooze-1' },
    });
    expect(snooze.statusCode).toBe(200);
    expect(snooze.json().snoozeCount).toBe(1);

    // The API stamps `snoozed_until` from the real wall clock while the worker
    // is running on a simulated one, so the window is re-anchored to the
    // simulated timeline. The endpoint above is still the thing under test.
    const { execFileSync } = await import('node:child_process');
    execFileSync('psql', ['-d', 'dawaee_test', '-c',
      `UPDATE dose_occurrences SET snoozed_until = timestamptz '${new Date(snoozeAt.getTime() + 60 * 60_000).toISOString()}' WHERE id = '${tomorrow.id}'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' }, stdio: 'pipe',
    });

    // 30 minutes in, the family would normally be told. It is snoozed, so no.
    h.setNow(new Date(snoozeAt.getTime() + 30 * 60_000));
    await h.tick();
    expect(sentToFamily()).toBe(familyBefore);

    // Once the snooze lapses, escalation resumes exactly where it left off.
    h.setNow(new Date(snoozeAt.getTime() + 70 * 60_000));
    await h.tick();
    // Whichever caregiver the ladder has reached by then — at 70 minutes late
    // it is the secondary — the point is that suppression ended rather than
    // permanently cancelled the escalation.
    expect(sentToFamily()).toBeGreaterThan(familyBefore);
  });
});
