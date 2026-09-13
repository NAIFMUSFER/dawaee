import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetClockSource, setClockSource } from '../src/lib/clock.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let owner: pg.Pool;
let patient: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  patient = await signIn(h, '+966500099931');
  await owner.query(
    `UPDATE patient_profiles
        SET timezone = 'Pacific/Kiritimati', home_timezone = 'Pacific/Kiritimati'
      WHERE id = $1`,
    [patient.profileId],
  );
});

afterEach(() => resetClockSource());
afterAll(async () => { resetClockSource(); await owner.end(); await h.close(); });

describe('weekly report default range follows the patient profile timezone', () => {
  it('uses the profile local date rather than a hard-coded Riyadh date at a timezone boundary', async () => {
    // 10 Sep 2026 11:30 UTC is 10 Sep in Riyadh but already 11 Sep in Kiritimati.
    setClockSource(() => new Date('2026-09-10T11:30:00.000Z'));

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/reports/weekly?profileId=${patient.profileId}`,
      headers: authHeaders(patient),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().meta).toMatchObject({
      timezone: 'Pacific/Kiritimati',
      from: '2026-09-05',
      to: '2026-09-11',
    });
  });
});
