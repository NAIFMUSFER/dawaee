import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let targetDate = '';
let doses: DoseRef[] = [];

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500092600');
  targetDate = day(7);

  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: 'Snooze state regression medicine', form: 'tablet', startDate: targetDate,
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00', '14:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: targetDate,
      },
    },
  });
  expect(med.statusCode, med.body).toBe(200);

  const list = await h.app.inject({
    method: 'GET',
    url: `/v1/doses?profileId=${user.profileId}&from=${targetDate}&to=${targetDate}`,
    headers: authHeaders(user),
  });
  expect(list.statusCode, list.body).toBe(200);
  doses = list.json<{ doses: DoseRef[] }>().doses
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  expect(doses.length).toBeGreaterThanOrEqual(2);
}, 120_000);

afterAll(async () => { await h.close(); });

async function detail(doseId: string) {
  const res = await h.app.inject({
    method: 'GET', url: `/v1/doses/${doseId}`, headers: authHeaders(user),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ dose: { status: string; snoozedUntil: string | null } }>().dose;
}

function atDose(dose: DoseRef): void {
  h.setServerNow(new Date(dose.scheduledAt));
}

describe('P20 snooze metadata follows dose state', () => {
  it('clears snoozedUntil when a snoozed dose is taken', async () => {
    const dose = doses[0]!;
    atDose(dose);
    const snooze = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/snooze`, headers: authHeaders(user),
      payload: { minutes: 15, clientEventId: 'state-snooze-taken-1' },
    });
    expect(snooze.statusCode, snooze.body).toBe(200);
    expect((await detail(dose.id)).snoozedUntil).not.toBeNull();

    const taken = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'state-taken-after-snooze-1', method: 'app' },
    });
    expect(taken.statusCode, taken.body).toBe(200);

    const after = await detail(dose.id);
    expect(['taken', 'taken_late']).toContain(after.status);
    expect(after.snoozedUntil).toBeNull();
  });

  it('clears snoozedUntil when a snoozed dose is skipped', async () => {
    const dose = doses[1]!;
    atDose(dose);
    const snooze = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/snooze`, headers: authHeaders(user),
      payload: { minutes: 15, clientEventId: 'state-snooze-skip-1' },
    });
    expect(snooze.statusCode, snooze.body).toBe(200);

    const skipped = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/skip`, headers: authHeaders(user),
      payload: { clientEventId: 'state-skip-after-snooze-1' },
    });
    expect(skipped.statusCode, skipped.body).toBe(200);

    const after = await detail(dose.id);
    expect(after.status).toBe('skipped');
    expect(after.snoozedUntil).toBeNull();
  });

  it('the worker clears an expired snooze when it persists a missed outcome', () => {
    const src = readFileSync(new URL('../../worker/src/jobs/mark-missed.ts', import.meta.url), 'utf8');
    expect(src).toContain("SET status = 'missed',");
    expect(src).toContain('snoozed_until = NULL');
  });

  it('the migration reconciles previously resolved rows without changing outcomes', () => {
    const sql = readFileSync(new URL('../../../db/migrations/0036_clear_terminal_snooze_state.sql', import.meta.url), 'utf8');
    expect(sql).toContain("WHERE status <> 'snoozed'");
    expect(sql).toContain('SET snoozed_until = NULL');
    expect(sql).not.toMatch(/SET\s+status\s*=/i);
  });
});
