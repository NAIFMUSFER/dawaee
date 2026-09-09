import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '0511000047');
});

afterAll(async () => {
  await h.close();
});

describe('PATCH preserves omitted fields but clears explicitly-null optional values', () => {
  it('clears nullable medication metadata when the client sends null', async () => {
    const created = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId,
        name: 'Nullable medication probe', brandName: 'Brand A', genericName: 'Generic A',
        form: 'tablet', strengthValue: 250, strengthUnit: 'mg', manufacturer: 'Manufacturer A',
        barcode: '1234567890123', instructions: 'Take with water',
        doctorInstructions: 'Doctor instruction', notes: 'Temporary note',
        startDate: '2026-09-01', endDate: '2026-12-31', expiryDate: '2027-06-30',
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const medicationId = created.json().medication.id as string;

    const patched = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(user),
      payload: {
        brandName: null, genericName: null, strengthValue: null, strengthUnit: null,
        manufacturer: null, barcode: null, instructions: null, doctorInstructions: null,
        notes: null, endDate: null, expiryDate: null,
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().medication).toMatchObject({
      brandName: null, genericName: null, strengthValue: null, strengthUnit: null,
      manufacturer: null, barcode: null, instructions: null, doctorInstructions: null,
      notes: null, endDate: null, expiryDate: null,
    });
    expect(patched.json().medication.name).toBe('Nullable medication probe');
    expect(patched.json().medication.form).toBe('tablet');
    expect(patched.json().medication.startDate).toBe('2026-09-01');
  });

  it('clears a schedule end date when the client sends endDate null', async () => {
    const created = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId, name: 'Open-ended schedule probe', form: 'tablet', startDate: '2026-09-01',
        schedule: {
          rule: { kind: 'fixed_times', times: ['09:00'] }, doseQuantity: 1, doseUnit: 'tablet',
          startDate: '2026-09-01', endDate: '2026-10-15',
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const scheduleId = created.json().scheduleId as string;
    expect(scheduleId).toBeTruthy();

    const patched = await h.app.inject({
      method: 'PATCH', url: `/v1/schedules/${scheduleId}`, headers: authHeaders(user),
      payload: { endDate: null },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().schedule.endDate).toBeNull();
    expect(patched.json().schedule.startDate).toBe('2026-09-01');
    expect(patched.json().schedule.doseQuantity).toBe(1);
    expect(patched.json().schedule.doseUnit).toBe('tablet');
  });
});
