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

const OBJECT_KEY = 'prescription_image/2026-09-10/11111111-2222-4333-8444-555555555555.jpg';

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

describe('private upload object identifiers stay out of platform request URLs', () => {
  it('moves objectKey to dedicated request metadata for the signed-read endpoint', async () => {
    await client.api.get('/v1/uploads/url', { objectKey: OBJECT_KEY });

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);

    expect(url.pathname).toBe('/v1/uploads/url');
    expect(url.searchParams.has('objectKey')).toBe(false);
    expect(rawUrl).not.toContain('prescription_image');
    expect(rawUrl).not.toContain(OBJECT_KEY);
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-access',
      'x-dawaee-object-key': OBJECT_KEY,
    });
  });
});
