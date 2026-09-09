import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import { resetClockSource, setClockSource } from '../src/lib/clock.js';

const RIYADH = 'Asia/Riyadh';
const BASE = (() => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: RIYADH, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = f.format(new Date()).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
})();
const day = (offset: number) => new Date(BASE + offset * 86_400_000).toISOString().slice(0, 10);

let h: Harness;
let user: TestUser;
let medicationId = '';
let doseId = '';
let scheduledAt = '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '0544111199');

  const medication = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: 'Ledger cycle medicine', form: 'tablet', startDate: day(-1),
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: day(-1),
      },
      stock: { trackingEnabled: true, initialQuantity: 10, unit: 'tablet' },
    },
  });
  expect(medication.statusCode, medication.body).toBe(200);
  medicationId = medication.json().medication.id;

  const doses = await h.app.inject({
    method: 'GET',
    url: `/v1/doses?profileId=${user.profileId}&from=${day(1)}&to=${day(1)}`,
    headers: authHeaders(user),
  });
  expect(doses.statusCode, doses.body).toBe(200);
  const dose = doses.json().doses[0];
  expect(dose).toBeTruthy();
  doseId = dose.id;
  scheduledAt = dose.scheduledAt;
});

afterAll(async () => {
  resetClockSource();
  await h.close();
});

describe('stock ledger across take/undo/re-take', () => {
  it('records every quantity movement, not only the first take and undo for a dose', async () => {
    // Put the server at the occurrence itself. This is a ledger test, not an
    // early-confirmation test, and production rejects distant future actions.
    setClockSource(() => new Date(scheduledAt));

    const take1 = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'ledger-cycle-take-1', method: 'app' },
    });
    expect(take1.statusCode, take1.body).toBe(200);

    const undo1 = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doseId}/undo`, headers: authHeaders(user),
    });
    expect(undo1.statusCode, undo1.body).toBe(200);

    const take2 = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'ledger-cycle-take-2', method: 'app' },
    });
    expect(take2.statusCode, take2.body).toBe(200);

    const stock = await h.app.inject({
      method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
    });
    expect(stock.statusCode, stock.body).toBe(200);
    const transactions = stock.json().transactions as Array<{ reason: string; delta: number }>;

    // The table is documented as a reconstructable quantity ledger. Before the
    // fix, its unique (dose_occurrence_id, reason) index suppressed the second
    // dose_taken row even though the balance was decremented a second time.
    expect(transactions.filter((t) => t.reason === 'dose_taken')).toHaveLength(2);
    expect(transactions.filter((t) => t.reason === 'dose_undone')).toHaveLength(1);
    expect(stock.json().stock.remainingQuantity).toBe(9);
  });
});
