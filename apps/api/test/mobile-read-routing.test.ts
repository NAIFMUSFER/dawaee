import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Run the real Fastify server and access checks. Only authentication/session
// I/O and database I/O are replaced with one synthetic account's records.
const h = vi.hoisted(() => ({
  user: '11111111-1111-4111-8111-111111111111',
  profile: '22222222-2222-4222-8222-222222222222',
  medication: '33333333-3333-4333-8333-333333333333',
  query: vi.fn(),
  authenticate: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/db.js', async (original) => {
  const db = await original<typeof import('../src/lib/db.js')>();
  return {
    ...db,
    withUserReadOnly: async (_userId: string, run: (tx: unknown) => unknown) => run({ query: h.query }),
  };
});
vi.mock('../src/middleware/context.js', async (original) => ({
  ...await original<typeof import('../src/middleware/context.js')>(),
  authenticate: h.authenticate,
  currentUser: () => ({ userId: h.user }),
}));

import { buildServer } from '../src/server.js';

let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  server = await buildServer();
  await server.app.ready();
});
afterAll(async () => { await server?.app.close(); });
beforeEach(() => {
  h.authenticate.mockClear();
  h.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM patient_profiles pp')) {
      return { rows: [{
        id: h.profile, owner_user_id: h.user, linked_user_id: h.user,
        archived_at: null, timezone: 'Asia/Riyadh', home_timezone: 'Asia/Riyadh',
        display_name: 'Synthetic patient', rel_status: null,
      }] };
    }
    if (sql.includes('SELECT patient_profile_id FROM medications')) {
      return { rows: [{ patient_profile_id: h.profile }] };
    }
    if (sql.includes('FROM medications m WHERE m.id = $1')) {
      return { rows: [{
        id: h.medication, patient_profile_id: h.profile, name: 'Synthetic medicine',
        form: 'tablet', status: 'active', strength_value: null, strength_unit: null,
        image_key: null, archived_at: null,
      }] };
    }
    return { rows: [] };
  });
});

describe('Android read contract on the serving API', () => {
  it.each([
    ['/v1/emergency/card', 'card'],
    ['/v1/care-circle', 'caregivers'],
    ['/v1/medications', 'medications'],
    ['/v1/doses?from=2026-09-13&to=2026-09-19', 'doses'],
  ])('loads %s with the profile in request headers', async (url, field) => {
    const response = await server.app.inject({
      method: 'GET', url,
      headers: { 'x-dawaee-profile-id': h.profile },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toHaveProperty(field);
    expect(h.authenticate).toHaveBeenCalled();
    const access = h.query.mock.calls.find(([sql]) => sql.includes('FROM patient_profiles pp'));
    expect(access?.[1]).toEqual([h.profile, h.user]);
  });

  it('preserves the selected medication filter in the history request', async () => {
    const response = await server.app.inject({
      method: 'GET', url: '/v1/doses?from=2026-09-13&to=2026-09-19',
      headers: { 'x-dawaee-profile-id': h.profile, 'x-dawaee-medication-id': h.medication },
    });
    expect(response.statusCode, response.body).toBe(200);
    const doses = h.query.mock.calls.find(([sql]) => sql.includes('FROM dose_occurrences d'));
    expect(doses?.[1]).toEqual([h.profile, '2026-09-13', '2026-09-19', h.medication, 500]);
  });

  it('opens an existing medication from the fixed mobile detail path', async () => {
    const response = await server.app.inject({
      method: 'GET', url: '/v1/medication',
      headers: { 'x-dawaee-medication-id': h.medication },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().medication.id).toBe(h.medication);
    expect(h.authenticate).toHaveBeenCalled();
    expect(h.query.mock.calls.some(([sql, values]) =>
      sql.includes('FROM medications m WHERE m.id = $1') && values[0] === h.medication,
    )).toBe(true);
  });

  it('continues supporting installed clients that use the legacy query', async () => {
    const response = await server.app.inject({
      method: 'GET', url: `/v1/emergency/card?profileId=${h.profile}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toHaveProperty('card', null);
  });
});
