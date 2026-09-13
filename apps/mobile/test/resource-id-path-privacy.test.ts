import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), readSession: vi.fn(), writeSession: vi.fn(), clearSession: vi.fn(), fetch: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: h.get, setItem: h.set } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('../src/api/token-store.js', () => ({
  readSession: h.readSession, writeSession: h.writeSession, clearStoredSession: h.clearSession,
}));

type Client = typeof import('../src/api/client.js');
let client: Client;

const MEDICATION_ID = '11111111-2222-4333-8444-555555555555';
const PROFILE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SCHEDULE_ID = '99999999-8888-4777-8666-555555555555';
const DOSE_ID = '77777777-6666-4555-8444-333333333333';
const DEVICE_ID = 'dev-synthetic-installation-123';

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://audit.invalid');
  vi.stubEnv('EXPO_PUBLIC_DEMO', '0');
  h.get.mockReset().mockResolvedValue(null);
  h.set.mockReset().mockResolvedValue(undefined);
  h.readSession.mockReset().mockResolvedValue(null);
  h.writeSession.mockReset().mockResolvedValue(undefined);
  h.clearSession.mockReset().mockResolvedValue(undefined);
  h.fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', h.fetch);
  client = await import('../src/api/client.js');
  await client.storeSession({ accessToken: 'test-access', refreshToken: 'test-refresh' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('stable resource ids stay out of platform-visible request paths', () => {
  it.each([
    [`/v1/medications/${MEDICATION_ID}`, '/v1/medication'],
    [`/v1/medications/${MEDICATION_ID}/stock`, '/v1/medication/stock'],
    [`/v1/medications/${MEDICATION_ID}/refill`, '/v1/medication/refill'],
    [`/v1/medications/${MEDICATION_ID}/schedules`, '/v1/medication/schedules'],
  ])('routes %s through a fixed medication path', async (legacyPath, fixedPath) => {
    await client.api.get(legacyPath);
    const [rawUrl, init] = h.fetch.mock.calls.at(-1) as [string, RequestInit];
    const url = new URL(rawUrl);

    expect(url.pathname).toBe(fixedPath);
    expect(rawUrl).not.toContain(MEDICATION_ID);
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-access',
      'x-dawaee-medication-id': MEDICATION_ID,
    });
  });

  it.each([
    [`/v1/profiles/${PROFILE_ID}`, '/v1/profile'],
    [`/v1/profiles/${PROFILE_ID}/timezone-check`, '/v1/profile/timezone-check'],
    [`/v1/profiles/${PROFILE_ID}/timezone-decision`, '/v1/profile/timezone-decision'],
  ])('routes %s through a fixed profile path', async (legacyPath, fixedPath) => {
    await client.api.get(legacyPath);
    const [rawUrl, init] = h.fetch.mock.calls.at(-1) as [string, RequestInit];
    const url = new URL(rawUrl);

    expect(url.pathname).toBe(fixedPath);
    expect(rawUrl).not.toContain(PROFILE_ID);
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-access',
      'x-dawaee-profile-id': PROFILE_ID,
    });
  });

  it('routes schedule updates through a fixed path', async () => {
    await client.api.patch(`/v1/schedules/${SCHEDULE_ID}`, { active: false });
    const [rawUrl, init] = h.fetch.mock.calls.at(-1) as [string, RequestInit];
    expect(new URL(rawUrl).pathname).toBe('/v1/schedule');
    expect(rawUrl).not.toContain(SCHEDULE_ID);
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-access',
      'x-dawaee-schedule-id': SCHEDULE_ID,
    });
  });

  it('routes dose detail reads through a fixed path', async () => {
    await client.api.get(`/v1/doses/${DOSE_ID}`);
    const [rawUrl, init] = h.fetch.mock.calls.at(-1) as [string, RequestInit];
    expect(new URL(rawUrl).pathname).toBe('/v1/dose');
    expect(rawUrl).not.toContain(DOSE_ID);
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-access',
      'x-dawaee-dose-id': DOSE_ID,
    });
  });

  it('routes push-token removal through a fixed path', async () => {
    await client.api.delete(`/v1/devices/push-token/${encodeURIComponent(DEVICE_ID)}`);
    const [rawUrl, init] = h.fetch.mock.calls.at(-1) as [string, RequestInit];
    expect(new URL(rawUrl).pathname).toBe('/v1/devices/push-token');
    expect(rawUrl).not.toContain(DEVICE_ID);
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-access',
      'x-dawaee-device-id': DEVICE_ID,
    });
  });

  it('keeps medication filters out of query logs while retaining harmless range filters', async () => {
    await client.api.get('/v1/doses', {
      profileId: PROFILE_ID,
      medicationId: MEDICATION_ID,
      from: '2026-09-01',
      to: '2026-09-10',
    });
    const [rawUrl, init] = h.fetch.mock.calls.at(-1) as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(rawUrl).not.toContain(PROFILE_ID);
    expect(rawUrl).not.toContain(MEDICATION_ID);
    expect(url.searchParams.get('profileId')).toBeNull();
    expect(url.searchParams.get('medicationId')).toBeNull();
    expect(url.searchParams.get('from')).toBe('2026-09-01');
    expect(url.searchParams.get('to')).toBe('2026-09-10');
    expect(init.headers).toMatchObject({
      'x-dawaee-profile-id': PROFILE_ID,
      'x-dawaee-medication-id': MEDICATION_ID,
    });
  });

  it('preserves harmless query text while removing the id from a medication path', async () => {
    await client.api.delete(`/v1/medications/${MEDICATION_ID}`, { force: 'true' });
    const [rawUrl] = h.fetch.mock.calls.at(-1) as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe('/v1/medication');
    expect(url.searchParams.get('force')).toBe('true');
    expect(rawUrl).not.toContain(MEDICATION_ID);
  });
});