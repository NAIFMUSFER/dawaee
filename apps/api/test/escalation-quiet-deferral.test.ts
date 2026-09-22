import { reviewAndAcceptInvitation } from './reviewed-invitation-fixture.js';
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
let quietRelationship: string;

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
  const invitationLink = invite.json<{ invitationLink: string }>().invitationLink;
  const fragment = new URL(invitationLink).hash.slice(1);
  const token = fragment.startsWith('/invite/') ? fragment.slice('/invite/'.length) : fragment;
  expect(token, 'invite response did not contain a fragment token').toBeTruthy();
  const accepted = await reviewAndAcceptInvitation(options => h.app.inject(options), {
    method: 'POST', url: '/v1/caregivers/invitations/preview', headers: authHeaders(invitee), payload: { token },
  });
  expect(accepted.statusCode).toBe(200);
  return invite.json().relationshipId as string;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '0533000001', `${PATIENT_DEVICE}-1`);
  son = await signIn(h, '0533000002', `${SON_DEVICE}-1`);
  daughter = await signIn(h, '0533000003', `${DAUGHTER_DEVICE}-1`);

  const sonRel = await acceptInvite(
    patient, son,
    ['view_adherence', 'view_schedule', 'view_medications', 'receive_notifications'],
    1,
  );
  quietRelationship = sonRel;
  const daughterRel = await acceptInvite(
    patient, daughter,
    ['view_adherence', 'view_schedule', 'view_medications', 'receive_notifications'],
    5,
  );

  for (const rel of [sonRel, daughterRel]) {
    await h.app.inject({
      method: 'PUT', url: `/v1/caregivers/${rel}/notification-rules`, headers: authHeaders(patient),
      payload: { channel: 'push', mode: 'missed_only', enabled: true, quietHoursStart: '20:00', quietHoursEnd: '21:00' },
    });
  }

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

describe('quiet escalation is deferred rather than lost', () => {
  it('sends once after quiet hours even though the stage pointer already advanced', async () => {
    h.setNow(at('20:30'));
    await h.tick();
    expect(sentToFamily()).toBe(0);
    h.setNow(at('21:00'));
    await h.tick();
    expect(sentTo(SON_DEVICE)).toHaveLength(1);
    await h.tick();
    expect(sentTo(SON_DEVICE)).toHaveLength(1);
  });
  it('does not send a deferred alert once its dose has been confirmed', async () => {
    const shift = (time: string) => new Date(at(time).getTime() + 86_400_000);
    h.setNow(shift('20:30'));
    const doses = await h.app.inject({ method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=${NEXT_DATE}&to=${NEXT_DATE}`, headers: authHeaders(patient) });
    const nextId = doses.json().doses[0].id;
    await h.tick();
    const before = sentToFamily();
    h.setNow(shift('20:35'));
    const take = await h.app.inject({ method: 'POST', url: `/v1/doses/${nextId}/taken`, headers: authHeaders(patient), payload: { clientEventId: 'quiet-confirm', method: 'app' } });
    expect(take.statusCode, take.body).toBe(200);
    h.setNow(shift('21:00'));
    await h.tick();
    expect(sentToFamily()).toBe(before);
  });
});

it('rechecks a revoked notification rule before delivering a deferred alert', async () => {
  const shift = (time: string) => new Date(at(time).getTime() + 2 * 86_400_000);
  h.setNow(shift('20:30'));
  await h.tick();
  const before = sentTo(SON_DEVICE).length;
  const disabled = await h.app.inject({ method: 'PUT', url: `/v1/caregivers/${quietRelationship}/notification-rules`, headers: authHeaders(patient), payload: { channel: 'push', mode: 'never', enabled: false } });
  expect(disabled.statusCode, disabled.body).toBe(200);
  h.setNow(shift('21:00'));
  await h.tick();
  expect(sentTo(SON_DEVICE)).toHaveLength(before);
});
