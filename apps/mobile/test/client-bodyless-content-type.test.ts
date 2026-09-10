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

describe('HTTP content-type matches the actual request body', () => {
  it('does not advertise JSON for a bodyless DELETE such as caregiver revoke', async () => {
    await client.api.delete('/v1/caregivers/test-relationship');

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const init = h.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-access' });
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('does not advertise JSON for a bodyless POST such as logout', async () => {
    await client.api.post('/v1/auth/logout');

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const init = h.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-access' });
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('still sends JSON content-type when a JSON body is present', async () => {
    await client.api.patch('/v1/caregivers/test-relationship/permissions', { permissions: [] });

    const init = h.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ permissions: [] }));
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-access',
      'content-type': 'application/json',
    });
  });
});
