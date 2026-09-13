import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, PANADOL, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '0511000001');
});
afterAll(async () => {
  await h.close();
});

async function createMedication(overrides: Record<string, unknown> = {}) {
  return h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      ...PANADOL,
      startDate: '2026-09-01',
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00', '14:00', '22:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
      ...overrides,
    },
  });
}

describe('medication CRUD', () => {
  let medicationId: string;

  it('creates a medication with its schedule and stock atomically', async () => {
    const res = await createMedication();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    medicationId = body.medication.id;
    expect(body.medication.name).toBe('Panadol');
    expect(body.medication.strengthValue).toBe(500);
    expect(body.scheduleId).toBeTruthy();
    expect(body.dosesCreated).toBeGreaterThan(30);
  });

  it('warns about a duplicate instead of silently creating one', async () => {
    const res = await createMedication({ schedule: undefined, stock: undefined });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('duplicate_medication');
    expect(body.meta.duplicates[0].medicationName).toBe('Panadol');
    expect(body.meta.duplicates[0].reasons).toContain('exact_name');
  });

  it('creates it anyway once the user acknowledges the warning', async () => {
    const res = await createMedication({ schedule: undefined, stock: undefined, acknowledgeDuplicate: true });
    expect(res.statusCode).toBe(200);
    await h.app.inject({
      method: 'DELETE', url: `/v1/medications/${res.json().medication.id}?force=true`, headers: authHeaders(user),
    });
  });

  it('does not flag a different strength of the same drug', async () => {
    const res = await createMedication({ strengthValue: 1000, schedule: undefined, stock: undefined });
    expect(res.statusCode).toBe(200);
    await h.app.inject({
      method: 'DELETE', url: `/v1/medications/${res.json().medication.id}?force=true`, headers: authHeaders(user),
    });
  });

  it('lists medications with a live stock forecast', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${user.profileId}`, headers: authHeaders(user),
    });
    expect(res.statusCode).toBe(200);
    const med = res.json().medications.find((m: { id: string }) => m.id === medicationId);
    expect(med.stock.remainingQuantity).toBe(30);
    expect(med.stockForecast.daysRemaining).toBe(10);
    expect(med.stockForecast.isLow).toBe(false);
  });

  it('requires explicit confirmation before a high-risk identity change', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(user),
      payload: { name: 'Metformin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('high_risk_confirmation_required');
    expect(res.json().meta.changes).toContain('medication_identity');
  });

  it('accepts the same change once confirmed', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(user),
      payload: { name: 'Panadol Extra', confirmHighRiskChange: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().medication.name).toBe('Panadol Extra');
  });

  it('allows harmless edits without any confirmation', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(user),
      payload: { notes: 'Kept in the kitchen cupboard' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('cancels future doses when a medication is paused, keeping history', async () => {
    const before = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2027-01-01`, headers: authHeaders(user),
    });
    const beforeCount = before.json().doses.length;

    const res = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(user),
      payload: { status: 'paused' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().futureDosesCancelled).toBeGreaterThan(0);

    const after = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2027-01-01`, headers: authHeaders(user),
    });
    expect(after.json().doses.length).toBeLessThan(beforeCount);

    const resumed = await h.app.inject({
      method: 'PATCH', url: `/v1/medications/${medicationId}`, headers: authHeaders(user), payload: { status: 'active' },
    });
    expect(resumed.json().futureDosesRevived).toBeGreaterThan(0);
    const restored = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2027-01-01`, headers: authHeaders(user),
    });
    expect(restored.json().doses.length).toBe(beforeCount);
  });

  it('archives rather than deletes a medication that has dose history', async () => {
    const today = await h.app.inject({
      method: 'GET', url: `/v1/today?profileId=${user.profileId}`, headers: authHeaders(user),
    });
    const dose = today.json().today.find((d: { status: string }) => d.status !== 'cancelled')
      ?? today.json().prefetch[0];
    expect(dose, 'the medication should have an actionable dose').toBeTruthy();

    // The 15-minute early-action invariant is part of production correctness.
    // This test is about archival after real history, not about bypassing that
    // invariant, so move the harness clock to the selected occurrence.
    h.setServerNow(new Date(dose.scheduledAt));
    const confirmed = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: `evt-archive-${Date.now()}`, method: 'app' },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const res = await h.app.inject({
      method: 'DELETE', url: `/v1/medications/${medicationId}`, headers: authHeaders(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted).toBe(false);
    expect(body.archived).toBe(true);
    expect(body.historyCount).toBeGreaterThan(0);
  });
});

describe('schedules', () => {
  it('supports every rule kind and regenerates doses on change', async () => {
    const med = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId, name: 'Metformin', form: 'tablet',
        strengthValue: 850, strengthUnit: 'mg', startDate: '2026-09-01',
        schedule: {
          rule: { kind: 'interval', everyHours: 8, anchorTime: '06:00' },
          doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
        },
      },
    });
    expect(med.statusCode).toBe(200);
    const scheduleId = med.json().scheduleId;

    const blocked = await h.app.inject({
      method: 'PATCH', url: `/v1/schedules/${scheduleId}`, headers: authHeaders(user),
      payload: { doseQuantity: 2 },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('high_risk_confirmation_required');

    const confirmed = await h.app.inject({
      method: 'PATCH', url: `/v1/schedules/${scheduleId}`, headers: authHeaders(user),
      payload: {
        rule: { kind: 'days_of_week', weekdays: [0, 2, 4], times: ['09:00'] },
        doseQuantity: 2, confirmHighRiskChange: true,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().futureDosesRemoved).toBeGreaterThan(0);
    expect(confirmed.json().dosesCreated).toBeGreaterThan(0);
  });

  it('handles fifty medications on one profile', async () => {
    const created: string[] = [];
    for (let i = 0; i < 50; i++) {
      const res = await h.app.inject({
        method: 'POST', url: '/v1/medications', headers: authHeaders(user),
        payload: {
          patientProfileId: user.profileId, name: `Bulk Medication ${i}`, form: 'tablet',
          startDate: '2026-09-01',
          schedule: {
            rule: { kind: 'fixed_times', times: ['09:00'] },
            doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      created.push(res.json().medication.id);
    }

    const started = Date.now();
    const list = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${user.profileId}`, headers: authHeaders(user),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().medications.length).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(8000);

    const today = await h.app.inject({
      method: 'GET', url: `/v1/today?profileId=${user.profileId}`, headers: authHeaders(user),
    });
    expect(today.statusCode).toBe(200);
  }, 120_000);
});
