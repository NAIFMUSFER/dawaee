import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Red-team regression: the privacy export calls itself a full data export.
 * An append-only audit trail can legitimately grow beyond an arbitrary page
 * size, so the export must not silently omit older rows.
 */
let h: Harness;
let patient: TestUser;

const psql = (sql: string) => execFileSync('psql', ['-d', 'dawaee_test', '-tAc', sql], {
  env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
}).toString().trim();

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097771');

  // One set-based insert keeps the test cheap while crossing the legacy
  // export cap by exactly one row. Values are synthetic and contain no PHI.
  psql(`
    INSERT INTO audit_logs
      (actor_user_id, patient_profile_id, action, entity_type, entity_id, new_value)
    SELECT
      '${patient.userId}', '${patient.profileId}', 'privacy.export.probe', 'probe',
      gs::text, jsonb_build_object('sequence', gs)
    FROM generate_series(1, 5001) AS gs
  `);
}, 180_000);

afterAll(async () => { await h.close(); });

describe('privacy export audit completeness', () => {
  it('exports every audit row for the selected profile instead of silently truncating at 5000', async () => {
    const expected = Number(psql(
      `SELECT count(*) FROM audit_logs WHERE patient_profile_id = '${patient.profileId}'`,
    ));
    expect(expected).toBeGreaterThan(5000);

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/reports/export?profileId=${patient.profileId}`,
      headers: authHeaders(patient),
      remoteAddress: '198.51.100.77',
    });

    expect(res.statusCode, res.body).toBe(200);
    const payload = res.json<{ data: { auditLog: unknown[] } }>();
    expect(payload.data.auditLog).toHaveLength(expected);
  });
});
