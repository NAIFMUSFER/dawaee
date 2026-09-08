import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, resetDatabase, signIn, startHarness, PANADOL,
  type Harness, type TestUser,
} from './harness.js';

let h: Harness;
let patient: TestUser;
let caregiver: TestUser;
let relationshipId = '';
let serial = 0;
const medName = (label: string) => `${label}-${++serial}`;

async function postMedication(name: string, extras: Record<string, unknown> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/medications',
    headers: authHeaders(caregiver),
    payload: {
      patientProfileId: patient.profileId,
      ...PANADOL,
      name,
      startDate: '2026-09-09',
      acknowledgeDuplicate: true,
      ...extras,
    },
  });
}

async function setPermissions(permissions: string[]) {
  const res = await h.app.inject({
    method: 'PATCH',
    url: `/v1/caregivers/${relationshipId}/permissions`,
    headers: authHeaders(patient),
    payload: { permissions },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function patientMedicationList() {
  return h.app.inject({
    method: 'GET', url: `/v1/medications?profileId=${patient.profileId}`, headers: authHeaders(patient),
  });
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500091100');
  caregiver = await signIn(h, '+966500091101');

  const invite = await h.app.inject({
    method: 'POST',
    url: '/v1/caregivers/invite',
    headers: authHeaders(patient),
    payload: {
      patientProfileId: patient.profileId,
      invitedName: 'Medication helper',
      invitedPhone: caregiver.phone,
      role: 'caregiver',
      permissions: ['add_medication'],
      escalationPriority: 1,
    },
  });
  expect(invite.statusCode, invite.body).toBe(200);
  const body = invite.json<{ relationshipId: string; invitationLink: string }>();
  relationshipId = body.relationshipId;
  const token = body.invitationLink.split('/invite/')[1]!;

  const accepted = await h.app.inject({
    method: 'POST', url: '/v1/caregivers/accept', headers: authHeaders(caregiver), payload: { token },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
}, 120_000);

afterAll(async () => { await h.close(); });

describe('P20 medication creation checks every permission its reads and nested writes need', () => {
  it('refuses the incoherent custom grant add_medication without view_medications before any write', async () => {
    const name = medName('add-only-denied');
    const res = await postMedication(name);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('view_medications');

    const list = await patientMedicationList();
    expect(list.body).not.toContain(name);
  });

  it('add_medication plus view_medications can create a bare medication', async () => {
    await setPermissions(['add_medication', 'view_medications']);
    const res = await postMedication(medName('bare'));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('but an initial schedule explicitly requires edit_schedule', async () => {
    const name = medName('schedule-denied');
    const res = await postMedication(name, {
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: '2026-09-09',
      },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('edit_schedule');

    const list = await patientMedicationList();
    expect(list.body).not.toContain(name);
  });

  it('edit_schedule without view_schedule is also refused before materialization', async () => {
    await setPermissions(['add_medication', 'view_medications', 'edit_schedule']);
    const name = medName('schedule-hidden-denied');
    const res = await postMedication(name, {
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: '2026-09-09',
      },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('view_schedule');

    const list = await patientMedicationList();
    expect(list.body).not.toContain(name);
  });

  it('initial stock explicitly requires update_stock', async () => {
    await setPermissions(['add_medication', 'view_medications']);
    const name = medName('stock-denied');
    const res = await postMedication(name, {
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('update_stock');

    const list = await patientMedicationList();
    expect(list.body).not.toContain(name);
  });

  it('positive control: every matching grant makes the complete create succeed', async () => {
    await setPermissions(['add_medication', 'view_medications', 'edit_schedule', 'view_schedule', 'update_stock']);
    const res = await postMedication(medName('complete'), {
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00', '20:00'] },
        doseQuantity: 1,
        doseUnit: 'tablet',
        startDate: '2026-09-09',
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ scheduleId: string | null; dosesCreated: number }>();
    expect(body.scheduleId).toBeTruthy();
    expect(body.dosesCreated).toBeGreaterThan(0);
  });
});
