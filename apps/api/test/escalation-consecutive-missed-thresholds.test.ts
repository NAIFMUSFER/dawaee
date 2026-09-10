import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Red-team regressions for caregiver `consecutive_missed` rules.
 *
 * The rule threshold is a count of consecutive missed DOSES including the dose
 * currently being escalated exactly once. Historical occurrences must be
 * classified with the threshold policy of their own schedule. A worker that
 * includes the current dose in the historical streak and then adds it again,
 * or that applies the current schedule's missed threshold to every historical
 * occurrence, can alert a caregiver too early.
 */

let h: Harness;
const DATE = '2026-06-10';
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 5, 10, hh - 3, mm, 0)); // Riyadh = UTC+3
};

const sentTo = (token: string) => h.push.sent.filter((message) => message.token === token);

async function acceptCaregiver(patient: TestUser, caregiver: TestUser, token: string): Promise<string> {
  const invite = await h.app.inject({
    method: 'POST',
    url: '/v1/caregivers/invite',
    headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      invitedName: 'Caregiver',
      invitedPhone: caregiver.phone,
      role: 'son',
      permissions: ['receive_notifications'],
      escalationPriority: 1,
    },
  });
  expect(invite.statusCode, invite.body).toBe(200);
  const invitationToken = invite.json().invitationLink.split('/invite/')[1]!;
  const accepted = await h.app.inject({
    method: 'POST',
    url: '/v1/caregivers/accept',
    headers: authHeaders(caregiver),
    payload: { token: invitationToken },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);

  const relationshipId = invite.json().relationshipId as string;
  const rule = await h.app.inject({
    method: 'PUT',
    url: `/v1/caregivers/${relationshipId}/notification-rules`,
    headers: authHeaders(patient),
    payload: {
      channel: 'push',
      mode: 'consecutive_missed',
      consecutiveMissedThreshold: 2,
      enabled: true,
    },
  });
  expect(rule.statusCode, rule.body).toBe(200);

  const device = await h.app.inject({
    method: 'POST',
    url: '/v1/devices/push-token',
    headers: authHeaders(caregiver),
    payload: { token, platform: 'ios', deviceId: `${token}-device` },
  });
  expect(device.statusCode, device.body).toBe(200);
  return relationshipId;
}

async function setCaregiverOnlyPolicy(patient: TestUser): Promise<void> {
  const policy = await h.app.inject({
    method: 'PUT',
    url: `/v1/escalation-policy?profileId=${patient.profileId}`,
    headers: authHeaders(patient),
    payload: {
      enabled: true,
      stages: [{ afterMinutes: 30, target: 'primary_caregiver', channels: ['push'] }],
    },
  });
  expect(policy.statusCode, policy.body).toBe(200);
}

async function createMedication(
  patient: TestUser,
  name: string,
  time: string,
  missedAfterMinutes: number,
): Promise<void> {
  const medication = await h.app.inject({
    method: 'POST',
    url: '/v1/medications',
    headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      name,
      form: 'tablet',
      strengthValue: 10,
      strengthUnit: 'mg',
      foodInstruction: 'no_preference',
      startDate: DATE,
      schedule: {
        rule: { kind: 'fixed_times', times: [time] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: DATE,
        lateAfterMinutes: 5,
        missedAfterMinutes,
      },
      stock: { trackingEnabled: false, initialQuantity: 0, unit: 'tablet' },
    },
  });
  expect(medication.statusCode, medication.body).toBe(200);
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('red team — consecutive-missed caregiver thresholds', () => {
  it('does not count the currently escalating dose twice', async () => {
    h.setNow(at('18:00'));
    const patient = await signIn(h, '+966500009201');
    const caregiver = await signIn(h, '+966500009202');
    const caregiverToken = 'ExponentPushToken[streak-no-double-count]';
    await acceptCaregiver(patient, caregiver, caregiverToken);
    await setCaregiverOnlyPolicy(patient);
    await createMedication(patient, 'Single missed dose', '20:00', 15);

    h.setNow(at('20:30'));
    await h.tick();

    expect(
      sentTo(caregiverToken),
      'threshold=2 fired on the first missed dose; the current dose was counted in the history and then added again',
    ).toHaveLength(0);
  });

  it('classifies each historical dose with its own schedule missed threshold', async () => {
    h.setNow(at('18:00'));
    const patient = await signIn(h, '+966500009211');
    const caregiver = await signIn(h, '+966500009212');
    const caregiverToken = 'ExponentPushToken[streak-per-schedule-threshold]';
    await acceptCaregiver(patient, caregiver, caregiverToken);
    await setCaregiverOnlyPolicy(patient);

    // At 20:30 this 19:00 dose is only 90 minutes old and therefore NOT
    // missed under its own 240-minute policy.
    await createMedication(patient, 'Long grace dose', '19:00', 240);
    // The currently escalating dose is missed at 20:15. Its 15-minute policy
    // must not be borrowed to reclassify the 19:00 dose as missed.
    await createMedication(patient, 'Short grace dose', '20:00', 15);

    h.setNow(at('20:30'));
    await h.tick();

    expect(
      sentTo(caregiverToken),
      'a historical dose borrowed the current schedule threshold, creating a false consecutive-missed streak',
    ).toHaveLength(0);
  });
});
