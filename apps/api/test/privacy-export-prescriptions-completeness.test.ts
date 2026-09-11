import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Red-team regression for the privacy export contract.
 *
 * Prescriptions are profile-scoped clinical records and may contain prescriber,
 * facility, date, image and OCR data. A route documented as the patient's full
 * data export must not silently omit them.
 */
let h: Harness;
let patient: TestUser;
let prescriptionId: string;

const psql = (sql: string) => execFileSync('psql', ['-d', 'dawaee_test', '-tAc', sql], {
  env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
}).toString().trim();

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097772');

  prescriptionId = psql(`
    INSERT INTO prescriptions
      (patient_profile_id, reference, prescriber_name, facility, issued_date,
       expiry_date, image_key, ocr_raw, ocr_status, created_by)
    VALUES
      ('${patient.profileId}', 'SYNTHETIC-RX-EXPORT', 'SYNTHETIC-PRESCRIBER',
       'SYNTHETIC-FACILITY', '2026-09-01', '2026-12-01',
       'synthetic/prescription/export-probe', '{"probe":"SYNTHETIC-OCR"}'::jsonb,
       'confirmed', '${patient.userId}')
    RETURNING id
  `);
});

afterAll(async () => { await h.close(); });

describe('privacy export prescription completeness', () => {
  it('includes profile-scoped prescription records in the full data export', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/reports/export?profileId=${patient.profileId}`,
      headers: authHeaders(patient),
      remoteAddress: '198.51.100.78',
    });

    expect(res.statusCode, res.body).toBe(200);
    const payload = res.json<{ data: { prescriptions?: Array<Record<string, unknown>> } }>();
    expect(payload.data.prescriptions).toBeDefined();
    expect(payload.data.prescriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: prescriptionId,
        patient_profile_id: patient.profileId,
        reference: 'SYNTHETIC-RX-EXPORT',
        prescriber_name: 'SYNTHETIC-PRESCRIBER',
        facility: 'SYNTHETIC-FACILITY',
        ocr_raw: { probe: 'SYNTHETIC-OCR' },
      }),
    ]));
  });
});
