import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let patient: TestUser;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  patient = await signIn(h, '+966500097781');

  const put = await h.app.inject({
    method: 'PUT',
    url: `/v1/emergency/card?profileId=${patient.profileId}`,
    headers: authHeaders(patient),
    payload: {
      bloodType: 'O+', allergies: ['SYNTHETIC-ALLERGY'], conditionsNote: 'SYNTHETIC-CONDITION',
      emergencyContacts: [], includeMedications: false, includeAllergies: true,
      includeContacts: false, includeConditions: true,
    },
  });
  expect(put.statusCode, put.body).toBe(200);

  const enabled = await h.app.inject({
    method: 'POST',
    url: `/v1/emergency/qr/enable?profileId=${patient.profileId}`,
    headers: authHeaders(patient),
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const token = enabled.json<{ token: string }>().token;

  const scan = await h.app.inject({
    method: 'GET', url: '/v1/emergency/scan/card', headers: { authorization: `Bearer ${token}` },
  });
  expect(scan.statusCode, scan.body).toBe(200);
});

afterAll(async () => { await h.close(); });

describe('privacy export emergency-card completeness', () => {
  it('exports disclosure and QR lifecycle metadata without the QR credential hash', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/reports/export?profileId=${patient.profileId}`,
      headers: authHeaders(patient),
      remoteAddress: '198.51.100.81',
    });

    expect(res.statusCode, res.body).toBe(200);
    const payload = res.json<{ data: { emergencyCard?: Array<Record<string, unknown>> } }>();
    expect(payload.data.emergencyCard).toHaveLength(1);
    expect(payload.data.emergencyCard![0]).toEqual(expect.objectContaining({
      include_conditions: true,
      qr_view_count: 1,
    }));
    expect(payload.data.emergencyCard![0]?.qr_rotated_at).toBeTruthy();
    expect(payload.data.emergencyCard![0]?.qr_last_viewed_at).toBeTruthy();
    expect(payload.data.emergencyCard![0]?.updated_at).toBeTruthy();
    expect(payload.data.emergencyCard![0]).not.toHaveProperty('qr_token_hash');
  });
});
