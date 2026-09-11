import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Red-team regression for the privacy export contract.
 *
 * The privacy screen promises a JSON file containing all data for the active
 * patient profile. Escalation policies are directly profile-scoped and encode
 * when and how missed-dose alerts are sent, so silently omitting them makes the
 * export incomplete even when every medication and dose row is present.
 */
let h: Harness;
let patient: TestUser;
let policyId: string;

const psqlScalar = (sql: string) => execFileSync('psql', ['-d', 'dawaee_test', '-tAc', sql], {
  env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
}).toString().trim().split(/\r?\n/, 1)[0] ?? '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097773');

  policyId = psqlScalar(`
    INSERT INTO escalation_policies
      (patient_profile_id, enabled, stages, quiet_hours_start, quiet_hours_end)
    VALUES
      ('${patient.profileId}', true,
       '[{"afterMinutes":17,"target":"primary","channels":["push"]}]'::jsonb,
       '22:00', '07:00')
    RETURNING id
  `);
});

afterAll(async () => { await h.close(); });

describe('privacy export escalation-policy completeness', () => {
  it('includes profile-scoped escalation policies in the full data export', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/reports/export?profileId=${patient.profileId}`,
      headers: authHeaders(patient),
      remoteAddress: '198.51.100.79',
    });

    expect(res.statusCode, res.body).toBe(200);
    const payload = res.json<{ data: { escalationPolicies?: Array<Record<string, unknown>> } }>();
    expect(payload.data.escalationPolicies).toBeDefined();
    expect(payload.data.escalationPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: policyId,
        patient_profile_id: patient.profileId,
        enabled: true,
        stages: [{ afterMinutes: 17, target: 'primary', channels: ['push'] }],
        quiet_hours_start: '22:00:00',
        quiet_hours_end: '07:00:00',
      }),
    ]));
  });
});
