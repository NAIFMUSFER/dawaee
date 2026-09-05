import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Single-flight refresh, on the client.
 *
 * The server no longer punishes the loser of a refresh race (P9-1), but the
 * client's job is not to create the race at all. Twenty API calls that all
 * discover an expired access token at the same instant must produce exactly ONE
 * refresh over the network — otherwise nineteen requests carry a token that the
 * first one is in the middle of rotating.
 *
 * This matters beyond tidiness because of the P1 persistence rule: a failed
 * refresh clears stored tokens. If a losing refresh took that path it would
 * erase the session the winning one had just written, turning a harmless race
 * into a sign-out — which is exactly the failure the server-side grace exists
 * to prevent, reintroduced on the device.
 */

const secure = new Map<string, string>();
const async_ = new Map<string, string>();
const platform = 'ios';

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
vi.mock('react-native', () => ({ Platform: { get OS() { return platform; } }, NativeModules: {} }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { apiBaseUrl: 'http://api.test' } } } }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: Symbol('afu'),
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));

const client = await import('../src/api/client.js');

/** Every request the client made, in order. */
let calls: Array<{ url: string; body: unknown }> = [];
/** How the fake server answers /v1/auth/refresh. */
let refreshResponder: () => { status: number; body: unknown } = () => ({
  status: 200, body: { accessToken: 'A2', refreshToken: 'R2' },
});
/** Resolves the in-flight refresh only when released, so the race is real. */
let releaseRefresh: (() => void) | null = null;

const fakeFetch = vi.fn(async (url: string, init?: { body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, body });

  if (url.endsWith('/v1/auth/refresh')) {
    if (releaseRefresh) {
      await new Promise<void>((resolve) => { releaseRefresh = resolve; });
    }
    const { status, body: payload } = refreshResponder();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      clone: () => ({ json: async () => payload }),
    };
  }

  // Every protected call answers 401 token_expired the first time, so each one
  // independently decides it needs a refresh.
  const payload = { error: { code: 'token_expired', message: 'expired' } };
  return {
    ok: false, status: 401,
    json: async () => payload,
    clone: () => ({ json: async () => payload }),
  };
});

vi.stubGlobal('fetch', fakeFetch);

beforeEach(async () => {
  calls = [];
  secure.clear();
  async_.clear();
  releaseRefresh = null;
  refreshResponder = () => ({ status: 200, body: { accessToken: 'A2', refreshToken: 'R2' } });
  fakeFetch.mockClear();
  await client.storeSession({ accessToken: 'A1', refreshToken: 'R1' });
});

const refreshCalls = () => calls.filter((c) => c.url.endsWith('/v1/auth/refresh'));

describe('twenty simultaneous callers produce one refresh', () => {
  it('collapses concurrent refreshes into a single HTTP request', async () => {
    // Hold the refresh open so all twenty callers are genuinely in flight.
    releaseRefresh = () => undefined;

    const inFlight = Array.from({ length: 20 }, () =>
      client.api.get('/v1/doses').catch(() => 'failed'));

    // Give every caller a chance to reach the refresh path.
    await new Promise((r) => setTimeout(r, 50));
    expect(refreshCalls().length, 'more than one refresh went over the network').toBe(1);

    releaseRefresh!();
    await Promise.all(inFlight);

    expect(refreshCalls().length, 'a second refresh was issued after release').toBe(1);
  });

  it('gives every caller the same resulting session', async () => {
    releaseRefresh = () => undefined;
    const inFlight = Array.from({ length: 20 }, () =>
      client.api.get('/v1/doses').catch(() => 'failed'));
    await new Promise((r) => setTimeout(r, 50));
    releaseRefresh!();
    await Promise.all(inFlight);

    // One rotation happened, and the stored session is the one it produced.
    const stored = JSON.parse(secure.get('dawaee.session.v1')!);
    expect(stored).toEqual({ accessToken: 'A2', refreshToken: 'R2' });
  });

  it('every caller sends the same R1, never a partially rotated one', async () => {
    releaseRefresh = () => undefined;
    const inFlight = Array.from({ length: 20 }, () =>
      client.api.get('/v1/doses').catch(() => 'failed'));
    await new Promise((r) => setTimeout(r, 50));
    releaseRefresh!();
    await Promise.all(inFlight);

    for (const call of refreshCalls()) {
      expect((call.body as { refreshToken: string }).refreshToken).toBe('R1');
    }
  });

  it('propagates a refresh failure consistently to all of them', async () => {
    // Held open, so all twenty are genuinely in flight when it fails. Without
    // this the mock resolves synchronously and each caller starts its own
    // refresh in turn, which is a different scenario.
    releaseRefresh = () => undefined;
    refreshResponder = () => ({ status: 401, body: { error: { code: 'unauthenticated' } } });
    let signedOut = 0;
    client.setUnauthenticatedHandler(() => { signedOut += 1; });

    const pending = Array.from({ length: 20 }, () => client.api.get('/v1/doses'));
    await new Promise((r) => setTimeout(r, 50));
    releaseRefresh!();
    const results = await Promise.allSettled(pending);
    expect(results.every((r) => r.status === 'rejected'),
      'some callers succeeded on a failed refresh').toBe(true);
    expect(refreshCalls().length, 'a failed refresh was retried per caller').toBe(1);
    // The sign-out is signalled once, not twenty times.
    expect(signedOut).toBe(1);
  });

  it('allows a later refresh once the first has settled', async () => {
    await client.api.get('/v1/doses').catch(() => undefined);
    const first = refreshCalls().length;
    await client.api.get('/v1/doses').catch(() => undefined);
    expect(refreshCalls().length, 'the in-flight promise was never cleared')
      .toBeGreaterThan(first);
  });
});

/**
 * The persistence race the audit called out specifically. A losing refresh must
 * never erase what a winning one stored.
 */
describe('a superseded refresh never erases the winner’s session', () => {
  it('does not clear storage on 409 REFRESH_SUPERSEDED', async () => {
    // The winner has already written R2 to the keychain.
    await client.storeSession({ accessToken: 'A2', refreshToken: 'R2' });
    expect(JSON.parse(secure.get('dawaee.session.v1')!).refreshToken).toBe('R2');

    // A straggler now loses the race and is told it was superseded.
    refreshResponder = () => ({
      status: 409, body: { error: { code: 'refresh_superseded', message: 'superseded' } },
    });
    let signedOut = 0;
    client.setUnauthenticatedHandler(() => { signedOut += 1; });

    await client.api.get('/v1/doses').catch(() => undefined);

    const stored = secure.get('dawaee.session.v1');
    expect(stored, 'the loser wiped the stored session').toBeTruthy();
    expect(JSON.parse(stored!).refreshToken, "the loser erased the winner's token").toBe('R2');
    expect(signedOut, 'a superseded refresh signalled a sign-out').toBe(0);
  });

  it('still clears on a genuine 401, so a dead session does not linger', async () => {
    refreshResponder = () => ({ status: 401, body: { error: { code: 'unauthenticated' } } });
    await client.api.get('/v1/doses').catch(() => undefined);
    expect(secure.get('dawaee.session.v1'), 'a dead session survived a 401').toBeUndefined();
  });

  it('keeps the session on a network failure rather than signing out', async () => {
    refreshResponder = () => { throw new Error('offline'); };
    await client.api.get('/v1/doses').catch(() => undefined);
    expect(secure.get('dawaee.session.v1'), 'an offline blip cleared the session').toBeTruthy();
  });
});
