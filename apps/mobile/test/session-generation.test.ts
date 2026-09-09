import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Session = { accessToken: string; refreshToken: string };
const storage = vi.hoisted(() => ({
  session: null as Session | null,
  read: null as (() => Promise<Session | null>) | null,
  write: null as ((tokens: Session) => Promise<void>) | null,
  clear: null as (() => Promise<void>) | null,
}));
vi.mock('../src/api/token-store.js', () => ({
  readSession: async () => storage.read ? storage.read() : storage.session,
  writeSession: async (tokens: Session) => {
    if (storage.write) await storage.write(tokens);
    storage.session = { ...tokens };
  },
  clearStoredSession: async () => {
    if (storage.clear) await storage.clear();
    storage.session = null;
  },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => 'audit-device', setItem: async () => undefined },
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { apiBaseUrl: 'http://api.test' } } },
}));

const A = { accessToken: 'access-a', refreshToken: 'refresh-a' };
const A2 = { accessToken: 'access-a2', refreshToken: 'refresh-a2' };
const B = { accessToken: 'access-b', refreshToken: 'refresh-b' };
const B2 = { accessToken: 'access-b2', refreshToken: 'refresh-b2' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const expired = () => reply(401, { error: { code: 'token_expired' } });
const rejected = () => reply(401, { error: { code: 'unauthenticated' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);
// The test controls the boundary, rather than relying on a lucky network delay.
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise<void>((r) => setImmediate(r));
  expect(predicate(), 'controlled interleaving was not reached').toBe(true);
}

let client: typeof import('../src/api/client.js');
let calls: Array<{ url: string; init: RequestInit }>;
let handler: (url: string, init: RequestInit) => Promise<Response>;
let signedOut: number;
const refreshCalls = () => calls.filter((c) => c.url.endsWith('/v1/auth/refresh'));
beforeEach(async () => {
  vi.resetModules();
  storage.session = null;
  storage.read = null;
  storage.write = null;
  storage.clear = null;
  calls = [];
  signedOut = 0;
  handler = async () => reply(200, { ok: true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  client = await import('../src/api/client.js');
  client.setUnauthenticatedHandler(() => { signedOut++; });
  await client.storeSession(A);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function pendingRefresh() {
  const gate = deferred<Response>();
  handler = async (url) => url.endsWith('/v1/auth/refresh') ? gate.promise : expired();
  const pending = settle(client.api.get('/v1/me'));
  await until(() => refreshCalls().length === 1);
  return { gate, pending };
}

describe('a request belongs to the session that started it', () => {
  it('cannot restore a logged-out session from a late refresh success', async () => {
    const { gate, pending } = await pendingRefresh();
    await client.clearSession();
    gate.resolve(reply(200, A2));
    expect((await pending).ok).toBe(false);
    expect(storage.session).toBeNull();
    expect(client.isSignedIn()).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('cannot overwrite a new account with a late refresh success', async () => {
    const { gate, pending } = await pendingRefresh();
    await client.storeSession(B);
    gate.resolve(reply(200, A2));
    expect((await pending).ok).toBe(false);
    expect(storage.session).toEqual(B);
    expect(calls).toHaveLength(2);
    expect(signedOut).toBe(0);
  });

  it('cannot sign a new account out with a late refresh rejection', async () => {
    const { gate, pending } = await pendingRefresh();
    await client.storeSession(B);
    gate.resolve(rejected());
    await pending;
    expect(storage.session).toEqual(B);
    expect(signedOut).toBe(0);
  });

  it('cannot clear a new account on a late protected-endpoint 401', async () => {
    const gate = deferred<Response>();
    handler = async () => gate.promise;
    const pending = settle(client.api.get('/v1/me'));
    await until(() => calls.length === 1);
    await client.storeSession(B);
    gate.resolve(rejected());
    await pending;
    expect(storage.session).toEqual(B);
    expect(signedOut).toBe(0);
  });

  it('never replays account A mutation with account B credentials', async () => {
    const gate = deferred<Response>();
    handler = async () => gate.promise;
    const pending = settle(client.api.patch('/v1/me/preferences', { showMedicationInNotifications: true }));
    await until(() => calls.length === 1);
    await client.storeSession(B);
    handler = async (url) => url.endsWith('/v1/auth/refresh') ? reply(200, B2) : reply(200, { ok: true });
    gate.resolve(expired());
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: 'session_changed' });
      expect(result.error).not.toBeInstanceOf(client.NetworkError);
    }
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${A.accessToken}`);
    expect(storage.session).toEqual(B);
  });

  it('discards a late successful response instead of exposing old-account data', async () => {
    const gate = deferred<Response>();
    handler = async () => gate.promise;
    const pending = settle(client.api.get('/v1/me'));
    await until(() => calls.length === 1);
    await client.storeSession(B);
    gate.resolve(reply(200, { private: 'synthetic-account-A-only' }));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'session_changed' });
  });

  it('also discards old-account data when switching while the body is decoded', async () => {
    const gate = deferred<unknown>();
    let decoding = false;
    handler = async () => {
      const response = reply(200, {});
      response.json = async () => { decoding = true; return gate.promise; };
      return response;
    };
    const pending = settle(client.api.get('/v1/me'));
    await until(() => decoding);
    await client.storeSession(B);
    gate.resolve({ private: 'synthetic-account-A-only' });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'session_changed' });
  });

  it('gives the new account an independent refresh flight', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    handler = async (url, init) => url.endsWith('/v1/auth/refresh')
      ? (JSON.parse(String(init.body)).refreshToken === A.refreshToken ? a.promise : b.promise)
      : expired();
    const old = settle(client.api.get('/v1/me'));
    await until(() => refreshCalls().length === 1);
    await client.storeSession(B);
    const current = settle(client.api.get('/v1/me'));
    try {
      await until(() => refreshCalls().length === 2);
      // Finishing A must not remove B's still-pending single-flight entry.
      a.resolve(reply(200, A2));
      await old;
      const third = settle(client.api.get('/v1/profiles'));
      await until(() => calls.some((c) => c.url.endsWith('/v1/profiles')));
      b.resolve(reply(200, B2));
      await Promise.all([current, third]);
      expect(refreshCalls()).toHaveLength(2);
      expect(storage.session).toEqual(B2);
    } finally {
      a.resolve(reply(200, A2));
      b.resolve(reply(200, B2));
      await Promise.all([old, current]);
    }
  });
});

describe('keychain ordering is part of the session boundary', () => {
  it('does not restore a session after logout during a keychain read', async () => {
    const gate = deferred<Session | null>();
    let reading = false;
    storage.read = async () => { reading = true; return gate.promise; };
    const loading = settle(client.loadStoredSession());
    await until(() => reading);
    const clearing = settle(client.clearSession());
    gate.resolve(A);
    await Promise.all([loading, clearing]);
    expect(client.isSignedIn()).toBe(false);
    expect(storage.session).toBeNull();
  });

  it('deletes a delayed write before logout completes', async () => {
    const gate = deferred<void>();
    let writing = false;
    storage.write = async () => { writing = true; await gate.promise; };
    const saving = settle(client.storeSession(A));
    await until(() => writing);
    const clearing = settle(client.clearSession());
    gate.resolve();
    await Promise.all([saving, clearing]);
    expect(storage.session).toBeNull();
    expect(client.isSignedIn()).toBe(false);
  });

  it('keeps the newest sign-in on disk when an older write was delayed', async () => {
    const gate = deferred<void>();
    let writing = false;
    storage.write = async (tokens) => {
      if (tokens.accessToken === A.accessToken) { writing = true; await gate.promise; }
    };
    const old = settle(client.storeSession(A));
    await until(() => writing);
    const current = settle(client.storeSession(B));
    gate.resolve();
    await Promise.all([old, current]);
    expect(storage.session).toEqual(B);
  });

  it('does not deliver an old unauthenticated callback after a later login', async () => {
    const gate = deferred<void>();
    let clearing = false;
    storage.clear = async () => { clearing = true; await gate.promise; };
    handler = async () => rejected();
    const old = settle(client.api.get('/v1/me'));
    await until(() => clearing);
    const current = settle(client.storeSession(B));
    gate.resolve();
    await Promise.all([old, current]);
    expect(storage.session).toEqual(B);
    expect(signedOut).toBe(0);
  });

  it('keeps the rotated memory pair but deletes the dead persisted token on write failure', async () => {
    storage.write = async () => { throw new Error('synthetic keychain failure'); };
    handler = async (url, init) => url.endsWith('/v1/auth/refresh') ? reply(200, A2)
      : new Headers(init.headers).get('authorization') === `Bearer ${A.accessToken}`
        ? expired() : reply(200, { ok: true });
    await expect(client.api.get('/v1/me')).resolves.toEqual({ ok: true });
    expect(storage.session).toBeNull();
    expect(client.isSignedIn()).toBe(true);
    expect(signedOut).toBe(0);
  });
});

describe('current-session and anonymous controls remain valid', () => {
  it.each([429, 503])('preserves credentials and HTTP status on refresh %s', async (status) => {
    handler = async (url) => url.endsWith('/v1/auth/refresh')
      ? reply(status, { error: { code: status === 429 ? 'rate_limited' : 'provider_unavailable' } }) : expired();
    const result = await settle(client.api.get('/v1/me'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ status });
      expect(result.error).not.toBeInstanceOf(client.NetworkError);
    }
    expect(storage.session).toEqual(A);
    expect(signedOut).toBe(0);
  });

  it('still clears a genuinely rejected current session', async () => {
    handler = async () => rejected();
    expect((await settle(client.api.get('/v1/me'))).ok).toBe(false);
    expect(storage.session).toBeNull();
    expect(signedOut).toBe(1);
  });

  it('keeps credentials on transport failure while refreshing', async () => {
    handler = async (url) => {
      if (url.endsWith('/v1/auth/refresh')) throw new Error('synthetic offline');
      return expired();
    };
    const result = await settle(client.api.get('/v1/me'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(client.NetworkError);
    expect(storage.session).toEqual(A);
    expect(signedOut).toBe(0);
  });

  it('retries a late old-token 401 with the same-session rotated token, without another refresh', async () => {
    const gate = deferred<Response>();
    handler = async (url, init) => {
      if (url.endsWith('/v1/auth/refresh')) return reply(200, A2);
      if (new Headers(init.headers).get('authorization') === `Bearer ${A2.accessToken}`) return reply(200, { ok: true });
      return url.endsWith('/v1/profiles') ? gate.promise : expired();
    };
    const slow = settle(client.api.get('/v1/profiles'));
    await until(() => calls.length === 1);
    await expect(client.api.get('/v1/me')).resolves.toEqual({ ok: true });
    gate.resolve(expired());
    expect((await slow).ok).toBe(true);
    expect(refreshCalls()).toHaveLength(1);
    expect(storage.session).toEqual(A2);
  });

  it('leaves anonymous requests independent of account changes and sends no credentials', async () => {
    const gate = deferred<Response>();
    handler = async () => gate.promise;
    const pending = client.api.anonymous.get('/public-info');
    await until(() => calls.length === 1);
    await client.storeSession(B);
    gate.resolve(reply(200, { public: true }));
    await expect(pending).resolves.toEqual({ public: true });
    expect(new Headers(calls[0]!.init.headers).has('authorization')).toBe(false);
    expect(storage.session).toEqual(B);
  });
});
