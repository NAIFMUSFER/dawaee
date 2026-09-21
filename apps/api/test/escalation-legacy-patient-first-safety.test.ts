import { reviewAndAcceptInvitation } from './reviewed-invitation-fixture.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

/**
 * A policy saved before the patient-first contract existed can still be present
 * in the database because the JSON column only enforces array shape/bounds.
 * The worker must never let that legacy row make a caregiver the first person
 * contacted for a due dose.
 */

let h: Harness;
let db: pg.Pool;

const PATIENT_TOKEN = 'ExponentPushToken[legacy-policy-patient]';
const CAREGIVER_TOKEN = 'ExponentPushToken[legacy-policy-caregiver]';
const RIYADH = 'Asia/Riyadh';

const riyadhParts = (d: Date) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: RIYADH,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, mo, da] = f.format(d).split('-').map(Number) as [number, number, number];
  return { y, mo, da };
};

const SCENARIO = riyadhParts(new Date(Date.now() + 24 * 60 * 60 * 1000));
const SCENARIO_DATE = `${SCENARIO.y}-${String(SCENARIO.mo).padStart(2, '0')}-${String(SCENARIO.da).padStart(2, '0')}`;
const at = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(SCENARIO.y, SCENARIO.mo - 1, SCENARIO.da, hh - 3, mm, 0));
};

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  db = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
});

afterAll(async () => {
  await db.end();
  await h.close();
});

describe('legacy escalation policy safety', () => {
  it('falls back to a patient-first ladder when an enabled stored policy starts with a caregiver', async () => {
    h.setNow(at('18:00'));
    const patient = await signIn(h, '+966500009301', 'legacy-policy-patient-device');
    const caregiver = await signIn(h, '+966500009302', 'legacy-policy-caregiver-device');

    const invite = await h.app.inject({
      method: 'POST',
      url: '/v1/caregivers/invite',
      headers: authHeaders(patient),
      payload: {
        patientProfileId: patient.profileId,
        invitedName: 'Legacy caregiver',
        invitedPhone: caregiver.phone,
        role: 'son',
        permissions: ['receive_notifications'],
        escalationPriority: 1,
      },
    });
    expect(invite.statusCode, invite.body).toBe(200);
    const invitationLink = invite.json<{ invitationLink: string }>().invitationLink;
    const fragment = new URL(invitationLink).hash.slice(1);
    const invitationToken = fragment.startsWith('/invite/') ? fragment.slice('/invite/'.length) : fragment;
    const accepted = await reviewAndAcceptInvitation(options => h.app.inject(options), {
      method: 'POST',
      url: '/v1/caregivers/invitations/preview',
      headers: authHeaders(caregiver),
      payload: { token: invitationToken },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const relationshipId = invite.json().relationshipId as string;
    const rule = await h.app.inject({
      method: 'PUT',
      url: `/v1/caregivers/${relationshipId}/notification-rules`,
      headers: authHeaders(patient),
      payload: { channel: 'push', mode: 'every_dose', enabled: true },
    });
    expect(rule.statusCode, rule.body).toBe(200);

    for (const [who, token, deviceId] of [
      [patient, PATIENT_TOKEN, 'legacy-policy-patient-device'],
      [caregiver, CAREGIVER_TOKEN, 'legacy-policy-caregiver-device'],
    ] as const) {
      const push = await h.app.inject({
        method: 'POST',
        url: '/v1/devices/push-token',
        headers: authHeaders(who),
        payload: { token, platform: 'ios', deviceId },
      });
      expect(push.statusCode, push.body).toBe(200);
    }

    const medication = await h.app.inject({
      method: 'POST',
      url: '/v1/medications',
      headers: authHeaders(patient),
      payload: {
        patientProfileId: patient.profileId,
        name: 'Legacy policy safety dose',
        form: 'tablet',
        strengthValue: 10,
        strengthUnit: 'mg',
        foodInstruction: 'no_preference',
        startDate: SCENARIO_DATE,
        schedule: {
          rule: { kind: 'fixed_times', times: ['20:00'] },
          doseQuantity: 1,
          doseUnit: 'tablet',
          startDate: SCENARIO_DATE,
          lateAfterMinutes: 15,
          missedAfterMinutes: 60,
        },
      },
    });
    expect(medication.statusCode, medication.body).toBe(200);

    // Simulate a row that can legitimately exist from the pre-patient-first
    // era. The API now rejects this shape, but the database JSON constraint does
    // not and existing rows are not rewritten during that contract change.
    await db.query(
      `INSERT INTO escalation_policies (patient_profile_id, enabled, stages)
       VALUES ($1, true, $2::jsonb)`,
      [
        patient.profileId,
        JSON.stringify([
          { afterMinutes: 0, target: 'primary_caregiver', channels: ['push'] },
        ]),
      ],
    );

    h.setNow(at('20:00'));
    await h.tick();

    const patientPushes = h.push.sent.filter((message) => message.token === PATIENT_TOKEN);
    const caregiverPushes = h.push.sent.filter((message) => message.token === CAREGIVER_TOKEN);
    expect(patientPushes, 'legacy policy fallback did not preserve the patient reminder').toHaveLength(1);
    expect(caregiverPushes, 'legacy caregiver-first policy bypassed the patient-first safety invariant').toHaveLength(0);
  });
});
