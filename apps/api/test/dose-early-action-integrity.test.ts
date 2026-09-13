import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EARLY_CONFIRMATION_WINDOW_MINUTES } from '@dawaee/core';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

const RIYADH = 'Asia/Riyadh';
const BASE = (() => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: RIYADH, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = f.format(new Date()).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
})();
const day = (offset: number) => new Date(BASE + offset * 86_400_000).toISOString().slice(0, 10);

type DoseRef = { id: string; scheduledAt: string };

let h: Harness;
let user: TestUser;
let doses: DoseRef[] = [];

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500092610');
  const startDate = day(7);

  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: 'Early action boundary medicine', form: 'tablet', startDate,
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00', '14:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate,
      },
    },
  });
  expect(med.statusCode, med.body).toBe(200);

  const list = await h.app.inject({
    method: 'GET',
    url: `/v1/doses?profileId=${user.profileId}&from=${startDate}&to=${startDate}`,
    headers: authHeaders(user),
  });
  expect(list.statusCode, list.body).toBe(200);
  doses = list.json<{ doses: DoseRef[] }>().doses.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  expect(doses).toHaveLength(2);
}, 120_000);

afterAll(async () => { await h.close(); });

function before(dose: DoseRef, minutes: number): Date {
  return new Date(new Date(dose.scheduledAt).getTime() - minutes * 60_000);
}

describe('P20 all explicit dose actions share the early safety boundary', () => {
  it('refuses snooze more than fifteen minutes before the occurrence and leaves it untouched', async () => {
    const dose = doses[0]!;
    h.setServerNow(before(dose, EARLY_CONFIRMATION_WINDOW_MINUTES + 1));
    const res = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/snooze`, headers: authHeaders(user),
      payload: { minutes: 10, clientEventId: 'early-snooze-refused-1' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('dose_not_actionable');

    const detail = await h.app.inject({ method: 'GET', url: `/v1/doses/${dose.id}`, headers: authHeaders(user) });
    expect(detail.json().dose.snoozedUntil).toBeNull();
  });

  it('allows snooze exactly at the shared early boundary', async () => {
    const dose = doses[0]!;
    h.setServerNow(before(dose, EARLY_CONFIRMATION_WINDOW_MINUTES));
    const res = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/snooze`, headers: authHeaders(user),
      payload: { minutes: 10, clientEventId: 'early-snooze-boundary-1' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses skip more than fifteen minutes before the occurrence and leaves it unresolved', async () => {
    const dose = doses[1]!;
    h.setServerNow(before(dose, EARLY_CONFIRMATION_WINDOW_MINUTES + 1));
    const res = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/skip`, headers: authHeaders(user),
      payload: { clientEventId: 'early-skip-refused-1' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('dose_not_actionable');

    const detail = await h.app.inject({ method: 'GET', url: `/v1/doses/${dose.id}`, headers: authHeaders(user) });
    expect(detail.json().dose.status).not.toBe('skipped');
  });

  it('allows skip exactly at the shared early boundary', async () => {
    const dose = doses[1]!;
    h.setServerNow(before(dose, EARLY_CONFIRMATION_WINDOW_MINUTES));
    const res = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/skip`, headers: authHeaders(user),
      payload: { clientEventId: 'early-skip-boundary-1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('skipped');
  });
});
