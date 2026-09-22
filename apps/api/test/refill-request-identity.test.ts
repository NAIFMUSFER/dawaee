import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
let other: TestUser;
let medicationId: string;
let untrackedId: string;
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

beforeAll(async () => {
  resetDatabase(); h = await startHarness();
  user = await signIn(h, '+966500091251');
  other = await signIn(h, '+966500091252');
  async function create(name: string, stock: boolean) {
    const r = await h.app.inject({ method: 'POST', url: '/v1/medications', headers: authHeaders(user),
      payload: { patientProfileId: user.profileId, name, form: 'tablet', startDate: today(),
        ...(stock ? { stock: { initialQuantity: 30, unit: 'tablet', trackingEnabled: true } } : {}) } });
    expect(r.statusCode, r.body).toBe(200); return r.json().medication.id;
  }
  medicationId = await create('Synthetic keyed refill', true);
  untrackedId = await create('Synthetic first refill', false);
}, 120_000);
afterAll(async () => { await h.close(); });

const refill = (id: string, key: string, quantityAdded = 5, actor = user) => h.app.inject({
  method: 'POST', url: `/v1/medications/${id}/refill`, headers: authHeaders(actor),
  payload: { quantityAdded, unit: 'tablet', clientRequestId: key },
});
async function stock(id: string) {
  const r = await h.app.inject({ method: 'GET', url: `/v1/medications/${id}/stock`, headers: authHeaders(user) });
  expect(r.statusCode, r.body).toBe(200); return r.json();
}

describe('durable refill identity', () => {
  it('concurrent retries produce one refill, one stock movement and one result', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => refill(medicationId, 'same-refill-0001')));
    for (const r of responses) {
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual(responses[0]!.json());
    }
    const state = await stock(medicationId);
    expect(state.stock.remainingQuantity).toBe(35);
    expect(state.refills).toHaveLength(1);
    expect(state.transactions.filter((t: { reason: string }) => t.reason === 'refill')).toHaveLength(1);
  });
  it('rejects conflicting reuse without changing the ledger', async () => {
    const r = await refill(medicationId, 'same-refill-0001', 50);
    expect(r.statusCode, r.body).toBe(409);
    const state = await stock(medicationId);
    expect(state.stock.remainingQuantity).toBe(35); expect(state.refills).toHaveLength(1);
  });
  it('retains the original response after another refill changes the balance', async () => {
    const before = await refill(medicationId, 'same-refill-0001');
    expect((await refill(medicationId, 'new-refill-00002', 2)).statusCode).toBe(200);
    const retry = await refill(medicationId, 'same-refill-0001');
    expect(retry.json()).toEqual(before.json());
    const state = await stock(medicationId);
    expect(state.stock.remainingQuantity).toBe(37); expect(state.refills).toHaveLength(2);
  });
  it('serializes first-stock creation as well as keyed replay', async () => {
    const responses = await Promise.all(['first-refill-0001', 'first-refill-0001', 'first-refill-0002', 'first-refill-0003']
      .map(key => refill(untrackedId, key)));
    for (const r of responses) expect(r.statusCode, r.body).toBe(200);
    const state = await stock(untrackedId);
    expect(state.stock.remainingQuantity).toBe(15); expect(state.refills).toHaveLength(3);
    expect(state.transactions.filter((t: { reason: string }) => t.reason === 'refill')).toHaveLength(3);
  });
  it('checks authorization before returning a keyed result', async () => {
    const r = await refill(medicationId, 'same-refill-0001', 5, other);
    expect([403, 404]).toContain(r.statusCode);
    expect(r.body).not.toContain('refillId');
  });
});
