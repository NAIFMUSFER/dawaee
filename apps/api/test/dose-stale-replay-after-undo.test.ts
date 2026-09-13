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
  user = await signIn(h, '0544111299');

  const medication = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: 'Stale replay medicine', form: 'tablet', startDate: day(-1),
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

describe('offline stale replay after an intentional undo', () => {
  it('does not resurrect an undone take or decrement stock again', async () => {
    setClockSource(() => new Date(scheduledAt));

    const clientEventId = 'stale-replay-original-take';
    const take = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(user),
      payload: { clientEventId, method: 'app' },
    });
    expect(take.statusCode, take.body).toBe(200);

    const undo = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doseId}/undo`, headers: authHeaders(user),
    });
    expect(undo.statusCode, undo.body).toBe(200);

    const afterUndo = await h.app.inject({
      method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
    });
    expect(afterUndo.statusCode, afterUndo.body).toBe(200);
    expect(afterUndo.json().stock.remainingQuantity).toBe(10);

    // Model a device that queued the original take while offline and only now
    // reconnects. The original client event was already applied and then
    // intentionally undone by the user. Replaying that stale intent must be a
    // replay/tombstone, not a new clinical action that reverses the newer undo.
    const replay = await h.app.inject({
      method: 'POST', url: '/v1/doses/sync', headers: authHeaders(user),
      payload: {
        deviceId: 'stale-replay-device',
        actions: [{
          type: 'taken', doseOccurrenceId: doseId, at: scheduledAt, clientEventId,
        }],
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().applied).toBe(0);
    expect(replay.json().replayed).toBe(1);
    expect(replay.json().failed).toBe(0);

    const finalStock = await h.app.inject({
      method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
    });
    expect(finalStock.statusCode, finalStock.body).toBe(200);
    expect(finalStock.json().stock.remainingQuantity).toBe(10);

    const dose = await h.app.inject({
      method: 'GET', url: `/v1/doses/${doseId}`, headers: authHeaders(user),
    });
    expect(dose.statusCode, dose.body).toBe(200);
    expect(dose.json().dose.storedStatus).toBe('upcoming');
  });
});
