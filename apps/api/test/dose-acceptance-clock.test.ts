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

describe('server acceptance undo clock', () => {
  it('preserves clinical time, does not renew acceptance on replay, and restores stock at the boundary', async () => {
    const accepted = new Date(Date.parse(scheduledAt) + 60 * 60_000);
    setClockSource(() => accepted);
    const payload = { clientEventId: 'acceptance-take', method: 'app', takenAt: scheduledAt };
    const take = await h.app.inject({ method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(user), payload });
    expect(take.statusCode, take.body).toBe(200);
    const read = async () => (await h.app.inject({ method: 'GET', url: `/v1/doses/${doseId}`, headers: authHeaders(user) })).json().dose;
    expect(await read()).toMatchObject({ confirmedAt: scheduledAt, confirmedReceivedAt: accepted.toISOString() });
    setClockSource(() => new Date(accepted.getTime() + 5 * 60_000));
    const replay = await h.app.inject({ method: 'POST', url: `/v1/doses/${doseId}/taken`, headers: authHeaders(user), payload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect((await read()).confirmedReceivedAt).toBe(accepted.toISOString());
    setClockSource(() => new Date(accepted.getTime() + 10 * 60_000));
    const undo = await h.app.inject({ method: 'POST', url: `/v1/doses/${doseId}/undo`, headers: authHeaders(user) });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await read()).toMatchObject({ confirmedAt: null, confirmedReceivedAt: null });
    const stock = await h.app.inject({ method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user) });
    expect(stock.json().stock.remainingQuantity).toBe(10);
  });
  it('expires a new skip after ten minutes of server time', async () => {
    const accepted = new Date(Date.parse(scheduledAt) + 2 * 60 * 60_000);
    setClockSource(() => accepted);
    const skip = await h.app.inject({ method: 'POST', url: `/v1/doses/${doseId}/skip`, headers: authHeaders(user), payload: { clientEventId: 'acceptance-skip' } });
    expect(skip.statusCode, skip.body).toBe(200);
    setClockSource(() => new Date(accepted.getTime() + 10 * 60_000 + 1));
    const undo = await h.app.inject({ method: 'POST', url: `/v1/doses/${doseId}/undo`, headers: authHeaders(user) });
    expect(undo.statusCode, undo.body).toBe(422);
  });
});
