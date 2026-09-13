import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
let medicationId = '';
let scheduleId = '';

const RIYADH = 'Asia/Riyadh';
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: RIYADH, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500091200');

  const res = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: 'Unit-safe tablets', form: 'tablet', startDate: today(),
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: today(),
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  medicationId = res.json<{ medication: { id: string }; scheduleId: string }>().medication.id;
  scheduleId = res.json<{ scheduleId: string }>().scheduleId;
}, 120_000);

afterAll(async () => { await h.close(); });

async function stockQuantity() {
  const res = await h.app.inject({
    method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ stock: { remainingQuantity: number } }>().stock.remainingQuantity;
}

describe('P20 stock-unit integrity: arithmetic never crosses dimensions', () => {
  it('rolls back an atomic medication create whose schedule and stock units disagree', async () => {
    const name = 'Impossible 500mg versus tablets';
    const res = await h.app.inject({
      method: 'POST', url: '/v1/medications', headers: authHeaders(user),
      payload: {
        patientProfileId: user.profileId,
        name, form: 'tablet', startDate: today(), acknowledgeDuplicate: true,
        schedule: {
          rule: { kind: 'fixed_times', times: ['09:00'] },
          doseQuantity: 500, doseUnit: 'mg', startDate: today(),
        },
        stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
      },
    });
    expect(res.statusCode, res.body).toBe(409);

    const list = await h.app.inject({
      method: 'GET', url: `/v1/medications?profileId=${user.profileId}`, headers: authHeaders(user),
    });
    expect(list.body).not.toContain(name);
  });

  it('refuses a new schedule in a different unit from existing stock', async () => {
    const res = await h.app.inject({
      method: 'POST', url: `/v1/medications/${medicationId}/schedules`, headers: authHeaders(user),
      payload: {
        rule: { kind: 'fixed_times', times: ['20:00'] },
        doseQuantity: 5, doseUnit: 'ml', startDate: today(),
      },
    });
    expect(res.statusCode, res.body).toBe(409);
  });

  it('refuses changing an existing schedule to a different stock unit', async () => {
    const res = await h.app.inject({
      method: 'PATCH', url: `/v1/schedules/${scheduleId}`, headers: authHeaders(user),
      payload: { doseUnit: 'ml', confirmHighRiskChange: true },
    });
    expect(res.statusCode, res.body).toBe(409);
  });

  it('refuses a refill recorded in a different unit and leaves balance unchanged', async () => {
    const before = await stockQuantity();
    const refill = await h.app.inject({
      method: 'POST', url: `/v1/medications/${medicationId}/refill`, headers: authHeaders(user),
      payload: { quantityAdded: 10, unit: 'ml' },
    });
    expect(refill.statusCode, refill.body).toBe(409);
    expect(await stockQuantity()).toBe(before);
  });
});
