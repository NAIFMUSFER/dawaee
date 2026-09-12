import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  readSession: vi.fn(),
  writeSession: vi.fn(),
  clearSession: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: h.get, setItem: h.set },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('../src/api/token-store.js', () => ({
  readSession: h.readSession,
  writeSession: h.writeSession,
  clearStoredSession: h.clearSession,
}));

type Client = typeof import('../src/api/client.js');
let client: Client;

const PROFILE_ID = '11111111-2222-4333-8444-555555555555';

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

describe('profile routing metadata stays out of platform request URLs', () => {
  const activeLegacySurfaces = [
    { path: '/v1/today', query: { profileId: PROFILE_ID } },
    { path: '/v1/medications', query: { profileId: PROFILE_ID, status: 'active' } },
    { path: '/v1/doses', query: { profileId: PROFILE_ID, from: '2026-09-01', to: '2026-09-10' } },
    { path: '/v1/adherence', query: { profileId: PROFILE_ID, from: '2026-09-01', to: '2026-09-10' } },
    { path: '/v1/care-circle', query: { profileId: PROFILE_ID } },
  ] as const;

  it.each(activeLegacySurfaces)(
    'keeps profileId out of the public URL for $path while preserving ordinary filters',
    async ({ path, query }) => {
      await client.api.get(path, query);

      expect(h.fetch).toHaveBeenCalledTimes(1);
      const [rawUrl, init] = h.fetch.mock.calls[0] as [string, RequestInit];
      const url = new URL(rawUrl);

      expect(url.pathname).toBe(path);
      expect(url.searchParams.has('profileId')).toBe(false);
      expect(rawUrl).not.toContain(PROFILE_ID);
      if ('status' in query) expect(url.searchParams.get('status')).toBe(query.status);
      if ('from' in query) expect(url.searchParams.get('from')).toBe(query.from);
      if ('to' in query) expect(url.searchParams.get('to')).toBe(query.to);
      expect(init.headers).toMatchObject({
        authorization: 'Bearer test-access',
        'x-dawaee-profile-id': PROFILE_ID,
      });

      h.fetch.mockClear();
    },
  );
});
