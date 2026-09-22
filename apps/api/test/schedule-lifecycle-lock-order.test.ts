import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import { resetClockSource } from '../src/lib/clock.js';

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
let scheduleId = '';
let owner: pg.Pool;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '0544111299');

  const medication = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId,
      name: 'Schedule lock medicine', form: 'tablet', startDate: day(-1),
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
  scheduleId = dose.scheduleId;
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 3 });
});

afterAll(async () => {
  resetClockSource();
  await owner.end();
  await h.close();
});

describe('schedule lifecycle lock order', () => {
  for (const method of ['PATCH', 'DELETE'] as const) {
    it(`${method} waits for lifecycle serialization before locking its schedule row`, async () => {
      const holder = await owner.connect();
      let pending: ReturnType<typeof h.app.inject> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))', [medicationId]);
        pending = h.app.inject({ method, url: `/v1/schedules/${scheduleId}`, headers: authHeaders(user),
          ...(method === 'PATCH' ? { payload: { lateAfterMinutes: 16 } } : {}) });
        const response = Promise.resolve(pending);
        let waiting = false;
        for (let i = 0; i < 160; i++) {
          const { rows } = await owner.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE 'SELECT pg_advisory_xact_lock%') AS waiting`);
          if (rows[0].waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(waiting).toBe(true);
        // Old PATCH locked this row while waiting on the advisory lock above.
        // NOWAIT detects the inversion without waiting for a deadlock victim.
        await holder.query('SELECT id FROM medication_schedules WHERE id=$1 FOR UPDATE NOWAIT', [scheduleId]);
        await holder.query('COMMIT');
        const result = await response;
        expect(result.statusCode, result.body).toBe(200);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        if (pending) await pending;
      }
    });
  }
});

it('returns invitation copy in the inviter account language', async () => {
  for (const locale of ['en', 'ar']) {
    await owner.query('UPDATE users SET locale=$2 WHERE id=$1', [user.userId, locale]);
    const invite = await h.app.inject({ method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(user),
      payload: { patientProfileId: user.profileId, invitedName: 'Synthetic caregiver', invitedEmail: `invite-${locale}@example.test`, role: 'son', permissions: ['view_medications'], channel: 'link' } });
    expect(invite.statusCode, invite.body).toBe(200);
    expect(invite.json().invitationMessage).toContain(locale === 'ar' ? 'دعاك' : 'invited');
  }
});
