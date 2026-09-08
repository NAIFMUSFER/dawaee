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

describe('P20 medication creation checks every permission its nested writes need', () => {
  it('add_medication alone can create a bare medication', async () => {
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

    const list = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${patient.profileId}`, headers: authHeaders(patient),
    });
    expect(list.body).not.toContain(name);
  });

  it('and initial stock explicitly requires update_stock', async () => {
    const name = medName('stock-denied');
    const res = await postMedication(name, {
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('update_stock');

    const list = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${patient.profileId}`, headers: authHeaders(patient),
    });
    expect(list.body).not.toContain(name);
  });

  it('positive control: the matching grants make the complete create succeed', async () => {
    await setPermissions(['add_medication', 'edit_schedule', 'update_stock']);
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
