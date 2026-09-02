import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * The smart escalation scenario from the product brief, end to end, through
 * the real API and the real worker.
 *
 *   20:00  patient notified
 *   20:10  second reminder
 *   20:30  WhatsApp to the primary caregiver
 *   20:35  patient confirms
 *   21:00  NO further escalation
 */

let h: Harness;
let patient: TestUser;
let son: TestUser;
let daughter: TestUser;
let doseId: string;

/** 20:00 Riyadh on the test date is 17:00Z. */
const at = (riyadhHHMM: string) => {
  const [hh, mm] = riyadhHHMM.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 8, 2, hh - 3, mm, 0));
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

  // WhatsApp alerts require explicit patient consent before they can be enabled.
  await h.app.inject({
    method: 'PUT', url: '/v1/me/consents', headers: authHeaders(patient),
    payload: { type: 'whatsapp_notifications', granted: true, version: '1.0' },
  });

  const sonRel = await acceptInvite(patient, son, ['view_adherence', 'receive_notifications'], 1);
  const daughterRel = await acceptInvite(patient, daughter, ['view_adherence', 'receive_notifications'], 5);

  for (const rel of [sonRel, daughterRel]) {
    await h.app.inject({
      method: 'PUT', url: `/v1/caregivers/${rel}/notification-rules`, headers: authHeaders(patient),
      payload: { channel: 'whatsapp', mode: 'missed_only', enabled: true },
    });
    await h.app.inject({
      method: 'PUT', url: `/v1/caregivers/${rel}/notification-rules`, headers: authHeaders(patient),
      payload: { channel: 'push', mode: 'missed_only', enabled: true },
    });
  }

  await h.app.inject({
    method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(patient),
    payload: { token: 'ExponentPushToken[patient-device]', platform: 'ios', deviceId: 'patient-device-1' },
  });

  await h.app.inject({
    method: 'PUT', url: `/v1/escalation-policy?profileId=${patient.profileId}`, headers: authHeaders(patient),
    payload: {
      enabled: true,
      stages: [
        { afterMinutes: 0, target: 'patient', channels: ['push'] },
        { afterMinutes: 10, target: 'patient', channels: ['push'] },
        { afterMinutes: 30, target: 'primary_caregiver', channels: ['whatsapp'] },
        { afterMinutes: 60, target: 'secondary_caregivers', channels: ['whatsapp'] },
      ],
    },
  });

  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId, name: 'Panadol', form: 'tablet',
      strengthValue: 500, strengthUnit: 'mg', foodInstruction: 'after_food', startDate: '2026-09-01',
      schedule: {
        rule: { kind: 'fixed_times', times: ['20:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
        lateAfterMinutes: 15, missedAfterMinutes: 180,
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    },
  });
  expect(med.statusCode).toBe(200);

  const doses = await h.app.inject({
    method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=2026-09-02&to=2026-09-02`,
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
    h.setWorkerNow(at('19:59'));
    await h.tick();
    expect(h.push.sent).toHaveLength(0);
    expect(h.whatsapp.sent).toHaveLength(0);
  });

  it('20:00 — stage 1 notifies the patient, and nobody else', async () => {
    h.setWorkerNow(at('20:00'));
    await h.tick();
    expect(h.push.sent).toHaveLength(1);
    expect(h.push.sent[0]!.token).toBe('ExponentPushToken[patient-device]');
    expect(h.push.sent[0]!.priority).toBe('high');
    expect(h.push.sent[0]!.body).toContain('Panadol');
    expect(h.whatsapp.sent).toHaveLength(0);
  });

  it('20:05 — no duplicate for the same stage', async () => {
    h.setWorkerNow(at('20:05'));
    await h.tick();
    expect(h.push.sent).toHaveLength(1);
  });

  it('20:10 — stage 2 sends a second patient reminder, still no family', async () => {
    h.setWorkerNow(at('20:10'));
    await h.tick();
    expect(h.push.sent).toHaveLength(2);
    expect(h.whatsapp.sent).toHaveLength(0);
  });

  it('20:30 — stage 3 reaches the PRIMARY caregiver on WhatsApp only', async () => {
    h.setWorkerNow(at('20:30'));
    await h.tick();
    expect(h.whatsapp.sent).toHaveLength(1);
    const msg = h.whatsapp.sent[0]!;
    expect(msg.templateName).toBe('dawaee_dose_unconfirmed');
    expect(msg.to).toBe('+966533000002'); // the son, priority 1
    // The message carries who / what / when and nothing more.
    expect(msg.parameters).toEqual([expect.any(String), 'Panadol', '20:00']);
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
    h.setWorkerNow(at('21:00'));
    await h.tick();
    // Still exactly the one WhatsApp message from 20:30.
    expect(h.whatsapp.sent).toHaveLength(1);
    expect(h.whatsapp.sent.map((m) => m.to)).not.toContain('+966533000003');
  });

  it('22:00 — and stays quiet afterwards', async () => {
    h.setWorkerNow(at('22:00'));
    await h.tick();
    expect(h.whatsapp.sent).toHaveLength(1);
    expect(h.push.sent).toHaveLength(2);
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
      method: 'GET', url: `/v1/adherence?profileId=${patient.profileId}&from=2026-09-02&to=2026-09-02`,
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
      method: 'GET', url: `/v1/doses?profileId=${patient.profileId}&from=2026-09-03&to=2026-09-03`,
      headers: authHeaders(patient),
    });
    const tomorrow = doses.json().doses[0];
    expect(tomorrow).toBeTruthy();

    const pushBefore = h.push.sent.length;
    const waBefore = h.whatsapp.sent.length;

    const snoozeAt = new Date(Date.UTC(2026, 8, 3, 17, 0, 0));
    h.setWorkerNow(snoozeAt);
    await h.tick();
    expect(h.push.sent.length).toBe(pushBefore + 1);

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
    h.setWorkerNow(new Date(snoozeAt.getTime() + 30 * 60_000));
    await h.tick();
    expect(h.whatsapp.sent.length).toBe(waBefore);

    // Once the snooze lapses, escalation resumes exactly where it left off.
    h.setWorkerNow(new Date(snoozeAt.getTime() + 70 * 60_000));
    await h.tick();
    expect(h.whatsapp.sent.length).toBeGreaterThan(waBefore);
  });
});
