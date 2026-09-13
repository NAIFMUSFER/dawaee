import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression proof for transient failures on /v1/auth/refresh.
 *
 * A rate-limit or server outage is not evidence that a refresh token is dead.
 * The client must keep the stored session so a later request can recover once
 * the transient condition clears. Only explicit authentication rejection may
 * destroy the session.
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
let refreshStatus = 503;
let signedOut = 0;

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url.endsWith('/v1/auth/refresh')) {
    const payload = refreshStatus === 429
      ? { error: { code: 'rate_limited', message: 'slow down' } }
      : { error: { code: 'provider_unavailable', message: 'temporary outage' } };
    return {
      ok: false,
      status: refreshStatus,
      json: async () => payload,
      clone: () => ({ json: async () => payload }),
    };
  }

  const payload = { error: { code: 'token_expired', message: 'expired' } };
  return {
    ok: false,
    status: 401,
    json: async () => payload,
    clone: () => ({ json: async () => payload }),
  };
}));

beforeEach(async () => {
  secure.clear();
  async_.clear();
  signedOut = 0;
  refreshStatus = 503;
  client.setUnauthenticatedHandler(() => { signedOut += 1; });
  await client.storeSession({ accessToken: 'A1', refreshToken: 'R1' });
});

async function attemptExpiredRequest(): Promise<void> {
  await client.api.get('/v1/doses').catch(() => undefined);
}

function storedSession(): { accessToken: string; refreshToken: string } | null {
  const raw = secure.get('dawaee.session.v1');
  return raw ? JSON.parse(raw) as { accessToken: string; refreshToken: string } : null;
}

describe('transient refresh failures do not destroy authentication state', () => {
  it('preserves the session on 429 rate limiting', async () => {
    refreshStatus = 429;
    await attemptExpiredRequest();

    expect(storedSession(), '429 erased a still-valid refresh token').toEqual({
      accessToken: 'A1', refreshToken: 'R1',
    });
    expect(signedOut, '429 was misclassified as an authentication rejection').toBe(0);
  });

  it('preserves the session on 5xx refresh outage', async () => {
    refreshStatus = 503;
    await attemptExpiredRequest();

    expect(storedSession(), '503 erased a still-valid refresh token').toEqual({
      accessToken: 'A1', refreshToken: 'R1',
    });
    expect(signedOut, '503 was misclassified as an authentication rejection').toBe(0);
  });
});
