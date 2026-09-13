import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A refresh rotates a bearer credential asynchronously. If the person signs
 * out — or signs into a different account — while that network request is in
 * flight, the response belongs to the OLD session and must not be allowed to
 * write its rotated pair back into memory/keychain afterwards.
 *
 * These tests deliberately hold the refresh response until the session has
 * changed. They were committed before the product fix: the old client writes
 * the late A2/R2 pair unconditionally, resurrecting A after sign-out or
 * replacing account B on a shared device.
 */
const secure = new Map<string, string>();
const async_ = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => async_.get(k) ?? null,
    setItem: async (k: string, v: string) => { async_.set(k, v); },
    removeItem: async (k: string) => { async_.delete(k); },
    multiRemove: async (keys: string[]) => { for (const k of keys) async_.delete(k); },
    multiSet: async (pairs: [string, string][]) => { for (const [k, v] of pairs) async_.set(k, v); },
    getAllKeys: async () => [...async_.keys()],
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, NativeModules: {} }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { apiBaseUrl: 'http://api.test' } } } }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: Symbol('afu'),
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));

const client = await import('../src/api/client.js');

type Resolver = (value: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  clone: () => { json: () => Promise<unknown> };
}) => void;
let releaseRefresh: Resolver | null = null;
let refreshStarted: Promise<void>;
let markRefreshStarted: (() => void) | null = null;

function response(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    clone: () => ({ json: async () => payload }),
  };
}

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url.endsWith('/v1/auth/refresh')) {
    markRefreshStarted?.();
    return await new Promise<ReturnType<typeof response>>((resolve) => { releaseRefresh = resolve; });
  }
  return response(401, { error: { code: 'token_expired', message: 'expired' } });
}));

beforeEach(async () => {
  secure.clear();
  async_.clear();
  releaseRefresh = null;
  refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  client.setUnauthenticatedHandler(() => undefined);
  await client.storeSession({ accessToken: 'A1', refreshToken: 'RA1' });
});

function storedSession(): { accessToken: string; refreshToken: string } | null {
  const raw = secure.get('dawaee.session.v1');
  return raw ? JSON.parse(raw) as { accessToken: string; refreshToken: string } : null;
}

async function startExpiredRequest(): Promise<{ pending: Promise<unknown> }> {
  const pending = client.api.get('/v1/doses').catch((e) => e);
  await refreshStarted;
  expect(releaseRefresh, 'refresh request should be held in flight').toBeTypeOf('function');
  return { pending };
}

describe('late refresh response cannot cross a session boundary', () => {
  it('does not resurrect the old session after explicit sign-out', async () => {
    const { pending } = await startExpiredRequest();
    await client.clearSession();

    releaseRefresh!(response(200, { accessToken: 'A2', refreshToken: 'RA2' }));
    await pending;

    expect(storedSession(), 'old refresh resurrected a session after sign-out').toBeNull();
    expect(client.isSignedIn()).toBe(false);
  });

  it('does not replace a newly signed-in account with the old account refresh', async () => {
    const { pending } = await startExpiredRequest();
    await client.clearSession();
    await client.storeSession({ accessToken: 'B1', refreshToken: 'RB1' });

    releaseRefresh!(response(200, { accessToken: 'A2', refreshToken: 'RA2' }));
    await pending;

    expect(storedSession(), 'late account-A refresh overwrote account B').toEqual({
      accessToken: 'B1', refreshToken: 'RB1',
    });
  });
});
